import { WHEN_OPTIONS, HOUR_OPTIONS } from '../constants/filterSchema';
import { t, listJoin, formatDate } from './i18n';
import { categoriesSummary } from './i18n/format';

// Natural "a, b and c" list in the active locale.
export { listJoin };

export function categorySummary(selectedIds) {
  return categoriesSummary(selectedIds);
}

export function whenSummary(when) {
  const options = when?.options || [];
  if (options.length === 0) return t('domain.summary.now');
  const labels = options.map((id) => (
    id === 'specific' && when.date
      ? formatDate(when.date)
      : WHEN_OPTIONS.find((o) => o.id === id)?.label ?? id
  ));
  if (labels.length <= 3) return listJoin(labels);
  return t('domain.summary.whenOptions', { count: labels.length });
}

// --- 🎛️ תקציר-בחירה מכווץ לשורות "סינון מתקדם" (components/FiltersSheet.js) ---
// שלוש פונקציות טהורות (בלי React) שמייצרות את "VALUE" / "VALUE +N" האחיד לכל שורת-פילטר -
// בקשת המשתמש: "one consistent summary mechanism", לא שבע מימושי-פורמט נפרדים. כל סוג-סקשן
// (chips/when/location) מתכנס לרשימת-תוויות מסודרת (labelsFor* למטה), ואז firstValuePlusN
// לבדו קובע את הפורמט הסופי - location (components/FiltersSheet.js, ראו locationSummary) לא
// עובר דרך רשימת-תוויות כי הוא תמיד ערך-מחויב-בודד (countForKey('location') הוא 0/1 תמיד, לא
// N בחירות עצמאיות) - locationSummary כבר מחזירה מחרוזת שלמה-אחת (כולל צירוף-פנימי של כמה
// אזורים, מופרדים בפסיקים, כשמדובר ב-mode:'region' מרובה) - את זה קוראים ישירות, לא דרך כאן.

// כל שדות ה-chips המרובים מאחסנים את הבחירה בסדר-לחיצה (לא סדר-הסכמה) - ChipsGrid.toggle,
// components/FiltersSheet.js: [...value, id] - כדי ש"הערך הראשון שנבחר" בפועל יתאים למה שהמשתמש
// באמת בחר ראשון. options (FILTER_SCHEMA[].options) כבר נושאות label מפוענח (getter, לא מחרוזת
// גולמית) - .filter(Boolean) מפיל בשקט מזהה שלא נמצא (state ישן/לא-תקין), לא קורס.
export function chipsSelectionLabels(selectedIds, options) {
  if (!selectedIds?.length) return [];
  return selectedIds.map((id) => options.find((o) => o.id === id)?.label).filter(Boolean);
}

// "מתי" משלב שני מפתחות-state (when.options + hour) לספירה אחת (countForKey, lib/filterActivities.js:
// when.options.length + (hour.option||hour.custom ? 1 : 0)) - הרשימה כאן משקפת בדיוק את אותו
// שילוב: תוויות-היום בסדר-הבחירה (כמו whenSummary למעלה, כולל "specific"+formatDate), ואז
// תווית-שעה *אחת* נוספת בסוף אם hour נבחר. "בשעה HH:MM" (hourAt) - אותו מפתח-תרגום בדיוק שכבר
// מוצג על הצ'יפ עצמו ב-WhenSection, לא מחרוזת חדשה.
export function whenSelectionLabels(when, hour) {
  const dayLabels = (when?.options || []).map((id) => (
    id === 'specific' && when.date ? formatDate(when.date) : WHEN_OPTIONS.find((o) => o.id === id)?.label ?? id
  ));
  const hourLabel = hour?.custom
    ? t('filters.when.hourAt', { time: hour.custom.start })
    : hour?.option
      ? HOUR_OPTIONS.find((o) => o.id === hour.option)?.label
      : null;
  return hourLabel ? [...dayLabels, hourLabel] : dayLabels;
}

// "VALUE" (1 תווית) | "VALUE +N" (2+) | null (0, אין תווית לפרוס - השורה נשארת נקייה בלי
// תקציר-מומצא). הכלל היחיד/המשותף לכל שורת-פילטר מכווצת - הבד"ד ("badge") ממשיך לספור לבד
// (countForKey), הפונקציה הזו רק בוחרת מה מוצג כטקסט לצד הבד"ד.
export function firstValuePlusN(labels) {
  if (!labels?.length) return null;
  const [first, ...rest] = labels;
  return rest.length ? `${first} +${rest.length}` : first;
}
