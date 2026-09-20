// TuRu - pure hours DISPLAY data preparation (Opening Hours Phase 2). No react-native, no i18n -
// same layering as lib/scheduleSummary.js ("pure, no imports") feeding lib/i18n/format.js's
// locale-aware string builders, which feed components/WeeklyHoursSection.js. This module answers
// two questions with structured data only (dates, flags, resolved intervals, calendar facts) -
// never a Hebrew/English string:
//   buildTodayStatus(activity, opts)   - is it open right now, until/opens-when
//   buildUpcomingDays(activity, opts)  - the next 7 actual Israel-calendar dates
//
// Both are built on lib/hoursResolver.js#resolveHoursForDate (Phase 1) with useIntervalsByDay:true
// - this is exactly the "future caller" that option was added for; it does NOT affect
// lib/filterActivities.js#getOpenNowInfo, which stays on useIntervalsByDay:false for parity.
// "Today" is anchored via lib/jerusalemTime.js (Israel-calendar semantics, per the product brief),
// independent of getOpenNowInfo's still-device-local "now" - a deliberate difference: this is a
// brand-new UI surface with no prior baseline to preserve parity against, and Jerusalem-anchoring
// is more correct (architecture audit section F: device-outside-Israel bug).
import { resolveHoursForDate } from './hoursResolver';
import { jerusalemIsoDate, jerusalemMinutesSinceMidnight } from './jerusalemTime';

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function addDaysToIsoDate(isoDate, days) {
  // Pure calendar-date arithmetic in UTC (not wall-clock/local-time math) - free of DST edge
  // cases entirely, since we only ever add whole days to a date STRING, never to a Date carrying
  // a time-of-day.
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// UI-facing kind: 'weekly' and 'fixed' (both resolver kinds, see lib/hoursResolver.js#classifyKind)
// get identical Detail treatment (the expandable 7-day view) - "open the same hours every day"
// (fixed) is just a special case of "open on a weekly pattern" (weekly) for display purposes, even
// though the resolver still distinguishes them internally for anyone who needs the finer signal.
function displayKind(resolverKind) {
  if (resolverKind === 'fixed') return 'weekly';
  return resolverKind; // 'weekly' | 'occurrence' | 'unknown'
}

const DEFAULT_HORIZON_DAYS = 6; // today (offset 0) + next 6 = 7 calendar dates total

// One resolved day, for either buildUpcomingDays or buildTodayStatus's internal lookahead.
function resolveDayRow(activity, isoDate, offsetDays) {
  const day = resolveHoursForDate(activity, isoDate, { strictness: 'display', useIntervalsByDay: true });
  return {
    date: isoDate,
    offsetDays,
    isToday: offsetDays === 0,
    isTomorrow: offsetDays === 1,
    weekdayLetter: day.weekdayLetter,
    kind: displayKind(day.kind),
    state: day.state, // 'open' | 'always_open' | 'closed' | 'unknown'
    intervals: day.intervals, // multi-interval-aware ([] when closed/unknown)
    holidays: day.calendar.holidays, // calendar FACT(s) for this date, independent of the warning
    warning: day.warning, // TURU POLICY verdict for this date, or null
  };
}

// The next 7 actual Israel-calendar dates starting today, each already resolved. Works for any
// activity shape - the caller decides whether `kind` warrants the weekly-hours UI at all
// (components/WeeklyHoursSection.js only renders this for kind 'weekly').
export function buildUpcomingDays(activity, opts = {}) {
  const now = opts.now || new Date();
  const horizonDays = opts.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const startIso = jerusalemIsoDate(now);
  const days = [];
  for (let offset = 0; offset <= horizonDays; offset++) {
    days.push(resolveDayRow(activity, addDaysToIsoDate(startIso, offset), offset));
  }
  return days;
}

// Whether `nowMinutes` falls inside one of today's (possibly several) intervals, or - if not -
// the next one later the SAME day. Intervals are sorted defensively (accumulation order from
// lib/scheduleSummary.js#intervalsByDay is insertion order, not guaranteed sorted).
function statusWithinToday(intervals, nowMinutes) {
  const sorted = [...intervals].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  for (const iv of sorted) {
    const start = toMinutes(iv.start);
    const end = toMinutes(iv.end); // raw, no end-of-day correction - see lib/hoursResolver.js's
    // own note: the "00:00 means 24:00" fix is deliberately NOT activated in this phase (task
    // section 11). A 20:00-00:00 interval will therefore report closed at 23:30 here too, exactly
    // as lib/filterActivities.js#getOpenNowInfo already does - not a new gap introduced by Phase 2.
    if (nowMinutes >= start && nowMinutes <= end) {
      return { isOpen: true, minutesUntilClose: end - nowMinutes, closesAt: iv.end, opensAt: null, minutesUntilOpen: null };
    }
  }
  const upcoming = sorted.find((iv) => toMinutes(iv.start) > nowMinutes);
  if (upcoming) {
    return { isOpen: false, minutesUntilClose: null, closesAt: null, opensAt: upcoming.start, minutesUntilOpen: toMinutes(upcoming.start) - nowMinutes };
  }
  return { isOpen: false, minutesUntilClose: null, closesAt: null, opensAt: null, minutesUntilOpen: null };
}

// Scans forward across `days` (already-resolved, from buildUpcomingDays) for the first date with
// a usable opening time, STARTING AFTER today (offset >= 1) - used when today has nothing left to
// open for. Returns null when nothing opens within the given horizon (never guessed further out).
function nextOpeningAfterToday(days) {
  for (let i = 1; i < days.length; i++) {
    const day = days[i];
    if (day.intervals.length) {
      const first = [...day.intervals].sort((a, b) => toMinutes(a.start) - toMinutes(b.start))[0];
      return { offsetDays: day.offsetDays, date: day.date, weekdayLetter: day.weekdayLetter, time: first.start };
    }
  }
  return null;
}

// "Is this activity open right now, and until/opens when" - the data behind the collapsed status
// row. Only meaningful for kind 'weekly' (the caller should not call this for 'occurrence' -
// occurrence-kind activities have their own, date-specific status; see components/
// WeeklyHoursSection.js's OccurrenceStatusRow, which reads activity.occurrences directly instead).
export function buildTodayStatus(activity, opts = {}) {
  const now = opts.now || new Date();
  const days = opts.days || buildUpcomingDays(activity, { now, horizonDays: DEFAULT_HORIZON_DAYS });
  const today = days[0];
  const nowMinutes = jerusalemMinutesSinceMidnight(now);

  if (today.kind === 'unknown' || !today.intervals.length) {
    // No usable hours today specifically. Still worth telling the user WHEN it next opens, if
    // that's knowable within the horizon (matches the brief's "סגור עכשיו · נפתח מחר ב-09:00").
    const nextOpening = nextOpeningAfterToday(days);
    return {
      kind: today.kind, state: today.state, isOpen: false, minutesUntilClose: null, closesAt: null,
      opensAt: null, minutesUntilOpen: null, nextOpening,
      todayHolidays: today.holidays, todayWarning: today.warning, today,
    };
  }

  if (today.state === 'always_open') {
    return {
      kind: today.kind, state: 'always_open', isOpen: true, minutesUntilClose: null, closesAt: null,
      opensAt: null, minutesUntilOpen: null, nextOpening: null,
      todayHolidays: today.holidays, todayWarning: today.warning, today,
    };
  }

  const status = statusWithinToday(today.intervals, nowMinutes);
  const nextOpening = !status.isOpen && !status.opensAt ? nextOpeningAfterToday(days) : null;
  return {
    kind: today.kind, state: today.state, isOpen: status.isOpen, minutesUntilClose: status.minutesUntilClose,
    closesAt: status.closesAt,
    // opensAt: a later interval THE SAME day (e.g. a lunch-break schedule); nextOpening: a future
    // DATE - mutually exclusive, never both set.
    opensAt: status.opensAt, minutesUntilOpen: status.minutesUntilOpen, nextOpening,
    todayHolidays: today.holidays, todayWarning: today.warning, today,
  };
}
