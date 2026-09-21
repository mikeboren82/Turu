// Unified hours resolver (architecture audit section J/K) - the shared semantic layer that will
// eventually replace the separate interpretations duplicated across lib/filterActivities.js
// (getOpenNowInfo, hourMatchesOnOffset), lib/i18n/format.js (scheduleHoursLabel), and
// lib/shareActivity.js. Today lib/filterActivities.js#getOpenNowInfo and lib/hoursDisplay.js both
// delegate here; the hour-range SEARCH filter (hourMatchesOnOffset/matchesHourOnly) and the
// label builders still carry their own interpretations - see the Phase 3 report.
//
// Two audiences, one implementation:
//   resolveHoursForDate(activity, isoDate, opts) - general per-date resolution (any date, past or
//     future). This is the future-facing layer for the not-yet-built 7-day view; nothing consumes
//     it live yet.
//   getOpenStatus(activity, opts) - "is it open right now" for TODAY specifically. This is what
//     getOpenNowInfo delegates to.
//
// OPENING HOURS PHASE 3 (2026-09-20) - the three semantic corrections the Foundation phase
// deliberately parked, now activated in the live open-now path. Each one is a KNOWN legacy bug,
// so this phase intentionally produces differences from the pre-Phase-3 behavior (every one of
// them is enumerated and classified by scripts/diff-hours-phase3.js):
//   A. Asia/Jerusalem civil time (lib/jerusalemTime.js) is now the authoritative clock instead of
//      the device's own timezone - an Israeli venue's open/closed badge no longer depends on
//      where the user's phone happens to be.
//   B. "00:00" as an END time means end-of-day (24:00), not minute zero - 22:00-00:00 is "open
//      until midnight", not a malformed interval that reads closed all evening.
//   C. Intervals crossing midnight (20:00-02:00) are honored, INCLUDING the part that lands on
//      the following calendar date (previous-day spillover), and activity.intervalsByDay's
//      several-intervals-per-day data is now used instead of hoursByDay's "last row wins".
//
// End-boundary semantics are UNCHANGED and remain INCLUSIVE (`now <= end`): an activity closing
// at 18:00 still reads open at exactly 18:00, with minutesUntilClose 0. Phase 3 deliberately does
// not touch that, so the only behavioral deltas are the three corrections above.
import { DAY_LETTERS } from './scheduleSummary';
import { resolveHolidayWarning } from './hoursPolicy';
import { toJerusalemParts } from './jerusalemTime';

export const MINUTES_PER_DAY = 24 * 60;

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// "00:00" as an END time means end-of-day (24:00), not midnight-start - the same convention
// lib/filterActivities.js's search path (toEndMinutes) has always used. As of Phase 3 the live
// open-now path uses it too (via intervalBounds below), so "22:00-00:00" finally means "open
// until midnight" everywhere instead of only inside the hour-range search filter.
//
// Note the asymmetry, which is the whole point: this applies ONLY to an end time. A "00:00"
// START time is plain minute zero (a genuine midnight opening, e.g. 00:00-08:00) - never 24:00
// and never "absent". Neither endpoint is ever treated as missing merely because it parses to the
// number 0; "missing" means null or '', which isValidInterval rejects separately below.
export function toEndOfDayAwareMinutes(hhmm) {
  const mins = toMinutes(hhmm);
  return mins === 0 ? 24 * 60 : mins;
}

// A schedule row can exist with only a start OR only an end recorded (real, if rare, imported-data
// shape - lib/scheduleSummary.js itself never writes one half without the other, but callers may
// hand the resolver a raw/malformed activity object directly, e.g. hand-built test fixtures or a
// not-yet-normalized source). Treated as "no usable interval", matching the pre-existing
// getOpenNowInfo's own `!hours?.start || !hours?.end` guard - never guessed, never crashes.
function isValidInterval(interval) {
  return !!(interval && interval.start && interval.end);
}

// --- Phase 3 interval math (midnight + overnight) -------------------------------------------
// One interval's minute bounds, expressed relative to midnight of the day the interval STARTS on:
//   { startMinutes, endMinutes, isOvernight }
// - a "00:00" start is minute 0 (a genuine midnight opening); a "00:00" end is 1440 (end-of-day)
// - an interval whose end-of-day-aware end falls strictly BEFORE its start crosses midnight, and
//   its endMinutes is therefore >1440 (e.g. 20:00-02:00 -> start 1200, end 1560)
// The comparison is deliberately strict (<, not <=): the real catalogue contains one_time rows
// recorded as e.g. 11:00-11:00, and those stay the degenerate point-in-time intervals they have
// always been rather than being silently reinterpreted as a 24-hour day.
export function intervalBounds(interval) {
  const startMinutes = toMinutes(interval.start);
  const endAware = toEndOfDayAwareMinutes(interval.end);
  const isOvernight = endAware < startMinutes;
  return { startMinutes, endMinutes: isOvernight ? endAware + MINUTES_PER_DAY : endAware, isOvernight };
}

export function isOvernightInterval(interval) {
  return isValidInterval(interval) && intervalBounds(interval).isOvernight;
}

// Which of `intervals` contain `nowMinutes` (minutes since TODAY's Jerusalem midnight).
// `dayOffsetMinutes` shifts the whole interval onto today's minute axis: 0 for intervals that
// belong to today, -MINUTES_PER_DAY for YESTERDAY's intervals. That single shift is all the
// previous-day spillover needs - yesterday's ordinary 09:00-17:00 lands at -900..-420 and can
// never match (nowMinutes is never negative), while yesterday's overnight 20:00-02:00 lands at
// -240..+120 and correctly matches today 00:00-02:00. No weekday arithmetic is involved, so this
// behaves identically across Saturday->Sunday, month ends and year ends.
// The end boundary stays INCLUSIVE (<=), matching the long-standing pre-Phase-3 convention.
export function openWindows(intervals, nowMinutes, dayOffsetMinutes = 0) {
  const windows = [];
  for (const interval of intervals) {
    if (!isValidInterval(interval)) continue;
    const { startMinutes, endMinutes } = intervalBounds(interval);
    const start = startMinutes + dayOffsetMinutes;
    const end = endMinutes + dayOffsetMinutes;
    if (nowMinutes >= start && nowMinutes <= end) windows.push({ interval, minutesUntilClose: end - nowMinutes });
  }
  return windows;
}

// The earliest start LATER TODAY among `intervals`, or null. Only today's own intervals are ever
// passed here: "opens in N minutes" is a same-day promise, and a spillover interval inherited
// from yesterday has by definition already started.
export function nextStartTodayMinutes(intervals, nowMinutes) {
  let earliest = null;
  for (const interval of intervals) {
    if (!isValidInterval(interval)) continue;
    const { startMinutes } = intervalBounds(interval);
    if (startMinutes > nowMinutes && (earliest === null || startMinutes < earliest)) earliest = startMinutes;
  }
  return earliest;
}

// Real calendar-date arithmetic on a date STRING, in UTC and never carrying a time-of-day, so it
// is immune to DST and correct across month and year boundaries (2027-01-01 minus 1 day is
// 2026-12-31, not "the same weekday last week").
export function addDaysToIsoDate(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Whether an interval spans (effectively) the full day - "24 hours" (architecture audit section
// M). Not currently surfaced as anything other than the `state` label; open-now math treats
// always_open the same as open. 23:59 (not just a literal 24:00/00:00-as-wrap) counts as
// end-of-day - the existing convention already used by constants/mockActivities.js for 24h venues.
const END_OF_DAY_THRESHOLD_MINUTES = 23 * 60 + 59;
function isAlwaysOpenInterval(interval) {
  if (!interval?.start || !interval?.end) return false;
  return toMinutes(interval.start) === 0 && toEndOfDayAwareMinutes(interval.end) >= END_OF_DAY_THRESHOLD_MINUTES;
}

// A date string ("2026-09-25") -> weekday letter, independent of any device/Jerusalem "now" -
// used by resolveHoursForDate, which resolves an arbitrary explicit date, not "today". Parsed at
// noon UTC specifically to avoid the date shifting by a day under any interpretation.
function weekdayLetterForIsoDate(isoDate) {
  const idx = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
  return DAY_LETTERS[idx];
}

// activity.occurrences ([{date,start,end,bookingUrl}], already sorted ascending - see
// lib/scheduleSummary.js#upcomingOccurrences) -> Map<isoDate, {start,end}>, first-occurrence-per-
// date wins (mirrors lib/filterActivities.js#occurrenceOffsetMap's `if (!map.has(offset))`).
function occurrenceMapByDate(activity) {
  const occ = activity.occurrences || [];
  if (!occ.length) return null;
  const map = new Map();
  for (const o of occ) {
    const key = String(o.date).slice(0, 10);
    if (!map.has(key)) map.set(key, { start: o.start || null, end: o.end || null });
  }
  return map;
}

// Distinguishes a dated event from a recurring weekly schedule from a venue-like fixed schedule
// (architecture audit section E/section 6 of this task: "do not conflate dated events with venue/
// opening hours"). This is a heuristic derived entirely from already-computed fields - no schema
// change: a `fixed_hours` schedule fans out to ALL 7 weekday letters with IDENTICAL {start,end}
// (lib/scheduleSummary.js:62), which is a signature a genuinely day-varying `recurring` schedule
// essentially never produces by coincidence. A recurring schedule that happens to list all 7 days
// with identical hours would also read as 'fixed' here - an acceptable edge case, since "open the
// same hours every day" behaves identically to "fixed venue hours" for every consumer of `kind`.
function classifyKind(activity, isDatedEvent) {
  if (isDatedEvent) return 'occurrence';
  const hoursByDay = activity.hoursByDay || {};
  const letters = Object.keys(hoursByDay);
  if (letters.length === 0) return 'unknown';
  if (letters.length === 7) {
    const first = hoursByDay[letters[0]];
    const allIdentical = letters.every((l) => hoursByDay[l].start === first.start && hoursByDay[l].end === first.end);
    if (allIdentical) return 'fixed';
  }
  return 'weekly';
}

// Resolves hours for one activity on one specific Gregorian date. Pure, synchronous.
//
// opts.strictness: 'display' (default) | 'search' - preserves the existing, deliberate asymmetry
// between getOpenNowInfo (display: refuses the flattened openHours envelope when hoursByDay has
// data for OTHER weekdays but not this one - the reliability rule) and hourMatchesOnOffset/
// matchesHourOnly (search: always falls back to openHours so incomplete data never hides a
// result). See lib/filterActivities.js for both pre-existing implementations this mirrors.
//
// opts.useIntervalsByDay: false (default) - when true, prefers activity.intervalsByDay (the
// multiple-interval-per-day foundation) over the single-interval activity.hoursByDay, which keeps
// only the LAST schedule row for a weekday ("last one wins", lib/scheduleSummary.js). The default
// stays false so a caller that explicitly wants the old single-interval view still gets it, but
// BOTH live consumers now opt in: lib/hoursDisplay.js (since Phase 2) and getOpenStatus below
// (since Phase 3). A venue open 09:00-12:00 and 16:00-01:00 on the same day is therefore no
// longer collapsed to a single envelope, nor reduced to whichever row happened to be imported last.
export function resolveHoursForDate(activity, isoDate, opts = {}) {
  const strictness = opts.strictness === 'search' ? 'search' : 'display';
  const useIntervalsByDay = !!opts.useIntervalsByDay;

  const weekdayLetter = weekdayLetterForIsoDate(isoDate);
  const occMap = occurrenceMapByDate(activity);
  const isDatedEvent = !!occMap;
  const kind = classifyKind(activity, isDatedEvent);
  const { holidays, warning } = resolveHolidayWarning(isoDate);

  let state = 'unknown';
  let intervals = [];
  let source = 'none';
  let confidence = 'unknown';

  if (isDatedEvent) {
    const occToday = occMap.get(isoDate);
    if (!occToday) {
      // No performance on this date at all - a definite fact, not a data gap.
      state = 'closed';
      source = 'occurrence';
      confidence = 'regular';
    } else if (occToday.start && occToday.end) {
      intervals = [{ start: occToday.start, end: occToday.end }];
      state = intervals.some(isAlwaysOpenInterval) ? 'always_open' : 'open';
      source = 'occurrence';
      confidence = 'regular';
    } else {
      // A performance happens, but its time is unknown - never guessed (matches
      // lib/filterActivities.js#hourMatchesOnOffset's dated-event branch: "occHours missing a
      // known time -> not a match", not "assume open").
      state = 'unknown';
      source = 'occurrence';
      confidence = 'unknown';
    }
  } else {
    const rawMultiIntervals = useIntervalsByDay && activity.intervalsByDay && activity.intervalsByDay[weekdayLetter];
    const multiIntervals = rawMultiIntervals ? rawMultiIntervals.filter(isValidInterval) : null;
    const rawDayHours = activity.hoursByDay && activity.hoursByDay[weekdayLetter];
    const dayHours = isValidInterval(rawDayHours) ? rawDayHours : null;
    // hasOtherDayHours keys off the RAW entry (even a malformed one still proves this weekday was
    // recorded specifically, distinguishing it from a weekday never recorded at all) - matches the
    // pre-existing getOpenNowInfo's own `!todayHours` check, which used the same raw truthiness.
    const hasOtherDayHours = !!(activity.hoursByDay && Object.keys(activity.hoursByDay).length > 0 && !rawDayHours);

    if (multiIntervals && multiIntervals.length) {
      intervals = multiIntervals;
      source = 'weekly';
      confidence = 'regular';
    } else if (dayHours) {
      intervals = [dayHours];
      source = 'weekly';
      confidence = 'regular';
    } else if ((!hasOtherDayHours || strictness === 'search') && isValidInterval(activity.openHours)) {
      // Legitimate envelope fallback. Unconditional when there is genuinely no day-specific data
      // anywhere (a fixed_hours activity recorded without a per-day breakdown - the same
      // pre-existing heuristic `availableDays.length === 0` already relies on); additionally
      // permitted under 'search' strictness even when OTHER days do have specific hours, matching
      // the existing permissive search behavior exactly. Under 'display' strictness with
      // hasOtherDayHours true, this branch is skipped on purpose - that is the reliability rule.
      intervals = [activity.openHours];
      source = 'envelope';
      confidence = 'uncertain';
    }

    if (intervals.length) {
      // .some(), not intervals[0]: with intervalsByDay a day can carry several intervals, and a
      // 00:00-23:59 "24 hours" row is still a 24-hour day whichever position it was imported in.
      // Identical to the previous intervals[0] check whenever a day has exactly one interval.
      state = intervals.some(isAlwaysOpenInterval) ? 'always_open' : 'open';
    }
  }

  return {
    date: isoDate,
    weekdayLetter,
    kind, // 'weekly' | 'fixed' | 'occurrence' | 'unknown'
    state, // 'open' | 'always_open' | 'closed' | 'unknown'
    intervals, // [{start,end}, ...] - [] when state is 'closed' or 'unknown'
    source, // 'weekly' | 'occurrence' | 'envelope' | 'none'
    confidence, // 'regular' | 'uncertain' | 'unknown'
    isDatedEvent,
    calendar: { holidays }, // calendar FACT for this date (lib/jewishCalendar.js) - independent of hours data
    warning, // TURU POLICY verdict for this date (lib/hoursPolicy.js) - null when no warning applies
  };
}

// Resolver options shared by both of getOpenStatus's per-date lookups (today and yesterday), so
// the spillover half can never drift away from the today half.
const OPEN_NOW_RESOLVE_OPTS = { strictness: 'display', useIntervalsByDay: true };

// Yesterday's intervals that actually reach into today - the previous-day spillover set.
//
// Restricted to NON-dated-event activities on purpose (task section 8): a venue's weekly opening
// hours legitimately continue past midnight, but "was there a performance yesterday evening that
// is still running" is a question about EVENT occurrence semantics, which this phase does not
// change. The real catalogue currently contains zero overnight one_time rows, so this restriction
// costs nothing today - see the Phase 3 report's deferred-work list.
//
// Filtered to overnight intervals specifically (rather than handed wholesale to openWindows,
// which would also reject them arithmetically): the CALLER needs "is there any spillover at all"
// as a boolean, and yesterday's ordinary daytime hours must not count as one.
function previousDaySpillover(activity, isoDate) {
  const previous = resolveHoursForDate(activity, addDaysToIsoDate(isoDate, -1), OPEN_NOW_RESOLVE_OPTS);
  if (previous.isDatedEvent) return { previous, intervals: [] };
  return { previous, intervals: previous.intervals.filter(isOvernightInterval) };
}

// "Is this activity open right now" - the function lib/filterActivities.js#getOpenNowInfo
// delegates to. Returns the richer resolved-day object under `resolved` for future/optional use;
// getOpenNowInfo itself only forwards the 4 original fields, so no existing caller is affected.
//
// "Now" is Asia/Jerusalem civil time (Phase 3, correction A): the supplied instant is converted
// with lib/jerusalemTime.js, which derives Israel's wall clock from the UTC epoch and its own DST
// rule rather than from the device's timezone or from Intl. A phone in Prague, New York or Tokyo
// therefore gets the same answer about an Israeli venue as a phone in Tel Aviv. No network call,
// no timezone dependency.
//
// opts.now: inject a fixed Date for deterministic tests (mirrors filterActivities.js's own
// __setClockForTests pattern, but as an explicit parameter here rather than a shared mutable
// clock, since this module has no other stateful test dependency).
export function getOpenStatus(activity, opts = {}) {
  const now = opts.now || new Date();
  const jerusalem = toJerusalemParts(now);
  const isoDate = jerusalem.isoDate;
  const nowMinutes = jerusalem.minutesSinceMidnight;
  const day = resolveHoursForDate(activity, isoDate, OPEN_NOW_RESOLVE_OPTS);

  // hasScheduleData mirrors the pre-existing getOpenNowInfo definition exactly (independent of
  // whether `day` actually resolved an interval for today - it only asks "does *any* hours signal
  // exist for this activity at all", the same coarse meaning it always had).
  const todayHours = activity.hoursByDay && activity.hoursByDay[day.weekdayLetter];
  const hasScheduleData = !!(activity.openHours?.start && activity.openHours?.end) || !!todayHours;

  const availableDays = activity.availableDays || [];
  const dayIsAvailable = (letter) => availableDays.length === 0 || availableDays.includes(letter);
  const todayIncluded = day.isDatedEvent ? day.state !== 'closed' : dayIsAvailable(day.weekdayLetter);
  const todayIntervals = todayIncluded ? day.intervals : [];

  // Previous-day spillover (Phase 3, correction C). Only consulted for venue-style hours, and
  // only when today itself is not a dated event - see previousDaySpillover.
  let spillover = [];
  if (!day.isDatedEvent) {
    const { previous, intervals } = previousDaySpillover(activity, isoDate);
    if (dayIsAvailable(previous.weekdayLetter)) spillover = intervals;
  }

  // Nothing knowable for today at all AND nothing running over from yesterday. Keyed off
  // day.intervals rather than todayIntervals so that "today has hours but availableDays excludes
  // this weekday" still falls through to the definite closed answer below, exactly as before.
  if (!day.intervals.length && !spillover.length) {
    return { isOpen: false, hasScheduleData, minutesUntilClose: null, minutesUntilOpenToday: null, resolved: day };
  }

  const windows = [
    ...openWindows(todayIntervals, nowMinutes, 0),
    ...openWindows(spillover, nowMinutes, -MINUTES_PER_DAY),
  ];
  if (windows.length) {
    // Several windows can only overlap on genuinely odd data (e.g. yesterday's tail overlapping
    // today's first interval). The latest closing time is the honest answer to "until when".
    const minutesUntilClose = Math.max(...windows.map((w) => w.minutesUntilClose));
    return { isOpen: true, hasScheduleData: true, minutesUntilClose, minutesUntilOpenToday: null, resolved: day };
  }

  const nextStart = nextStartTodayMinutes(todayIntervals, nowMinutes);
  if (nextStart !== null) {
    return { isOpen: false, hasScheduleData: true, minutesUntilClose: null, minutesUntilOpenToday: nextStart - nowMinutes, resolved: day };
  }
  return { isOpen: false, hasScheduleData: true, minutesUntilClose: null, minutesUntilOpenToday: null, resolved: day };
}
