// lib/jerusalemTime.js - deterministic Israel-local time, independent of device timezone.
// Boundary instants below are verified against the actual 2026 Israel DST dates (Time
// Determination Law rule: Friday before the last Sunday of March 02:00 -> last Sunday of
// October 02:00): starts 2026-03-27, ends 2026-10-25.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  toJerusalemParts, jerusalemIsoDate, jerusalemWeekdayLetter, jerusalemMinutesSinceMidnight, isIsraelDst,
} = require('../lib/jerusalemTime.js');

test('normal winter date (standard time, UTC+2)', () => {
  const parts = toJerusalemParts(new Date('2026-01-15T10:00:00Z'));
  assert.equal(parts.hour, 12);
  assert.equal(parts.utcOffsetMinutes, 120);
  assert.equal(parts.isDst, false);
  assert.equal(parts.isoDate, '2026-01-15');
});

test('normal summer date (daylight time, UTC+3)', () => {
  const parts = toJerusalemParts(new Date('2026-06-15T10:00:00Z'));
  assert.equal(parts.hour, 13);
  assert.equal(parts.utcOffsetMinutes, 180);
  assert.equal(parts.isDst, true);
});

test('DST start boundary: 2026-03-27 00:00 UTC - clock jumps from 02:00 to 03:00 local', () => {
  const before = toJerusalemParts(new Date('2026-03-26T23:59:00Z'));
  assert.equal(before.hour, 1); assert.equal(before.minute, 59); assert.equal(before.utcOffsetMinutes, 120);
  const after = toJerusalemParts(new Date('2026-03-27T00:01:00Z'));
  assert.equal(after.hour, 3); assert.equal(after.minute, 1); assert.equal(after.utcOffsetMinutes, 180);
  assert.equal(isIsraelDst(new Date('2026-03-26T23:59:00Z').getTime()), false);
  assert.equal(isIsraelDst(new Date('2026-03-27T00:01:00Z').getTime()), true);
});

test('DST end boundary: 2026-10-24 23:00 UTC - clock falls back from 01:59 to 01:01 local', () => {
  const before = toJerusalemParts(new Date('2026-10-24T22:59:00Z'));
  assert.equal(before.hour, 1); assert.equal(before.minute, 59); assert.equal(before.utcOffsetMinutes, 180);
  const after = toJerusalemParts(new Date('2026-10-24T23:01:00Z'));
  assert.equal(after.hour, 1); assert.equal(after.minute, 1); assert.equal(after.utcOffsetMinutes, 120);
});

test('Jerusalem calendar-day boundary can differ from the UTC calendar day', () => {
  // 22:30 UTC on 2026-06-14 is already 01:30 on 2026-06-15 in Jerusalem (summer, UTC+3)
  const parts = toJerusalemParts(new Date('2026-06-14T22:30:00Z'));
  assert.equal(parts.isoDate, '2026-06-15');
  assert.equal(parts.hour, 1);
});

test('device physically outside Israel does not affect the result - only the UTC instant matters', () => {
  const instant = new Date('2026-06-15T10:00:00Z');
  const originalTz = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    const fromLA = toJerusalemParts(instant);
    process.env.TZ = 'Asia/Jerusalem';
    const fromJerusalem = toJerusalemParts(instant);
    process.env.TZ = 'Pacific/Auckland';
    const fromAuckland = toJerusalemParts(instant);
    assert.deepEqual(fromLA, fromJerusalem);
    assert.deepEqual(fromLA, fromAuckland);
  } finally {
    if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz;
  }
});

test('jerusalemIsoDate / jerusalemWeekdayLetter / jerusalemMinutesSinceMidnight convenience wrappers', () => {
  const d = new Date('2026-06-15T10:05:00Z'); // 13:05 Jerusalem, a Monday
  assert.equal(jerusalemIsoDate(d), '2026-06-15');
  assert.equal(jerusalemWeekdayLetter(d), 'ב');
  assert.equal(jerusalemMinutesSinceMidnight(d), 13 * 60 + 5);
});
