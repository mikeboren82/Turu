// lib/hoursDisplay.js - pure data preparation behind components/WeeklyHoursSection.js. No
// react-native/i18n dependency in the module under test, but the require-hook is still needed
// because it (transitively, via lib/hoursResolver.js -> lib/hoursPolicy.js -> lib/jewishCalendar.js)
// imports constants/holidays.generated.json with ES `import` syntax - see tests/jewishCalendar.test.js.
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

const { buildUpcomingDays, buildTodayStatus } = require('../lib/hoursDisplay.js');

// Fixed reference instants - all device-local time is irrelevant here (hoursDisplay anchors to
// Jerusalem-calendar dates), but Date's own constructor still needs an explicit time to avoid
// ambiguity, so every "now" below is written as a full local Date, not just a date string.
const WEDNESDAY_10AM = new Date('2026-06-17T10:00:00'); // ordinary weekday, no holiday fact at all
const FRIDAY_10AM = new Date('2026-06-19T10:00:00');
const SATURDAY_10AM = new Date('2026-06-20T10:00:00');
const THURSDAY_NOON = new Date('2026-06-18T12:00:00'); // week-boundary-crossing anchor
// Yom Kippur 2026 civil dates (independently verified against hebcal.com: "Sun, 20 September
// sunset - Mon, 21 September nightfall" - see tests/holidayCivilDate.test.js for the full
// cross-check that caught and fixed the 2026-09-20 off-by-one holiday-date bug).
const EREV_YOM_KIPPUR_10AM = new Date('2026-09-20T10:00:00'); // Sunday, holiday eve
const YOM_KIPPUR_10AM = new Date('2026-09-21T10:00:00'); // Monday, yom tov
const ROSH_CHODESH_10AM = new Date('2026-06-15T10:00:00'); // Monday, non-warning minor calendar date

test('ordinary weekday: open during hours, todayHolidays empty, no warning', () => {
  const activity = { hoursByDay: { ד: { start: '09:00', end: '18:00' } }, openHours: { start: '09:00', end: '18:00' } };
  const status = buildTodayStatus(activity, { now: WEDNESDAY_10AM });
  assert.equal(status.isOpen, true);
  assert.equal(status.minutesUntilClose, 480);
  assert.equal(status.closesAt, '18:00');
  assert.deepEqual(status.todayHolidays, []);
  assert.equal(status.todayWarning, null);
});

test('Friday: resolves using Friday\'s own hours, independent of other days', () => {
  const activity = {
    hoursByDay: { ו: { start: '08:00', end: '14:00' }, ש: { start: '20:00', end: '23:00' } },
    openHours: { start: '08:00', end: '23:00' },
  };
  const status = buildTodayStatus(activity, { now: FRIDAY_10AM });
  assert.equal(status.isOpen, true);
  assert.equal(status.minutesUntilClose, 240); // 14:00 - 10:00
});

test('Saturday: resolves using Saturday\'s own hours', () => {
  const activity = {
    hoursByDay: { ו: { start: '08:00', end: '14:00' }, ש: { start: '20:00', end: '23:00' } },
    openHours: { start: '08:00', end: '23:00' },
  };
  const status = buildTodayStatus(activity, { now: SATURDAY_10AM }); // 10:00, before Saturday's 20:00 open
  assert.equal(status.isOpen, false);
  assert.equal(status.opensAt, '20:00');
  assert.equal(status.minutesUntilOpen, 600);
});

test('next 7 dates cross a week boundary (Thursday start -> following Wednesday)', () => {
  const activity = { hoursByDay: {}, openHours: null };
  const days = buildUpcomingDays(activity, { now: THURSDAY_NOON });
  assert.equal(days.length, 7);
  assert.deepEqual(days.map((d) => d.date), [
    '2026-06-18', '2026-06-19', '2026-06-20', '2026-06-21', '2026-06-22', '2026-06-23', '2026-06-24',
  ]);
  assert.deepEqual(days.map((d) => d.weekdayLetter), ['ה', 'ו', 'ש', 'א', 'ב', 'ג', 'ד']);
});

test('today + tomorrow flags are set exactly on offsets 0 and 1', () => {
  const activity = { hoursByDay: {}, openHours: null };
  const days = buildUpcomingDays(activity, { now: WEDNESDAY_10AM });
  assert.equal(days[0].isToday, true); assert.equal(days[0].isTomorrow, false);
  assert.equal(days[1].isToday, false); assert.equal(days[1].isTomorrow, true);
  for (let i = 2; i < days.length; i++) { assert.equal(days[i].isToday, false); assert.equal(days[i].isTomorrow, false); }
});

test('holiday eve: calendar fact + warning are attached to today\'s row', () => {
  const activity = { hoursByDay: { א: { start: '09:00', end: '14:00' } }, openHours: { start: '09:00', end: '14:00' } };
  const status = buildTodayStatus(activity, { now: EREV_YOM_KIPPUR_10AM });
  assert.equal(status.todayHolidays.length, 1);
  assert.equal(status.todayHolidays[0].class, 'erev_yom_kippur');
  assert.ok(status.todayWarning);
  assert.equal(status.todayWarning.nameHe, 'ערב יום כיפור');
  // the warning does NOT change the reported hours - still 09:00-14:00, never fabricated
  assert.equal(status.isOpen, true);
});

test('yom tov with ordinary hours known -> hours shown AND warning present (never suppressed)', () => {
  const activity = { hoursByDay: { ב: { start: '09:00', end: '18:00' } }, openHours: { start: '09:00', end: '18:00' } };
  const status = buildTodayStatus(activity, { now: YOM_KIPPUR_10AM });
  assert.equal(status.isOpen, true);
  assert.deepEqual(status.today.intervals, [{ start: '09:00', end: '18:00' }]);
  assert.ok(status.todayWarning);
});

test('yom tov with UNKNOWN hours: state is unknown, warning fact still attached, no hours fabricated', () => {
  const activity = { hoursByDay: {}, openHours: null }; // genuinely no schedule data anywhere
  const status = buildTodayStatus(activity, { now: YOM_KIPPUR_10AM });
  assert.equal(status.state, 'unknown');
  assert.equal(status.isOpen, false);
  assert.deepEqual(status.today.intervals, []);
  assert.ok(status.todayWarning); // the calendar fact is still known even though hours aren't
});

test('non-warning minor calendar date (Rosh Chodesh): fact present, warning null', () => {
  const activity = { hoursByDay: { ב: { start: '09:00', end: '18:00' } }, openHours: { start: '09:00', end: '18:00' } };
  const status = buildTodayStatus(activity, { now: ROSH_CHODESH_10AM });
  assert.equal(status.todayHolidays.length, 1);
  assert.equal(status.todayHolidays[0].class, 'rosh_chodesh');
  assert.equal(status.todayWarning, null);
});

test('multiple intervals in one day: both are represented, and status picks the correct one', () => {
  const activity = {
    hoursByDay: { ד: { start: '16:00', end: '20:00' } }, // "last row wins" single-interval view
    intervalsByDay: { ד: [{ start: '09:00', end: '12:00' }, { start: '16:00', end: '20:00' }] },
    openHours: { start: '09:00', end: '20:00' },
  };
  const days = buildUpcomingDays(activity, { now: WEDNESDAY_10AM });
  assert.deepEqual(days[0].intervals, [{ start: '09:00', end: '12:00' }, { start: '16:00', end: '20:00' }]);

  const duringMorning = buildTodayStatus(activity, { now: new Date('2026-06-17T10:00:00') });
  assert.equal(duringMorning.isOpen, true);
  assert.equal(duringMorning.minutesUntilClose, 120);

  const betweenIntervals = buildTodayStatus(activity, { now: new Date('2026-06-17T14:00:00') });
  assert.equal(betweenIntervals.isOpen, false);
  assert.equal(betweenIntervals.opensAt, '16:00');
  assert.equal(betweenIntervals.minutesUntilOpen, 120);

  const duringEvening = buildTodayStatus(activity, { now: new Date('2026-06-17T17:00:00') });
  assert.equal(duringEvening.isOpen, true);
  assert.equal(duringEvening.minutesUntilClose, 180);
});

test('missing weekday (no data for today, other days known) -> state unknown, NOT closed', () => {
  const activity = {
    hoursByDay: { א: { start: '09:00', end: '12:00' }, ב: { start: '15:00', end: '20:00' } },
    openHours: { start: '09:00', end: '20:00' },
  };
  const status = buildTodayStatus(activity, { now: new Date('2026-06-16T10:00:00') }); // Tuesday - no entry
  assert.equal(status.state, 'unknown');
  assert.notEqual(status.state, 'closed');
});

test('missing weekday still reports the next KNOWN opening within the horizon, not a guess', () => {
  const activity = {
    hoursByDay: { א: { start: '09:00', end: '12:00' }, ב: { start: '15:00', end: '20:00' } },
    openHours: { start: '09:00', end: '20:00' },
  };
  // Tuesday 2026-06-16 has no entry; Wednesday/Thursday/Friday/Saturday also have none; the
  // following Sunday (2026-06-21, offset 5) is the next date with hoursByDay data.
  const status = buildTodayStatus(activity, { now: new Date('2026-06-16T10:00:00') });
  assert.ok(status.nextOpening);
  assert.equal(status.nextOpening.date, '2026-06-21');
  assert.equal(status.nextOpening.time, '09:00');
});

test('one-time occurrence activity does NOT get weekly kind, even on a date it performs', () => {
  const activity = { occurrences: [{ date: '2026-06-17', start: '17:00', end: '18:00' }], openHours: { start: '17:00', end: '18:00' }, hoursByDay: {} };
  const days = buildUpcomingDays(activity, { now: WEDNESDAY_10AM });
  assert.equal(days[0].kind, 'occurrence');
  assert.notEqual(days[0].kind, 'weekly');
});

test('a date with no performance for an occurrence activity is state:closed, not unknown', () => {
  const activity = { occurrences: [{ date: '2026-06-25', start: '17:00', end: '18:00' }], openHours: { start: '17:00', end: '18:00' }, hoursByDay: {} };
  const days = buildUpcomingDays(activity, { now: WEDNESDAY_10AM }); // window is 2026-06-17..23, no performance in it
  assert.ok(days.every((d) => d.state === 'closed'));
});

test('recurring schedule (day-varying hours) gets kind:weekly', () => {
  const activity = {
    hoursByDay: { א: { start: '09:00', end: '12:00' }, ב: { start: '15:00', end: '20:00' } },
    openHours: { start: '09:00', end: '20:00' },
  };
  const days = buildUpcomingDays(activity, { now: WEDNESDAY_10AM });
  assert.ok(days.some((d) => d.kind === 'weekly'));
});

test('FLATTENED-ENVELOPE REGRESSION: Sun 09-12 + Sat 16-20 must NEVER display 09-20 as a specific day\'s hours', () => {
  const activity = {
    hoursByDay: { א: { start: '09:00', end: '12:00' }, ש: { start: '16:00', end: '20:00' } },
    openHours: { start: '09:00', end: '20:00' }, // the flattened envelope - must never leak into a day row
  };
  const days = buildUpcomingDays(activity, { now: THURSDAY_NOON }); // 2026-06-18..24, includes Fri/Sat/Sun
  for (const day of days) {
    for (const interval of day.intervals) {
      assert.notDeepEqual(interval, { start: '09:00', end: '20:00' }, `date ${day.date} must not show the flattened 09:00-20:00 envelope`);
    }
  }
  const sunday = days.find((d) => d.weekdayLetter === 'א');
  const saturday = days.find((d) => d.weekdayLetter === 'ש');
  assert.deepEqual(sunday.intervals, [{ start: '09:00', end: '12:00' }]);
  assert.deepEqual(saturday.intervals, [{ start: '16:00', end: '20:00' }]);
  // Tuesday/Wednesday etc. (genuinely no data) must resolve to unknown, not the envelope either.
  const tuesday = days.find((d) => d.weekdayLetter === 'ג');
  assert.equal(tuesday.state, 'unknown');
  assert.deepEqual(tuesday.intervals, []);
});
