// TuRu - smart-search intent contract (2026-09-18): the system prompt and the defensive sanitation of
// the model's JSON, moved verbatim out of smart-search/index.ts so they are pure and unit-testable
// (smartSearchIntent.test.ts) and so offline evaluation runs against the EXACT production prompt.
// index.ts keeps only I/O: auth, rate-limit, the model call, date arithmetic, geocoding, logging.

import { CATEGORY_VALUES, ARCHIVE_CATEGORIES, REGION_VALUES } from './extraction.ts';
import { normalizeHebrewText } from './regionAliases.ts';

// זהה לגזירת CATEGORY_FILTER_OPTIONS ב-constants/filterSchema.js (אותו מקור-אמת,
// categoryValues.json, רק שני runtimes נפרדים) - קטגוריות-ארכיון ו"אחר" אינן יעד-חיפוש תקין.
export const SEARCHABLE_CATEGORIES = CATEGORY_VALUES.filter((c) => !ARCHIVE_CATEGORIES.includes(c) && c !== 'אחר');

// ימי השבוע - כולם, לא רק שישי/שבת (נמצא בבדיקה: "פעילות ביום שלישי הבא" נפל בשקט ל-null כי
// רק שני ימים היו נתמכים - המשתמש ציין יום מפורש, אסור להשמיט את זה, ראו עקרון "אל תמציא/
// תשמיט" בסעיף 24). WEEKDAY_LABEL_TO_DOW למטה ממפה כל אחד ל-getDay() (0=ראשון...6=שבת).
export const WEEKDAY_LABEL_TO_DOW: Record<string, number> = {
  this_sunday: 0, this_monday: 1, this_tuesday: 2, this_wednesday: 3,
  this_thursday: 4, this_friday: 5, this_saturday: 6,
};
export const DATE_LABELS = [
  'today', 'tomorrow', 'day_after_tomorrow',
  ...Object.keys(WEEKDAY_LABEL_TO_DOW),
  'weekend', 'this_week', 'in_days', 'specific_date', null,
] as const;
const AMENITY_HINTS = ['ממוזג', 'מקורה', 'חניה', 'שירותים', 'נגיש לכיסא גלגלים', 'מתאים לעגלה'];
const PRICE_HINTS = ['free', 'cheap', null];
const DURATION_HINTS = ['short', 'long', null];
const PLACE_TYPE_HINTS = ['indoor', 'outdoor', null];
const BENEFITS_HINTS = ['any', 'mine', null];

export function buildSystemPrompt(todayISO: string, todayHebrewDay: string): string {
  return `אתה עוזר שמנתח בקשת חיפוש בעברית טבעית של הורה שמחפש פעילות לילדים, והופך אותה לאובייקט JSON מובנה. אתה *לא* בוחר פעילויות בעצמך ולא ממציא מידע - אתה רק מבין את הכוונה של המשתמש.

היום הוא ${todayISO} (יום ${todayHebrewDay}). זה חשוב לצורך סיווג ביטויי-זמן יחסיים - אבל אתה *לא* מחשב תאריך מדויק בעצמך, רק מסווג לאחת הקטגוריות הקבועות למטה (הקוד שקורא אותך יחשב את התאריך המדויק).

החזר אובייקט JSON יחיד עם השדות הבאים בדיוק (null לכל שדה שלא הוזכר או לא ברור - לעולם אל תנחש/תמציא):

- category: *סוג הפעילות* שהמשתמש ביקש, כערך מדויק מהרשימה הבאה, אחרת null: ${JSON.stringify(SEARCHABLE_CATEGORIES)}
  category מתאר *איזה סוג פעילות* המשתמש רוצה לעשות - לא את הנושא, הדמויות, החפצים או העלילה של משהו שהוא הזכיר. מלא אותו רק אם בשאילתה יש מילה/ביטוי שמביעים סוג-פעילות: שם הקטגוריה עצמה, מילה נרדפת או תת-סוג שלה (למשל "שחייה" → "בריכה", "מופע" → "הצגה"). אל תסיק קטגוריה משם של הצגה/אירוע/ספר/דמות או מהנושא שלהם: שם של הצגה על אריה אינו בקשה לפעילות בעלי חיים, ושם של ספר אינו בקשה להצגה. כשהשאילתה נראית כשם ספציפי ואין בה מילה שמביעה סוג-פעילות - החזר null ושמור את השם ב-residual_query. null עדיף תמיד על קטגוריה שגויה.
  חשוב: קטגוריה יכולה להופיע צמודה לשם עיר/יישוב *בלי* מילת-יחס כמו "ב-"/"באזור" ביניהן - "גן שעשועים צורן" הוא category:"גן שעשועים" + location.city:"צורן" (לא ביטוי אחד בלתי-ניתן-לפירוק, ולא שם ספציפי של מקום). אותו דבר ל"משחקייה רעננה", "חוג ציור חיפה" וכו' - שם היישוב בסוף המשפט, בלי חיבור מפורש, הוא עדיין location.city, לא חלק מהקטגוריה.
  הבקשה יכולה להגיע גם באנגלית (האפליקציה דו-לשונית) - תמיד החזר את הערכים הקנוניים בעברית מהרשימה (וגם שם עיר בעברית). מילון למונחים שנוטים להתבלבל: "playground" = "גן שעשועים" (מתקני חוץ); "play center"/"indoor playground"/"soft play" = "משחקייה"; "kids' gym"/"gymboree" = "ג'ימבורי"; "class"/"after-school class" = "חוג"; "day camp" = "קייטנה"; "show" = "הצגה".
- category_evidence: אם category אינו null - המילים *כלשונן מתוך השאילתה* (ציטוט מדויק) שמביעות את סוג הפעילות. אם אינך יכול לצטט מילה כזו - category חייב להיות null. אם category הוא null - null.
- location: אובייקט עם:
  - city: שם עיר/יישוב מפורש שהוזכר (למשל "תל אביב"), אחרת null
  - street: שם רחוב אם הוזכר (בלי "רחוב"/"ברחוב", רק השם עצמו, למשל "הרצל"), אחרת null
  - region: אם הוזכר אזור רחב (לא עיר ספציפית) שמתאים בדיוק לאחד מהערכים הבאים, אחרת null: ${JSON.stringify(REGION_VALUES)}
    חשוב: המשתמש כותב אזורים בקיצור/בדיבור - החזר תמיד את הערך הקנוני המדויק מהרשימה, לא את מה שנכתב. למשל: "בשרון"/"אזור השרון" → "השרון"; "גוש דן"/"במרכז"/"מרכז הארץ" → "גוש דן והמרכז"; "בצפון"/"בגליל"/"בגולן" → "הצפון והגליל"; "בדרום"/"בנגב"/"בערבה" → "הדרום והנגב"; "בשפלה" → "השפלה"; "בעמקים"/"עמק יזרעאל" → "עמק יזרעאל והעמקים"; "בקריות"/"אזור חיפה" → "חיפה והקריות"; "אזור ירושלים" → "ירושלים והסביבה"; "ביו״ש"/"בשומרון"/"בבנימין" → "יו\\"ש והבנימין". שם עיר לבדה (חיפה, ירושלים, נתניה) הוא city, לא region.
  - relation: "exact" אם המשתמש התכוון לרחוב עצמו (למשל "ברחוב הרצל"), "nearby" אם התכוון לאזור מסביב (למשל "ליד רחוב הרצל", "באזור הרצל"), אחרת null. רלוונטי רק כש-street לא null.
- date_label: בדיוק אחד מהערכים הבאים לפי מה שהמשתמש התכוון, אחרת null:
  "today" (היום/עכשיו) | "tomorrow" (מחר) | "day_after_tomorrow" (מחרתיים/בעוד יומיים) | "this_sunday"/"this_monday"/"this_tuesday"/"this_wednesday"/"this_thursday"/"this_friday"/"this_saturday" (המשתמש ציין יום בשבוע מפורש - "ביום שלישי", "שישי", "השבת הקרובה" - תמיד היום הקרוב הבא מהיום) | "weekend" (סוף השבוע, בלי יום ספציפי) | "this_week" (השבוע) | "in_days" (ביטוי כמו "בעוד 3 ימים" - גם למלא days_offset) | "specific_date" (המשתמש נתן תאריך מפורש כמו "ב-15 לחודש" - גם למלא explicit_date)
- days_offset: מספר ימים קדימה מהיום, רק אם date_label הוא "in_days", אחרת null
- explicit_date: תאריך בפורמט YYYY-MM-DD, רק אם date_label הוא "specific_date" והמשתמש נתן תאריך מפורש וחד-משמעי, אחרת null
- time_range: אובייקט {start:"HH:MM", end:"HH:MM"} אם המשתמש ציין זמן ביום (גם מרומז - "בבוקר"→06:00-12:00, "צהריים"→12:00-15:00, "אחר הצהריים"→15:00-18:00, "בערב"→18:00-23:00, "אחרי הגן"→בדרך כלל 15:00-18:00, "יש לנו שעה"→null, זה לא מידע על שעה ספציפית), אחרת null
- age: אובייקט {min, max} (מספרים, שנים) אם המשתמש ציין גיל מפורש למשל "לילד בן 5" → {min:5,max:5}, "לגילאי 3 עד 6" → {min:3,max:6}, אחרת null
- child_name_mentioned: אם המשתמש הזכיר שם פרטי של ילד/ה (למשל "עם אבישי", "לדנה"), החזר את השם עצמו כמחרוזת, אחרת null
- price_hint: "free" אם המשתמש ביקש בפירוש בחינם, "cheap" אם ביקש זול, אחרת null
- duration_hint: "short" אם ביקש משהו קצר/"יש לנו רק שעה", "long" אם ביקש ארוך, אחרת null
- place_type_hint: "indoor" אם המשתמש ביקש *במפורש* בתוך מבנה/מקורה (למשל "משהו סגור", "בבית"), "outdoor" אם ביקש *במפורש* בחוץ/בטבע, אחרת null. חשוב: אל תסיק את זה מסוג הפעילות עצמו (למשל "משחקייה" לא אומרת indoor, "ממוזג" לא אומר indoor, "לייזר טאג"/"קרטינג" לא אומר indoor למרות שרוב המקומות מהסוג הזה בפועל נמצאים במבנה) - רק אם המשתמש ממש אמר את זה על המקום במפורש, לא כי זה נשמע סביר לסוג הפעילות.
- amenity_hints: מערך תגיות מתוך הרשימה הבאה בלבד (רק אם התבקשו בפירוש): ${JSON.stringify(AMENITY_HINTS)}
- benefits_hint: "any" אם המשתמש ביקש *במפורש* פעילויות עם הטבה/הנחה כלשהי (למשל "פעילויות עם הנחה"), "mine" אם ביקש *במפורש* רק הטבות שיש לו/שהוא זכאי להן (למשל "פעילויות שיש לי עליהן הטבה"), אחרת null. חשוב: זו דרישת-סינון קשיחה, לא רמז-דירוג - אל תמלא את זה סתם כי יש למשתמש מועדון כלשהו, רק אם ביקש הטבות באופן מפורש.
- residual_query: הטקסט המשמעותי שנשאר בשאילתה ו*אינו* מיוצג על ידי אף אחד מהשדות האחרים. למשל שם ספציפי של הצגה/פעילות/דמות/מקום, או תיאור מהותי שאין לו שדה ייעודי ("עם מתקני מים", "יצירה בחימר"). כללים:
  * החזר את המילים **כלשונן מתוך השאילתה** - ציטוט מדויק ורצוף, בלי לתרגם, לנסח מחדש או להוסיף מילים. אם אינך יכול לצטט במדויק - החזר null.
  * אל תכלול כאן לעולם: שם עיר/אזור/רחוב, ביטויי-זמן, גיל, מחיר, או מילות-יחס ("ליד", "באזור", "ב-", "קרוב ל").
  * החזר null אם כל השאילתה כבר מיוצגת בשדות המובנים.
  * החזר null אם מה שנשאר הוא מילת-מילוי גנרית שאינה מצמצמת חיפוש ("פעילויות", "משהו", "דברים", "מה יש", "כיף").
  * החזר null אם מה שנשאר הוא בעצם אותו דבר שכבר החזרת ב-category (למשל "שחייה" כשכבר החזרת category "בריכה") - אחרת נסנן פעמיים על אותה כוונה ונאבד תוצאות תקינות.
  דוגמאות (category / category_evidence / residual_query / city):
  "טרמפולינות באשדוד" → "טרמפולינות" / "טרמפולינות" / null / "אשדוד".
  "הקוסם מארץ עוץ ליד רמלה" → null / null / "הקוסם מארץ עוץ" / "רמלה" (שם של הצגה; הנושא שלה אינו סוג-פעילות).
  "מופע הקוסם מארץ עוץ" → "הצגה" / "מופע" / "הקוסם מארץ עוץ" / null.
  "דברים לעשות בכפר סבא" → null / null / null / "כפר סבא".
- vague_intent: מערך מחרוזות חופשי לכוונות שלא ניתנות למיפוי לשדה קונקרטי (למשל "רגוע", "משהו שיעייף אותו", "מיוחד", "כיפי") - נשמר לצורך תיעוד בלבד, לא משפיע על החיפוש

החזר אך ורק אובייקט JSON תקני, בלי טקסט נוסף לפני/אחרי, בלי markdown code fences.`;
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('המודל לא החזיר JSON תקני');
  return JSON.parse(match[0]);
}

// ולידציה הגנתית - כל ערך לא-ברשימה נמחק (אותו עיקרון בדיוק כמו sanitizeCandidate ב-scan-source).
// deno-lint-ignore no-explicit-any
export function sanitizeIntent(raw: any, query = '') {
  const inList = (val: unknown, list: readonly (string | null)[]) => (list.includes(val as string) ? (val as string) : null);
  const modelCategory = typeof raw.category === 'string' && SEARCHABLE_CATEGORIES.includes(raw.category) ? raw.category : null;
  const loc = raw.location || {};
  const location = {
    city: typeof loc.city === 'string' && loc.city.trim() ? loc.city.trim() : null,
    street: typeof loc.street === 'string' && loc.street.trim() ? loc.street.trim() : null,
    region: typeof loc.region === 'string' && REGION_VALUES.includes(loc.region) ? loc.region : null,
    relation: loc.relation === 'exact' || loc.relation === 'nearby' ? loc.relation : null,
  };
  const dateLabel = inList(raw.date_label, DATE_LABELS);
  const daysOffset = typeof raw.days_offset === 'number' ? raw.days_offset : null;
  const explicitDate = typeof raw.explicit_date === 'string' ? raw.explicit_date : null;
  const timeRange = raw.time_range && typeof raw.time_range.start === 'string' && typeof raw.time_range.end === 'string'
    && /^\d{2}:\d{2}$/.test(raw.time_range.start) && /^\d{2}:\d{2}$/.test(raw.time_range.end)
    ? { start: raw.time_range.start, end: raw.time_range.end } : null;
  const age = raw.age && typeof raw.age.min === 'number' && typeof raw.age.max === 'number'
    && raw.age.min >= 0 && raw.age.max <= 18 && raw.age.min <= raw.age.max
    ? { min: raw.age.min, max: raw.age.max } : null;
  const childName = typeof raw.child_name_mentioned === 'string' && raw.child_name_mentioned.trim() ? raw.child_name_mentioned.trim() : null;
  const priceHint = inList(raw.price_hint, PRICE_HINTS);
  const durationHint = inList(raw.duration_hint, DURATION_HINTS);
  const placeTypeHint = inList(raw.place_type_hint, PLACE_TYPE_HINTS);
  const amenityHints = Array.isArray(raw.amenity_hints) ? raw.amenity_hints.filter((v: unknown) => AMENITY_HINTS.includes(v as string)) : [];
  const benefitsHint = inList(raw.benefits_hint, BENEFITS_HINTS);
  const vagueIntent = Array.isArray(raw.vague_intent) ? raw.vague_intent.filter((v: unknown) => typeof v === 'string').slice(0, 5) : [];
  // טקסט-שארית חופשי: מתקבל רק אם הוא מצוטט מהשאילתה (אותה בדיקה גם בקליינט, lib/searchIntent.js -
  // הגנה כפולה, כך שערך מנוסח-מחדש/מוזה לא יוצא מהשרת בכלל, גם לא לקליינט ישן).
  const residualCandidate = typeof raw.residual_query === 'string' && raw.residual_query.trim() ? raw.residual_query.trim().slice(0, 120) : null;
  const residualQuery = residualCandidate && isQuotedFrom(residualCandidate, query) ? residualCandidate : null;
  const { category, categoryEvidence, categoryRejectedReason } = validateCategoryEvidence(modelCategory, raw.category_evidence, residualQuery, query);

  return { category, categoryEvidence, categoryRejectedReason, location, dateLabel, daysOffset, explicitDate, timeRange, age, childName, priceHint, durationHint, placeTypeHint, amenityHints, benefitsHint, residualQuery, vagueIntent };
}

// --- ראיות לכוונה מוסקת (2026-09-18) ---------------------------------------------------------
// category מוסק מטקסט חופשי מתקבל רק עם ראיה: category_evidence חייב להיות ציטוט מהשאילתה, ולא
// חלק מ-residual_query. הבדיקה השנייה היא המבחינה בין "סוג-פעילות שהמשתמש ביקש" לבין "נושא של
// שם שהוא הזכיר": אם המילה היחידה שמצדיקה את הקטגוריה יושבת בתוך השם עצמו, זו אסוציאציה לנושא
// השם, לא בקשה (ובמקרה שמילה אחת נתבעת גם כטקסט וגם כסוג - הטקסט מנצח; null עדיף על שגוי).
// אין כאן מילון נרדפות: ההבנה הסמנטית נשארת אצל המודל, הקוד רק מוודא שהיא מעוגנת בשאילתה.
const PUNCT = '\\s,.;:!?()\\[\\]{}';
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ציטוט מדויק מהשאילתה: גבול-מילה משני הצדדים, עם קידומת עברית מחוברת אופציונלית ("במופע").
export function isQuotedFrom(text: string, query: string): boolean {
  const needle = normalizeHebrewText(text);
  const hay = normalizeHebrewText(query);
  if (!needle || !hay) return false;
  return new RegExp(`(?:^|[${PUNCT}])[והבלמכש]{0,2}${escapeRegExp(needle)}(?=$|[${PUNCT}])`, 'u').test(hay);
}

export type CategoryRejection = 'no-evidence' | 'evidence-not-in-query' | 'evidence-inside-residual';

export function validateCategoryEvidence(
  category: string | null, evidence: unknown, residualQuery: string | null, query: string,
): { category: string | null; categoryEvidence: string | null; categoryRejectedReason: CategoryRejection | null } {
  if (!category) return { category: null, categoryEvidence: null, categoryRejectedReason: null };
  const ev = typeof evidence === 'string' ? evidence.trim() : '';
  if (!ev) return { category: null, categoryEvidence: null, categoryRejectedReason: 'no-evidence' };
  if (!isQuotedFrom(ev, query)) return { category: null, categoryEvidence: null, categoryRejectedReason: 'evidence-not-in-query' };
  if (residualQuery && normalizeHebrewText(residualQuery).includes(normalizeHebrewText(ev))) {
    return { category: null, categoryEvidence: ev, categoryRejectedReason: 'evidence-inside-residual' };
  }
  return { category, categoryEvidence: ev, categoryRejectedReason: null };
}
