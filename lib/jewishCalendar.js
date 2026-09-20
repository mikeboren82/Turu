// Runtime Israeli/Jewish calendar FACT lookup - reads the pre-generated table only, never
// @hebcal/core itself (a devDependency, see scripts/generate-holidays.js). Synchronous, no I/O,
// cheap (a single Map hit per date) - safe to call per-activity while filtering the whole
// catalog (architecture audit section C/J).
//
// This module answers "what does the calendar say about this date" only. It does NOT decide
// whether that fact should produce a user-facing "hours may vary" warning - that policy layer
// is deliberately separate, see lib/hoursPolicy.js.
import holidayTable from '../constants/holidays.generated.json';

// { key, nameHe, nameEn, class, isErev }
// class one of: yom_tov | erev_yom_tov | yom_kippur | erev_yom_kippur | chol_hamoed |
//               major_fast | minor_fast | civic_major | civic_minor | purim | chanukah |
//               minor_holiday | rosh_chodesh
export function holidaysOnDate(isoDate) {
  return holidayTable.days[isoDate] || [];
}

export function isHolidayDate(isoDate) {
  return holidaysOnDate(isoDate).length > 0;
}

export function holidayTableRange() {
  return { start: holidayTable.meta.rangeStart, end: holidayTable.meta.rangeEnd };
}

export function holidayTableMeta() {
  return holidayTable.meta;
}

// How many whole future years (from `fromDate`) the generated table still covers - the signal
// the coverage test (tests/jewishCalendar.test.js) uses to decide the table needs regenerating
// (via `npm run holidays:generate`), instead of ever hardcoding a "this expires in year X" date.
export function remainingFutureYears(fromDate = new Date()) {
  const rangeEndYear = Number(holidayTable.meta.rangeEnd.slice(0, 4));
  return rangeEndYear - fromDate.getFullYear();
}
