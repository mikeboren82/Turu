// Entity-type-aware approval gate: a one-time event needs a date, a recurring event needs days, an
// evergreen place needs nothing. Mirrors the Deno tests in _shared/extraction.test.ts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { missingTemporalEvidence, repairEntityTypeFromSchedule, ISSUE_LABEL } = require('../lib/temporalEvidence');
const { handBackIncoming } = require('../cleaner/apply');

test('one-time event without a date is missing evidence; with a date or occurrences it is not', () => {
  assert.equal(missingTemporalEvidence({ entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: null }), 'one_time_without_date');
  assert.equal(missingTemporalEvidence({ entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: '2026-10-01' }), null);
  assert.equal(missingTemporalEvidence({ entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: null, occurrences: [{ date: '2026-10-01' }] }), null);
  assert.equal(missingTemporalEvidence({ entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: '31/10/2026' }), 'one_time_without_date', 'a non-ISO string is not a date');
});

test('recurring event without weekdays is missing evidence; with days it is not', () => {
  assert.equal(missingTemporalEvidence({ entity_type: 'אירוע_קבוע', schedule_type: 'recurring', recurring_days: [] }), 'recurring_without_days');
  assert.equal(missingTemporalEvidence({ entity_type: 'פעילות', schedule_type: 'recurring', recurring_days: null }), 'recurring_without_days');
  assert.equal(missingTemporalEvidence({ entity_type: 'פעילות', schedule_type: 'recurring', recurring_days: ['שני', 'רביעי'] }), null);
  assert.equal(missingTemporalEvidence({ entity_type: 'פעילות', schedule_type: null }), 'recurring_event_without_schedule', 'a workshop/class genuinely needs a real recurring cadence (commitment-policy doctrine) - unchanged');
});

test('REPERTOIRE PHASE 1 (2026-09-22): a standing programme record (אירוע_קבוע, no schedule at all) is "awaiting_schedule", not "missing" data', () => {
  assert.equal(missingTemporalEvidence({ entity_type: 'אירוע_קבוע', schedule_type: null }), 'awaiting_schedule');
  assert.equal(ISSUE_LABEL.awaiting_schedule, 'ממתין ללוח זמנים');
  // once it gains a real cadence or a date, it clears exactly like before - unaffected by this change
  assert.equal(missingTemporalEvidence({ entity_type: 'אירוע_קבוע', schedule_type: 'recurring', recurring_days: ['שבת'] }), null);
  assert.equal(missingTemporalEvidence({ entity_type: 'אירוע_קבוע', schedule_type: 'one_time', one_time_date: '2026-10-01' }), null);
});

test('an "אירוע" with a non one-time schedule is a model contradiction, never silently approvable', () => {
  assert.equal(missingTemporalEvidence({ entity_type: 'אירוע', schedule_type: 'fixed_hours' }), 'event_without_one_time_schedule');
  assert.equal(missingTemporalEvidence({ entity_type: 'אירוע', schedule_type: null }), 'event_without_one_time_schedule');
  assert.equal(repairEntityTypeFromSchedule({ entity_type: 'אירוע', schedule_type: 'recurring', recurring_days: ['שישי'] }), 'אירוע_קבוע');
  assert.equal(repairEntityTypeFromSchedule({ entity_type: 'אירוע', schedule_type: 'one_time' }), 'אירוע');
  assert.equal(repairEntityTypeFromSchedule({ entity_type: 'מקום_קבוע', schedule_type: 'recurring', recurring_days: ['שישי'] }), 'מקום_קבוע');
});

test('evergreen places and OSM/Google playgrounds stay valid without any schedule or hours', () => {
  assert.equal(missingTemporalEvidence({ entity_type: 'מקום_קבוע', schedule_type: 'fixed_hours', start_time: null, end_time: null }), null);
  assert.equal(missingTemporalEvidence({ entity_type: 'מקום_קבוע', schedule_type: null }), null);
  assert.equal(missingTemporalEvidence({ entity_type: 'מקום_קבוע', category: 'גן שעשועים' }), null);
  assert.equal(ISSUE_LABEL.recurring_without_days, 'ימי פעילות');
});

test('the Cleaner hand-back never publishes a trusted candidate that lacks its temporal evidence (policy hold, explained)', async () => {
  const client = { from: (table) => { const chain = new Proxy({}, { get(_o, k) {
    if (k === 'maybeSingle') return () => Promise.resolve({ data: table === 'sources' ? { is_trusted: true, source_trust_score: 95 } : null, error: null });
    if (k === 'then') return (res) => res({ data: [], error: null });
    return () => chain;
  } }); return chain; } };
  const settings = { thresholds: { duplicate: 0.9, needsReview: 0.6, proximityKm: 0.15 }, minTrust: 80, maxDaysAhead: 180 };
  const row = { id: 'i1', source_id: 's1', page_url: 'https://x/y', status: 'new', validation_issues: [], extracted_data: { name: 'חוג יצירה לילדים', city: 'חולון', location_name: 'מתנ״ס', lat: 32.01, lng: 34.77, entity_type: 'פעילות', schedule_type: 'recurring', recurring_days: [], audience: 'children' } };
  const r = await handBackIncoming(client, row, { settings, userId: 'u', cache: new Map(), today: '2026-09-19', counters: null });
  assert.equal(r.outcome, 'awaiting_policy'); assert.equal(r.why, 'temporal:recurring_without_days');
});
