// Occurrence persistence planning (lib/occurrences.js): insert only missing future (date,time) rows,
// never rewrite "the" date, recurring rows are deleted only on an explicit conversion and only after
// the caller verified the inserted set; fingerprints are never part of the plan.
const test = require('node:test');
const assert = require('node:assert/strict');
const { planScheduleChange, occurrencesPersisted, nextOccurrence } = require('../lib/occurrences');

const today = '2026-09-14';
const existing = [
  { id: 'r1', schedule_type: 'one_time', one_time_date: '2026-10-12', start_time: '16:30:00', end_time: null },
  { id: 'r2', schedule_type: 'one_time', one_time_date: '2026-10-12', start_time: '17:30:00', end_time: null },
];

test('insert-missing: present (date,time) skipped, past skipped, a new time on a known date is a new occurrence', () => {
  const plan = planScheduleChange(existing, [
    { date: '2026-10-12', start_time: '16:30' },                 // present
    { date: '2026-09-01', start_time: '16:30' },                 // past
    { date: '2026-10-12', start_time: '18:30' },                 // new time, same date
    { date: '2026-12-21', start_time: '16:30', external_id: '31437', booking_url: 'https://t/x?id=31437' },
    { date: '2026-12-21', start_time: '16:30' },                 // duplicate in the candidate list
  ], today);
  assert.deepEqual(plan.skipped, { past: 1, present: 1 });
  assert.deepEqual(plan.insert.map((r) => `${r.one_time_date} ${r.start_time}`), ['2026-10-12 18:30', '2026-12-21 16:30']);
  assert.equal(plan.insert[1].external_id, '31437');
  assert.equal(plan.insert[1].booking_url, 'https://t/x?id=31437');
  assert.deepEqual(plan.deleteRecurring, []);
});

test('recurring rows are listed for deletion only when converting; time-less occurrences keep null time', () => {
  const rows = [{ id: 'w1', schedule_type: 'recurring', day_of_week: 'שני', start_time: '16:30:00' }];
  const occ = [{ date: '2026-10-12', start_time: '16:30' }, { date: '2026-12-21' }];
  assert.deepEqual(planScheduleChange(rows, occ, today).deleteRecurring, []);
  const plan = planScheduleChange(rows, occ, today, { convertRecurring: true });
  assert.deepEqual(plan.deleteRecurring, ['w1']);
  assert.equal(plan.insert[1].start_time, null);
});

test('occurrencesPersisted: verification requires every expected (date,time) to be present', () => {
  const expected = [{ date: '2026-10-12', start_time: '16:30' }, { date: '2026-12-21', start_time: '16:30' }];
  assert.equal(occurrencesPersisted(existing, expected), false);
  assert.equal(occurrencesPersisted([...existing, { schedule_type: 'one_time', one_time_date: '2026-12-21', start_time: '16:30:00' }], expected), true);
});

test('nextOccurrence: earliest upcoming, falling back to the earliest at all', () => {
  assert.equal(nextOccurrence(existing, '2026-10-12').start_time, '16:30');
  assert.equal(nextOccurrence(existing, '2027-01-01').date, '2026-10-12');
  assert.equal(nextOccurrence([{ schedule_type: 'recurring', day_of_week: 'שני' }], today), null);
});
