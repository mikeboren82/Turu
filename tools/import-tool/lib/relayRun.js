// TuRu - one relay run for one source: plan -> ceiling -> starvation-safe order -> submit (with retry) ->
// confirm each part by its own stored snapshot -> bounded follow-up rounds for deferred parts only ->
// COMPLETE / PARTIAL / FAILED verdict -> guarded next_scan write. Dependencies are injected for tests.
const plan = require('./relayPlan');
const { callWithRetry } = require('./relayRpc');

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll for a scan log of this source that is not one we already accounted for, until it leaves 'running'.
async function waitForScan(ctx, sourceId, since, excludeIds) {
  const t0 = Date.now();
  for (let polls = 0; Date.now() - t0 < ctx.waitTimeoutMs && polls < ctx.maxPolls; polls++) {
    await ctx.sleep(ctx.pollMs);
    const { data } = await ctx.client.from('source_scan_logs').select('id, started_at, status, pages_checked, ai_calls, activities_found, new_count, duplicate_count, rejected_count, error_type')
      .eq('source_id', sourceId).gte('started_at', since).order('started_at', { ascending: false }).limit(5);
    const fresh = (data || []).find((l) => !excludeIds.has(l.id));
    if (fresh && fresh.status !== 'running') return fresh;
  }
  return null;
}

async function newScanLogExists(client, sourceId, since, excludeIds) {
  const { data } = await client.from('source_scan_logs').select('id').eq('source_id', sourceId).gte('started_at', since).limit(5);
  return (data || []).some((l) => !excludeIds.has(l.id));
}

async function readSnapshots(client, sourceId, urls) {
  const out = [];
  for (let i = 0; i < urls.length; i += 50) {
    const { data } = await client.from('source_page_snapshots').select('url, content_hash, last_fetched_at').eq('source_id', sourceId).in('url', urls.slice(i, i + 50));
    out.push(...(data || []));
  }
  return out;
}

function runSummary(run) {
  const f = run.failedBatch;
  return `relay ${run.outcome}: ${run.confirmedParts}/${run.plannedParts} parts confirmed, ${run.deferredParts} deferred; batches ${run.successfulBatches}/${run.submittedBatches} ok of ${run.plannedBatches} planned`
    + (f ? `; batch ${f.index} failed after ${f.attempts} attempt(s): ${f.error?.causedBy || f.error?.message || 'unknown'}${f.error?.cause?.code ? ' [' + f.error.cause.code + ']' : ''}` : '')
    + (run.waitTimedOut ? '; scan did not finish in time' : '')
    + (run.ceiling ? `; part ceiling dropped ${run.ceiling.itemsDropped} item(s) / ${run.ceiling.charsDropped} chars` : '');
}

// scan-source flips its log BEFORE finalizeSource writes last_scan_at / next_scan_at, so the verdict is written
// only after that write landed, and only while no newer scan has touched the row (conditional on last_scan_at).
async function applyVerdict(ctx, s, run, lastLog, progressed) {
  if (run.outcome === 'COMPLETE' || !run.submittedBatches) return null;
  let src = null;
  for (let t0 = Date.now(), polls = 0; ; polls++) {
    const { data } = await ctx.client.from('sources').select('last_scan_at, scan_frequency_hours').eq('id', s.id).maybeSingle();
    src = data;
    if (!lastLog || (src && src.last_scan_at && Date.parse(src.last_scan_at) >= Date.parse(lastLog.started_at))) break;
    if (Date.now() - t0 >= ctx.finalizeWaitMs || polls >= ctx.maxPolls) break;
    await ctx.sleep(ctx.pollMs);
  }
  if (!src) return null;
  const next = plan.nextScanDecision({ outcome: run.outcome, progressed, frequencyHours: src.scan_frequency_hours, nowMs: ctx.now() });
  const patch = { last_scan_status: 'partial', last_scan_error: runSummary(run).slice(0, 500) };
  if (next) patch.next_scan_at = next;
  let q = ctx.client.from('sources').update(patch).eq('id', s.id);
  q = src.last_scan_at ? q.eq('last_scan_at', src.last_scan_at) : q.is('last_scan_at', null);
  const { data: w, error } = await q.select('id');
  if (error) throw error;
  return { written: !!(w && w.length), nextScanAt: next };
}

async function relaySource(ctxIn, s) {
  const ctx = { batchSize: 3, sleep: realSleep, pollMs: 5000, waitTimeoutMs: 240_000, finalizeWaitMs: 30_000, maxPolls: Infinity, now: () => Date.now(), log: console.log, recorder: null, ...ctxIn };
  const { client, log } = ctx;
  const run = { source: s.name, sourceId: s.id, outcome: null, plannedParts: 0, confirmedParts: 0, deferredParts: 0, plannedBatches: 0, submittedBatches: 0, successfulBatches: 0, followupRounds: 0, failedBatch: null, waitTimedOut: false, ceiling: null, charsSent: 0, pages: [] };
  const { stats, pages } = await ctx.relayPages(s);
  run.pages = stats;
  const detailPages = pages.filter((p) => p.kind === 'detail');
  const { kept, ceiling } = plan.applyPartCeiling(pages.filter((p) => p.kind !== 'detail'), ctx.maxParts);
  run.ceiling = ceiling; run.plannedParts = kept.length;
  if (ceiling) log(`   ⚠ part ceiling: ${JSON.stringify(ceiling)}`);
  let queue = plan.orderPartsForRelay(kept, await readSnapshots(client, s.id, kept.map((p) => p.url)));
  const needsExtraction = new Set(queue.filter((p) => p.state === 'pending').map((p) => p.url));
  const confirmed = new Set();
  const seenLogIds = new Set();
  let lastLog = null;

  for (let round = 0; round <= plan.MAX_FOLLOWUP_ROUNDS && queue.length; round++) {
    run.followupRounds = round;
    const batches = plan.batchParts(queue, detailPages, ctx.batchSize);
    run.plannedBatches += batches.length;
    const deferred = [];
    let stop = false, roundConfirmed = 0;
    for (let i = 0; i < batches.length && !stop; i++) {
      const batch = batches[i];
      const listing = batch.filter((p) => p.kind !== 'detail');
      const since = new Date(ctx.now() - 60_000).toISOString();
      const { data: pre } = await client.from('source_scan_logs').select('id').eq('source_id', s.id).gte('started_at', since);
      for (const l of pre || []) seenLogIds.add(l.id);
      const payload = batch.map(({ state, ...p }) => p);
      const r = await callWithRetry({ rpc: () => client.rpc('relay_scan_source', { p_source_id: s.id, p_pages: payload }), landed: () => newScanLogExists(client, s.id, since, seenLogIds), recorder: ctx.recorder, sleep: ctx.sleep, log });
      if (!r.ok) { run.failedBatch = { round, index: i + 1, of: batches.length, attempts: r.attempts, fatal: !!r.fatal, error: r.failures[r.failures.length - 1] || null }; stop = true; break; }
      run.submittedBatches++;
      run.charsSent += payload.reduce((n, p) => n + (p.text || '').length + (p.html || '').length, 0);
      const done = await waitForScan(ctx, s.id, since, seenLogIds);
      if (!done) { run.waitTimedOut = true; log(`   round ${round} batch ${i + 1}: scan did not finish in time`); stop = true; break; }
      seenLogIds.add(done.id); lastLog = done;
      if (done.status !== 'error') run.successfulBatches++;
      const ok = plan.processedUrls(listing, await readSnapshots(client, s.id, listing.map((p) => p.url)), done.started_at);
      for (const p of listing) { if (ok.has(p.url)) { confirmed.add(p.url); roundConfirmed++; } else deferred.push(p); }
      log(`   round ${round} batch ${i + 1}/${batches.length}: ${done.status} parts ${listing.length} processed ${ok.size} deferred ${listing.length - ok.size} | found ${done.activities_found} new ${done.new_count} dup ${done.duplicate_count} rej ${done.rejected_count}${done.error_type ? ' (' + done.error_type + ')' : ''}`);
    }
    if (stop || !deferred.length || !roundConfirmed) break; // failure, done, or no progress - never resend the same set blindly
    queue = deferred; // only the deferred parts go again
  }

  run.confirmedParts = confirmed.size;
  run.deferredParts = run.plannedParts - confirmed.size;
  run.outcome = plan.classifyRun({ plannedParts: run.plannedParts, confirmedParts: run.confirmedParts, submittedBatches: run.submittedBatches, failedBatch: run.failedBatch, ceiling: run.ceiling, waitTimedOut: run.waitTimedOut });
  const progressed = [...confirmed].some((u) => needsExtraction.has(u));
  run.verdictWrite = await applyVerdict(ctx, s, run, lastLog, progressed);
  return run;
}

module.exports = { relaySource, runSummary, waitForScan, readSnapshots };
