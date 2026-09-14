// App schedule summary (lib/scheduleSummary.js, ESM loaded via require(esm)): single-row activities must
// summarize exactly as before the occurrence model; multi-occurrence events lead with the next date.
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeSchedules } = require('../../../lib/scheduleSummary.js');

const today = '2026-09-14';

test('parity: recurring / fixed_hours / single one_time rows summarize as before', () => {
  const rec = summarizeSchedules([{ schedule_type: 'recurring', day_of_week: 'שני', start_time: '16:30:00', end_time: '17:30:00' }, { schedule_type: 'recurring', day_of_week: 'רביעי', start_time: '16:30:00', end_time: '17:30:00' }], today);
  assert.deepEqual(rec.availableDays, ['ב', 'ד']); assert.deepEqual(rec.openHours, { start: '16:30', end: '17:30' }); assert.equal(rec.hours, '16:30–17:30 (שני׳, רביעי׳)');
  const fixed = summarizeSchedules([{ schedule_type: 'fixed_hours', start_time: '08:00:00', end_time: '20:00:00' }], today);
  assert.equal(fixed.availableDays.length, 7); assert.equal(fixed.hours, '08:00–20:00');
  const one = summarizeSchedules([{ schedule_type: 'one_time', one_time_date: '2026-10-12', start_time: '16:30:00', end_time: null }], today);
  assert.deepEqual(one.availableDays, ['ב']); assert.equal(one.openHours, null); assert.equal(one.hours, new Date('2026-10-12').toLocaleDateString('he-IL'));
  assert.equal(one.nextDate, '2026-10-12'); assert.equal(one.occurrences.length, 1);
  // a single past row (cron has not archived it yet) still summarizes as before
  const past = summarizeSchedules([{ schedule_type: 'one_time', one_time_date: '2026-09-01', start_time: null, end_time: null }], today);
  assert.equal(past.hours, new Date('2026-09-01').toLocaleDateString('he-IL'));
  assert.deepEqual(summarizeSchedules([], today), { availableDays: [], openHours: null, hours: 'שעות לא צוינו', occurrences: [], nextDate: null });
});

test('multi-occurrence: only upcoming rows count, next one leads, count shown, past ones ignored', () => {
  const rows = [
    { schedule_type: 'one_time', one_time_date: '2026-09-01', start_time: '16:30:00', end_time: '17:15:00' }, // past (Tuesday)
    { schedule_type: 'one_time', one_time_date: '2026-12-21', start_time: '17:30:00', end_time: '18:15:00' },
    { schedule_type: 'one_time', one_time_date: '2026-10-12', start_time: '16:30:00', end_time: '17:15:00' },
    { schedule_type: 'one_time', one_time_date: '2026-10-12', start_time: '17:30:00', end_time: '18:15:00' },
  ];
  const s = summarizeSchedules(rows, today);
  assert.equal(s.nextDate, '2026-10-12');
  assert.deepEqual(s.occurrences.map((o) => `${o.date} ${o.start}`), ['2026-10-12 16:30', '2026-10-12 17:30', '2026-12-21 17:30']);
  assert.deepEqual(s.availableDays, ['ב']); // 12.10 and 21.12 are both Mondays; the past Tuesday is gone
  assert.deepEqual(s.openHours, { start: '16:30', end: '17:15' }); // the NEXT performance's hours, not a min/max over all
  assert.equal(s.hours, '16:30–17:15 (+2 מועדים)');
});
