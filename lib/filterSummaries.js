import {
  WHEN_OPTIONS, HOUR_OPTIONS, AGE_OPTIONS, DEFAULT_FILTERS,
  PRICE_OPTIONS, PLACE_TYPE_OPTIONS, BOOKING_OPTIONS, DURATION_OPTIONS, AMENITY_COMFORT_OPTIONS, BENEFIT_FILTER_OPTIONS,
} from '../constants/filterSchema';
import { t, listJoin, formatDate } from './i18n';
import { placeName, regionLabel, locationSummaryText } from './i18n/format';
import { travelSelection } from './filterActivities';
import { browseSummary } from './browseGroups';

// Natural "a, b and c" list in the active locale.
export { listJoin };

// Browse-group aware (lib/browseGroups.js browseSummary): a fully selected group reads as the group
// label, exact picks keep their canonical labels, internal values are never surfaced. [] stays "הכל".
export function categorySummary(selectedIds) {
  return browseSummary(selectedIds);
}

// moved here from components/AgeQuickPicker.js (2026-09-21, "Active Search Constraints Chips" task) -
// it was a pure function (no React/RN) stranded in a component file; buildActiveChips below needs it
// and living in lib/ alongside categorySummary/whenSummary avoids a components/ -> lib/ -> components/
// import cycle (AgeQuickPicker.js already imports listJoin from this file). AgeQuickPicker.js now
// imports it back from here instead of defining it.
export function ageSummary(selectedIds) {
  if (!selectedIds || selectedIds.length === 0) return t('common.actions.all');
  const labels = selectedIds.map((id) => AGE_OPTIONS.find((o) => o.id === id)?.label ?? id);
  if (labels.length <= 3) return listJoin(labels);
  return t('filters.age.rangesCount', { count: labels.length });
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
  // Task "Activities Search Summary" section 4 (responsive text, 2026-09-27): many regions collapse
  // to a count ("N אזורים") instead of a growing comma list - matches the existing ageSummary/
  // whenSummary <=3-joined / 4+-counted convention. The <=3 case keeps the ORIGINAL plain comma
  // join (not listJoin's "X ו-Y") - that exact join style is pinned by tests/resultsSummary.test.js
  // ('...באזור השרון, גוש דן והמרכז...'), so only the never-before-covered 4+ case is new behaviour.
  if (location.mode === 'region' && location.region?.length) {
    const labels = location.region.map(regionLabel);
    const joined = labels.length <= 3 ? labels.join(', ') : t('domain.summary.regions', { count: labels.length });
    return t('activities.resultsSummary.inArea', { place: joined });
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
// buildResultsSummarySegments(filters) - ACTIVITIES SEARCH SUMMARY interactivity (2026-09-27):
// same sentence as buildResultsSummary below (same phrase functions, same composition order/
// punctuation - buildResultsSummary is now DERIVED from this, not a parallel implementation), but
// broken into an ordered list of { kind, text } pieces so app/activities.js can render each
// semantic piece as its own tap target while the rest of the sentence stays plain text. Only two
// interactive kinds exist because that is all the underlying UI has: 'category' opens the existing
// category picker (gateCategoryOpen/QuickPicker); 'location' opens the existing location picker
// (gateLocationOpen/LocationQuickPicker), which is ALSO where travel mode/time lives (walking/
// driving + minutes are controls inside that same component, not a separate screen) - so the WHERE
// phrase and the trailing DISTANCE phrase (resultsDistancePhrase) share the 'location' kind and the
// same tap target on purpose (task req: "tapping travel: open the existing travel mode/time
// control" - that control has no separate identity to open on its own). WHAT is tagged 'category'
// unconditionally, even on its generic "פעילויות" fallback (no category chosen) or its quoted-q
// fallback - tapping either still opens the category picker, which is the one UI that can add a
// category constraint. No new filter/location state: every segment's tap only ever flips the same
// gateCategoryOpen/gateLocationOpen booleans the entry gate already uses on the identical filters
// object (single source of truth, task req "do NOT create a second filter state").
export function buildResultsSummarySegments(filters) {
  if (!filters) return [];
  const category = filters.category || [];
  const age = filters.age || [];
  const q = (filters.q || '').trim();
  const when = filters.when || DEFAULT_FILTERS.when;
  const hour = filters.hour || DEFAULT_FILTERS.hour;
  const location = filters.location || DEFAULT_FILTERS.location;

  const hasContext = category.length > 0 || !!q || !!location?.mode || age.length > 0
    || (when.options || []).length > 0 || !!hour.option || !!hour.custom;
  if (!hasContext) return [];

  // WHAT never comes back empty (its own fallback chain always yields a value - see the comment on
  // resultsWhatPhrase above), so leadParts always has at least the category piece.
  const leadParts = [
    { kind: 'category', text: resultsWhatPhrase(filters) },
    { kind: 'text', text: resultsWhenPhrase(when, hour) },
    { kind: 'location', text: resultsWherePhrase(location) },
  ].filter((p) => p.text);
  const trailingParts = [
    { kind: 'text', text: resultsAgePhrase(age) },
    { kind: 'location', text: resultsDistancePhrase(location) },
  ].filter((p) => p.text);

  const segments = [{ kind: 'text', text: `${t('activities.resultsSummary.prefix')} ` }];
  leadParts.forEach((part, i) => {
    if (i > 0) segments.push({ kind: 'text', text: ' ' });
    segments.push(part);
  });
  trailingParts.forEach((part) => {
    segments.push({ kind: 'text', text: ', ' });
    segments.push(part);
  });
  return segments;
}

// null when there is no meaningful context (see the note above buildResultsSummarySegments) -
// otherwise the concatenation of every segment's text, byte-for-byte the same sentence this
// function always produced (see tests/resultsSummary.test.js, unchanged by the 2026-09-27 refactor).
export function buildResultsSummary(filters) {
  const segments = buildResultsSummarySegments(filters);
  return segments.length ? segments.map((s) => s.text).join('') : null;
}

// --- 🔍📍👶 Active Search Constraints Chips (app/activities.js, 2026-09-21) -----------------------
// One entry per ACTIVE structured filter dimension, each independently removable - the same
// dimensions countActiveFilters (lib/filterActivities.js) already counts. excludeCategory/
// excludeCity/excludeRegion/categoryAliasPhrases are deliberately excluded, exactly as they are
// there (see the comment on countActiveFilters): they already have their own dedicated UI (the
// "🚫 הסר פעילויות"/"⛔ לאן לא תרצו להגיע?" pickers + hiddenAreaCount indicator in
// app/activities.js), so listing them again here would be the exact "same filter shown twice"
// requirement.md warns against. q (filters.q, the persistent Free Search text) is NOT included -
// it has no FILTER_SCHEMA section at all and is rendered as its own distinctly-styled chip by the
// caller (see searchIntentChip in app/activities.js) - this function only covers the structured
// dimensions. Pure data only ({key, icon, text}) - removal is the caller's job (see
// shouldReopenLocationChooser below for the one dimension with a removal rule beyond "reset to
// DEFAULT_FILTERS[key]").
export function buildActiveChips(filters) {
  const chips = [];
  if (filters.location?.mode) chips.push({ key: 'location', icon: '📍', text: locationSummaryText(filters.location) });
  if (filters.age?.length) chips.push({ key: 'age', icon: '👶', text: ageSummary(filters.age) });
  if (filters.when?.options?.length) chips.push({ key: 'when', icon: '📅', text: whenSummary(filters.when) });
  if (filters.hour?.option || filters.hour?.custom) {
    const label = filters.hour.custom
      ? t('filters.when.hourAt', { time: filters.hour.custom.start })
      : HOUR_OPTIONS.find((o) => o.id === filters.hour.option)?.label;
    chips.push({ key: 'hour', icon: '🕐', text: label });
  }
  if (filters.category?.length) chips.push({ key: 'category', icon: '🎯', text: categorySummary(filters.category) });
  if (filters.price?.length) chips.push({ key: 'price', icon: '💰', text: listJoin(chipsSelectionLabels(filters.price, PRICE_OPTIONS)) });
  if (filters.placeType?.length) chips.push({ key: 'placeType', icon: '🏠', text: listJoin(chipsSelectionLabels(filters.placeType, PLACE_TYPE_OPTIONS)) });
  if (filters.booking?.length) chips.push({ key: 'booking', icon: '🎟️', text: listJoin(chipsSelectionLabels(filters.booking, BOOKING_OPTIONS)) });
  if (filters.duration?.length) chips.push({ key: 'duration', icon: '⏱️', text: listJoin(chipsSelectionLabels(filters.duration, DURATION_OPTIONS)) });
  if (filters.amenities?.length) chips.push({ key: 'amenities', icon: '♿', text: listJoin(chipsSelectionLabels(filters.amenities, AMENITY_COMFORT_OPTIONS)) });
  if (filters.benefits?.length) chips.push({ key: 'benefits', icon: '🎟️', text: listJoin(chipsSelectionLabels(filters.benefits, BENEFIT_FILTER_OPTIONS)) });
  return chips;
}

// Removing the location chip always clears the location dimension fully (DEFAULT_FILTERS.location,
// mode:null - never 'nationwide', which is a distinct EXPLICIT choice a user can make in the location
// chooser itself). The one extra rule (task requirement 3): if the Free Search text intent (q) is
// still active once location is gone, the screen has no geographic context left for that intent at
// all - re-open the existing standard location chooser instead of silently leaving the search
// nationwide-by-omission. Without an active q, clearing location is just an ordinary filter removal -
// no picker pops up uninvited.
export function shouldReopenLocationChooser(filters) {
  return !!(filters.q || '').trim();
}
