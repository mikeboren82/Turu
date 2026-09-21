// lib/hoursResolver.js - the unified resolver. These tests exercise resolveHoursForDate/
// getOpenStatus directly (not through getOpenNowInfo), and separately re-run every scenario
// lib/filterActivities.js's existing "day-specific hours" test cases cover, to prove getOpenStatus
// is a safe delegate BEFORE getOpenNowInfo is switched to use it (task section 9/10).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const babel = require('@babel/core');
const { addHook } = require('pirates');

const ROOT = path.resolve(__dirname, '..');
addHook(
  (code, filename) => babel.transformSync(code, { filename, babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'] }).code,
  { exts: ['.js'], matcher: (f) => f.startsWith(path.join(ROOT, 'lib')) || f.startsWith(path.join(ROOT, 'constants')) },
);

const { resolveHoursForDate, getOpenStatus } = require('../lib/hoursResolver.js');
const { jerusalemInstant: jerusalem } = require('./support/jerusalemInstant.js');

// ---- resolveHoursForDate: general per-date resolution --------------------------------------

test('recurring activity: a weekday with specific hours resolves as weekly/open', () => {
  const activity = { hoursByDay: { ב: { start: '09:00', end: '12:00' }, ד: { start: '09:00', end: '12:00' } }, openHours: { start: '09:00', end: '12:00' } };
  const day = resolveHoursForDate(activity, '2026-06-15'); // a Monday ('ב')
  assert.equal(day.weekdayLetter, 'ב');
  assert.equal(day.kind, 'weekly');
  assert.equal(day.state, 'open');
  assert.deepEqual(day.intervals, [{ start: '09:00', end: '12:00' }]);
  assert.equal(day.source, 'weekly');
});

test('display strictness: hoursByDay has OTHER days but not this one -> unknown, envelope NOT used', () => {
  // Sunday+Monday hours known, Tuesday unknown - openHours envelope must not stand in for Tuesday.
  const activity = {
    hoursByDay: { א: { start: '09:00', end: '12:00' }, ב: { start: '15:00', end: '20:00' } },
    openHours: { start: '09:00', end: '20:00' },
  };
  const day = resolveHoursForDate(activity, '2026-06-16', { strictness: 'display' }); // a Tuesday ('ג')
  assert.equal(day.weekdayLetter, 'ג');
  assert.equal(day.state, 'unknown');
  assert.deepEqual(day.intervals, []);
});

test('search strictness: the SAME missing-Tuesday case falls back to the envelope (permissive)', () => {
  const activity = {
    hoursByDay: { א: { start: '09:00', end: '12:00' }, ב: { start: '15:00', end: '20:00' } },
    openHours: { start: '09:00', end: '20:00' },
  };
  const day = resolveHoursForDate(activity, '2026-06-16', { strictness: 'search' });
  assert.equal(day.state, 'open');
  assert.deepEqual(day.intervals, [{ start: '09:00', end: '20:00' }]);
  assert.equal(day.source, 'envelope');
  assert.equal(day.confidence, 'uncertain');
});

test('no per-day breakdown at all (fixed_hours with only an envelope) falls back in BOTH strictness modes', () => {
  const activity = { hoursByDay: {}, openHours: { start: '08:00', end: '20:00' } };
  for (const strictness of ['display', 'search']) {
    const day = resolveHoursForDate(activity, '2026-06-16', { strictness });
    assert.deepEqual(day.intervals, [{ start: '08:00', end: '20:00' }], `strictness=${strictness}`);
    assert.equal(day.kind, 'unknown'); // no hoursByDay entries at all -> kind can't be classified as weekly/fixed
  }
});

test('fixed_hours activity (identical hours on all 7 days) classifies as kind:fixed', () => {
  const same = { start: '08:00', end: '20:00' };
  const activity = { hoursByDay: { א: same, ב: same, ג: same, ד: same, ה: same, ו: same, ש: same }, openHours: same };
  const day = resolveHoursForDate(activity, '2026-06-15');
  assert.equal(day.kind, 'fixed');
});

test('recurring activity with genuinely different hours per day classifies as kind:weekly', () => {
  const activity = {
    hoursByDay: { א: { start: '09:00', end: '12:00' }, ב: { start: '15:00', end: '20:00' } },
    openHours: { start: '09:00', end: '20:00' },
  };
  const day = resolveHoursForDate(activity, '2026-06-15');
  assert.equal(day.kind, 'weekly');
});

test('dated event: a performance today resolves as occurrence/open with that performance\'s own hours', () => {
  const activity = { occurrences: [{ date: '2026-06-15', start: '17:00', end: '18:00' }], openHours: { start: '17:00', end: '18:00' } };
  const day = resolveHoursForDate(activity, '2026-06-15');
  assert.equal(day.kind, 'occurrence');
  assert.equal(day.state, 'open');
  assert.deepEqual(day.intervals, [{ start: '17:00', end: '18:00' }]);
});

test('dated event: no performance on this date -> closed, not unknown, never falls back to another performance\'s hours', () => {
  const activity = { occurrences: [{ date: '2026-07-01', start: '17:00', end: '18:00' }], openHours: { start: '17:00', end: '18:00' } };
  const day = resolveHoursForDate(activity, '2026-06-15');
  assert.equal(day.state, 'closed');
  assert.deepEqual(day.intervals, []);
});

test('dated event: a performance today with an unknown time is never guessed open', () => {
  const activity = { occurrences: [{ date: '2026-06-15', start: null, end: null }], openHours: null };
  const day = resolveHoursForDate(activity, '2026-06-15');
  assert.equal(day.state, 'unknown');
  assert.deepEqual(day.intervals, []);
});

test('24-hour interval resolves as state:always_open', () => {
  const activity = { hoursByDay: { ב: { start: '00:00', end: '23:59' } }, openHours: { start: '00:00', end: '23:59' } };
  const day = resolveHoursForDate(activity, '2026-06-15');
  assert.equal(day.state, 'always_open');
});

test('holiday calendar fact and warning are attached independent of hours data', () => {
  const noHours = { hoursByDay: {}, openHours: null };
  const day = resolveHoursForDate(noHours, '2026-09-20'); // Erev Yom Kippur (see tests/holidayCivilDate.test.js for the independently-verified civil date)
  assert.equal(day.calendar.holidays.length, 1);
  assert.ok(day.warning);
  assert.equal(day.warning.nameHe, 'ערב יום כיפור');
});

test('useIntervalsByDay is opt-in: off by default even when intervalsByDay has richer data', () => {
  const activity = {
    hoursByDay: { ב: { start: '16:00', end: '20:00' } }, // "last row wins" - only the 2nd interval
    intervalsByDay: { ב: [{ start: '09:00', end: '12:00' }, { start: '16:00', end: '20:00' }] },
    openHours: { start: '09:00', end: '20:00' },
  };
  const defaultDay = resolveHoursForDate(activity, '2026-06-15');
  assert.deepEqual(defaultDay.intervals, [{ start: '16:00', end: '20:00' }]); // same as hoursByDay-only
  const optedIn = resolveHoursForDate(activity, '2026-06-15', { useIntervalsByDay: true });
  assert.deepEqual(optedIn.intervals, [{ start: '09:00', end: '12:00' }, { start: '16:00', end: '20:00' }]);
});

// ---- getOpenStatus: parity with the pre-existing lib/filterActivities.js#getOpenNowInfo -----
// Every case below is a direct restatement of a scenario lib/filterActivities.js's OWN test
// suite (tests/temporalFiltering.test.js "day-specific hours 1-7") already covers, run here
// against the NEW function to demonstrate identical behavior before the switch (task section 9).

test('day-specific hours 1: Sunday 09-12 vs Monday 09-20 - Sunday 15:00 must be CLOSED', () => {
  const activity = {
    hoursByDay: { א: { start: '09:00', end: '12:00' }, ב: { start: '09:00', end: '20:00' } },
    openHours: { start: '09:00', end: '20:00' },
    availableDays: ['א', 'ב'],
  };
  const sunday3pm = jerusalem('2026-06-14', '15:00'); // 2026-06-14 is a Sunday
  const status = getOpenStatus(activity, { now: sunday3pm });
  assert.equal(status.isOpen, false);
  assert.equal(status.hasScheduleData, true);
});

test('day-specific hours 2: currently inside today\'s own range -> open', () => {
  const activity = { hoursByDay: { א: { start: '09:00', end: '12:00' } }, openHours: { start: '09:00', end: '12:00' }, availableDays: ['א'] };
  const status = getOpenStatus(activity, { now: jerusalem('2026-06-14', '10:00') });
  assert.equal(status.isOpen, true);
  assert.equal(status.minutesUntilClose, 120);
});

test('day-specific hours 3: outside today\'s own range (before opening) -> closed, with opens-in estimate', () => {
  const activity = { hoursByDay: { א: { start: '09:00', end: '12:00' } }, openHours: { start: '09:00', end: '12:00' }, availableDays: ['א'] };
  const status = getOpenStatus(activity, { now: jerusalem('2026-06-14', '08:00') });
  assert.equal(status.isOpen, false);
  assert.equal(status.minutesUntilOpenToday, 60);
});

test('day-specific hours 4: another weekday\'s later closing time must not leak into today\'s comparison', () => {
  const activity = {
    hoursByDay: { א: { start: '09:00', end: '12:00' }, ב: { start: '09:00', end: '22:00' } },
    openHours: { start: '09:00', end: '22:00' },
    availableDays: ['א', 'ב'],
  };
  const status = getOpenStatus(activity, { now: jerusalem('2026-06-14', '13:00') }); // Sunday 13:00 - after Sunday's own 12:00 close
  assert.equal(status.isOpen, false);
  assert.equal(status.minutesUntilClose, null);
});

test('day-specific hours 5: recurring venue open Monday, no Sunday entry - queried Sunday must NOT borrow Monday\'s hours', () => {
  const activity = { hoursByDay: { ב: { start: '09:00', end: '20:00' } }, openHours: { start: '09:00', end: '20:00' }, availableDays: ['ב'] };
  const status = getOpenStatus(activity, { now: jerusalem('2026-06-14', '15:00') }); // Sunday
  assert.equal(status.isOpen, false);
  assert.equal(status.hasScheduleData, true); // openHours exists, just not usable for today
});

// UPDATED BY OPENING HOURS PHASE 3 (2026-09-20) - these two used to pin the legacy gaps
// ("intervalsByDay is invisible to getOpenStatus", '"00:00" end is not end-of-day'). Both are
// fixed now, so they assert the corrected behavior; the superseded assertion is noted inline.
test('day-specific hours 6 (CORRECTED by Phase 3): getOpenStatus now reads intervalsByDay, so a second same-day slot is no longer discarded', () => {
  const activity = {
    hoursByDay: { ב: { start: '16:00', end: '20:00' } }, // "last one wins"
    intervalsByDay: { ב: [{ start: '09:00', end: '12:00' }, { start: '16:00', end: '20:00' }] },
    openHours: { start: '09:00', end: '20:00' },
    availableDays: ['ב'],
  };
  // was: isOpen false (the 09-12 interval was invisible to getOpenStatus)
  assert.equal(getOpenStatus(activity, { now: jerusalem('2026-06-15', '10:00') }).isOpen, true);
  assert.equal(getOpenStatus(activity, { now: jerusalem('2026-06-15', '14:00') }).isOpen, false, 'the genuine lunch gap is still closed');
  assert.equal(getOpenStatus(activity, { now: jerusalem('2026-06-15', '17:00') }).isOpen, true);
});

test('day-specific hours 7 (CORRECTED by Phase 3): an "end":"00:00" interval means open until midnight', () => {
  const activity = { hoursByDay: { ב: { start: '20:00', end: '00:00' } }, openHours: { start: '20:00', end: '00:00' }, availableDays: ['ב'] };
  const status = getOpenStatus(activity, { now: jerusalem('2026-06-15', '21:00') }); // Monday 21:00
  // was: isOpen false, because toMinutes('00:00') === 0 and 1260 <= 0 is false. The end-of-day
  // correction (toEndOfDayAwareMinutes, long used by the hour-range SEARCH filter) now applies to
  // the live open-now path too, via intervalBounds.
  assert.equal(status.isOpen, true);
  assert.equal(status.minutesUntilClose, 180);
});

test('no schedule data at all -> unknown, never guessed open', () => {
  const activity = { hoursByDay: {}, openHours: null, availableDays: [] };
  const status = getOpenStatus(activity, { now: jerusalem('2026-06-15', '10:00') });
  assert.equal(status.isOpen, false);
  assert.equal(status.hasScheduleData, false);
});

test('a dated one-off occurrence (no hoursByDay at all) uses its own occurrence hours for today', () => {
  const activity = { occurrences: [{ date: '2026-06-15', start: '17:00', end: '18:00' }], openHours: { start: '17:00', end: '18:00' }, hoursByDay: {}, availableDays: [] };
  const openNow = getOpenStatus(activity, { now: jerusalem('2026-06-15', '17:30') });
  assert.equal(openNow.isOpen, true);
  const notToday = getOpenStatus({ ...activity, occurrences: [{ date: '2026-07-01', start: '17:00', end: '18:00' }], openHours: { start: '17:00', end: '18:00' } }, { now: jerusalem('2026-06-15', '17:30') });
  assert.equal(notToday.isOpen, false);
});
