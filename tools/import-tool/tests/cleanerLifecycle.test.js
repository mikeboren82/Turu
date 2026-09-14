// Lifecycle proof with a stub client: an attempt is information gain (untried stages remain =>
// retry with the next strategy, never archive); terminal archive only after every stage was tried
// or recorded unavailable AND attempts >= max, with a structured explanation; a blocking incoming
// row is rejected with the same code; non-blocking activity issues archive only the case; every
// terminal/retry write releases the lease; reopen() re-queues an archived case (and its row) when
// the location label now resolves to a venue.
const test = require('node:test');
const assert = require('node:assert/strict');
const { markAttemptFailed, archiveCase, reopenWhereEvidenceChanged, settingsFrom, stagesForAttempt, remainingStages, EVIDENCE_STAGES } = require('../cleaner/lifecycle');

// minimal chainable stub of the supabase-js query builder recording updates per table
function stubClient({ selects = {} } = {}) {
  const updates = [];
  const table = (name) => {
    const chain = { _table: name, _op: null, _payload: null, _filters: [] };
    const self = new Proxy(chain, { get(t, k) {
      if (k === 'update') return (payload) => { t._op = 'update'; t._payload = payload; return self; };
      if (k === 'select') return () => { t._op = t._op || 'select'; return self; };
      if (k === 'then') return (res) => { if (t._op === 'update') updates.push({ table: name, payload: t._payload, filters: t._filters }); const data = t._op === 'select' ? (selects[name] || null) : (t._op === 'update' ? [{ id: 'x' }] : null); return res({ data, error: null }); };
      if (k === 'maybeSingle') return () => Promise.resolve({ data: (selects[name] || [])[0] || null, error: null });
      return (...args) => { t._filters.push([k, ...args]); return self; };
    } });
    return self;
  };
  return { from: table, updates };
}
module.exports = { stubClient };

const settings = settingsFrom([{ key: 'cleaner_max_attempts', value: 2 }, { key: 'cleaner_backoff_hours', value: [1, 2] }]);
const released = (u) => u.payload.claimed_by === null && u.payload.lease_until === null;

test('attempt plan: existing first, then only never-tried evidence stages', () => {
  assert.deepEqual(stagesForAttempt({ methods_tried: [] }), ['existing', ...EVIDENCE_STAGES]);
  assert.deepEqual(stagesForAttempt({ methods_tried: ['existing', 'source_page', 'detail_page'] }), ['existing', 'venue_site', 'place_lookup', 'place_lookup_inferred']);
  const c = { issue: 'missing_location', methods_tried: ['existing', 'source_page'], resolution: { unavailable: [{ stage: 'place_lookup', why: 'no city' }] } };
  assert.deepEqual(remainingStages(c), ['detail_page', 'venue_site', 'place_lookup_inferred']);
});

test('untried available stages remain => retry with the next strategy even at max attempts (no false exhaustion)', async () => {
  const c = { id: 'case1', subject_kind: 'incoming', subject_id: 'inc1', issue: 'missing_location', attempts: 1, methods_tried: ['existing', 'source_page'], resolution: null };
  const client = stubClient();
  const r = await markAttemptFailed(client, c, { method: ['existing'], skipped: [{ stage: 'venue_site', why: 'no canonical venue for this label yet' }], error: 'no evidence', settings });
  assert.equal(r.outcome, 'retry');
  assert.deepEqual(r.remaining, ['detail_page', 'place_lookup', 'place_lookup_inferred']);
  const u = client.updates.find((x) => x.table === 'cleaner_cases');
  assert.equal(u.payload.attempts, 2); assert.equal(u.payload.resolution.next_strategy, 'detail_page'); assert.ok(u.payload.next_attempt_at > new Date().toISOString());
  assert.deepEqual(u.payload.resolution.unavailable, [{ stage: 'venue_site', why: 'no canonical venue for this label yet' }]);
  assert.ok(released(u), 'retry releases the lease');
  assert.ok(!client.updates.some((x) => x.table === 'incoming_activities'), 'the row stays open');
});

test('exhausted (every stage tried or unavailable) + attempts >= max => archived with a structured explanation; blocking incoming row rejected', async () => {
  const c = { id: 'case1', subject_kind: 'incoming', subject_id: 'inc1', issue: 'missing_location', attempts: 1, methods_tried: ['existing', 'source_page', 'detail_page'], resolution: { unavailable: [{ stage: 'venue_site', why: 'no canonical venue for this label yet' }] } };
  const client = stubClient();
  const r = await markAttemptFailed(client, c, { method: ['existing', 'place_lookup_inferred'], skipped: [{ stage: 'place_lookup', why: 'no city (place lookup needs label + city)' }], error: 'no evidence', settings });
  assert.equal(r.outcome, 'archived'); assert.equal(r.reason, 'missing_address_unresolved');
  const ex = r.explanation;
  assert.equal(ex.missing, 'verified location (city + place + coordinates)');
  assert.deepEqual(ex.methods_tried, ['existing', 'source_page', 'detail_page', 'place_lookup_inferred']);
  assert.deepEqual(ex.methods_unavailable.map((x) => x.stage).sort(), ['place_lookup', 'venue_site']);
  assert.ok(ex.external_limit.includes('google_places'), 'external limitation recorded');
  assert.ok(ex.reopen_when.length >= 2);
  const caseUpd = client.updates.find((u) => u.table === 'cleaner_cases'); assert.equal(caseUpd.payload.status, 'archived'); assert.equal(caseUpd.payload.resolution.explanation.why_insufficient, 'no evidence');
  assert.ok(released(caseUpd), 'archive releases the lease');
  const rowUpd = client.updates.find((u) => u.table === 'incoming_activities'); assert.equal(rowUpd.payload.status, 'rejected'); assert.equal(rowUpd.payload.archive_reason, 'missing_address_unresolved'); assert.ok(rowUpd.payload.reject_reason.includes('THE CLEANER'));
  assert.ok(rowUpd.filters.some((f) => f[0] === 'in' && f[1] === 'status'), 'only an open row is rejected (admin decision meanwhile wins)');
});

test('exhausted below max attempts => retry that only re-checks existing (awaiting new canonical evidence)', async () => {
  const c = { id: 'c', subject_kind: 'incoming', subject_id: 'i', issue: 'missing_location', attempts: 0, methods_tried: [], resolution: null };
  const client = stubClient();
  const skipped = EVIDENCE_STAGES.map((stage) => ({ stage, why: 'n/a' }));
  const r = await markAttemptFailed(client, c, { method: ['existing'], skipped, error: 'no evidence', settings });
  assert.equal(r.outcome, 'retry'); assert.deepEqual(r.remaining, []);
  assert.equal(client.updates[0].payload.resolution.next_strategy, 'existing (await new canonical evidence)');
});

test('ambiguous evidence archives as ambiguous_location; a non-blocking live-activity issue archives only the case', async () => {
  const client = stubClient();
  const r = await markAttemptFailed(client, { id: 'c', subject_kind: 'incoming', subject_id: 'i', issue: 'missing_location', attempts: 1, methods_tried: [...EVIDENCE_STAGES, 'existing'] }, { method: 'place_lookup', error: 'ambiguous', settings, evidence: { ambiguous: true } });
  assert.equal(r.reason, 'ambiguous_location');
  assert.ok(r.explanation.why_insufficient.includes('several places'));
  const multi = await markAttemptFailed(stubClient(), { id: 'c', subject_kind: 'incoming', subject_id: 'i', issue: 'missing_location', attempts: 1, methods_tried: [...EVIDENCE_STAGES, 'existing'] }, { method: 'source_page', error: 'only LOW', settings, evidence: { ambiguous: true, low: { method: 'source_page', evidence: { multi_venue: true, venues: ['חולון', 'רמלה', 'טבריה', 'עפולה'] } } } });
  assert.equal(multi.reason, 'ambiguous_location');
  assert.ok(multi.explanation.why_insufficient.includes('touring show'), multi.explanation.why_insufficient);
  const client3 = stubClient();
  const r3 = await archiveCase(client3, { id: 'c2', subject_kind: 'activity', subject_id: 'a1', issue: 'missing_image', attempts: 2, methods_tried: ['page'] }, { reason: 'image_unavailable_only', evidence: { rejected: [{ url: 'x', reason: 'too_small_px' }] } });
  assert.equal(r3.outcome, 'archived');
  assert.ok(r3.explanation.why_insufficient.includes('too_small_px'));
  assert.equal(r3.explanation.external_limit, null);
  assert.ok(!client3.updates.some((u) => u.table === 'activities' || u.table === 'incoming_activities'), 'the published activity must stay published');
});

test('reopen: an archived missing-address case is re-queued when its label now resolves to a venue', async () => {
  const venueNaming = require('../venueNaming');
  const orig = venueNaming.resolveVenue;
  venueNaming.resolveVenue = async () => ({ id: 'v1', name_he: 'מדיטק חולון' });
  try {
    const client = stubClient({ selects: {
      cleaner_cases: [{ id: 'c9', subject_kind: 'incoming', subject_id: 'i9', issue: 'missing_location', archive_reason: 'missing_address_unresolved', reopened_count: 0 }],
      incoming_activities: [{ status: 'rejected', location_name: 'מדיטק', city: 'חולון', name: 'הצגה', schedule_type: 'one_time', one_time_date: '2099-01-01' }],
    } });
    const lifecycle = require('../cleaner/lifecycle');
    const r = await lifecycle.reopenWhereEvidenceChanged(client);
    assert.equal(r.reopened, 1);
    const caseUpd = client.updates.find((u) => u.table === 'cleaner_cases'); assert.equal(caseUpd.payload.status, 'open'); assert.equal(caseUpd.payload.attempts, 0); assert.equal(caseUpd.payload.reopened_count, 1); assert.ok(released(caseUpd));
    const rowUpd = client.updates.find((u) => u.table === 'incoming_activities'); assert.equal(rowUpd.payload.status, 'needs_review'); assert.equal(rowUpd.payload.archive_reason, null);
  } finally { venueNaming.resolveVenue = orig; }
});
