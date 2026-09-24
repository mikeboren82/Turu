// TuRu - CANONICAL INCOMING ELIGIBILITY (2026-09-24): "may THIS incoming row be published automatically NOW?"
// The single evaluator behind POST /api/incoming/:id/evaluate, the approve route's write boundary, the Cleaner
// hand-back and reprocess-review-queue.js. The Cleaner resolves EVIDENCE; this decides.
//
// Always evaluates CURRENT state: the row, its source and the policy settings are re-read on every call, so a
// verdict stored when a scan ran or a Cleaner case opened can never carry publish permission forward. The rules
// are lib/publishPolicy.js (twin of the scan-source intake policy); this adds the facts that need the database:
//   location_unverified  hold      no resolved coordinates yet (the Cleaner / verify_location supplies them)
//   outside_service_area terminal  resolved coordinates fall outside TURU's service area
//   exact_duplicate      terminal  google_place_id / event fingerprint already live (what /approve 409s on)
// Read-only: never writes, never changes review status. Safe to call repeatedly.
const { evaluatePublishPolicy, decide } = require('./publishPolicy');
const { israelToday } = require('./intakePolicy');
const { normalizeIncomingCandidate } = require('../incomingShape');
const { computeEventFingerprint } = require('../eventFingerprint');

const ROW_COLUMNS = 'id, source_id, match_type, status, validation_issues, deferred_until, extracted_data, existing_activity_id, page_url';

async function loadPolicySettings(client) {
  const { data, error } = await client.from('automation_settings').select('key, value').in('key', ['auto_approve_min_trust_score', 'event_max_days_ahead']);
  if (error) throw error;
  const m = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
  return { minTrust: Number(m.auto_approve_min_trust_score ?? 80), maxDaysAhead: Number(m.event_max_days_ahead ?? 180) };
}

// facts that need the database -> extra reasons (pure given its inputs; exported for tests)
function rowFactReasons(c, { serviceArea = null, duplicate = null } = {}) {
  const reasons = [];
  const hasCoords = c.lat != null && c.lng != null && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng));
  if (!hasCoords) reasons.push({ code: 'location_unverified', severity: 'hold', humanOverridable: true });
  if (serviceArea && serviceArea.klass === 'OUTSIDE_SERVICE_AREA') reasons.push({ code: 'outside_service_area', severity: 'terminal', humanOverridable: false, detail: { reason: serviceArea.reason } });
  if (duplicate) reasons.push({ code: 'exact_duplicate', severity: 'terminal', humanOverridable: false, detail: duplicate });
  return reasons;
}

/**
 * @param idOrRow  an incoming row id (or an object with .id) - the row is ALWAYS re-read
 * @param opts.trustOverride  a named reason the source-trust gate is satisfied (e.g. 'cleaner_settlement_review');
 *                            it never touches relevance, content safety, access or granularity
 * -> { id, found, decision: ELIGIBLE|HELD|INELIGIBLE, humanApprovable, reasons[], row, source, policy }
 */
// opts.claimedFromStatus: the caller (publishIncoming) holds the row's publication claim (status 'processing')
// and evaluates it as the pending status it was claimed from - never used to bypass a real status change
async function evaluateIncomingRow(client, idOrRow, { trustOverride = null, today = israelToday(), settings = null, serviceAreaIndex, claimedFromStatus = null } = {}) {
  const id = typeof idOrRow === 'string' ? idOrRow : idOrRow && idOrRow.id;
  const { data: fresh, error } = await client.from('incoming_activities').select(ROW_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!fresh) return { id, found: false, decision: 'INELIGIBLE', humanApprovable: false, reasons: [{ code: 'row_not_found', severity: 'terminal', humanOverridable: false }] };
  const row = claimedFromStatus && fresh.status === 'processing' ? { ...fresh, status: claimedFromStatus } : fresh;
  const policy = settings || await loadPolicySettings(client);
  let source = null;
  if (row.source_id) {
    const { data: src, error: srcErr } = await client.from('sources').select('id, name, seed_url, is_trusted, source_trust_score').eq('id', row.source_id).maybeSingle();
    if (srcErr) throw srcErr;
    source = src;
  }
  const c = row.extracted_data || {};
  const core = evaluatePublishPolicy(c, { source, issues: row.validation_issues, today, minTrust: policy.minTrust, maxDaysAhead: policy.maxDaysAhead, row, trustOverride });

  let serviceArea = null;
  if (c.lat != null && c.lng != null) {
    const { classifyServiceArea } = require('./serviceArea');
    let index = serviceAreaIndex;
    if (index === undefined) { const { loadSettlementIndex } = require('./canonicalSettlement'); try { index = await loadSettlementIndex(client); } catch { index = null; } }
    serviceArea = classifyServiceArea({ lat: c.lat, lng: c.lng }, { index, reverse: c.cleaner_location?.evidence?.reverse || null, cityHint: c.city || null });
  }
  let duplicate = null;
  if (row.match_type === 'new') {
    const p = normalizeIncomingCandidate(c);
    if (p.google_place_id) {
      const { data } = await client.from('activities').select('id').eq('google_place_id', p.google_place_id).limit(1).maybeSingle();
      if (data) duplicate = { activityId: data.id, by: 'google_place_id' };
    }
    const fp = !duplicate && computeEventFingerprint({ name: p.name, venueId: p.venue_id || null, city: p.city, scheduleType: p.schedule_type, oneTimeDate: p.one_time_date, recurringDays: p.recurring_days, startTime: p.start_time });
    if (fp) {
      const { data } = await client.from('activities').select('id').eq('event_fingerprint', fp).neq('status', 'archived').limit(1).maybeSingle();
      if (data) duplicate = { activityId: data.id, by: 'event_fingerprint' };
    }
  }
  const reasons = [...core.reasons, ...rowFactReasons(c, { serviceArea, duplicate })];
  return { id, found: true, ...decide(reasons), reasons, row, source, policy: { ...policy, today, trustOverride } };
}

// reasons that block the given approval MODE at the write boundary. exact_duplicate / outside_service_area are
// not listed: the approve route's own guards turn them into their terminal writes (link as duplicate / reject
// with the geographic evidence) - they never publish either way.
function approvalBlockers(evaluation, mode) {
  const handledDownstream = new Set(['exact_duplicate', 'outside_service_area']);
  return evaluation.reasons.filter((r) => !handledDownstream.has(r.code) && (mode === 'human' ? (r.severity === 'terminal' && !r.humanOverridable) : true));
}

module.exports = { evaluateIncomingRow, loadPolicySettings, rowFactReasons, approvalBlockers, ROW_COLUMNS };
