// TuRu - temporal-search audit (2026-09-19): deterministic tests for resolveDateLabel and its
// helpers, using FIXED "today" strings (never the real current date - section 11 of the task).
// Run with `npx deno test --node-modules-dir=none supabase/functions/_shared/`.

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  resolveDateLabel, addDaysISO, dowOfISO, nextWeekdayOffset, daysUntilNextWeekSunday,
  isRealCalendarDate, toIsraelISODate,
} from './temporalResolve.ts';

// כל התאריכים-הקבועים למטה נבחרו כך שכל יום-בשבוע מכוסה לפחות פעם אחת (FRI=2026-09-18 עד
// יום שישי הבא, וכו') - "אל תכתבי בדיקות שתלויות באיזה יום ה-suite באמת רץ" (סעיף 11 בבקשה).
const SUN = '2026-09-13'; // ראשון
const MON = '2026-09-14'; // שני
const WED = '2026-09-16'; // רביעי
const THU = '2026-09-17'; // חמישי
const FRI = '2026-09-18'; // שישי
const SAT = '2026-09-19'; // שבת

Deno.test('dowOfISO: matches the real Gregorian weekday for every fixed date above', () => {
  assertEquals(dowOfISO(SUN), 0);
  assertEquals(dowOfISO(MON), 1);
  assertEquals(dowOfISO(WED), 3);
  assertEquals(dowOfISO(THU), 4);
  assertEquals(dowOfISO(FRI), 5);
  assertEquals(dowOfISO(SAT), 6);
});

Deno.test('היום / מחר / מחרתיים - relative to a fixed today, never Date.now()', () => {
  assertEquals(resolveDateLabel('today', null, null, WED), { whenOption: 'today', resolvedDate: WED });
  assertEquals(resolveDateLabel('tomorrow', null, null, WED), { whenOption: 'tomorrow', resolvedDate: THU });
  assertEquals(resolveDateLabel('day_after_tomorrow', null, null, WED), { whenOption: 'specific', resolvedDate: FRI });
});

Deno.test('בעוד 3 ימים / בעוד יומיים (in_days)', () => {
  assertEquals(resolveDateLabel('in_days', 3, null, WED), { whenOption: 'specific', resolvedDate: SAT });
  assertEquals(resolveDateLabel('in_days', 2, null, WED), { whenOption: 'specific', resolvedDate: FRI });
  // gibberish/out-of-range offsets never silently produce a wrong date
  assertEquals(resolveDateLabel('in_days', -1, null, WED), { whenOption: null, resolvedDate: null });
  assertEquals(resolveDateLabel('in_days', 61, null, WED), { whenOption: null, resolvedDate: null });
});

Deno.test('שבת / השבת הקרובה: nearest Saturday INCLUDING today when today already is Saturday', () => {
  assertEquals(resolveDateLabel('this_saturday', null, null, WED), { whenOption: 'specific', resolvedDate: SAT });
  assertEquals(resolveDateLabel('this_saturday', null, null, SAT), { whenOption: 'specific', resolvedDate: SAT }, 'today IS Saturday -> today, not next week');
  // "ראשון הקרוב" said on a Sunday -> today (section 6's own example)
  assertEquals(resolveDateLabel('this_sunday', null, null, SUN), { whenOption: 'specific', resolvedDate: SUN });
});

Deno.test('שבת הבאה: next CALENDAR WEEK Saturday, distinct from this_saturday', () => {
  // today=Wed: this_saturday=this coming Sat (+3d); next_saturday must be a full week later (+10d)
  assertEquals(resolveDateLabel('this_saturday', null, null, WED).resolvedDate, addDaysISO(WED, 3));
  assertEquals(resolveDateLabel('next_saturday', null, null, WED).resolvedDate, addDaysISO(WED, 10));
  // today=Saturday itself: this_saturday=today; next_saturday=a full week from today
  assertEquals(resolveDateLabel('this_saturday', null, null, SAT).resolvedDate, SAT);
  assertEquals(resolveDateLabel('next_saturday', null, null, SAT).resolvedDate, addDaysISO(SAT, 7));
  // "ראשון הבא" said on a Sunday -> next week's Sunday, i.e. +7 days (section 6's own example)
  assertEquals(resolveDateLabel('next_sunday', null, null, SUN).resolvedDate, addDaysISO(SUN, 7));
});

Deno.test('השבוע: today through the coming Saturday INCLUSIVE - not a rolling 7 days', () => {
  // this_week resolves to whenOption:'week' with no single resolvedDate - the actual day-offset
  // list is computed client-side (lib/filterActivities.js#optionDayOffsets); tested there.
  assertEquals(resolveDateLabel('this_week', null, null, WED), { whenOption: 'week', resolvedDate: null });
});

Deno.test('שבוע הבא: a distinct symbolic range from השבוע', () => {
  assertEquals(resolveDateLabel('next_week', null, null, WED), { whenOption: 'next_week', resolvedDate: null });
});

Deno.test('daysUntilNextWeekSunday: tomorrow when today is Saturday, a full week when today is Sunday', () => {
  assertEquals(daysUntilNextWeekSunday(SAT), 1);
  assertEquals(daysUntilNextWeekSunday(SUN), 7);
  assertEquals(daysUntilNextWeekSunday(WED), 4);
});

Deno.test('nextWeekdayOffset: 0 when today already is the target weekday', () => {
  assertEquals(nextWeekdayOffset(SAT, 6), 0);
  assertEquals(nextWeekdayOffset(WED, 3), 0);
  assertEquals(nextWeekdayOffset(WED, 6), 3); // Wed -> this Saturday
});

Deno.test('isRealCalendarDate: rejects impossible dates instead of silently rolling over', () => {
  assertEquals(isRealCalendarDate('2026-09-25'), true);
  assertEquals(isRealCalendarDate('2026-09-31'), false, '31.9 does not exist - must not become Oct 1');
  assertEquals(isRealCalendarDate('2026-11-31'), false, '31.11 does not exist either');
  assertEquals(isRealCalendarDate('2026-02-30'), false);
  assertEquals(isRealCalendarDate('2026-13-01'), false, 'month 13 is not valid');
  assertEquals(isRealCalendarDate('2026-9-5'), false, 'must be zero-padded YYYY-MM-DD');
  assertEquals(isRealCalendarDate('not-a-date'), false);
});

Deno.test('explicit date: future day/month this year is kept as-is', () => {
  // today=2026-09-18, "25.9" (no year, assumed current year by the model) -> stays 2026-09-25
  assertEquals(resolveDateLabel('specific_date', null, '2026-09-25', FRI), { whenOption: 'specific', resolvedDate: '2026-09-25' });
});

// --- explicitDateYearGiven regression (2026-09-19): the roll-forward-a-year behavior must apply
// ONLY when the user gave no year themselves - never when they gave an explicit (even past) year.
// This distinction was reported missing after the first pass ("10.9.2025" was being silently
// rolled to a different year exactly like bare "10.9") - see resolveDateLabel's own comment.

Deno.test('explicit date, NO year given ("10.9"): already passed this year -> rolls to next year (section 8 example)', () => {
  // today=2026-09-18, "10.9" (no year -> model assumes current year -> 2026-09-10, already past)
  // -> code rolls forward to 2027-09-10, exactly the example given in the task.
  assertEquals(
    resolveDateLabel('specific_date', null, '2026-09-10', FRI, false),
    { whenOption: 'specific', resolvedDate: '2027-09-10' },
  );
});

Deno.test('explicit date, YEAR EXPLICITLY GIVEN ("10.9.2025"): already past -> rejected, NEVER rolled to a different year', () => {
  // The user said 2025 on purpose - even though it has passed, the code must not "fix" it by
  // substituting 2026 or 2027. Rejecting (whenOption:null) is the correct, honest outcome.
  assertEquals(
    resolveDateLabel('specific_date', null, '2025-09-10', FRI, true),
    { whenOption: null, resolvedDate: null },
  );
});

Deno.test('explicit date, YEAR EXPLICITLY GIVEN and in the future ("10.9.2027"): kept exactly as given', () => {
  assertEquals(
    resolveDateLabel('specific_date', null, '2027-09-10', FRI, true),
    { whenOption: 'specific', resolvedDate: '2027-09-10' },
  );
});

Deno.test('explicit date: missing/omitted explicitDateYearGiven defaults to false (backward compatible with old call sites)', () => {
  // no 5th argument at all - must behave exactly like explicitDateYearGiven=false (roll forward).
  assertEquals(resolveDateLabel('specific_date', null, '2026-09-10', FRI), { whenOption: 'specific', resolvedDate: '2027-09-10' });
});

Deno.test('explicit date: invalid calendar date (31.9) is rejected outright, never rolled to October', () => {
  const r = resolveDateLabel('specific_date', null, '2026-09-31', FRI);
  assertEquals(r, { whenOption: null, resolvedDate: null });
});

Deno.test('explicit date: a real future date already in a later year is kept unchanged', () => {
  assertEquals(resolveDateLabel('specific_date', null, '2027-03-01', FRI), { whenOption: 'specific', resolvedDate: '2027-03-01' });
});

Deno.test('unrecognized/null date_label resolves to nothing (never guesses)', () => {
  assertEquals(resolveDateLabel(null, null, null, WED), { whenOption: null, resolvedDate: null });
  assertEquals(resolveDateLabel('some_future_label_the_model_invented', null, null, WED), { whenOption: null, resolvedDate: null });
});

Deno.test('toIsraelISODate: a UTC instant maps to the correct Israel calendar date across the day boundary', () => {
  // 2026-01-15 22:30 UTC = 2026-01-16 00:30 Israel time (UTC+2 in January) - the calendar date
  // must already have rolled over to the 16th in Israel, even though it is still the 15th in UTC.
  assertEquals(toIsraelISODate(new Date('2026-01-15T22:30:00Z')), '2026-01-16');
});
