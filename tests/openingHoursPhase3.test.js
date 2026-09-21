// Opening Hours Phase 3 (2026-09-20) - midnight, overnight intervals and Jerusalem-time
// activation in the LIVE open-now path (lib/hoursResolver.js#getOpenStatus, which
// lib/filterActivities.js#getOpenNowInfo delegates to).
//
// Every "now" in this file is an explicit UTC INSTANT built by tests/support/jerusalemInstant.js,
// never a device-local Date literal - the whole point of the phase is that the answer depends on
// Asia/Jerusalem civil time and not on the machine, so the tests must not depend on the machine
// either. The timezone section below proves that directly by re-running one instant under five
// different process timezones.
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

const { getOpenStatus, resolveHoursForDate, intervalBounds } = require('../lib/hoursResolver.js');
const { jerusalemInstant: jerusalem } = require('./support/jerusalemInstant.js');

// Weekday letters (lib/scheduleSummary.js DAY_LETTERS, 0=Sunday): א ב ג ד ה ו ש.
// Anchor dates used below: 2026-06-14 Sun, 06-15 Mon, 06-16 Tue, 06-17 Wed, 06-19 Fri,
// 06-20 Sat, 06-21 Sun; 2026-12-31 Thu; 2027-01-01 Fri.

// A venue-style activity shaped exactly as lib/scheduleSummary.js#summarizeSchedules produces it:
// availableDays mirrors the recorded weekdays, hoursByDay keeps one interval per weekday,
// intervalsByDay accumulates all of them, and openHours is the flattened min-start/max-end envelope.
function venue(hoursByDay, envelope) {
  const intervalsByDay = {};
  for (const [letter, iv] of Object.entries(hoursByDay)) intervalsByDay[letter] = [iv];
  return { availableDays: Object.keys(hoursByDay), hoursByDay, intervalsByDay, openHours: envelope || null, occurrences: [] };
}

const open = (activity, isoDate, hhmm) => getOpenStatus(activity, { now: jerusalem(isoDate, hhmm) });

// ===========================================================================================
// MIDNIGHT
// ===========================================================================================

test('midnight: 00:00 as a START time is minute zero, not "missing" and not 24:00', () => {
  const act = venue({ ב: { start: '00:00', end: '08:00' } }, { start: '00:00', end: '08:00' });
  const atMidnight = open(act, '2026-06-15', '00:00');
  assert.equal(atMidnight.isOpen, true, 'a 00:00 opening minute is a real opening minute');
  assert.equal(atMidnight.hasScheduleData, true, 'parsing to the number 0 must never read as "no data"');
  assert.equal(atMidnight.minutesUntilClose, 480);
  assert.equal(open(act, '2026-06-15', '03:00').isOpen, true);
  assert.equal(open(act, '2026-06-15', '08:00').isOpen, true, 'end boundary is inclusive, unchanged by Phase 3');
  assert.equal(open(act, '2026-06-15', '08:01').isOpen, false);
  assert.equal(open(act, '2026-06-15', '23:00').isOpen, false);
});

test('midnight: 00:00 as an END time means end-of-day (24:00) - "open until midnight"', () => {
  const act = venue({ ב: { start: '20:00', end: '00:00' } }, { start: '20:00', end: '00:00' });
  const before = open(act, '2026-06-15', '19:59');
  assert.equal(before.isOpen, false);
  assert.equal(before.minutesUntilOpenToday, 1);
  assert.equal(open(act, '2026-06-15', '20:00').isOpen, true);
  const lateEvening = open(act, '2026-06-15', '23:59');
  assert.equal(lateEvening.isOpen, true, 'the legacy bug reported this CLOSED all evening');
  assert.equal(lateEvening.minutesUntilClose, 1);
});

test('midnight: an "end":"00:00" interval is NOT overnight - it stops at midnight, it does not spill into the next day', () => {
  const act = venue({ ב: { start: '20:00', end: '00:00' } }, { start: '20:00', end: '00:00' });
  assert.equal(intervalBounds({ start: '20:00', end: '00:00' }).isOvernight, false);
  assert.equal(open(act, '2026-06-16', '00:30').isOpen, false, 'Tuesday 00:30 is after Monday closed at midnight');
});

test('midnight: 00:00-00:00 keeps the codebase\'s existing "24 hours" meaning (always_open), not a zero-length day', () => {
  // The production catalogue currently contains ZERO 00:00-00:00 rows (Phase 3 data audit), so
  // this pins the meaning lib/hoursResolver.js#isAlwaysOpenInterval has always assigned rather
  // than inventing one: a start at minute 0 plus an end-of-day-aware end of 1440.
  const act = venue({ ב: { start: '00:00', end: '00:00' } }, { start: '00:00', end: '00:00' });
  assert.equal(resolveHoursForDate(act, '2026-06-15').state, 'always_open');
  assert.equal(open(act, '2026-06-15', '03:00').isOpen, true);
  assert.equal(open(act, '2026-06-15', '21:00').isOpen, true);
});

test('midnight: an interval recorded with only one endpoint stays UNKNOWN - never open, never a confident "closed"', () => {
  const startOnly = { availableDays: ['ב'], hoursByDay: { ב: { start: '09:00', end: null } }, intervalsByDay: { ב: [{ start: '09:00', end: null }] }, openHours: null, occurrences: [] };
  const endOnly = { availableDays: ['ב'], hoursByDay: { ב: { start: null, end: '17:00' } }, intervalsByDay: { ב: [{ start: null, end: '17:00' }] }, openHours: null, occurrences: [] };
  for (const act of [startOnly, endOnly]) {
    const status = open(act, '2026-06-15', '12:00');
    assert.equal(status.isOpen, false);
    assert.equal(status.resolved.state, 'unknown', 'a half-recorded row is missing data, not proof of closure');
    assert.equal(status.resolved.intervals.length, 0);
  }
});

// ===========================================================================================
// OVERNIGHT INTERVALS
// ===========================================================================================

test('overnight: Friday 20:00-02:00 - the full boundary ladder, including after midnight on Saturday', () => {
  const act = venue({ ו: { start: '20:00', end: '02:00' } }, { start: '20:00', end: '02:00' });
  assert.equal(open(act, '2026-06-19', '19:00').isOpen, false, 'Friday 19:00');
  assert.equal(open(act, '2026-06-19', '20:00').isOpen, true, 'Friday 20:00');
  assert.equal(open(act, '2026-06-19', '23:30').isOpen, true, 'Friday 23:30');
  const justAfterMidnight = open(act, '2026-06-20', '00:30');
  assert.equal(justAfterMidnight.isOpen, true, 'Saturday 00:30 - resolved from FRIDAY, which Saturday\'s own (empty) schedule cannot answer');
  assert.equal(justAfterMidnight.minutesUntilClose, 90);
  assert.equal(open(act, '2026-06-20', '01:59').isOpen, true, 'Saturday 01:59');
  // NOTE: the Phase 3 brief lists Saturday 02:00 as CLOSED "according to the project's existing
  // end-boundary semantics". The project's existing end boundary is INCLUSIVE (now <= end) - an
  // activity closing at 18:00 has always read open at exactly 18:00 with minutesUntilClose 0 - so
  // the overnight case follows that same rule rather than introducing a second, contradictory one.
  // Flagged in the Phase 3 report for an explicit ruling: flipping it would be a one-line change
  // in openWindows that affects EVERY activity's closing minute, not only overnight ones.
  const atClose = open(act, '2026-06-20', '02:00');
  assert.equal(atClose.isOpen, true, 'inclusive end boundary, consistent with every non-overnight interval');
  assert.equal(atClose.minutesUntilClose, 0);
  assert.equal(open(act, '2026-06-20', '02:01').isOpen, false, 'Saturday 02:01 - definitively closed');
});

test('overnight: 22:30-01:15 across the midnight boundary', () => {
  const act = venue({ ב: { start: '22:30', end: '01:15' } }, { start: '22:30', end: '01:15' });
  assert.equal(open(act, '2026-06-15', '22:29').isOpen, false);
  assert.equal(open(act, '2026-06-15', '22:30').isOpen, true);
  const afterMidnight = open(act, '2026-06-16', '01:00');
  assert.equal(afterMidnight.isOpen, true);
  assert.equal(afterMidnight.minutesUntilClose, 15);
  assert.equal(open(act, '2026-06-16', '01:16').isOpen, false);
  assert.equal(open(act, '2026-06-16', '12:00').isOpen, false, 'Tuesday midday is not covered by Monday\'s tail');
});

// ===========================================================================================
// MULTIPLE INTERVALS IN ONE DAY
// ===========================================================================================

test('multiple intervals: 09:00-12:00 + 16:00-01:00 on Monday - both honored, gap respected, tail spills into Tuesday', () => {
  const act = {
    availableDays: ['ב'],
    hoursByDay: { ב: { start: '16:00', end: '01:00' } }, // "last row wins" - the lossy legacy field
    intervalsByDay: { ב: [{ start: '09:00', end: '12:00' }, { start: '16:00', end: '01:00' }] },
    openHours: { start: '09:00', end: '12:00' }, // flattened envelope; deliberately NOT the union
    occurrences: [],
  };
  assert.equal(open(act, '2026-06-15', '10:00').isOpen, true, 'inside the morning slot');
  const inGap = open(act, '2026-06-15', '14:00');
  assert.equal(inGap.isOpen, false, 'the lunch gap is a real gap - intervals are never collapsed into one envelope');
  assert.equal(inGap.minutesUntilOpenToday, 120, 'and the NEXT slot today is what "opens in" reports');
  assert.equal(open(act, '2026-06-15', '17:00').isOpen, true, 'inside the evening slot');
  const tuesdaySpill = open(act, '2026-06-16', '00:30');
  assert.equal(tuesdaySpill.isOpen, true, 'Monday\'s evening slot runs to 01:00 on Tuesday');
  assert.equal(tuesdaySpill.minutesUntilClose, 30);
  assert.equal(open(act, '2026-06-16', '01:30').isOpen, false);
});

// ===========================================================================================
// PREVIOUS-DAY SPILLOVER ACROSS CALENDAR BOUNDARIES
// ===========================================================================================

test('spillover: Saturday -> Sunday (the week boundary, where naive weekday arithmetic breaks)', () => {
  const act = venue({ ש: { start: '21:00', end: '03:00' } }, { start: '21:00', end: '03:00' });
  assert.equal(open(act, '2026-06-20', '22:00').isOpen, true, 'Saturday 22:00');
  const sunday = open(act, '2026-06-21', '01:00');
  assert.equal(sunday.isOpen, true, 'Sunday 01:00 - yesterday is weekday index 6, today is index 0');
  assert.equal(sunday.minutesUntilClose, 120);
  assert.equal(open(act, '2026-06-21', '04:00').isOpen, false);
});

test('spillover: 31 December -> 1 January (month AND year boundary)', () => {
  const act = venue({ ה: { start: '22:00', end: '03:00' } }, { start: '22:00', end: '03:00' }); // Thursday
  assert.equal(open(act, '2026-12-31', '23:00').isOpen, true, 'Thursday 2026-12-31 23:00');
  const newYear = open(act, '2027-01-01', '01:00');
  assert.equal(newYear.isOpen, true, '2027-01-01 01:00 resolves against 2026-12-31 - a real calendar date, not index arithmetic');
  assert.equal(newYear.minutesUntilClose, 120);
});

test('spillover is limited to intervals that genuinely cross midnight - yesterday\'s ordinary hours never leak into today', () => {
  const act = venue({ ב: { start: '09:00', end: '17:00' } }, { start: '09:00', end: '17:00' });
  const tuesday = open(act, '2026-06-16', '10:00');
  assert.equal(tuesday.isOpen, false, 'Monday 09:00-17:00 says nothing about Tuesday');
  assert.equal(tuesday.resolved.state, 'unknown', 'and Tuesday stays UNKNOWN, not a confident "closed"');
});

// ===========================================================================================
// BOUNDARIES
// ===========================================================================================

test('boundaries: exact opening minute, minute before closing, exact closing minute, minute after', () => {
  const act = venue({ ב: { start: '09:00', end: '17:00' } }, { start: '09:00', end: '17:00' });
  const beforeOpen = open(act, '2026-06-15', '08:59');
  assert.equal(beforeOpen.isOpen, false);
  assert.equal(beforeOpen.minutesUntilOpenToday, 1);
  const atOpen = open(act, '2026-06-15', '09:00');
  assert.equal(atOpen.isOpen, true);
  assert.equal(atOpen.minutesUntilClose, 480);
  assert.equal(open(act, '2026-06-15', '16:59').minutesUntilClose, 1);
  const atClose = open(act, '2026-06-15', '17:00');
  assert.equal(atClose.isOpen, true, 'INCLUSIVE end boundary - long-standing project convention, untouched by Phase 3');
  assert.equal(atClose.minutesUntilClose, 0);
  const afterClose = open(act, '2026-06-15', '17:01');
  assert.equal(afterClose.isOpen, false);
  assert.equal(afterClose.minutesUntilOpenToday, null, 'nothing else opens later today');
});

// ===========================================================================================
// TIMEZONE: the device must not decide whether an Israeli venue is open
// ===========================================================================================

function underTimezone(tz, fn) {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
}

test('timezone: the SAME UTC instant yields the same answer on a device in Prague, New York, Tokyo or Tel Aviv', () => {
  const act = venue({ ב: { start: '22:00', end: '23:00' } }, { start: '22:00', end: '23:00' });
  // 2026-06-15T19:30:00Z is Monday 22:30 in Jerusalem (UTC+3 in June) - but Monday 15:30 in New
  // York and Tuesday 04:30 in Tokyo, so a device-local implementation disagrees with itself here.
  const instant = new Date('2026-06-15T19:30:00Z');
  const results = ['UTC', 'Europe/Prague', 'America/New_York', 'Asia/Tokyo', 'Asia/Jerusalem']
    .map((tz) => underTimezone(tz, () => getOpenStatus(act, { now: instant })));
  for (const result of results) {
    assert.equal(result.isOpen, true, 'open because it is 22:30 in JERUSALEM, wherever the phone is');
    assert.equal(result.minutesUntilClose, 30);
  }
});

test('timezone: the Jerusalem civil DATE decides the weekday, even when UTC is still on the previous date', () => {
  const act = venue({ ב: { start: '01:00', end: '02:00' } }, { start: '01:00', end: '02:00' }); // Monday only
  // 2026-06-14T22:30:00Z: still Sunday in UTC, but already Monday 01:30 in Jerusalem.
  const instant = new Date('2026-06-14T22:30:00Z');
  const status = underTimezone('UTC', () => getOpenStatus(act, { now: instant }));
  assert.equal(status.isOpen, true, 'the Jerusalem date rolled over to Monday; the UTC date had not');
  assert.equal(status.resolved.date, '2026-06-15');
  assert.equal(status.resolved.weekdayLetter, 'ב');
});

test('timezone: winter (UTC+2) and summer (UTC+3) instants both resolve to Jerusalem 10:30', () => {
  const act = venue({ ה: { start: '10:00', end: '11:00' }, ד: { start: '10:00', end: '11:00' } }, { start: '10:00', end: '11:00' });
  const winter = getOpenStatus(act, { now: new Date('2026-01-15T08:30:00Z') }); // Thursday, IST +2
  assert.equal(winter.isOpen, true);
  assert.equal(winter.minutesUntilClose, 30);
  const summer = getOpenStatus(act, { now: new Date('2026-07-15T07:30:00Z') }); // Wednesday, IDT +3
  assert.equal(summer.isOpen, true);
  assert.equal(summer.minutesUntilClose, 30);
  // The same UTC clock time maps to DIFFERENT Jerusalem times in the two seasons - proof the
  // offset is really being applied, rather than a constant being coincidentally right.
  assert.equal(getOpenStatus(act, { now: new Date('2026-07-15T08:30:00Z') }).isOpen, false, 'summer 08:30Z is 11:30 in Jerusalem, past closing');
});

// ===========================================================================================
// ISRAEL DST TRANSITIONS
// ===========================================================================================

test('DST: spring forward (Friday 2026-03-27, 02:00 IST -> 03:00 IDT)', () => {
  const act = venue({ ו: { start: '03:00', end: '04:00' } }, { start: '03:00', end: '04:00' }); // Friday
  // 2026-03-26T23:30:00Z is still UTC+2 -> Friday 01:30, before the jump and before opening.
  assert.equal(getOpenStatus(act, { now: new Date('2026-03-26T23:30:00Z') }).isOpen, false);
  // 2026-03-27T00:30:00Z is UTC+3 -> Friday 03:30, immediately after the jump.
  const afterJump = getOpenStatus(act, { now: new Date('2026-03-27T00:30:00Z') });
  assert.equal(afterJump.isOpen, true);
  assert.equal(afterJump.minutesUntilClose, 30);
  assert.equal(getOpenStatus(act, { now: new Date('2026-03-27T01:30:00Z') }).isOpen, false, 'Friday 04:30 IDT, past closing');
});

test('DST: an overnight interval spanning the spring-forward night is evaluated in wall-clock time', () => {
  const act = venue({ ה: { start: '22:00', end: '03:00' } }, { start: '22:00', end: '03:00' }); // Thursday 2026-03-26
  // The clocks jump 02:00 -> 03:00 during this venue's night, so it is open for 5 WALL-CLOCK
  // hours but only 4 real ones. Wall clock is the right reading: a sign on the door saying
  // "open until 03:00" means 03:00 on whatever clock is in force at the time.
  assert.equal(getOpenStatus(act, { now: new Date('2026-03-26T21:00:00Z') }).isOpen, true, 'Thursday 23:00 IST');
  assert.equal(getOpenStatus(act, { now: new Date('2026-03-26T23:30:00Z') }).isOpen, true, 'Friday 01:30 IST, still inside Thursday\'s tail');
  const atJump = getOpenStatus(act, { now: new Date('2026-03-27T00:00:00Z') });
  assert.equal(atJump.isOpen, true, 'Friday 03:00 IDT - the wall clock reads exactly the closing time');
  assert.equal(atJump.minutesUntilClose, 0);
  assert.equal(getOpenStatus(act, { now: new Date('2026-03-27T00:30:00Z') }).isOpen, false, 'Friday 03:30 IDT');
});

test('DST: fall back (Sunday 2026-10-25, 02:00 IDT -> 01:00 IST) - the repeated hour resolves consistently', () => {
  const act = venue({ א: { start: '01:00', end: '02:00' } }, { start: '01:00', end: '02:00' }); // Sunday
  // Both instants are Jerusalem 01:30 on Sunday 2026-10-25 - once on IDT, once on IST.
  const firstPass = getOpenStatus(act, { now: new Date('2026-10-24T22:30:00Z') }); // +3
  const secondPass = getOpenStatus(act, { now: new Date('2026-10-24T23:30:00Z') }); // +2
  assert.equal(firstPass.isOpen, true);
  assert.equal(secondPass.isOpen, true);
  assert.equal(firstPass.resolved.date, '2026-10-25');
  assert.equal(secondPass.resolved.date, '2026-10-25');
});

// ===========================================================================================
// UNKNOWN STAYS UNKNOWN, AND DAY-SPECIFIC HOURS STAY AUTHORITATIVE
// ===========================================================================================

test('unknown: no schedule data at all stays UNKNOWN - never a guessed "open", never a confident "closed"', () => {
  const act = { availableDays: [], hoursByDay: {}, intervalsByDay: {}, openHours: null, occurrences: [] };
  const status = open(act, '2026-06-15', '12:00');
  assert.equal(status.isOpen, false);
  assert.equal(status.hasScheduleData, false);
  assert.equal(status.resolved.state, 'unknown');
});

test('day-specific safety: the flattened openHours envelope must not make a venue "open" on a weekday it has no hours for', () => {
  // The exact regression the reliability rule exists for - re-asserted with overnight data in
  // play, since Phase 3 added a SECOND per-date lookup (yesterday) that could have reintroduced it.
  const act = venue({ ב: { start: '20:00', end: '02:00' } }, { start: '20:00', end: '02:00' }); // Monday only
  const tuesdayEvening = open(act, '2026-06-16', '21:00');
  assert.equal(tuesdayEvening.isOpen, false, 'Tuesday 21:00 must NOT borrow Monday\'s 20:00-02:00 via the envelope');
  const tuesdayNight = open(act, '2026-06-16', '00:30');
  assert.equal(tuesdayNight.isOpen, true, 'but Tuesday 00:30 IS covered - by Monday\'s own interval, not by the envelope');
  assert.equal(open(act, '2026-06-17', '00:30').isOpen, false, 'Wednesday 00:30 has no Tuesday interval to inherit');
});

test('venue spillover never reaches into dated-event occurrence semantics', () => {
  // A performance recorded 20:00-02:00 on Monday does NOT make the activity "open" at Tuesday
  // 00:30. Occurrence semantics are deliberately out of Phase 3's scope (see the report); the
  // production catalogue currently holds zero overnight one_time rows, so nothing real is affected.
  const act = { availableDays: ['ב'], hoursByDay: {}, intervalsByDay: {}, openHours: { start: '20:00', end: '02:00' }, occurrences: [{ date: '2026-06-15', start: '20:00', end: '02:00' }] };
  assert.equal(open(act, '2026-06-16', '00:30').isOpen, false, 'unchanged event semantics - reported, not silently altered');
});
