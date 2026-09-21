import { WHEN_OPTIONS, HOUR_OPTIONS, AGE_OPTIONS, DEFAULT_FILTERS } from '../constants/filterSchema';
import { t, listJoin, formatDate } from './i18n';
import { categoriesSummary, placeName, regionLabel } from './i18n/format';
import { travelSelection } from './filterActivities';

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

// --- 📝 "מציג כעת..." - תקציר-חיפוש בשפה טבעית (Activity Results Search Summary, 2026-09-20) --
// buildResultsSummary(filters) הוא פונקציה טהורה יחידה, המקור-האמת היחיד למשפט הזה בכל מקום
// שהוא מוצג (app/activities.js) - בלי state/רשת/React. מקבלת את אותו filters מנורמל בדיוק שכל
// שאר המסך כבר משתמש בו (constants/filterSchema.js DEFAULT_FILTERS) - בכוונה *לא* פרסינג נפרד
// של free-text/route-params: חיפוש חופשי (lib/smartSearch.js intentToFilters), "בחירה מהירה"
// (guided search, app/index.js) ו"מה קרוב?" (goNearMe, אותו app/index.js) כולם כבר מתכנסים
// ל-filters הרגיל לפני שהם מגיעים לכאן - "מה קרוב?" למשל מייצר location:{mode:'current',
// radiusKm:null} בלי שום דגל-route נפרד, אז ה-WHERE-phrase הגנרי (resultsWherePhrase למטה)
// כבר מפיק "קרוב אליי" ממנו לבד, בלי מקרה-קצה יעודי. ראו ה-JSX ב-app/activities.js למקום התצוגה.

// יום/שעה כמשפט-פרוזה (לא צ'יפ) - מפות-תרגום נפרדות מ-WHEN_OPTIONS/HOUR_OPTIONS הרגילים (שם
// התוויות הן שמות-עצם עצמאיים ל-UI כמו "סוף השבוע"/"בוקר") כי כאן צריך תוספת-מילת-יחס טבעית
// ("בסוף השבוע"/"בבוקר") כדי שהזרימה עם שאר המשפט תישאר תקינה דקדוקית.
const RESULTS_WHEN_KEY = {
  now: 'now', today: 'today', tomorrow: 'tomorrow', weekend: 'weekend', week: 'week', next_week: 'nextWeek',
};
const RESULTS_HOUR_KEY = {
  morning: 'morning', noon: 'noon', afternoon: 'afternoon', evening: 'evening', night: 'night',
};

// "היום/מחר/בסוף השבוע..." + "בבוקר/בערב..." יחד ("היום בבוקר") - עד 2 ימים מפורשים מצורפים
// עם listJoin ("היום ומחר"); 3+ נופל בחזרה ל-whenSummary הקיים ("{{count}} אפשרויות זמן", לא
// עוד ניסוח-פרוזה חדש) - אותו עיקרון כמו categorySummary/firstValuePlusN למעלה: לא להמציא עוד
// מנגנון-פורמט מקביל בשביל המקרה-הקצוותי. null אם אין יום *ואין* שעה נבחרים בכלל.
function resultsWhenPhrase(when, hour) {
  const options = when?.options || [];
  const dayLabel = (id) => (id === 'specific' && when.date ? formatDate(when.date) : t(`activities.resultsSummary.when.${RESULTS_WHEN_KEY[id] || id}`));
  let dayPart = null;
  if (options.length === 1) dayPart = dayLabel(options[0]);
  else if (options.length === 2) dayPart = listJoin(options.map(dayLabel));
  else if (options.length > 2) dayPart = t('domain.summary.whenOptions', { count: options.length });

  let hourPart = null;
  if (hour?.custom?.start && hour?.custom?.end) hourPart = t('activities.resultsSummary.hourRange', { start: hour.custom.start, end: hour.custom.end });
  else if (hour?.option) hourPart = t(`activities.resultsSummary.hour.${RESULTS_HOUR_KEY[hour.option] || hour.option}`);

  if (dayPart && hourPart) return `${dayPart} ${hourPart}`;
  return dayPart || hourPart || null;
}

// "באזור X" / "קרוב אליי" / "בכל הארץ" / "ליד X" - מפיק ישירות מ-location.mode/city/region
// (בלי travel/distance - זה resultsDistancePhrase למטה, שני fragment-ים נפרדים בכוונה כדי
// שיוכלו לזרום שונה במשפט: WHERE צמוד ל-WHAT/WHEN, DISTANCE נגרר בסוף עם פסיק, ראו
// buildResultsSummary). mode:null (אין מיקום ידוע בכלל) -> null, לא מומצא "בכל הארץ"/עיר.
function resultsWherePhrase(location) {
  if (!location?.mode) return null;
  if (location.mode === 'nationwide') return t('activities.resultsSummary.nationwide');
  if (location.mode === 'current') return t('activities.resultsSummary.near');
  if (location.mode === 'city' && location.city) return t('activities.resultsSummary.inArea', { place: placeName(location.city) });
  if (location.mode === 'region' && location.region?.length) {
    return t('activities.resultsSummary.inArea', { place: location.region.map(regionLabel).join(', ') });
  }
  if (location.mode === 'address') {
    const place = placeName(location.addressLabel || location.city || '');
    return place ? t('activities.resultsSummary.nearPlace', { place }) : null;
  }
  return null;
}

// "עד N דקות נסיעה" / "במרחק הליכה" - travelSelection (lib/filterActivities.js) הוא כבר
// מקור-האמת היחיד לאיזו בחירת-מרחק "פעילה" כרגע (אותה פונקציה בדיוק ש-LocationQuickPicker.js
// מציג לפיה את הצ'יפ המסומן) - לא נגזר כאן שוב מ-location.travelMode ישירות. 'any' ("לא משנה
// לי המרחק", noTimeLimit) ואין-בחירה שניהם מפיקים null בכוונה (סעיף 5: "if travel time is not
// active, do not mention it").
function resultsDistancePhrase(location) {
  const selection = travelSelection(location);
  if (selection.walking) return t('activities.resultsSummary.walking');
  // Truthful distance (Phase A item 7): travelMinutes never reaches matchesLocation, so it is not
  // reported as a constraint. A precise mode has a real radiusKm; a city/region match is name-based
  // and widened by Smart Radius, which is what 'ובסביבה' describes. See lib/i18n/format.js.
  // noTimeLimit ('any' = "לא משנה לי המרחק") keeps producing null, exactly as before: travelSelection
  // reports driving:true for it too, but it is an active NON-choice and must stay unmentioned.
  if (selection.noTimeLimit) return null;
  if (selection.driving && location?.radiusKm) return t('activities.resultsSummary.drivingKm', { km: location.radiusKm });
  if (selection.driving) return t('activities.resultsSummary.nearbyArea');
  return null;
}

// "לגילאי 0–3" / "מגיל 13" - ממזג את בנדי-הגיל שנבחרו (AGE_OPTIONS, constants/filterSchema.js)
// לטווח-מספרים יחיד לפי min של הראשון ו-max של האחרון (אחרי מיון) - לא רשימת-בנדים נפרדת
// ("0–1, 2–3"), כדי שהמשפט יזרום כמו שדוגמאות הבקשה מראות. max>=120 הוא הסנטינל הקיים ל"13+"
// (ראו AGE_OPTIONS) - "מגיל 13" ולא "לגילאי 13–120" (מספר-עליון מומצא/לא-משמעותי למשתמש).
function resultsAgePhrase(selectedIds) {
  if (!selectedIds?.length) return null;
  const bands = selectedIds.map((id) => AGE_OPTIONS.find((o) => o.id === id)).filter(Boolean).sort((a, b) => a.min - b.min);
  if (!bands.length) return null;
  const min = bands[0].min;
  const last = bands[bands.length - 1];
  if (last.max >= 120) return t('domain.summary.ageFrom', { min });
  return t('domain.summary.ageRange', { min, max: last.max });
}

// WHAT: קטגוריה נבחרת (categorySummary, כמו בכל מקום אחר) גוברת תמיד על q (בדיוק כמו
// intentToFilters, lib/smartSearch.js: "EXPLICIT STRUCTURED INTENT... גוברת... על בחירת WHAT
// מפורשת" - אותו עיקרון-עדיפות, לא הפוך). filters.q (חיפוש-חופשי שנשאר-כטקסט אחרי שהניתוח-
// המובנה לא תפס הכל, ראו deriveTextQuery/lib/searchIntent.js) מוצג מצוטט כשאין קטגוריה - "לשמר
// את משמעות-החיפוש בלי להעמיד פנים שהובן במלואו" (סעיף 6 בבקשה), לא נזרק בשקט. בלי אף אחד
// מהשניים - "פעילויות" הגנרי (סעיף 5: "if category is broad/all: say simply 'פעילויות'").
function resultsWhatPhrase(filters) {
  if (filters.category?.length) return categorySummary(filters.category);
  const q = (filters.q || '').trim();
  if (q) return t('activities.resultsSummary.freeTextWhat', { query: q });
  return t('activities.resultsSummary.genericWhat');
}

// buildResultsSummary(filters) - ראו ההערה הראשית למעלה. סדר-הרכבה: "מציג כעת" + WHAT+WHEN+WHERE
// זורמים כמשפט אחד רציף בלי פסיקים (כל השלושה הם adverbial phrases עצמאיים דקדוקית -
// "פעילויות מחר באזור נתניה" תקין בלי חיבור), ואז AGE+DISTANCE נגררים בסוף עם פסיק-מפריד כל
// אחד - שני "qualifiers" משניים יותר, לא חלק מהתיאור הראשי של מה מחפשים. תואם את רוב הדוגמאות
// בבקשה (המעטות שסטו מהתבנית הזו הן ניסוח-חופשי בכוונה, ראו "DO NOT hardcode this example").
// null כש-hasContext הוא false (סעיף 11: מסך פתוח בלי שום הקשר משמעותי - "כל הפעילויות" הקיים
// כבר אומר את זה, לא עוד "מציג כעת פעילויות" ריק) - הבדיקה היא על ה-filters הגולמיים (category/
// location.mode/age/when/hour/q), *לא* על תוצאות ה-phrase-פונקציות למעלה (חלקן, כמו WHAT, תמיד
// מפיקות ערך fallback לא-null - "פעילויות" - שלא אמור לבד להצדיק הצגת המשפט).
export function buildResultsSummary(filters) {
  if (!filters) return null;
  const category = filters.category || [];
  const age = filters.age || [];
  const q = (filters.q || '').trim();
  const when = filters.when || DEFAULT_FILTERS.when;
  const hour = filters.hour || DEFAULT_FILTERS.hour;
  const location = filters.location || DEFAULT_FILTERS.location;

  const hasContext = category.length > 0 || !!q || !!location?.mode || age.length > 0
    || (when.options || []).length > 0 || !!hour.option || !!hour.custom;
  if (!hasContext) return null;

  const lead = [resultsWhatPhrase(filters), resultsWhenPhrase(when, hour), resultsWherePhrase(location)]
    .filter(Boolean).join(' ');
  const trailing = [resultsAgePhrase(age), resultsDistancePhrase(location)].filter(Boolean);

  let sentence = `${t('activities.resultsSummary.prefix')} ${lead}`;
  if (trailing.length) sentence += `, ${trailing.join(', ')}`;
  return sentence;
}
