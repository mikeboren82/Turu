// Lifecycle proof with a stub client: max attempts => case archived with a reason AND the blocking
// incoming row rejected with the same code; non-blocking activity issues archive only the case;
// reopen() re-queues an archived case (and its row) when the location label now resolves to a venue.
const test = require('node:test');
const assert = require('node:assert/strict');
const { markAttemptFailed, archiveCase, reopenWhereEvidenceChanged, settingsFrom } = require('../cleaner/lifecycle');

// minimal chainable stub of the supabase-js query builder recording updates per table
function stubClient({ selects = {}, venueResolves = false } = {}) {
  const updates = [];
  const table = (name) => {
    const chain = { _table: name, _op: null, _payload: null, _filters: [] };
    const self = new Proxy(chain, { get(t, k) {
      if (k === 'update') return (payload) => { t._op = 'update'; t._payload = payload; return self; };
      if (k === 'select') return () => { t._op = t._op || 'select'; return self; };
      if (k === 'then') return (res) => { if (t._op === 'update') updates.push({ table: name, payload: t._payload, filters: t._filters }); const data = t._op === 'select' ? (selects[name] || null) : null; return res({ data, error: null }); };
      if (k === 'maybeSingle') return () => Promise.resolve({ data: (selects[name] || [])[0] || null, error: null });
      return (...args) => { t._filters.push([k, ...args]); return self; };
    } });
    return self;
  };
  return { from: table, updates };
}

const settings = settingsFrom([{ key: 'cleaner_max_attempts', value: 2 }, { key: 'cleaner_backoff_hours', value: [1, 2] }]);

test('failure below max attempts => retry with backoff; at max => archived case + rejected incoming row with the reason code', async () => {
  const c = { id: 'case1', subject_kind: 'incoming', subject_id: 'inc1', issue: 'missing_location', attempts: 0, methods_tried: [], resolution: null };
  const client = stubClient();
  const r1 = await markAttemptFailed(client, c, { method: ['existing', 'source_page'], error: 'no evidence', settings });
  assert.equal(r1.outcome, 'retry');
  const u1 = client.updates.find((u) => u.table === 'cleaner_cases');
  assert.equal(u1.payload.attempts, 1); assert.deepEqual(u1.payload.methods_tried, ['existing', 'source_page']); assert.ok(u1.payload.next_attempt_at > new Date().toISOString());
  const client2 = stubClient();
  const r2 = await markAttemptFailed(client2, { ...c, attempts: 1, methods_tried: ['existing', 'source_page'] }, { method: 'place_lookup', error: 'no evidence', settings });
  assert.equal(r2.outcome, 'archived'); assert.equal(r2.reason, 'missing_address_unresolved');
  const caseUpd = client2.updates.find((u) => u.table === 'cleaner_cases'); assert.equal(caseUpd.payload.status, 'archived'); assert.equal(caseUpd.payload.archive_reason, 'missing_address_unresolved');
  const rowUpd = client2.updates.find((u) => u.table === 'incoming_activities'); assert.equal(rowUpd.payload.status, 'rejected'); assert.equal(rowUpd.payload.archive_reason, 'missing_address_unresolved'); assert.ok(rowUpd.payload.reject_reason.includes('THE CLEANER'));
});

test('ambiguous evidence archives as ambiguous_location; a non-blocking live-activity issue archives only the case', async () => {
  const client = stubClient();
  const r = await markAttemptFailed(client, { id: 'c', subject_kind: 'incoming', subject_id: 'i', issue: 'missing_location', attempts: 1, methods_tried: [] }, { method: 'place_lookup', error: 'ambiguous', settings, evidence: { ambiguous: true } });
  assert.equal(r.reason, 'ambiguous_location');
  const client3 = stubClient();
  const r3 = await archiveCase(client3, { id: 'c2', subject_kind: 'activity', subject_id: 'a1', issue: 'missing_image', attempts: 2, methods_tried: ['page'] }, { reason: 'image_unavailable_only' });
  assert.equal(r3.outcome, 'archived');
  assert.ok(!client3.updates.some((u) => u.table === 'activities' || u.table === 'incoming_activities'), 'the published activity must stay published');
});

test('reopen: an archived missing-address case is re-queued when its label now resolves to a venue', async () => {
  const Module = require('module');
  const venueNaming = require('../venueNaming');
  const orig = venueNaming.resolveVenue;
  venueNaming.resolveVenue = async () => ({ id: 'v1', name_he: 'מדיטק חולון' });
  try {
    const client = stubClient({ selects: {
      cleaner_cases: [{ id: 'c9', subject_kind: 'incoming', subject_id: 'i9', issue: 'missing_location', archive_reason: 'missing_address_unresolved', reopened_count: 0 }],
      incoming_activities: [{ status: 'rejected', location_name: 'מדיטק', city: 'חולון', name: 'הצגה', schedule_type: 'one_time', one_time_date: '2099-01-01' }],
    } });
    // lifecycle requires resolveVenue from the module object at call time
    const lifecycle = require('../cleaner/lifecycle');
    const r = await lifecycle.reopenWhereEvidenceChanged(client);
    assert.equal(r.reopened, 1);
    const caseUpd = client.updates.find((u) => u.table === 'cleaner_cases'); assert.equal(caseUpd.payload.status, 'open'); assert.equal(caseUpd.payload.attempts, 0); assert.equal(caseUpd.payload.reopened_count, 1);
    const rowUpd = client.updates.find((u) => u.table === 'incoming_activities'); assert.equal(rowUpd.payload.status, 'needs_review'); assert.equal(rowUpd.payload.archive_reason, null);
  } finally { venueNaming.resolveVenue = orig; }
});
