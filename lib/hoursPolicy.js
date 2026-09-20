// TURU's opening-hours warning POLICY - separate from calendar FACT (lib/jewishCalendar.js), per
// the architecture audit (section G): "This date is X" is a calendar fact; "this date should
// trigger a possible-hours-change warning" is a TURU product decision, and the two must not be
// fused together, so the warn/no-warn set can be reconfigured later without touching calendar data.
//
// A warning NEVER means "these are the special hours" - TURU does not fabricate hours (matches
// the existing ingestion principle already documented at supabase/functions/_shared/extraction.ts:
// "hours are never fabricated"). It only means the activity's ordinary/regular hours are not to be
// fully trusted for this specific date, until a verified date-specific override exists (future work,
// architecture audit section H/I - out of scope for this phase).
import { holidaysOnDate } from './jewishCalendar';

// Initial direction from the product brief. Keys are lib/jewishCalendar.js `class` values.
export const HOLIDAY_WARNING_POLICY = Object.freeze({
  yom_tov: true,
  erev_yom_tov: true,
  yom_kippur: true,
  erev_yom_kippur: true,
  chol_hamoed: true,
  major_fast: true, // Tish'a B'Av + its erev - meaningful commercial-hours impact, not a "chag"
  civic_major: true, // Yom HaZikaron / Yom HaAtzma'ut

  // Explicitly configurable, default ON per the product brief - not a calendar fact, a TURU choice.
  purim: true,
  chanukah: true,

  // No general commercial-hours signal (product decision, matches the brief's explicit examples).
  minor_fast: false, // sunrise-to-sunset personal fasts (Tzom Gedaliah, Ta'anit Esther, ...) - same reasoning as Tu BiShvat/Lag BaOmer
  minor_holiday: false, // Tu BiShvat, Lag BaOmer, Pesach Sheni, ...
  rosh_chodesh: false,
  civic_minor: false, // school-observance days (Family Day, Jabotinsky Day, Ben-Gurion Day, Yom HaShoah, Yom Yerushalayim, ...)
});

export function classWarns(holidayClass, policy = HOLIDAY_WARNING_POLICY) {
  return !!policy[holidayClass];
}

// { holidays: [...facts for this date], warning: null | { kind, nameHe, holidayKey } }
// When several holiday facts land on the same date (e.g. Rosh Chodesh coinciding with Chanukah),
// exactly one warning is produced - from the first warn-eligible fact - never one warning per fact.
export function resolveHolidayWarning(isoDate, policy = HOLIDAY_WARNING_POLICY) {
  const holidays = holidaysOnDate(isoDate);
  if (holidays.length === 0) return { holidays, warning: null };
  const warnedBy = holidays.find((h) => classWarns(h.class, policy));
  if (!warnedBy) return { holidays, warning: null };
  return {
    holidays,
    warning: { kind: 'holiday_hours_may_vary', nameHe: warnedBy.nameHe, holidayKey: warnedBy.key },
  };
}
