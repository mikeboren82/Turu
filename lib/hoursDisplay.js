// TuRu - pure hours DISPLAY data preparation (Opening Hours Phase 2). No react-native, no i18n -
// same layering as lib/scheduleSummary.js ("pure, no imports") feeding lib/i18n/format.js's
// locale-aware string builders, which feed components/WeeklyHoursSection.js. This module answers
// two questions with structured data only (dates, flags, resolved intervals, calendar facts) -
// never a Hebrew/English string:
//   buildTodayStatus(activity, opts)   - is it open right now, until/opens-when
//   buildUpcomingDays(activity, opts)  - the next 7 actual Israel-calendar dates
//
// Both are built on lib/hoursResolver.js#resolveHoursForDate with useIntervalsByDay:true, and
// "today" is anchored via lib/jerusalemTime.js (Israel-calendar semantics, per the product brief).
// This module adopted both in Phase 2, ahead of the rest of the app; as of Phase 3
// lib/filterActivities.js#getOpenNowInfo does too, so the two surfaces are no longer on different
// clocks or different interval data (architecture audit section F: device-outside-Israel bug).
// Phase 3 (2026-09-20): the midnight/overnight interval math now lives in lib/hoursResolver.js and
// is IMPORTED here rather than re-derived, so the Detail screen's "open now" row and the card
// badge (lib/filterActivities.js#getOpenNowInfo -> the same resolver) can never disagree about
// whether a 22:00-00:00 or 20:00-02:00 venue is open. addDaysToIsoDate moved there too - it was
// already identical, and previous-day spillover needs it on both sides.
import {
  resolveHoursForDate, addDaysToIsoDate, openWindows, nextStartTodayMinutes,
  isOvernightInterval, MINUTES_PER_DAY,
} from './hoursResolver';
import { jerusalemIsoDate, jerusalemMinutesSinceMidnight } from './jerusalemTime';

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
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

// Yesterday's intervals that run past midnight into today (Phase 3). Same rule as the resolver's
// own previousDaySpillover: venue hours only, never a dated event's occurrence times.
function previousDaySpillover(activity, todayIsoDate) {
  const previous = resolveHoursForDate(activity, addDaysToIsoDate(todayIsoDate, -1), { strictness: 'display', useIntervalsByDay: true });
  if (previous.isDatedEvent) return [];
  return previous.intervals.filter(isOvernightInterval);
}

// Whether `nowMinutes` falls inside one of today's (possibly several) intervals or inside an
// interval that started YESTERDAY and has not closed yet, or - if neither - the next interval
// later the SAME day. All interval arithmetic (a "00:00" end meaning 24:00, an end earlier than
// its start meaning "crosses midnight", yesterday's tail shifted onto today's minute axis) comes
// from lib/hoursResolver.js, so this row and the open-now badge share one implementation.
function statusWithinToday(intervals, spillover, nowMinutes) {
  const windows = [
    ...openWindows(intervals, nowMinutes, 0),
    ...openWindows(spillover, nowMinutes, -MINUTES_PER_DAY),
  ];
  if (windows.length) {
    // The latest closing time wins, so "פתוח · נסגר ב-" never under-reports on overlapping data.
    const best = windows.reduce((a, b) => (b.minutesUntilClose > a.minutesUntilClose ? b : a));
    return { isOpen: true, minutesUntilClose: best.minutesUntilClose, closesAt: best.interval.end, opensAt: null, minutesUntilOpen: null };
  }
  const nextStart = nextStartTodayMinutes(intervals, nowMinutes);
  if (nextStart !== null) {
    // Guarded on iv.start: nextStartTodayMinutes skips malformed intervals, so the one it
    // found is valid, but this scan walks the whole list to reach it.
    const upcoming = intervals.find((iv) => iv && iv.start && toMinutes(iv.start) === nextStart);
    return { isOpen: false, minutesUntilClose: null, closesAt: null, opensAt: upcoming.start, minutesUntilOpen: nextStart - nowMinutes };
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
  // Yesterday's overnight tail counts as "open now" even when today's own schedule is empty - a
  // venue whose only row is Friday 20:00-02:00 is genuinely open on Saturday at 00:30.
  const spillover = today.kind === 'unknown' ? [] : previousDaySpillover(activity, today.date);

  if (today.kind === 'unknown' || (!today.intervals.length && !spillover.length)) {
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

  const status = statusWithinToday(today.intervals, spillover, nowMinutes);
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
