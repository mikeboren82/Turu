// TuRu - deterministic date-label resolution (2026-09-19, temporal-search audit item E.3, moved out
// of smart-search/index.ts so it is directly unit-testable - see temporalResolve.test.ts).
//
// Architectural principle (unchanged): the model only classifies a phrase into one of the fixed
// date_label values in buildSystemPrompt (smartSearchIntent.ts) - it never computes a calendar date
// itself. Every actual date computation lives here, in small pure functions.
//
// Timezone (section 12): every function here is anchored to a YYYY-MM-DD calendar-date STRING that
// the caller already resolved in Asia/Jerusalem (toIsraelISODate, using the real "now" only once, at
// the entry point). From that string on, all arithmetic goes through Date.UTC + toISOString/getUTCDay -
// never a bare `new Date("YYYY-MM-DD...")` parse - so the result never depends on the runtime's own
// local timezone (Deno Deploy's, a test runner's, or anyone's), only on the calendar date itself.

export function toIsraelISODate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
}

export const HEBREW_DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// "שבת" / "השבת הקרובה" / "ביום שלישי" - הקרוב ביותר, כולל היום עצמו אם היום כבר אותו יום.
export const WEEKDAY_LABEL_TO_DOW: Record<string, number> = {
  this_sunday: 0, this_monday: 1, this_tuesday: 2, this_wednesday: 3,
  this_thursday: 4, this_friday: 5, this_saturday: 6,
};
// "שבת הבאה" / "יום ראשון הבא" (סעיף 6) - אותו יום-בשבוע, אבל בשבוע הקלנדרי *הבא*, לא הקרוב ביותר.
export const NEXT_WEEKDAY_LABEL_TO_DOW: Record<string, number> = {
  next_sunday: 0, next_monday: 1, next_tuesday: 2, next_wednesday: 3,
  next_thursday: 4, next_friday: 5, next_saturday: 6,
};

function parseISODate(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

// חשבון-תאריכים טהור, מעוגן ל-Date.UTC - לעולם לא "מתגלגל" דרך אזור-הזמן המקומי של ה-runtime
// (סעיף 12): אותו קלט YYYY-MM-DD מייצר תמיד את אותה תוצאה, בלי קשר לאיפה הקוד רץ בפועל.
export function addDaysISO(todayISO: string, days: number): string {
  const { y, m, d } = parseISODate(todayISO);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function dowOfISO(iso: string): number {
  const { y, m, d } = parseISODate(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function nextWeekdayOffset(todayISO: string, targetDow: number): number {
  const diff = targetDow - dowOfISO(todayISO);
  return diff < 0 ? diff + 7 : diff;
}

// ימים מ-todayISO עד יום ראשון שפותח את השבוע הקלנדרי *הבא* - היום ש'(6)->1 (מחר), היום א'(0)->7
// (שבוע שלם קדימה). בסיס גם ל-'next_week' (המרחק עד היום הזה) וגם ל-next_<weekday> (מוסיפים dow).
export function daysUntilNextWeekSunday(todayISO: string): number {
  return 7 - dowOfISO(todayISO);
}

// דוחה תאריכים בלתי-אפשריים בלוח השנה (31.9) במקום לתת ל-JS "לגלגל" אותם בשקט לחודש הבא (31.9 ->
// 1.10) - השוואת round-trip דרך Date.UTC תופסת בדיוק את זה: אם מה שחזר לא זהה למה שביקשנו, זה נדחה.
export function isRealCalendarDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const { y, m, d } = parseISODate(iso);
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// ממיר date_label (סיווג מה-AI) לתאריך אמיתי + ה-WHEN_OPTIONS id המתאים (constants/filterSchema.js) -
// חישוב דטרמיניסטי, לא תלוי-AI. מחזיר {whenOption, resolvedDate} - שניהם עשויים להיות null.
// explicitDateYearGiven (2026-09-19, תיקון-רגרסיה): true אם המשתמש עצמו כתב שנה מפורשת (למשל
// "10.9.2025"), false אם נתן רק יום+חודש והמודל מילא את השנה הנוכחית בעצמו ("10.9"). ברירת-
// המחדל (false) משמרת את ההתנהגות הישנה לקריאות שלא מעבירות את הפרמטר (בדיקות קיימות) - ראו
// case 'specific_date' למטה להבחנה בין שני המקרים.
export function resolveDateLabel(
  label: string | null, daysOffset: number | null, explicitDate: string | null, todayISO: string,
  explicitDateYearGiven = false,
): { whenOption: string | null; resolvedDate: string | null } {
  if (label && label in WEEKDAY_LABEL_TO_DOW) {
    return { whenOption: 'specific', resolvedDate: addDaysISO(todayISO, nextWeekdayOffset(todayISO, WEEKDAY_LABEL_TO_DOW[label])) };
  }
  if (label && label in NEXT_WEEKDAY_LABEL_TO_DOW) {
    const targetDow = NEXT_WEEKDAY_LABEL_TO_DOW[label];
    return { whenOption: 'specific', resolvedDate: addDaysISO(todayISO, daysUntilNextWeekSunday(todayISO) + targetDow) };
  }
  switch (label) {
    case 'today': return { whenOption: 'today', resolvedDate: todayISO };
    case 'tomorrow': return { whenOption: 'tomorrow', resolvedDate: addDaysISO(todayISO, 1) };
    case 'day_after_tomorrow': return { whenOption: 'specific', resolvedDate: addDaysISO(todayISO, 2) };
    case 'weekend': return { whenOption: 'weekend', resolvedDate: null };
    case 'this_week': return { whenOption: 'week', resolvedDate: null };
    case 'next_week': return { whenOption: 'next_week', resolvedDate: null };
    case 'in_days': {
      const n = typeof daysOffset === 'number' && daysOffset >= 0 && daysOffset <= 60 ? daysOffset : null;
      return n == null ? { whenOption: null, resolvedDate: null } : { whenOption: 'specific', resolvedDate: addDaysISO(todayISO, n) };
    }
    case 'specific_date': {
      // תוקן (audit item 8): היה רק regex-פורמט + "לא בעבר" (דוחה, לא מגלגל-שנה). עכשיו: תאריך-
      // קלנדרי אמיתי (לא רק פורמט). תאריך-עבר מגולגל שנה אחת קדימה *רק* כשהמשתמש לא נתן שנה
      // בעצמו ("10.9" עם היום=2026-09-18 -> המודל מילא את השנה הנוכחית, "2026-09-10", כבר עבר
      // -> כאן הופך ל"2027-09-10"). תוקן שוב (2026-09-19, regression): "10.9.2025" (שנה מפורשת,
      // כבר עברה) *לא* מגולגל לשנה אחרת - נדחה, בדיוק כמו מדיניות-תאריך-עבר שהייתה לפני התיקון
      // הראשון - המשתמש התכוון לשנה הזו במפורש, אסור "לתקן" אותה בשקט (עקרון: null עדיף על שגוי).
      if (!explicitDate || !isRealCalendarDate(explicitDate)) return { whenOption: null, resolvedDate: null };
      if (explicitDate >= todayISO) return { whenOption: 'specific', resolvedDate: explicitDate };
      if (explicitDateYearGiven) return { whenOption: null, resolvedDate: null };
      const { y, m, d } = parseISODate(explicitDate);
      const rolled = `${y + 1}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (!isRealCalendarDate(rolled) || rolled < todayISO) return { whenOption: null, resolvedDate: null };
      return { whenOption: 'specific', resolvedDate: rolled };
    }
    default:
      return { whenOption: null, resolvedDate: null };
  }
}
