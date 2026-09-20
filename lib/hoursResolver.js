// Unified hours resolver (architecture audit section J/K) - the shared semantic layer that will
// eventually replace the separate interpretations duplicated across lib/filterActivities.js
// (getOpenNowInfo, hourMatchesOnOffset), lib/i18n/format.js (scheduleHoursLabel), and
// lib/shareActivity.js. In THIS phase only lib/filterActivities.js#getOpenNowInfo is switched to
// delegate here (task section 10) - every other consumer is untouched.
//
// Two audiences, one implementation:
//   resolveHoursForDate(activity, isoDate, opts) - general per-date resolution (any date, past or
//     future). This is the future-facing layer for the not-yet-built 7-day view; nothing consumes
//     it live yet.
//   getOpenStatus(activity, opts) - "is it open right now" for TODAY specifically. This is what
//     getOpenNowInfo delegates to, and its interval math is deliberately restricted to the exact
//     same data (hoursByDay / openHours, single interval) and exact same arithmetic (no
//     end-of-day midnight correction) as the pre-existing getOpenNowInfo, so switching to it is a
//     no-op for every existing caller. See the `useIntervalsByDay` and overnight-normalization
//     notes below for what is deliberately NOT yet activated.
import { DAY_LETTERS } from './scheduleSummary';
import { resolveHolidayWarning } from './hoursPolicy';

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// "00:00" as an end time means end-of-day (24:00), not midnight-start - the same convention
// lib/filterActivities.js's search path (toEndMinutes) already uses. NOT applied by getOpenStatus
// (see below) - getOpenNowInfo never applied it either, and changing that is a separate, later,
// explicitly-reviewed step (task section 8). Exported so a future consumer (or a later phase of
// this same resolver) can opt in without duplicating the arithmetic.
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
// step-7 multiple-interval-per-day foundation) over the single-interval activity.hoursByDay.
// Left OFF by default and unused by getOpenStatus below: intervalsByDay can legitimately hold
// MORE information than hoursByDay for a weekday with more than one schedule row (hoursByDay
// keeps only the last row - "last one wins", lib/scheduleSummary.js:56), and surfacing that
// automatically would change today's open-now answer for such activities. That activation is a
// separate, later, explicitly-reviewed step (task section 7/8) - this flag exists so the richer
// data is already available to a future caller (e.g. the 7-day view) without waiting on it.
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
      state = isAlwaysOpenInterval(intervals[0]) ? 'always_open' : 'open';
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
      state = isAlwaysOpenInterval(intervals[0]) ? 'always_open' : 'open';
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

// Device-local "today" as YYYY-MM-DD, matching the exact convention getOpenNowInfo already used
// (new Date()'s own local getters) - NOT Jerusalem-time-aware. See the file-level comment: that
// is intentional in this phase, so getOpenStatus is a byte-for-byte-safe replacement.
function isoDateFromLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// "Is this activity open right now" - the function lib/filterActivities.js#getOpenNowInfo
// delegates to. Returns the richer resolved-day object under `resolved` for future/optional use;
// getOpenNowInfo itself only forwards the 4 original fields, so no existing caller is affected.
//
// opts.now: inject a fixed Date for deterministic tests (mirrors filterActivities.js's own
// __setClockForTests pattern, but as an explicit parameter here rather than a shared mutable
// clock, since this module has no other stateful test dependency).
export function getOpenStatus(activity, opts = {}) {
  const now = opts.now || new Date();
  const isoDate = isoDateFromLocalDate(now);
  const day = resolveHoursForDate(activity, isoDate, { strictness: 'display', useIntervalsByDay: false });

  // hasScheduleData mirrors the pre-existing getOpenNowInfo definition exactly (independent of
  // whether `day` actually resolved an interval for today - it only asks "does *any* hours signal
  // exist for this activity at all", the same coarse meaning it always had).
  const todayHours = activity.hoursByDay && activity.hoursByDay[day.weekdayLetter];
  const hasScheduleData = !!(activity.openHours?.start && activity.openHours?.end) || !!todayHours;

  if (!day.intervals.length) {
    return { isOpen: false, hasScheduleData, minutesUntilClose: null, minutesUntilOpenToday: null, resolved: day };
  }

  const availableDays = activity.availableDays || [];
  const todayIncluded = day.isDatedEvent
    ? day.state !== 'closed'
    : (availableDays.length === 0 || availableDays.includes(day.weekdayLetter));

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const { start, end } = day.intervals[0];
  const startMinutes = toMinutes(start);
  const endMinutes = toMinutes(end); // raw - no end-of-day correction, matches getOpenNowInfo exactly

  if (todayIncluded && nowMinutes >= startMinutes && nowMinutes <= endMinutes) {
    return { isOpen: true, hasScheduleData: true, minutesUntilClose: endMinutes - nowMinutes, minutesUntilOpenToday: null, resolved: day };
  }
  if (todayIncluded && nowMinutes < startMinutes) {
    return { isOpen: false, hasScheduleData: true, minutesUntilClose: null, minutesUntilOpenToday: startMinutes - nowMinutes, resolved: day };
  }
  return { isOpen: false, hasScheduleData: true, minutesUntilClose: null, minutesUntilOpenToday: null, resolved: day };
}
