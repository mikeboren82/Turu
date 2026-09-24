const test = require('node:test');
const assert = require('node:assert/strict');
const { relaySource } = require('../lib/relayRun');

const TRANSPORT = { error: { message: 'TypeError: fetch failed', details: 'TypeError: fetch failed\n\nCaused by: Error: read ECONNRESET (ECONNRESET)', hint: '', code: '' }, status: 0 };
const APP = { error: { message: 'permission denied', details: null, hint: null, code: 'P0001' }, status: 400 };

// Fake Supabase: tables + a relay_scan_source that behaves like scan-source (per-invocation page budget,
// hash-skip of unchanged parts, snapshot saved only for processed parts, log flipped BEFORE finalizeSource).
function fakeWorld({ budget = 3, rpcScript = [], snapshots = [] } = {}) {
  let clock = Date.parse('2026-09-24T08:00:00Z');
  const now = () => clock;
  const iso = () => new Date(clock).toISOString();
  const t = { source_scan_logs: [], source_page_snapshots: snapshots.map((s) => ({ source_id: 'S', ...s })), sources: [{ id: 'S', last_scan_at: '2026-09-21T03:00:00.000Z', next_scan_at: '2026-09-24T00:00:00.000Z', scan_frequency_hours: 72, last_scan_status: 'success', last_scan_error: null }] };
  const rpcCalls = [];
  let logSeq = 0;
  const scanSource = (pages) => {
    clock += 60_000;
    const log = { id: `log${++logSeq}`, source_id: 'S', started_at: iso(), status: 'running', pages_checked: 0, ai_calls: 0, activities_found: 0, new_count: 0, duplicate_count: 0, rejected_count: 0, error_type: null };
    t.source_scan_logs.push(log);
    let extracted = 0;
    for (const p of pages.filter((x) => x.kind !== 'detail')) {
      const snap = t.source_page_snapshots.find((s) => s.url === p.url);
      if (snap && snap.content_hash === p.hash) { snap.last_fetched_at = iso(); log.pages_checked++; continue; }
      if (extracted >= budget) { log.error_type = 'rate_limited'; break; }
      extracted++; log.pages_checked++; log.ai_calls++;
      if (snap) Object.assign(snap, { content_hash: p.hash, last_fetched_at: iso() }); else t.source_page_snapshots.push({ source_id: 'S', url: p.url, content_hash: p.hash, last_fetched_at: iso() });
    }
    clock += 30_000;
    log.status = 'success'; // log flips first ...
    clock += 1000;
    Object.assign(t.sources[0], { last_scan_at: iso(), last_scan_status: 'success', next_scan_at: new Date(clock + 72 * 3600e3).toISOString() }); // ... then finalizeSource
  };
  const from = (table) => {
    const q = { op: 'select', patch: null, f: [], ord: null, lim: null, ret: false };
    const match = (r) => q.f.every(([k, v, kind]) => kind === 'eq' ? r[k] === v : kind === 'gte' ? r[k] >= v : kind === 'in' ? v.includes(r[k]) : (r[k] ?? null) === v);
    const run = () => {
      let rows = (t[table] ||= []).filter(match);
      if (q.op === 'update') { for (const r of rows) Object.assign(r, q.patch); return { data: q.ret ? rows.map((r) => ({ ...r })) : null, error: null }; }
      if (q.ord) rows = [...rows].sort((a, b) => (a[q.ord.k] < b[q.ord.k] ? -1 : 1) * (q.ord.asc ? 1 : -1));
      if (q.lim != null) rows = rows.slice(0, q.lim);
      return { data: rows.map((r) => ({ ...r })), error: null };
    };
    const b = {
      select() { if (q.op !== 'select') q.ret = true; return b; },
      update(p) { q.op = 'update'; q.patch = p; return b; },
      eq(k, v) { q.f.push([k, v, 'eq']); return b; }, gte(k, v) { q.f.push([k, v, 'gte']); return b; },
      in(k, v) { q.f.push([k, v, 'in']); return b; }, is(k, v) { q.f.push([k, v, 'is']); return b; },
      order(k, o) { q.ord = { k, asc: o?.ascending !== false }; return b; }, limit(n) { q.lim = n; return b; },
      maybeSingle() { const r = run(); return Promise.resolve({ data: r.data[0] ?? null, error: null }); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  };
  const client = {
    from,
    rpc: async (name, args) => {
      const scripted = rpcScript[rpcCalls.length];
      rpcCalls.push(args.p_pages.map((p) => p.url));
      if (scripted && scripted.error) return scripted;
      scanSource(args.p_pages);
      return { error: null, status: 204 };
    },
  };
  return { client, t, rpcCalls, now };
}

const parts = (n, tag = 'v1') => Array.from({ length: n }, (_, i) => ({ url: i === 0 ? 'https://h/cal' : `https://h/cal#part=${i + 1}`, text: `part ${i + 1} ${tag}`, hash: `h${i + 1}-${tag}` }));
const ctxFor = (w, pages) => ({ client: w.client, now: w.now, sleep: async () => {}, pollMs: 0, maxPolls: 3, log: () => {}, relayPages: async () => ({ stats: [], pages }) });
const S = { id: 'S', name: 'Holon' };

test('COMPLETE: every part confirmed by its own snapshot; scan-source keeps its normal cadence', async () => {
  const w = fakeWorld({ budget: 3 });
  const run = await relaySource(ctxFor(w, parts(5)), S);
  assert.equal(run.outcome, 'COMPLETE');
  assert.deepEqual([run.confirmedParts, run.deferredParts, run.submittedBatches], [5, 0, 2]);
  assert.equal(run.verdictWrite, null);
  assert.equal(w.t.sources[0].last_scan_status, 'success');
});

test('deferred-page recovery: only the deferred parts are re-sent; a run that cannot finish is PARTIAL with a short retry', async () => {
  const w = fakeWorld({ budget: 1 });
  const run = await relaySource(ctxFor(w, parts(5)), S);
  assert.deepEqual(w.rpcCalls, [
    ['https://h/cal', 'https://h/cal#part=2', 'https://h/cal#part=3'], ['https://h/cal#part=4', 'https://h/cal#part=5'], // round 0
    ['https://h/cal#part=2', 'https://h/cal#part=3', 'https://h/cal#part=5'], // round 1: deferred only
    ['https://h/cal#part=3', 'https://h/cal#part=5'], // round 2
  ]);
  assert.equal(run.outcome, 'PARTIAL');
  assert.deepEqual([run.confirmedParts, run.deferredParts], [4, 1]);
  assert.equal(w.t.sources[0].last_scan_status, 'partial');
  assert.match(w.t.sources[0].last_scan_error, /relay PARTIAL: 4\/5 parts confirmed, 1 deferred/);
  assert.equal(Date.parse(w.t.sources[0].next_scan_at) - w.now(), 6 * 3600e3); // not +72h
});

test('no starvation across runs: the part left deferred goes first next time, ahead of a part 1 that changed again', async () => {
  const w = fakeWorld({ budget: 1 });
  await relaySource(ctxFor(w, parts(5)), S); // leaves part 5 deferred
  const next = parts(5).map((p, i) => (i === 0 ? { ...p, text: 'part 1 v2', hash: 'h1-v2' } : p)); // part 1 changed overnight
  w.rpcCalls.length = 0;
  const run2 = await relaySource(ctxFor(w, next), S);
  assert.equal(w.rpcCalls[0][0], 'https://h/cal#part=5');
  assert.equal(run2.outcome, 'COMPLETE');
});

test('transient RPC failure is retried; the batch is submitted exactly once', async () => {
  const w = fakeWorld({ budget: 3, rpcScript: [null, TRANSPORT] });
  const run = await relaySource(ctxFor(w, parts(5)), S);
  assert.equal(run.outcome, 'COMPLETE');
  assert.equal(w.t.source_scan_logs.length, 2);
  assert.equal(w.rpcCalls.length, 3); // batch 1, batch 2 (failed), batch 2 (retry)
});

test('application error is not retried: run is PARTIAL, failed batch reported, progress still earns the short retry', async () => {
  const w = fakeWorld({ budget: 3, rpcScript: [null, APP] });
  const run = await relaySource(ctxFor(w, parts(5)), S);
  assert.equal(run.outcome, 'PARTIAL');
  assert.deepEqual([run.failedBatch.index, run.failedBatch.fatal, run.failedBatch.attempts, run.failedBatch.error.code], [2, true, 1, 'P0001']);
  assert.equal(w.rpcCalls.length, 2);
  assert.equal(w.t.sources[0].last_scan_status, 'partial');
  assert.match(w.t.sources[0].last_scan_error, /batch 2 failed after 1 attempt/);
});

test('FAILED before anything reached scan-source leaves the source row untouched (still due for the next relay cycle)', async () => {
  const w = fakeWorld({ budget: 3, rpcScript: [APP] });
  const before = { ...w.t.sources[0] };
  const run = await relaySource(ctxFor(w, parts(3)), S);
  assert.equal(run.outcome, 'FAILED');
  assert.deepEqual(w.t.sources[0], before);
});

test('no progress (scan-source extracts nothing) stops after one round and keeps the normal cadence', async () => {
  const w = fakeWorld({ budget: 0 });
  const run = await relaySource(ctxFor(w, parts(4)), S);
  assert.equal(run.outcome, 'PARTIAL');
  assert.equal(w.rpcCalls.length, 2); // round 0 only - the same set is never blindly resent
  assert.equal(w.t.sources[0].last_scan_status, 'partial');
  assert.ok(Date.parse(w.t.sources[0].next_scan_at) - w.now() > 70 * 3600e3);
});

test('part ceiling: dropped items are reported and the run is PARTIAL, never silently COMPLETE', async () => {
  const w = fakeWorld({ budget: 20 });
  const run = await relaySource({ ...ctxFor(w, parts(15)), maxParts: 12 }, S);
  assert.equal(run.outcome, 'PARTIAL');
  assert.deepEqual([run.ceiling.partsDropped, run.confirmedParts], [3, 12]);
  assert.match(w.t.sources[0].last_scan_error, /part ceiling dropped 3 item/);
});
