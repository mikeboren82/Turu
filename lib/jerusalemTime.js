// Deterministic Israel-local (Asia/Jerusalem) wall-clock time, computed from UTC epoch math -
// NOT from the device's own timezone or from Intl/timeZone APIs (architecture audit section F:
// Hermes's Intl timeZone support is not something to bet the open/closed badge on, and this
// keeps the whole module dependency-free and synchronous). Works correctly regardless of what
// timezone the device itself is set to, because Date#getTime() always returns the UTC epoch -
// only Date's *local* getters (getHours/getDate/...) depend on the device's zone, and this file
// never calls those on the caller-supplied Date.
//
// Israel Summer Time law (Time Determination Law, 2013 amendment): clocks advance on the Friday
// before the last Sunday of March at 02:00 (standard time), and revert on the last Sunday of
// October at 02:00 (daylight time). Standard offset UTC+2, daylight offset UTC+3.
//
// This module is currently NOT wired into any existing consumer (lib/filterActivities.js keeps
// using device-local Date methods, matching its pre-existing behavior exactly) - see the notes
// in lib/hoursResolver.js for why activating it is a separate, later, explicitly-reviewed step.

export const DAY_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש']; // 0=Sunday..6=Saturday, same convention as lib/scheduleSummary.js

// Last Sunday of a given UTC month (monthIndex0: 2=March, 9=October), as a day-of-month number.
function lastSundayOfMonthUtc(year, monthIndex0) {
  const lastDayOfMonth = new Date(Date.UTC(year, monthIndex0 + 1, 0)); // day 0 of next month = last day of this month
  const day = lastDayOfMonth.getUTCDate();
  const dow = lastDayOfMonth.getUTCDay(); // 0=Sunday
  return day - dow;
}

// The two UTC instants (epoch ms) at which Israel's clocks change for a given (UTC-calendar) year.
function israelDstBoundsUtc(year) {
  const marchLastSunday = lastSundayOfMonthUtc(year, 2);
  const dstStartDay = marchLastSunday - 2; // the Friday before that Sunday
  const dstStartUtc = Date.UTC(year, 2, dstStartDay, 0, 0, 0); // 02:00 IST (UTC+2) = 00:00 UTC
  const octLastSunday = lastSundayOfMonthUtc(year, 9);
  // 02:00 IDT (UTC+3) = -1:00 UTC, which Date.UTC normalizes to 23:00 the previous day.
  const dstEndUtc = Date.UTC(year, 9, octLastSunday, -1, 0, 0);
  return { dstStartUtc, dstEndUtc };
}

// Whether daylight time is in effect in Israel at a given UTC epoch instant.
export function isIsraelDst(epochMs) {
  const year = new Date(epochMs).getUTCFullYear();
  const { dstStartUtc, dstEndUtc } = israelDstBoundsUtc(year);
  if (epochMs >= dstStartUtc && epochMs < dstEndUtc) return true;
  // Guard the boundary: a UTC instant in early January/late December can only ever be standard
  // time in Israel (DST never wraps a UTC calendar year boundary), so no cross-year check is needed.
  return false;
}

export function israelUtcOffsetMinutes(epochMs) {
  return isIsraelDst(epochMs) ? 180 : 120;
}

// Converts a JS Date (any device timezone) into its Israel-local wall-clock parts.
export function toJerusalemParts(date = new Date()) {
  const epochMs = date.getTime();
  const offsetMinutes = israelUtcOffsetMinutes(epochMs);
  const shifted = new Date(epochMs + offsetMinutes * 60000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  const weekday = shifted.getUTCDay(); // 0=Sunday..6=Saturday, Israel-local
  return {
    year, month, day, hour, minute, weekday,
    weekdayLetter: DAY_LETTERS[weekday],
    isoDate: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    minutesSinceMidnight: hour * 60 + minute,
    utcOffsetMinutes: offsetMinutes,
    isDst: offsetMinutes === 180,
  };
}

export function jerusalemIsoDate(date = new Date()) {
  return toJerusalemParts(date).isoDate;
}

export function jerusalemWeekdayLetter(date = new Date()) {
  return toJerusalemParts(date).weekdayLetter;
}

export function jerusalemMinutesSinceMidnight(date = new Date()) {
  return toJerusalemParts(date).minutesSinceMidnight;
}
