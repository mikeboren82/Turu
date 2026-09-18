// TuRu - פירוק עמימות בכוונת-חיפוש (Entity/Location disambiguation) לחיפוש החופשי.
//
// הבעיה שזה פותר (נמצאה 2026-09-17 עם השאילתה "זהבה"): מנתח-השפה (supabase/functions/smart-search)
// מחזיר *רק* שדות מובנים, ואין בסכמה שלו מימד של "שם פעילות/הצגה". לכן שם-עצם פרטי בודד יכול
// לנחות רק ב-location.city - והמנתח אכן החזיר city:"זהבה" לשאילתה "זהבה", למרות ש:
//   1. אין יישוב בשם "זהבה" בכלל (טבלת settlements),
//   2. יש 4 פעילויות מאושרות שהשם שלהן מכיל "זהבה" ("זהבה ושלושת הדובים ...").
// התוצאה בפועל: filters.location={mode:'city',city:'זהבה'} + q ריק → אפס תוצאות, והטקסט הגולמי
// נאכל לגמרי בדרך.
//
// העיקרון כאן: התאמה למילון-מקומות היא *ראיה*, לא *כוונה*. מחליטים לפי שתי ראיות דטרמיניסטיות:
//   (א) האם המקום קיים בפועל בקטלוג היישובים (verifyCityInCatalog, שאילתה חסומה אחת),
//   (ב) האם יש רמז גאוגרפי לשוני בשאילתה עצמה ("בזהבה", "ליד זהבה", "באזור זהבה", "in/near").
// רק כששתיהן שליליות המקום מודח לטקסט חופשי. כלומר: חיפושי-מקום אמיתיים ("שדרות", "פעילויות
// בזהבה") לא משתנים כלל - זו לא תיקון-יתר לכיוון ההפוך (ראו tests/searchIntent.test.js).
//
// הנרמול והתאמת-הגבולות כאן מכוונים במתכוון לאותו רעיון כמו supabase/functions/_shared/regionAliases.ts
// (אותו מקור-אמת רעיוני, שני runtimes נפרדים - Deno מול React Native, בדיוק כמו CATEGORY_VALUES
// מול CATEGORY_FILTER_OPTIONS): התאמת מילה שלמה עם קידומות עבריות מחוברות, לעולם לא substring חופשי.
//
// המודול הזה טהור בכוונה (בלי supabase/רשת/React) - גם כדי שיהיה בדיק ישירות, וגם כדי
// ש-lib/filterActivities.js יוכל לייבא ממנו את הנרמול בלי לגרור אליו תלות ב-DB. אימות היישוב
// מול ה-DB (הצד הלא-טהור היחיד) חי ב-lib/smartSearch.js, הקורא היחיד שלו.

// מכווץ איות שנבדל רק בפיסוק: גרש/גרשיים (כולל ״ ו-׳), מקף/מקף עברי, רווחים כפולים.
// אין הסרת קידומות (ב/ל/מ/ה) - "בזהבה" ו"זהבה" *חייבים* להישאר שונים, ההבדל ביניהם הוא בדיוק
// הראיה הגאוגרפית שאנחנו מודדים (ראו hasGeographicCue), והסרה עיוורת שלהן הייתה יוצרת עמימות חדשה.
export function normalizeSearchText(text) {
  return String(text ?? '')
    .replace(/\\/g, '')
    .replace(/["״“”'׳’`]/g, '')
    .replace(/[-–—־]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const PUNCT = '\\s,.;:!?()\\[\\]{}';
const BOUNDARY_BEFORE = `(?:^|[${PUNCT}])`;
const BOUNDARY_AFTER = `(?=$|[${PUNCT}])`;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// מילות-יחס גאוגרפיות עצמאיות שמופיעות *לפני* שם המקום.
const CUE_WORDS_BEFORE = [
  'ליד', 'באזור', 'אזור', 'בסביבות', 'סביב', 'קרוב ל', 'בקרבת', 'סמוך ל',
  'in', 'near', 'around', 'at', 'close to', 'next to',
];

// קידומות עבריות מחוברות שהופכות שם-מקום לביטוי-מקום: ב (בזהבה), ל (לזהבה), מ (מזהבה),
// כולל ו/ה מובילות ("ובזהבה"). ה' לבדה או ו' לבדה אינן ראיה גאוגרפית - "הזהבה"/"וזהבה" לא נחשבים.
const GEO_PREFIX = '(?:[וה]?[בלמ])';

// האם השאילתה הגולמית מתייחסת ל-place כאל *מקום* (ולא סתם מזכירה את המילה)?
// בוליאני דטרמיניסטי, בלי AI, בלי רשת - זו הראיה הלשונית מסעיף "LOCATION INTENT SHOULD REQUIRE EVIDENCE".
export function hasGeographicCue(rawQuery, place) {
  const text = normalizeSearchText(rawQuery);
  const name = normalizeSearchText(place);
  if (!text || !name) return false;
  const escaped = escapeRegExp(name);

  // (א) קידומת מחוברת: "בזהבה", "ליד" נבדק בסעיף ב'. חייב להיות גבול-מילה משני הצדדים כדי
  // ש"בזהבה" יתפס אבל "מזהב" או מילה אחרת שמכילה את הרצף במקרה - לא.
  if (new RegExp(`${BOUNDARY_BEFORE}${GEO_PREFIX}${escaped}${BOUNDARY_AFTER}`, 'u').test(text)) return true;

  // (ב) מילת-יחס עצמאית שצמודה לשם המקום ("ליד זהבה", "באזור זהבה", "near haifa").
  for (const cue of CUE_WORDS_BEFORE) {
    const c = escapeRegExp(normalizeSearchText(cue));
    if (new RegExp(`${BOUNDARY_BEFORE}${c}\\s+[הוב]?${escaped}${BOUNDARY_AFTER}`, 'u').test(text)) return true;
  }
  return false;
}

// פיצול לטוקנים משמעותיים (טוקן בן תו אחד הוא רעש - "ו", "ב").
export function searchTokens(text) {
  return normalizeSearchText(text)
    .split(new RegExp(`[${PUNCT}]+`, 'u'))
    .filter((t) => t.length > 1);
}

// --- הכרעה בין ההשערות --------------------------------------------------------------------
// מחזיר את ההחלטה *והנימוק* (reason) - הנימוק נשמר כדי שיהיה אפשר להבין בפיתוח למה שאילתה
// התפרשה כך (ראו debugSearchIntent למטה), בלי לוגים של מידע אישי.
export function resolveLocationIntent({ rawQuery, city, cityVerified }) {
  if (!city) return { keepLocation: false, demotedCity: null, reason: 'no-city' };
  const cue = hasGeographicCue(rawQuery, city);
  if (cityVerified) return { keepLocation: true, demotedCity: null, reason: cue ? 'verified-with-cue' : 'verified' };
  // מקום שלא קיים בקטלוג, אבל המשתמש אמר במפורש "ב/ליד/באזור X" - זו בקשה גאוגרפית מפורשת,
  // ומכבדים אותה (גם אם התוצאה תהיה ריקה - "אין מקום כזה" היא תשובה נכונה, ראו empty state קיים).
  if (cue) return { keepLocation: true, demotedCity: null, reason: 'unverified-but-explicit-geo' };
  return { keepLocation: false, demotedCity: city, reason: 'unverified-no-geo-cue' };
}

// האם המנתח חילץ *משהו* מובנה שנשאר בתוקף? (משמש כדי להחליט אם כל השאילתה היא טקסט חופשי)
// keptLocation נכנס בנפרד כי מיקום שהודח אינו "מבנה" - אבל מיקום שנשאר (עיר מאומתת/בקשה
// גאוגרפית מפורשת) בהחלט כן, ואסור שהשאילתה תיהפך גם לסינון-טקסט על גביו ("שדרות" → q="שדרות"
// היה מסנן החוצה כל פעילות בשדרות שהמילה לא מופיעה בכותרת שלה).
function hasStructuredSignal(intent, keptLocation) {
  const loc = intent.location || {};
  return !!(
    keptLocation
    || intent.category
    || loc.region
    || loc.coords
    || intent.when?.option
    || intent.when?.date
    || intent.timeRange
    || intent.age
    || intent.childNameMentioned
    || intent.priceHint
    || intent.durationHint
    || intent.placeTypeHint
    || intent.benefitsHint
    || (intent.amenityHints || []).length > 0
  );
}

// vagueIntent הוא "סל שאריות" של המנתח - לפעמים תיאור מעורפל אמיתי ("כיפי" עבור "משהו כיף
// לילדים") ולפעמים דווקא *שם הישות* שלא היה לו שדה לנחות בו ("זהבה" עבור "הצגה זהבה", נמדד
// בפועל). המבדיל הדטרמיניסטי: שארית שמופיעה מילה-במילה בשאילתה הגולמית היא שם/ציטוט מהטקסט,
// ולכן מועמדת-טקסט; שארית שהמנתח ניסח מחדש ("כיפי") - לא.
// האם המחרוזת מצוטטת *כלשונה* מתוך השאילתה? זה שער-הבטיחות היחיד של residual_query: המודל
// התבקש לצטט, וכל דבר שנוסח מחדש/הוזה נפסל כאן לפני שהוא הופך לסינון. גבול-מילה משני הצדדים
// (עם קידומת עברית מחוברת אופציונלית) כדי ש"קרקס" לא יתפס בתוך מילה אחרת במקרה.
export function isQuotedFromQuery(text, rawQuery) {
  const needle = normalizeSearchText(text);
  const hay = normalizeSearchText(rawQuery);
  if (!needle || !hay) return false;
  return new RegExp(`${BOUNDARY_BEFORE}[והבלמכש]{0,2}${escapeRegExp(needle)}${BOUNDARY_AFTER}`, 'u').test(hay);
}

function verbatimVagueTokens(intent, rawQuery) {
  const text = normalizeSearchText(rawQuery);
  if (!text) return [];
  return (intent.vagueIntent || [])
    .filter((v) => typeof v === 'string' && v.trim().length > 1)
    .filter((v) => new RegExp(`${BOUNDARY_BEFORE}[והבלמ]?${escapeRegExp(normalizeSearchText(v))}${BOUNDARY_AFTER}`, 'u').test(text));
}

// הטקסט שיילך ל-filters.q (חיפוש חופשי קנוני קיים, matchesFreeText ב-lib/filterActivities.js).
// סדר הכללים הוא סדר-הראיות: מהראיה החזקה (טוקן שהודח מפורשות) לחלשה (כל השאילתה).
export function deriveTextQuery({ intent, resolution, rawQuery }) {
  // 1. המקום שהודח *הוא* מועמד-הטקסט - הטוקן שהמנתח חשב שהוא עיר הוא בדיוק מה שהמשתמש חיפש.
  if (resolution?.demotedCity) return resolution.demotedCity;
  // 2. residual_query - הייצוג הקנוני של "טקסט משמעותי שלא נתפס בשום שדה מובנה" (שאילתה
  //    מעורבת: "זהבה ליד חיפה" → q:"זהבה" + city:"חיפה"). מתקבל רק אם הוא באמת מצוטט
  //    מהשאילתה, כך שערך מנוסח-מחדש/מוזה לא יכול להפוך לסינון. כשהשדה לא קיים (שרת שעדיין
  //    לא עודכן) פשוט ממשיכים לכללים 3-5 הקיימים - שום דבר לא נשבר.
  if (intent.residualQuery && isQuotedFromQuery(intent.residualQuery, rawQuery)) return intent.residualQuery.trim();
  // 3. רחוב שה-geocoding נכשל עליו (geocodeFailed מגיע כבר היום מה-Edge Function) - לא כתובת
  //    אמיתית, אז עדיף לחפש אותו כטקסט מאשר לאבד אותו בשקט.
  const loc = intent.location || {};
  if (loc.street && loc.geocodeFailed) return loc.street;
  // 4. שם-ישות שהמנתח זרק ל-vagueIntent אבל מופיע מילה-במילה בשאילתה ("הצגה זהבה" → "זהבה").
  //    רק לחוזה הישן: שרת מעודכן שולח תמיד את המפתח residualQuery (גם כ-null), ואז "null" הוא
  //    תשובה מפורשת "לא נשאר טקסט משמעותי" - vagueIntent חוזר להיות תיעוד בלבד. אחרת "משהו כיף
  //    בחיפה" (vagueIntent:["כיף"], מילולי) היה הופך ל-q:"כיף" ומסנן החוצה כמעט את כל חיפה.
  const oldContract = !Object.prototype.hasOwnProperty.call(intent, 'residualQuery');
  const verbatim = oldContract ? verbatimVagueTokens(intent, rawQuery) : [];
  if (verbatim.length > 0) return verbatim.join(' ');
  // 5. שאילתה שלא הניבה שום אות מובנה ושאינה מעורפלת ("זהבה דובים", "שלושת הדובים") - כל
  //    הטקסט הוא שם הפעילות המבוקשת. אם המנתח כן סימן עמימות (vagueIntent לא ריק ולא מילולי),
  //    לא כופים סינון-טקסט: "משהו כיף לילדים" צריך להישאר חיפוש רחב, לא אפס תוצאות.
  if (!hasStructuredSignal(intent, resolution?.keepLocation) && (intent.vagueIntent || []).length === 0 && rawQuery.trim()) {
    return rawQuery.trim();
  }
  return '';
}

// תיעוד-פיתוח בלבד (סעיף Observability): מסכם איך שאילתה התפרשה, בלי שום מידע אישי -
// רק הטקסט שהמשתמש הקליד בעצמו, ההחלטה והנימוק.
export function debugSearchIntent({ rawQuery, resolution, textQuery, location }) {
  return {
    rawQuery,
    decision: resolution?.reason || 'no-city',
    locationMode: location?.mode || null,
    locationCity: location?.city || null,
    textQuery: textQuery || null,
  };
}
