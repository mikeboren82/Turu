// TuRu - לוגיקת חילוץ-AI משותפת בין extract-activity (הוספת פעילות ע"י משתמש-קצה) ו-scan-source
// (סריקה אוטומטית של מקורות). היה משוכפל תו-לתו בין שני קבצים לפני זה - ריפקטור-פנימי-בלבד,
// אין שינוי בהתנהגות של extract-activity.
//
// ערכי הקטגוריה/אזור נשאבים מ-categoryValues.json (מראה של constants/categoryValues.json
// בשורש הריפו - Edge Functions נפרסות כ-bundle עצמאי של תיקיית supabase/functions, אז קובץ
// מחוץ לתיקייה הזו לא בהכרח נגיש ב-deploy; זהו עותק מכוון, לא שכפול-ידני-של-לוגיקה - אם הקובץ
// בשורש משתנה, יש להעתיק את זה שוב לכאן).
//
// 2026-09-13 hardening (root cause of "המודל החזיר תשובה פגומה" on 5/11 sources): Haiku writes
// Hebrew abbreviations with an unescaped ASCII quote inside JSON strings ("גן החיות התנ"כי"), which
// breaks JSON.parse; the old salvage path could not recover when it was in the first object.
// repairHebrewGershayim() fixes that deterministically before parsing, the prompt asks for ״/׳,
// max_tokens is raised, pages are capped at 30 activities, and fetchHtml() decodes legacy
// windows-1255 pages instead of assuming UTF-8.

import categoryValues from './categoryValues.json' with { type: 'json' };
import { classifyFetchFailure, type FailureKind } from './sourceHealth.ts';

export const CATEGORY_VALUES: string[] = categoryValues.categories;
export const ARCHIVE_CATEGORIES: string[] = categoryValues.archiveCategories;
export const REGION_VALUES: string[] = categoryValues.regions;
export const WEATHER_VALUES = ['מתאים ליום חם', 'מתאים ליום גשום', 'ממוזג', 'מוצל', 'מקורה', 'פעילות בחוץ בלבד'];
export const AMENITIES_VALUES = [
  'חניה', 'שירותים', 'חניה נגישה', 'שירותים נגישים', 'נגיש לכיסא גלגלים',
  'מתאים לעגלה', 'עמדת החתלה', 'מקום ישיבה להורים', 'בית קפה', 'מזנון',
  'מים לשתייה', 'Wi-Fi', 'הצללה', 'מיזוג', 'תחבורה ציבורית קרובה',
];
export const FAMILY_FIT_VALUES = [
  'מתאים לילד ולהורה', 'פעילות לילדים בלבד', 'הורה חייב להישאר', 'אפשר להשאיר את הילד',
  'מתאים לאחים בגילאים שונים', 'מתאים לקבוצות', 'מתאים ליום הולדת',
];
export const ENTITY_TYPE_VALUES = ['מקום_קבוע', 'פעילות', 'אירוע_קבוע', 'אירוע'];
export const PRICE_TYPE_VALUES = ['free', 'fixed', 'range'];
export const INDOOR_OUTDOOR_VALUES = ['indoor', 'outdoor', 'both'];
export const BOOKING_VALUES = ['none', 'walk_in', 'registration_required', 'advance_booking', 'available_now'];

export const EXTRACTION_MODEL = 'claude-haiku-4-5-20251001';
// 8192 truncated long listing pages (municipal calendars, mall event boards) mid-array; the model
// supports far more output. The prompt also caps at 30 activities per page so a single page can't
// blow the budget regardless.
export const EXTRACTION_MAX_TOKENS = 16000;
export const MAX_ACTIVITIES_PER_PAGE = 30;
export const PAGE_TEXT_CHAR_LIMIT = 18000;

export function buildExtractionSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `אתה עוזר שמחלץ מידע מובנה על פעילויות ואירועים לילדים מתוך טקסט גולמי של עמוד אינטרנט.
קיבלת את תוכן הטקסט של עמוד (יכול להכיל כמה פעילויות/אירועים בעמוד אחד, כמו לוח אירועים של קניון או עירייה).

היום הנוכחי הוא ${today}. זה חשוב לכמה מטרות:
1. אם יש תאריך מפורש לאירוע חד-פעמי (one_time_date) שכבר עבר לפני היום הנוכחי - אל תכלול את הפעילות הזו בתשובה בכלל, היא לא רלוונטית יותר.
2. תוכן שקשור לחג ספציפי (פסח, שבועות, סוכות, פורים, חנוכה, ראש השנה, יום העצמאות וכו') בלי תאריך מפורש - היזהר מאוד: אתרי "מה עושים" רבים מפרסמים דפים כאלה פעם בשנה ולא מעדכנים אותם, כך שתוכן על "אירועי שבועות" עלול להיות משנה שעברה. אל תכלול פעילות כזו בתשובה, אלא אם כן ברור מהטקסט שמדובר במקום/פעילות שפועלים כל השנה (למשל שם של גן חיות שיש בו גם אירוע חג - את הגן עצמו כן אפשר לכלול, את "אירוע החג" הספציפי בו לא, אלא אם יש תאריך עתידי מפורש).
3. חשוב מאוד: **אל תסמכו על כותרות כמו "אירועים קרובים" / "השבוע" / "עכשיו" בעמוד עצמו כהוכחה לרלוונטיות**. אתרים רבים משאירים כותרות כאלה קבועות בעיצוב העמוד גם כשהתוכן מתחתיהן ישן ולא עודכן. הכותרת "אירועים קרובים" בפני עצמה, בלי תאריך מפורש (יום+חודש, או לפחות חודש) ליד כל פריט, היא לא ערובה לכך שמדובר במשהו שקורה בקרוב. אם פריט תחת כותרת כזו קשור לחג ספציפי (ראו סעיף 2) ואין לידו תאריך מפורש - אל תכלילו אותו, גם אם הכותרת שמעליו אומרת "קרוב" או "עכשיו".
   תאריך בלי שנה (למשל "27.9") - השלם לשנה הקרובה שבה התאריך עדיין עתידי או היום; אם יש בעמוד תאריך פרסום/עדכון של הפריט שמעיד שהוא ישן (יותר משנה) - ציין אותו ב-source_published_date ואל תמציא שנה.
4. **קריטי - TuRu הוא אך ורק מאגר פעילויות לילדים ומשפחות. אל תכלול בתשובה שום פעילות/מקום שאינו מיועד לילדים באופן מובהק**, גם אם העמוד עצמו מסווג אותו כ"אטרקציה"/"פעילות פנאי" כללית. דוגמאות למקומות/פעילויות שיש לדלג עליהם לגמרי (לא להחזיר אותם בתשובה בכלל, לא לנסות "לתייג" אותם כמתאימים): סיורי/סדנאות יין וטעימות אלכוהול, ברים ופאבים, מועדוני לילה, קזינו/הימורים, ספא למבוגרים בלבד, מסעדות/מקומות בילוי ללא זיקה ברורה לילדים, הרצאות/מופעים למבוגרים, ישיבות מועצה, הודעות עירוניות שאינן פעילות. אם הטקסט לא מציין שום דבר שמעיד על התאמה לילדים (למשל "לכל המשפחה", "לילדים", גיל מינימלי סביר, פעילות/מתקן שילדים משתמשים בו) - אל תניחו ברירת מחדל שזה מתאים; דלגו על הפריט. family_fit הוא **תוצאה** של רמז מפורש בטקסט, לא ברירת מחדל שממלאים כי "זה כנראה בסדר למשפחות" - מקום שאין שום סיבה קונקרטית לחשוב שהוא לילדים לא אמור להופיע בתשובה בכלל, גם לא עם family_fit ריק.
5. החזר לכל היותר ${MAX_ACTIVITIES_PER_PAGE} פעילויות מהעמוד - אם יש יותר, בחר את אלה עם התאריך הקרוב ביותר / הרלוונטיות הברורה ביותר לילדים.

עבור כל פעילות/אירוע/מקום שאתה מזהה בטקסט, החזר אובייקט עם השדות הבאים. אם שדה לא מופיע בטקסט בבירור - השאר אותו null, אל תמציא ערכים.

- name: שם הפעילות (מחרוזת)
- entity_type: אחד מ- "מקום_קבוע" | "פעילות" | "אירוע_קבוע" | "אירוע"
  הגדרות:
  * "מקום_קבוע" - מקום פיזי עם שעות פתיחה קבועות (schedule_type: fixed_hours)
  * "פעילות" - חוג/סדנה/פעילות חוזרת שהילדים משתתפים בה באופן פעיל (schedule_type: recurring)
  * "אירוע_קבוע" - אירוע/יריד/שוק/מופע שחוזר על עצמו בלוח זמנים קבוע אבל הוא בעיקרו אירוע להתארח בו ולא סדנה (schedule_type: recurring)
  * "אירוע" - אירוע חד-פעמי בתאריך ספציפי (schedule_type: one_time)
  חשוב: "אירוע" (בלי "קבוע") מותר רק כאשר schedule_type הוא one_time. כל דבר שחוזר על עצמו בלוח זמנים קבוע הוא "פעילות" או "אירוע_קבוע", לעולם לא "אירוע" סתם
- description: תיאור קצר (עד 2-3 משפטים), בעברית, מנוסח מחדש בקצרה מהטקסט המקורי
- schedule_type: אחד מ- "recurring" (חוזר על עצמו) | "one_time" (תאריך ושעה חד פעמיים) | "fixed_hours" (מקום עם שעות פתיחה קבועות)
- recurring_days: מערך של ימים בעברית אם schedule_type הוא recurring, למשל ["שני", "רביעי"], אחרת null
- start_time: שעת התחלה כמחרוזת "HH:MM" אם קיימת, אחרת null
- end_time: שעת סיום כמחרוזת "HH:MM" אם קיימת, אחרת null
- one_time_date: תאריך בפורמט YYYY-MM-DD אם schedule_type הוא one_time ויש תאריך מפורש בטקסט, אחרת null
- source_published_date: תאריך פרסום/עדכון של הפריט בעמוד בפורמט YYYY-MM-DD אם מופיע במפורש, אחרת null
- min_age: גיל מינימלי כמספר (בשנים, אפשר עשרוני כמו 0.5), אחרת null
- max_age: גיל מקסימלי כמספר, אחרת null
- price_type: אחד מ- "free" | "fixed" | "range" | null אם לא צוין
- price_amount: מספר (בשקלים) אם price_type הוא fixed, אחרת null
- location_name: שם המקום הפיזי שבו הפעילות מתקיימת (למשל שם הקניון/הפארק/הספרייה/המתנ״ס) - לא שם הגוף שמפרסם את העמוד, אחרת null
- location_detail: פרטי מיקום נוספים בתוך המקום (קומה, אזור וכו'), אחרת null
- address: כתובת הרחוב של המקום (רחוב ומספר בית) **רק אם היא כתובה במפורש בטקסט**, למשל "רחוב הרצל 12" - אל תנחש כתובת ואל תמציא מספר בית; אם מופיע רק שם המקום או רק העיר - null
- city: שם היישוב/העיר שבו נמצאת הפעילות (למשל "תל אביב", "חיפה", "קרית שמונה"), אחרת null
- organizer_name: שם הגוף שמארגן/מפעיל את הפעילות אם מצוין (עירייה, מתנ״ס, חברת הפקות, הקניון עצמו), אחרת null
- registration_url: קישור להרשמה/רכישת כרטיסים אם מופיע בטקסט ככתובת מלאה, אחרת null
- audience: קהל היעד לפי הטקסט - בדיוק אחד מ- "children" (לילדים/פעוטות/תינוקות) | "family" (לכל המשפחה / הורים וילדים) | "adults" (מבוגרים, גיל הזהב, ותיקים, נשים, הרצאה/סטנדאפ/קונצרט למבוגרים, מנויים) | "unknown" (לא ברור). לוחות אירועים עירוניים מערבבים הכל - סמן בזהירות; אירוע למבוגרים חייב להיות "adults" גם אם הוא מופיע ליד אירועי ילדים

בנוסף, סווג את הפעילות לפי השדות הבאים - **רק אם ניתן להסיק אותם בביטחון סביר מהטקסט**. אל תנחש - אם אין רמז ברור, השאר null (או מערך ריק [] עבור שדות מסוג מערך).

- category: בדיוק אחת מהאפשרויות הבאות (המתאימה ביותר), אחרת null: ${JSON.stringify(CATEGORY_VALUES)}
  שים לב: category הוא שדה שונה לגמרי מ-entity_type! לעולם אל תחזיר כאן "מקום_קבוע"/"פעילות"/"אירוע_קבוע"/"אירוע" - אלה שייכים רק לשדה entity_type. category מתאר את סוג התוכן (למשל "בישול", "פעילות קהילתית", "אחר")
- duration_minutes: משך הפעילות המשוער בדקות (מספר), אחרת null
- indoor_outdoor: אחד מ- "indoor" | "outdoor" | "both", אחרת null
- booking_requirement: אחד מ- "none" | "walk_in" | "registration_required" | "advance_booking" | "available_now", אחרת null
- weather_suitable: מערך תגיות מתוך הרשימה הבאה בלבד (אפשר כמה, אפשר מערך ריק): ${JSON.stringify(WEATHER_VALUES)}
- amenities: מערך תגיות מתוך הרשימה הבאה בלבד (רק אם מוזכרות בפירוש בטקסט): ${JSON.stringify(AMENITIES_VALUES)}
- family_fit: מערך תגיות מתוך הרשימה הבאה בלבד (אפשר כמה, אפשר מערך ריק): ${JSON.stringify(FAMILY_FIT_VALUES)}
- region: האזור הגאוגרפי בישראל שבו נמצא היישוב (city), בהתאם לידע הכללי שלך על גאוגרפיית ישראל.
  בדיוק אחת מהאפשרויות הבאות, אחרת null אם אינך בטוח לאיזה אזור שייך היישוב: ${JSON.stringify(REGION_VALUES)}
  ההנחיות הבאות מחייבות במפורש (כולל כמה מקרים שקל לטעות בהם) - כאשר יישוב מופיע ברשימה של אזור מסוים,
  יש לסווג אותו לאזור הזה בדיוק, גם אם באופן גאוגרפי כללי הוא נראה קרוב לאזור אחר:
  * "גוש דן והמרכז": תל אביב, רמת גן, גבעתיים, פתח תקווה, ראשון לציון, חולון, בת ים.
    חשוב: "הרצליה" סתם (בלי "פיתוח"/"הירוקה" בפירוש) שייכת לכאן, לגוש דן - לא לשרון.
  * "השרון": נתניה, כפר סבא, רעננה, הוד השרון, חדרה, אזור עמק חפר, וכן ספציפית "הרצליה פיתוח" או "הרצליה הירוקה" (אך לא "הרצליה" סתם - זו גוש דן, ראו למעלה)
  * "ירושלים והסביבה": ירושלים, מבשרת ציון, מעלה אדומים, בית שמש, גוש עציון
  * "חיפה והקריות": חיפה, טבעון, נשר, וכל ערי "קריית X" ליד מפרץ חיפה בלבד - קריית ביאליק, קריית אתא, קריית ים, קריית מוצקין, קריית חיים
  * "הצפון והגליל": עכו, נהריה, כרמיאל, צפת, קצרין, ראש פינה, קרית שמונה, נוף הגליל, וכלל יישובי הגליל (עליון/תחתון/מערבי) והגולן.
    חשוב: "עכו" ו"נהריה" שייכות לכאן, לצפון - לא לחיפה והקריות, למרות הקרבה הגאוגרפית לחיפה.
  * "עמק יזרעאל והעמקים": עפולה, מגדל העמק, יקנעם עילית, טבריה, בית שאן, כפר תבור, נצרת, וכלל יישובי עמק יזרעאל, עמק הירדן וסביבות הכנרת.
  * "השפלה": רחובות, מודיעין, רמלה, לוד, אשדוד, נס ציונה, יבנה, קריית גת, וכלל יישובי השפלה (הפנימית והחוף) שאינם עוטף עזה/הנגב.
  * "הדרום והנגב": באר שבע, אשקלון, אילת, שדרות, דימונה, ערד, וכלל יישובי הנגב, עוטף עזה והערבה.
  * "יו"ש והבנימין": אריאל, מודיעין עילית, ביתר עילית, וכלל יישובי השומרון והבנימין

בהודעת המשתמש תקבל גם "רשימת תמונות מהעמוד" - מערך של אובייקטים {url, alt, context} שנאספו מתגי <img> בעמוד.
- image_urls: מערך של כתובות URL מתוך הרשימה הזו (ורק ממנה - אסור להמציא כתובת) שמייצגות בבירור את הפעילות הספציפית הזו, על סמך alt/context שמתאימים לשם/לתיאור שלה. עד 3 כתובות. אם אין תמונה שמתאימה בבירור - החזר מערך ריק [].

כללי פורמט מחייבים:
- החזר תשובה שהיא אך ורק מערך JSON תקני (JSON array) של אובייקטים כאלה, בלי טקסט נוסף לפני או אחרי, ובלי markdown code fences.
- בתוך מחרוזות JSON אסור להשתמש בגרשיים ASCII (") - לקיצורים עבריים כמו התנ״כי, ע״ש, מתנ״ס השתמש בסימן ״ (U+05F4), ולגרש בשמות כמו ג׳ימבורי השתמש ב-׳ (U+05F3). אל תשתמש בתו " בשום מקום בתוך ערך טקסטואלי.`;
}

export interface CandidateImage { url: string; alt: string; context: string }

// deno-lint-ignore no-explicit-any
export function extractCandidateImages($: any, baseUrl: string): CandidateImage[] {
  const seen = new Set<string>();
  const images: CandidateImage[] = [];
  $('img').each((_: number, el: unknown) => {
    const $el = $(el);
    const src = [$el.attr('data-src'), $el.attr('data-lazy-src'), $el.attr('data-original'), $el.attr('src')]
      .find((s: string | undefined) => s && !s.startsWith('data:'));
    if (!src) return;
    let absolute: string;
    try {
      absolute = new URL(src, baseUrl).toString();
    } catch {
      return;
    }
    if (seen.has(absolute)) return;
    const lower = absolute.toLowerCase();
    if (/logo|sprite|icon|favicon|placeholder|pixel\.gif|\.svg($|\?)/.test(lower)) return;
    const width = parseInt($el.attr('width') || '0', 10);
    const height = parseInt($el.attr('height') || '0', 10);
    if ((width && width < 80) || (height && height < 80)) return;
    const alt = ($el.attr('alt') || '').trim();
    const context = ($el.closest('div, article, li, section').text() || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    seen.add(absolute);
    images.push({ url: absolute, alt, context });
  });
  return images.slice(0, 40);
}

// Haiku sometimes writes Hebrew abbreviations with a raw ASCII quote inside a JSON string
// ("התנ"כי", "ע"ש", "מתנ"ס") - invalid JSON. Only a quote with a Hebrew letter on BOTH sides can be
// such an abbreviation (a real JSON delimiter is always followed by : , ] } or whitespace), so this
// replacement is safe to apply to the whole response before parsing. Same rule for the Node copy
// in tools/import-tool/server.js (repairHebrewGershayim).
export function repairHebrewGershayim(raw: string): string {
  return raw.replace(/(?<=[א-ת])"(?=[א-ת])/g, '״');
}

// Second, structural repair for quotes the gershayim rule can't see (e.g. a quoted word inside a
// description: "...הסדנה "מדע לילדים" מתאימה..."). Walks the text tracking string state; a `"`
// met INSIDE a string is a real closing quote only if the next non-space character is a JSON
// delimiter (, : ] }) or end of text - otherwise it is literal and gets escaped. Deterministic,
// never changes well-formed JSON (well-formed input has no such quotes).
export function repairUnescapedQuotes(raw: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === '\\') { out += ch + (raw[i + 1] ?? ''); i++; continue; }
    if (ch !== '"') { out += ch; continue; }
    let j = i + 1;
    while (j < raw.length && /\s/.test(raw[j])) j++;
    const next = raw[j];
    if (next === undefined || next === ',' || next === ':' || next === ']' || next === '}') { inString = false; out += ch; }
    else out += '\\"';
  }
  return out;
}

// מוצא את גבולות ה-JSON array המאוזן הראשון בטקסט (מה-"[" הראשון עד ה-"]" התואם לו, תוך מעקב
// אחרי מחרוזות ותווי-escape) - לא regex גרידי. נמצא בפועל (סריקות אמיתיות על כמה מקורות שונים,
// לא רק תיאורטי): `raw.match(/\[[\s\S]*\]/)` הקודם היה גרידי-מקסימלי מה-"[" הראשון עד ה-"]"
// *האחרון בכל הטקסט* - אם Claude הוסיף הערה/הסבר קצר אחרי המערך שבמקרה מכיל "]" (למשל בתוך
// תוכן שצוטט מהעמוד המקורי), ה-match היה בולע גם את הזבל הזה ושובר את ה-JSON.parse, למרות
// שהמערך עצמו היה תקין ושלם. סריקת-איזון (bracket depth, מתעלמת מסוגריים בתוך מחרוזות) פותרת
// את זה נכון גם אם יש טקסט לפני/אחרי המערך, ומחזירה null (לא זורקת) אם המערך עצמו נקטע (depth
// לא חוזר ל-0) - המקרה הזה עדיין מטופל ע"י תיקון-הקטיעה הקיים למטה.
function extractBalancedJsonArray(raw: string): string | null {
  const start = raw.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null; // המערך לא נסגר בכלל - קטוע, לא רק "יש זבל אחריו"
}

// מפרק את תשובת ה-JSON array שClaude מחזירה, כולל תיקון-גרשיים (ראו repairHebrewGershayim) ותיקון-
// קטיעה (עמוד עם הרבה פעילויות עלול לגרום לתשובה להיקטע לפני שהמערך נסגר - משחזרים את כל
// האובייקטים השלמים שכן הגיעו). repaired=true מדווח שהתיקון-הדטרמיניסטי היה נדרש (למדידה).
export function parseExtractionResponse(raw: string): { activities: unknown[]; truncated: boolean; repaired: boolean } {
  const tryParseArray = (text: string): unknown[] | null => {
    try { const v = JSON.parse(text); return Array.isArray(v) ? v : null; } catch { return null; }
  };
  const salvage = (text: string): { activities: unknown[]; truncated: boolean } => {
    const lastCompleteObjEnd = text.lastIndexOf('},');
    if (lastCompleteObjEnd === -1) throw new Error('המודל החזיר תשובה פגומה');
    const arr = tryParseArray(text.slice(0, lastCompleteObjEnd + 1) + ']');
    if (!arr) throw new Error('המודל החזיר תשובה פגומה');
    return { activities: arr, truncated: true };
  };

  const attempts: { text: string; repaired: boolean }[] = [{ text: raw, repaired: false }];
  const fixed = repairHebrewGershayim(raw);
  if (fixed !== raw) attempts.push({ text: fixed, repaired: true });
  const fixed2 = repairUnescapedQuotes(fixed);
  if (fixed2 !== fixed) attempts.push({ text: fixed2, repaired: true });

  // 1. balanced array, as-is or after gershayim repair
  for (const a of attempts) {
    const balanced = extractBalancedJsonArray(a.text);
    if (!balanced) continue;
    const arr = tryParseArray(balanced);
    if (arr) return { activities: arr, truncated: false, repaired: a.repaired };
  }
  // 2. truncated / internally broken - salvage on the repaired text (superset of fixes)
  const best = attempts[attempts.length - 1];
  const start = best.text.indexOf('[');
  if (start === -1) throw new Error('המודל לא החזיר תשובה תקינה');
  const balanced = extractBalancedJsonArray(best.text);
  const res = salvage(balanced ?? best.text.slice(start));
  return { ...res, repaired: best.repaired };
}

// רשת ביטחון ברמת הקוד (לא רק בפרומפט) - תאריך חד-פעמי שכבר עבר לא רלוונטי יותר, גם אם
// המודל בכל זאת החזיר אותו.
// deno-lint-ignore no-explicit-any
export function filterPastOneTimeActivities(activities: any[], todayStr: string): any[] {
  return activities.filter((a) => (
    !(a.schedule_type === 'one_time' && a.one_time_date && a.one_time_date < todayStr)
  ));
}

// Child-relevance gate (code-level safety net on top of the prompt). Municipal calendars mix
// lectures, senior workshops, subscription series and business meetups with children's shows -
// observed live (גני תקווה: "קפה עסקי", "סדרת הסיקסטיז", "סדנת הכר את הנייד"). The model's own
// `audience` label decides first; explicit adult markers in the title/description override an
// unknown label. Returns 'reject' | 'review' | 'ok'.
export const AUDIENCE_VALUES = ['children', 'family', 'adults', 'unknown'];
const ADULT_MARKERS = [
  'הרצאה', 'הרצאת', 'סטנדאפ', 'סטנד אפ', 'מנוי', 'סדרת', 'גיל הזהב', 'ותיקים', 'ותיקות', 'אזרחים ותיקים', 'גמלאים', 'פנסיונרים',
  'קפה עסקי', 'נטוורקינג', 'צ׳יקונג', "צ'יקונג", 'טאי צ׳י', "טאי צ'י", 'יוגה למבוגרים', 'פילאטיס', 'הכר את הנייד', 'סמארטפון למבוגרים',
  'ערב נשים', 'לנשים בלבד', 'מסיבת רווקים', 'טעימות יין', 'סיור יין', 'יקב', 'אלכוהול', 'בירה', 'מועדון לילה', 'קונצרט ערב', 'ישיבת מועצה',
  'קורס', 'סדנת הורים', 'הורים בלבד', 'ערב הורים', 'קבלת קהל', 'הודעה לתושבים', 'סיור מקצועי', '18+', 'למבוגרים בלבד', 'לגיל השלישי',
];
const CHILD_MARKERS = [
  'ילדים', 'ילדה', 'לילד', 'פעוט', 'תינוק', 'משפחה', 'משפחות', 'הורים וילדים', 'גיל הרך', 'גני ילדים', 'שעת סיפור', 'הצגת ילדים',
  'תיאטרון ילדים', 'סדנת יצירה', 'קטנטנים', 'בייבי', 'לכל הגילאים', 'לכל המשפחה', 'הפעלה', 'מתנפחים', 'קוסם', 'ליצן', 'בובות',
  'גילאי', 'כיתות', 'נוער', 'קייטנה', 'חופש הגדול', 'חנוכה לילדים', 'פורים', 'סוכות', 'שעשועים', 'משחקים', 'משחקייה',
];
// an explicit child age in the title/description ("לגיל 2-4", "גילאי 3-6", "בני 5+") - a ticketing site
// tagging a toddlers' show for both "ילדים ומשפחה" and "אזרחים ותיקים" (grandparents) made the model label
// it adults and the gate reject it (Ra'anana, 2026-09-14)
const CHILD_AGE_RE = /(?:לגיל|לגילאי|גילאי|גיל|בני)\s*(\d{1,2})\s*(?:[-–]|עד)?\s*(\d{1,2})?/;
export function hasExplicitChildAge(text: string): boolean {
  const m = CHILD_AGE_RE.exec(text); if (!m) return false;
  const a = Number(m[1]), b = m[2] ? Number(m[2]) : NaN;
  const lo = Number.isNaN(b) ? a : Math.min(a, b), hi = Number.isNaN(b) ? a : Math.max(a, b);
  return lo <= 12 && hi <= 16;
}
export function assessChildRelevance(candidate: { audience?: unknown; name?: unknown; description?: unknown; min_age?: unknown; max_age?: unknown; category?: unknown }): 'reject' | 'review' | 'ok' {
  const text = `${candidate.name ?? ''} ${candidate.description ?? ''}`.toLowerCase();
  const explicitChildAge = hasExplicitChildAge(text) || (typeof candidate.max_age === 'number' && candidate.max_age <= 12);
  const hasChild = CHILD_MARKERS.some((m) => text.includes(m.toLowerCase())) || (typeof candidate.max_age === 'number' && candidate.max_age <= 18) || (typeof candidate.min_age === 'number' && candidate.min_age <= 12) || explicitChildAge;
  const hasAdult = ADULT_MARKERS.some((m) => text.includes(m.toLowerCase()));
  // an "adults" label contradicted by an explicit child age is reviewable, never silently dropped
  if (candidate.audience === 'adults') return explicitChildAge ? 'review' : 'reject';
  if (hasAdult && !hasChild) return 'reject';
  if (candidate.audience === 'children' || candidate.audience === 'family') return hasAdult ? 'review' : 'ok';
  // unknown / missing audience: only explicit child evidence passes silently
  return hasChild ? 'ok' : 'review';
}

// Auto-publish date sanity: a one-time event must have a real, well-formed date that is today or
// in the near future (default 180 days). Anything else is not "HIGH confidence" and goes to review.
export function isPlausibleEventDate(dateStr: string | null | undefined, todayStr: string, maxDaysAhead: number): boolean {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(dateStr + 'T00:00:00Z').getTime();
  const t = new Date(todayStr + 'T00:00:00Z').getTime();
  if (Number.isNaN(d) || Number.isNaN(t)) return false;
  const days = (d - t) / 86400000;
  return days >= 0 && days <= maxDaysAhead;
}

// An item whose page says it was published long ago, offered as a one-time event without a date
// that pins it to the future, is the classic "old post re-imported as future event" trap.
export function looksLikeStaleRepost(candidate: { schedule_type?: string | null; one_time_date?: string | null; source_published_date?: string | null }, todayStr: string, maxAgeDays = 365): boolean {
  const pub = candidate.source_published_date;
  if (!pub || !/^\d{4}-\d{2}-\d{2}$/.test(pub)) return false;
  const ageDays = (new Date(todayStr + 'T00:00:00Z').getTime() - new Date(pub + 'T00:00:00Z').getTime()) / 86400000;
  if (ageDays <= maxAgeDays) return false;
  return candidate.schedule_type === 'one_time' || !candidate.schedule_type;
}

// ---- Fetch with charset detection + failure classification (shared by scan-source / extract-activity) ----

export interface FetchHtmlResult {
  ok: boolean;
  html?: string;
  status?: number;
  fetchError?: string;
  failureKind?: FailureKind;
  charset?: string;
}

function sniffCharset(contentType: string | null, headBytes: Uint8Array): string {
  const fromHeader = contentType && /charset=([\w-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const head = new TextDecoder('latin1').decode(headBytes);
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  return (fromMeta || 'utf-8').toLowerCase();
}

function decodeBody(buf: ArrayBuffer, charset: string): string {
  const cs = charset === 'iso-8859-8-i' ? 'iso-8859-8' : charset;
  try {
    return new TextDecoder(cs).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

// fetchError/failureKind are returned to the caller (not just ok:false) - without them
// source_scan_logs.error_message stayed null and no one could tell WHY a page failed (403 from a
// WAF blocking cloud traffic, 404 from a wrong link, timeout…) - observed on a real source.
export async function fetchHtml(url: string, opts: { timeoutMs: number; retries: number; userAgent?: string }): Promise<FetchHtmlResult> {
  let lastErr: { name: string; message: string } | undefined;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': opts.userAgent || 'Mozilla/5.0 (compatible; TuruBot/1.0)',
          'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'he-IL,he;q=0.9,en;q=0.5',
        },
        signal: AbortSignal.timeout(opts.timeoutMs),
        redirect: 'follow',
      });
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const charset = sniffCharset(res.headers.get('content-type'), bytes.slice(0, 4096));
      const html = decodeBody(buf, charset);
      if (!res.ok) {
        return { ok: false, status: res.status, fetchError: `HTTP ${res.status}`, failureKind: classifyFetchFailure({ status: res.status, bodySnippet: html.slice(0, 2000) }), charset };
      }
      return { ok: true, html, status: res.status, charset };
    } catch (err) {
      lastErr = err instanceof Error ? { name: err.name, message: err.message } : { name: 'Error', message: String(err) };
      if (attempt === opts.retries) break;
    }
  }
  return {
    ok: false,
    fetchError: lastErr ? `${lastErr.name}: ${lastErr.message}` : 'unknown fetch failure',
    failureKind: classifyFetchFailure({ errorName: lastErr?.name, errorMessage: lastErr?.message }),
  };
}

// Text preparation shared by both callers - strips chrome/scripts and caps size for the model.
// deno-lint-ignore no-explicit-any
export function pageTextForExtraction($: any, limit = PAGE_TEXT_CHAR_LIMIT): string {
  // Never remove <form> itself: ASP.NET WebForms / SharePoint sites (Holon, Rishon, Beer Sheva,
  // Netanya, Herzliya...) wrap the ENTIRE page body in one <form>, so dropping it left ~300 chars of
  // accessibility menu and every such municipality scanned as "HTTP 200, 0 events" (found 2026-09-13).
  // Only the controls go.
  $('script, style, noscript, nav, footer, header, svg, input, select, textarea, button').remove();
  return $('body').text().replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim().slice(0, limit);
}

// Long listing pages (municipal calendars: Holon's is ~97k chars with ~460 dates) carry far more
// than PAGE_TEXT_CHAR_LIMIT; a single window sees only the first screen. Split on line boundaries
// into at most maxChunks windows so the scanner can run one extraction per window.
export const MAX_TEXT_CHUNKS = 4;
export function splitTextForExtraction(text: string, limit = PAGE_TEXT_CHAR_LIMIT, maxChunks = MAX_TEXT_CHUNKS): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0 && chunks.length < maxChunks) {
    if (rest.length <= limit) { chunks.push(rest); break; }
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  return chunks;
}

// ---- Cheap path for very heavy pages (no DOM). The edge runtime's CPU budget is small; parsing a
// 2MB mall page with cheerio (observed: azrielimalls.co.il event pages) kills the invocation before
// the scan can finish. Regex-based stripping costs a fraction of that and the model only ever sees
// the first PAGE_TEXT_CHAR_LIMIT chars anyway.
export const HEAVY_HTML_BYTES = 400_000;
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&apos;': "'" };
export function cheapPageText(html: string, limit = PAGE_TEXT_CHAR_LIMIT): string {
  let s = html.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  const bodyStart = s.search(/<body\b/i);
  if (bodyStart > 0) s = s.slice(bodyStart);
  // same boilerplate the DOM path drops (menus/footers on heavy municipal pages run to 15k+ chars
  // and used to consume the whole extraction window before the first event)
  s = s.replace(/<(header|nav|footer)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&(amp|lt|gt|quot|#39|nbsp|apos);/g, (m) => ENTITIES[m] ?? m).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  return s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim().slice(0, limit);
}

// Same heuristic as discovery.ts (same host, event/calendar/pagination keywords, depth 1) without a DOM.
const CHEAP_LINK_KEYWORDS = ['אירוע', 'פעילויות', 'פעילות', 'event', 'calendar', 'activities', 'page=', '/page/'];
export function cheapDiscoverLinks(html: string, baseUrl: string, maxExtra: number): string[] {
  const base = new URL(baseUrl);
  const norm = (h: string) => h.replace(/^www\./, '');
  const seen = new Set<string>([base.toString()]);
  const out: string[] = [];
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  let scanned = 0;
  while ((m = re.exec(html)) && scanned < 400 && out.length < maxExtra) {
    scanned++;
    let abs: URL;
    try { abs = new URL(m[1], base); } catch { continue; }
    if (!['http:', 'https:'].includes(abs.protocol) || norm(abs.hostname) !== norm(base.hostname)) continue;
    abs.hash = '';
    const key = abs.toString();
    if (seen.has(key)) continue;
    const text = m[2].replace(/<[^>]+>/g, ' ').toLowerCase();
    const href = m[1].toLowerCase();
    if (!CHEAP_LINK_KEYWORDS.some((k) => text.includes(k) || href.includes(k))) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
