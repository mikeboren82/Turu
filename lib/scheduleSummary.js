// TuRu - schedule summary for the app (pure, no imports). Occurrence-aware (2026-09-14): an event may
// hold several `one_time` rows (its performances, each with its own time). Past occurrences are kept in
// the DB until the last one passes (expiry cron), so the summary looks only at UPCOMING ones - and for
// an activity with a single row it produces exactly what it produced before (parity pinned by
// tools/import-tool/tests/scheduleSummary.test.js).
export const DAY_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
export const DAY_NAME_TO_LETTER = {
  ראשון: 'א', שני: 'ב', שלישי: 'ג', רביעי: 'ד', חמישי: 'ה', שישי: 'ו', שבת: 'ש',
};

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const hhmm = (t) => (t ? String(t).slice(0, 5) : null);

// upcoming one_time rows sorted by date+time; when none is upcoming, all one_time rows (legacy behaviour
// for a single past row that the cron has not archived yet)
export function upcomingOccurrences(schedules, today = isoToday()) {
  const dated = (schedules || []).filter((s) => s.schedule_type === 'one_time' && s.one_time_date)
    .map((s) => ({ date: String(s.one_time_date).slice(0, 10), start: hhmm(s.start_time), end: hhmm(s.end_time), bookingUrl: s.booking_url || null }))
    .sort((a, b) => (a.date + (a.start || '')).localeCompare(b.date + (b.start || '')));
  const upcoming = dated.filter((o) => o.date >= today);
  return upcoming.length ? upcoming : dated;
}

export function summarizeSchedules(schedules, today = isoToday()) {
  if (!schedules || schedules.length === 0) {
    return { availableDays: [], openHours: null, hours: 'שעות לא צוינו', occurrences: [], nextDate: null };
  }
  const occurrences = upcomingOccurrences(schedules, today);
  const nextOcc = occurrences[0] || null;
  const availableDaysSet = new Set();
  const recurringDayNames = [];
  let earliestStart = null;
  let latestEnd = null;

  const consider = (start, end) => {
    if (start && (earliestStart === null || start < earliestStart)) earliestStart = start;
    if (end && (latestEnd === null || end > latestEnd)) latestEnd = end;
  };
  schedules.forEach((s) => {
    if (s.schedule_type === 'recurring' && s.day_of_week) {
      consider(hhmm(s.start_time), hhmm(s.end_time));
      const letter = DAY_NAME_TO_LETTER[s.day_of_week];
      if (letter) availableDaysSet.add(letter);
      recurringDayNames.push(s.day_of_week);
    } else if (s.schedule_type === 'fixed_hours') {
      consider(hhmm(s.start_time), hhmm(s.end_time));
      DAY_LETTERS.forEach((l) => availableDaysSet.add(l));
    }
  });
  // dated performances: only the upcoming ones count as available days / hours (the next one leads)
  occurrences.forEach((o) => {
    const d = new Date(o.date);
    availableDaysSet.add(DAY_LETTERS[d.getDay()]);
  });
  if (nextOcc) consider(nextOcc.start, nextOcc.end);
  else occurrences.forEach((o) => consider(o.start, o.end));

  const openHours = earliestStart && latestEnd ? { start: earliestStart, end: latestEnd } : null;

  let hours = 'שעות לא צוינו';
  if (openHours) {
    hours = `${openHours.start}–${openHours.end}`;
    if (recurringDayNames.length > 0 && recurringDayNames.length <= 3) {
      hours += ` (${recurringDayNames.join('׳, ')}׳)`;
    }
  } else if (nextOcc) {
    hours = new Date(nextOcc.date).toLocaleDateString('he-IL');
  }
  if (nextOcc && occurrences.length > 1) hours += ` (+${occurrences.length - 1} מועדים)`;

  // recurringDays: canonical Hebrew day names, for locale-aware display (lib/i18n/format.js scheduleHoursLabel).
  // `hours` keeps the original Hebrew text for this pure module's tests; the app displays scheduleHoursLabel().
  return { availableDays: Array.from(availableDaysSet), openHours, hours, occurrences, nextDate: nextOcc ? nextOcc.date : null, recurringDays: recurringDayNames };
}
