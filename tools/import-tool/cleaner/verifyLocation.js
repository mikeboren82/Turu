// TuRu Cleaner - VERIFY_LOCATION (Phase 2, 2026-09-24). A clean candidate whose ONLY remaining blocker is a verified
// location is resolved from evidence and handed back through the CANONICAL evaluator + the single publication
// implementation - no human unless the evidence genuinely conflicts.
//
//   discovery   open new rows where the canonical policy has NO hold (so never a trust-blocked row) and either
//                 resolve  : no coordinates, the location label names a place (lib/locationEvidence verifyLocationShape)
//                 handback : already resolved by the Cleaner with HIGH/MEDIUM evidence and a venue-shaped label -
//                            re-evaluation / publication only, never another geocode
//   ladder      lib/locationEvidence classifyResolution over the existing resolver (cleaner/locationResolver.js)
//   write       a verified write of coordinates + the full cleaner_location evidence object; never renames the
//               location label, never replaces a known address / city / venue with a weaker value
//   hand-back   cleaner/apply.js handBackIncoming (canonical evaluator -> publishIncoming, mode 'auto')
//   outcomes    RESOLVED_AND_PUBLISHED | RESOLVED_BUT_NOT_AUTO_PUBLISHABLE | CONFLICT_REQUIRES_HUMAN | NO_EVIDENCE |
//               TEMPORARY_FAILURE (+ EXCLUDED_WRONG_SHAPE / SUPERSEDED_BY_POLICY when the row changed under the case)
// Loop safety: a resolved row carries coordinates, so it is never re-discovered for resolution; a hand-back case that
// ended RESOLVED_BUT_NOT_AUTO_PUBLISHABLE reopens only when the policy state it was held for has changed; an exhausted
// case archives non-blocking (the row stays for a person) and may reopen once, on new venue evidence.
const { evaluatePublishPolicy } = require('../lib/publishPolicy');
const { withCardEvidence } = require('../lib/temporalShape');
const { verifyLocationShape, classifyResolution, storedLocationHolds, labelKind } = require('../lib/locationEvidence');
const { verifiedFieldUpdate, OUTCOME: W } = require('../lib/verifiedWrite');
const { normalizeCityName } = require('../cityNaming');

const OPEN = ['new', 'needs_review'];
const hasCoords = (c) => c && c.lat != null && c.lng != null && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng));
// the policy state a hand-back was held for; a change of it (e.g. the source became trusted) is new information
const policySignature = (codes) => [...new Set(codes || [])].sort().join(',');

// Pure plan for one open row. ctx: { source, settings: {minTrust, maxDaysAhead}, today, settlementOf }
// -> { kind: 'resolve' | 'handback' | null, bucket, reasons, exclusion? }
function planRow(row, ctx) {
  const c = withCardEvidence(row.extracted_data || {}, row.raw_source_snapshot);
  if (row.match_type !== 'new' || !OPEN.includes(row.status)) return { kind: null, bucket: 'not_an_open_new_row' };
  const core = evaluatePublishPolicy(c, { source: ctx.source, issues: row.validation_issues, today: ctx.today, minTrust: ctx.settings.minTrust, maxDaysAhead: ctx.settings.maxDaysAhead, row });
  const codes = core.reasons.map((r) => r.code);
  const trustBlocked = codes.includes('untrusted_source');
  if (hasCoords(c)) {
    if (codes.length) return { kind: null, bucket: trustBlocked && codes.length === 1 ? 'resolved_trust_blocked' : 'resolved_policy_held', reasons: codes };
    const holds = storedLocationHolds(c).map((r) => r.code);
    if (holds.length) return { kind: null, bucket: 'resolved_location_unsound', reasons: holds };
    if (!c.cleaner_location) return { kind: null, bucket: 'coordinates_not_from_cleaner' };
    return { kind: 'handback', bucket: 'resolved_needs_handback', reasons: [] };
  }
  if (codes.length) {
    if (trustBlocked && codes.length === 1) return { kind: null, bucket: 'trust_blocked_and_location_blocked', reasons: codes };
    return { kind: null, bucket: 'other_blockers', reasons: codes };
  }
  const shape = verifyLocationShape(c, { settlementOf: ctx.settlementOf });
  if (!shape.ok) return { kind: null, bucket: 'excluded_' + shape.exclusion, reasons: [], exclusion: shape.exclusion };
  return { kind: 'resolve', bucket: 'verify_location_eligible', reasons: [] };
}

async function pageAll(client, table, select, fn) {
  let out = [], from = 0;
  while (true) {
    let q = client.from(table).select(select).range(from, from + 999); if (fn) q = fn(q);
    const { data, error } = await q; if (error) throw error;
    out = out.concat(data || []); if (!data || data.length < 1000) return out; from += 1000;
  }
}

// -> { candidates: [discover-shaped], stats: {bucket: n}, reopenIds: [case ids whose held state changed] }
async function discoverVerifyLocation(client, { today }) {
  const { loadPolicySettings } = require('../lib/incomingEligibility');
  const { loadSettlementIndex, resolveSettlement } = require('../lib/canonicalSettlement');
  const settings = await loadPolicySettings(client);
  let index = null; try { index = await loadSettlementIndex(client); } catch { index = null; }
  const settlementOf = index && index.size ? (city) => resolveSettlement(index, city) : null;
  const sources = Object.fromEntries((await pageAll(client, 'sources', 'id, name, seed_url, is_trusted, source_trust_score')).map((s) => [s.id, s]));
  const rows = await pageAll(client, 'incoming_activities', 'id, source_id, match_type, status, validation_issues, deferred_until, extracted_data, raw_source_snapshot', (q) => q.in('status', OPEN).eq('match_type', 'new'));
  const stats = {}; const candidates = []; const handbackIds = [];
  for (const row of rows) {
    const p = planRow(row, { source: sources[row.source_id] || null, settings, today, settlementOf });
    stats[p.bucket] = (stats[p.bucket] || 0) + 1;
    if (!p.kind) continue;
    const ed = row.extracted_data || {};
    const eventDate = ed.schedule_type === 'one_time' ? ed.one_time_date || null : null;
    candidates.push({ subject_kind: 'incoming', subject_id: row.id, issue: 'verify_location', priority: p.kind === 'handback' ? 9 : 11, event_date: eventDate, source_id: row.source_id, opened_reason: p.kind === 'handback' ? 'resolved location, canonical policy clear: hand-back only' : 'location is the only remaining blocker' });
    if (p.kind === 'handback') handbackIds.push(row.id);
  }
  // a hand-back that was HELD re-opens only when the policy state it was held for is gone (e.g. trust arrived)
  const reopenIds = [];
  for (let i = 0; i < handbackIds.length; i += 150) {
    const { data } = await client.from('cleaner_cases').select('id, subject_id, status, resolution').eq('issue', 'verify_location').eq('status', 'resolved').in('subject_id', handbackIds.slice(i, i + 150));
    for (const k of data || []) if (k.resolution?.outcome === 'RESOLVED_BUT_NOT_AUTO_PUBLISHABLE' && (k.resolution.policy_signature ?? null) !== policySignature([])) reopenIds.push(k.id);
  }
  return { candidates, stats, reopenIds };
}

async function reopenVerifyLocationCases(client, ids) {
  let n = 0;
  for (const id of ids) {
    const now = new Date().toISOString();
    const { data } = await client.from('cleaner_cases').update({ status: 'open', next_attempt_at: now, resolved_at: null, opened_reason: 'reopened: canonical policy state changed since the held hand-back', updated_at: now }).eq('id', id).eq('status', 'resolved').select('id');
    if (data && data.length) n++;
  }
  return n;
}

// The verified write of a resolution: coordinates + evidence; label / known values never downgraded.
async function writeResolvedLocation(client, row, result, verification, attempt) {
  const ed = { ...(row.extracted_data || {}) };
  const now = new Date().toISOString();
  const city = normalizeCityName(ed.city || null) || normalizeCityName(result.city || null);
  const canonicalVenue = ['existing_venue', 'existing_source_venue'].includes(result.method) && result.venue_id ? result.venue_id : null;
  // `filled` records exactly which fields this write set, with their prior values, so a wrong resolution can be
  // reverted exactly (pilot 2026-09-24 had to reconstruct it)
  const filled = { lat: ed.lat ?? null, lng: ed.lng ?? null };
  ed.lat = result.lat; ed.lng = result.lng;
  if (city && city !== ed.city) { filled.city = ed.city ?? null; ed.city = city; }
  if (!ed.address && !ed.formatted_address && result.address) { filled.address = ed.address ?? null; ed.address = result.address; }
  if (!ed.venue_id && canonicalVenue) { filled.venue_id = ed.venue_id ?? null; ed.venue_id = canonicalVenue; }
  ed.cleaner_location = { lat: result.lat, lng: result.lng, address: result.address || null, city: result.city ? normalizeCityName(result.city) : city, venue_id: canonicalVenue, method: result.method, confidence: verification.class, resolver_confidence: result.confidence, evidence: result.evidence || {}, verification, resolved_at: now, attempt, filled };
  const r = await verifiedFieldUpdate(client, {
    table: 'incoming_activities', id: row.id, patch: { extracted_data: ed },
    applyGuard: (q) => q.in('status', OPEN),
    guardStillHolds: (fresh) => OPEN.includes(fresh.status),
    alreadySatisfied: (fresh) => hasCoords(fresh.extracted_data) && fresh.extracted_data?.cleaner_location?.method === result.method,
  });
  if (r.outcome === W.SUCCESS || r.outcome === W.NO_CHANGE_ALREADY_SATISFIED) return { ok: true, write: r.outcome, row: { ...row, extracted_data: ed } };
  if (r.outcome === W.PRECONDITION_CHANGED || r.outcome === W.ROW_NOT_FOUND) return { ok: false, closed: true, status: r.row?.status || null };
  return { ok: false, closed: false, error: `location write not applied (${r.outcome})${r.error ? ': ' + r.error : ''}` };
}

const isTemporary = (msg) => /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timeout|429|50[234]|budget exhausted|rate/i.test(String(msg || ''));

// hand-back result -> verify_location outcome. Publication EXECUTION stays distinct from resolution: a policy hold is a
// decision (RESOLVED_BUT_NOT_AUTO_PUBLISHABLE, the case resolves - no retry loop); an infrastructure failure retries
// (TEMPORARY_FAILURE); any other execution failure (LOCATION_INVALID / WRITE_DENIED / ERROR) retries within the case's
// attempt budget as PUBLISH_EXECUTION_FAILED, carrying the publication code.
function outcomeFromHandBack(hb) {
  if (hb.outcome === 'published') return 'RESOLVED_AND_PUBLISHED';
  if (hb.outcome === 'error') return !hb.publish || hb.publish === 'TEMPORARY_INFRA_FAILURE' ? 'TEMPORARY_FAILURE' : 'PUBLISH_EXECUTION_FAILED';
  return 'RESOLVED_BUT_NOT_AUTO_PUBLISHABLE';
}
const RETRY_OUTCOMES = new Set(['TEMPORARY_FAILURE', 'PUBLISH_EXECUTION_FAILED']);

/**
 * Process one verify_location case. h = the Cleaner's lifecycle wrappers { markFail, archiveOrDry, resolveOrDry, DRY,
 * resolveLocation, stagesForAttempt, handBackIncoming, maxEvidenceStages }.
 */
async function processVerifyLocation(client, c, row, ctx, h) {
  const counters = ctx.counters; counters.verifyLocation = counters.verifyLocation || {};
  const count = (k) => { counters.verifyLocation[k] = (counters.verifyLocation[k] || 0) + 1; };
  const settings = ctx.settings;
  const { data: src } = await client.from('sources').select('id, name, seed_url, is_trusted, source_trust_score').eq('id', row.source_id).maybeSingle();
  const plan = planRow(row, { source: src || null, settings, today: ctx.today, settlementOf: null });
  const ed = row.extracted_data || {};

  // HAND-BACK ONLY: already resolved - re-evaluate with the CURRENT policy and publish if eligible
  if (hasCoords(ed)) {
    if (plan.kind !== 'handback') { count('SUPERSEDED_BY_POLICY'); return h.resolveOrDry(client, c, { outcome: 'SUPERSEDED_BY_POLICY', policy_reasons: plan.reasons || [], bucket: plan.bucket }); }
    if (h.DRY) return { outcome: 'dry:handback' };
    const hb = await h.handBackIncoming(client, row, ctx);
    const o = outcomeFromHandBack(hb); count(o);
    if (RETRY_OUTCOMES.has(o)) return h.markFail(client, c, { method: ['handback'], error: hb.error, settings, evidence: { handback: hb } });
    return h.resolveOrDry(client, c, { outcome: o, stage: 'handback', handback: hb, policy_signature: policySignature(hb.reasons || []) });
  }
  if (plan.kind !== 'resolve') {
    const o = plan.exclusion ? 'EXCLUDED_WRONG_SHAPE' : 'SUPERSEDED_BY_POLICY'; count(o);
    return h.resolveOrDry(client, c, { outcome: o, policy_reasons: plan.reasons || [], bucket: plan.bucket, label: labelKind(ed) });
  }

  // RESOLVE: the existing evidence ladder, never a second resolver
  const subject = { name: ed.name, location_name: ed.location_name || null, city: ed.city || null, organizer_name: ed.organizer_name || null, page_url: row.page_url, source_id: row.source_id, source_venue_id: row.source?.venue_id || null, description: ed.description };
  let res;
  try { res = await h.resolveLocation(client, subject, { stages: h.stagesForAttempt(c), maxEvidenceStages: h.maxEvidenceStages, cache: ctx.cache, counters: counters.gain }); }
  catch (e) { count('TEMPORARY_FAILURE'); return h.markFail(client, c, { method: ['resolver'], error: 'TEMPORARY_FAILURE: ' + (e.message || e), settings }); }
  const { result, tried, skipped, errors } = res;
  const v = classifyResolution(result, subject);
  if (h.DRY) return { outcome: 'dry:' + v.class, method: result?.method || null, rule: v.rule, tried, errors: errors.join('; ') || null };

  if (v.class === 'HIGH' || v.class === 'MEDIUM') {
    const w = await writeResolvedLocation(client, row, result, v, (c.attempts || 0) + 1);
    if (!w.ok && w.closed) { count('SUPERSEDED_BY_POLICY'); return h.resolveOrDry(client, c, { outcome: 'resolved_externally', status: w.status }); }
    if (!w.ok) { count('TEMPORARY_FAILURE'); return h.markFail(client, c, { method: tried, skipped, error: w.error, settings, evidence: { location: result, verification: v } }); }
    const hb = await h.handBackIncoming(client, w.row, ctx);
    const o = outcomeFromHandBack(hb); count(o);
    if (RETRY_OUTCOMES.has(o)) return h.markFail(client, c, { method: tried, skipped, error: hb.error, settings, evidence: { location: result, verification: v, handback: hb } });
    return h.resolveOrDry(client, c, { outcome: o, method: result.method, confidence: v.class, verification: v, evidence: result.evidence, handback: hb, tried, skipped, policy_signature: policySignature(hb.reasons || []) });
  }
  if (v.class === 'CONFLICT') {
    count('CONFLICT_REQUIRES_HUMAN');
    // non-blocking archive: the case ends, the row stays in the queue for a person with the conflicting evidence
    return h.archiveOrDry(client, c, { reason: 'requires_human_judgment', note: 'CONFLICT_REQUIRES_HUMAN: ' + v.rule, methods: tried, evidence: { conflict: result, verification: v } });
  }
  // VERIFY_MORE / NO_EVIDENCE: next attempt tries evidence stages not yet run (backoff 6 h / 24 h / 72 h); exhausted -> archive
  const temporary = errors.some(isTemporary) && !result;
  count(temporary ? 'TEMPORARY_FAILURE' : 'NO_EVIDENCE');
  return h.markFail(client, c, { method: tried, skipped, error: (temporary ? 'TEMPORARY_FAILURE: ' : 'NO_EVIDENCE: ') + (errors.join('; ') || v.rule), settings, evidence: result ? { low: result, verification: v, ambiguous: !!result.ambiguous } : { verification: v } });
}

module.exports = { planRow, discoverVerifyLocation, reopenVerifyLocationCases, processVerifyLocation, writeResolvedLocation, outcomeFromHandBack, policySignature };
