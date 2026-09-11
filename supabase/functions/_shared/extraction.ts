// TuRu - לוגיקת חילוץ-AI משותפת בין extract-activity (הוספת פעילות ע"י משתמש-קצה) ו-scan-source
// (סריקה אוטומטית של מקורות). היה משוכפל תו-לתו בין שני קבצים לפני זה - ריפקטור-פנימי-בלבד,
// אין שינוי בהתנהגות של extract-activity.
//
// ערכי הקטגוריה/אזור נשאבים מ-categoryValues.json (מראה של constants/categoryValues.json
// בשורש הריפו - Edge Functions נפרסות כ-bundle עצמאי של תיקיית supabase/functions, אז קובץ
// מחוץ לתיקייה הזו לא בהכרח נגיש ב-deploy; זהו עותק מכוון, לא שכפול-ידני-של-לוגיקה - אם הקובץ
// בשורש משתנה, יש להעתיק את זה שוב לכאן).

import categoryValues from './categoryValues.json' with { type: 'json' };

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

export function buildExtractionSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `אתה עוזר שמחלץ מידע מובנה על פעילויות ואירועים לילדים מתוך טקסט גולמי של עמוד אינטרנט.
קיבלת את תוכן הטקסט של עמוד (יכול להכיל כמה פעילויות/אירועים בעמוד אחד, כמו לוח אירועים של קניון).

היום הנוכחי הוא ${today}. זה חשוב לכמה מטרות:
1. אם יש תאריך מפורש לאירוע חד-פעמי (one_time_date) שכבר עבר לפני היום הנוכחי - אל תכלול את הפעילות הזו בתשובה בכלל, היא לא רלוונטית יותר.
2. תוכן שקשור לחג ספציפי (פסח, שבועות, סוכות, פורים, חנוכה, ראש השנה, יום העצמאות וכו') בלי תאריך מפורש - היזהר מאוד: אתרי "מה עושים" רבים מפרסמים דפים כאלה פעם בשנה ולא מעדכנים אותם, כך שתוכן על "אירועי שבועות" עלול להיות משנה שעברה. אל תכלול פעילות כזו בתשובה, אלא אם כן ברור מהטקסט שמדובר במקום/פעילות שפועלים כל השנה (למשל שם של גן חיות שיש בו גם אירוע חג - את הגן עצמו כן אפשר לכלול, את "אירוע החג" הספציפי בו לא, אלא אם יש תאריך עתידי מפורש).
3. חשוב מאוד: **אל תסמכו על כותרות כמו "אירועים קרובים" / "השבוע" / "עכשיו" בעמוד עצמו כהוכחה לרלוונטיות**. אתרים רבים משאירים כותרות כאלה קבועות בעיצוב העמוד גם כשהתוכן מתחתיהן ישן ולא עודכן. הכותרת "אירועים קרובים" בפני עצמה, בלי תאריך מפורש (יום+חודש, או לפחות חודש) ליד כל פריט, היא לא ערובה לכך שמדובר במשהו שקורה בקרוב. אם פריט תחת כותרת כזו קשור לחג ספציפי (ראו סעיף 2) ואין לידו תאריך מפורש - אל תכלילו אותו, גם אם הכותרת שמעליו אומרת "קרוב" או "עכשיו".
4. **קריטי - TuRu הוא אך ורק מאגר פעילויות לילדים ומשפחות. אל תכלול בתשובה שום פעילות/מקום שאינו מיועד לילדים באופן מובהק**, גם אם העמוד עצמו מסווג אותו כ"אטרקציה"/"פעילות פנאי" כללית. דוגמאות למקומות/פעילויות שיש לדלג עליהם לגמרי (לא להחזיר אותם בתשובה בכלל, לא לנסות "לתייג" אותם כמתאימים): סיורי/סדנאות יין וטעימות אלכוהול, ברים ופאבים, מועדוני לילה, קזינו/הימורים, ספא למבוגרים בלבד, מסעדות/מקומות בילוי ללא זיקה ברורה לילדים. אם הטקסט לא מציין שום דבר שמעיד על התאמה לילדים (למשל "לכל המשפחה", "לילדים", גיל מינימלי סביר, פעילות/מתקן שילדים משתמשים בו) - אל תניחו ברירת מחדל שזה מתאים; דלגו על הפריט. family_fit הוא **תוצאה** של רמז מפורש בטקסט, לא ברירת מחדל שממלאים כי "זה כנראה בסדר למשפחות" - מקום שאין שום סיבה קונקרטית לחשוב שהוא לילדים לא אמור להופיע בתשובה בכלל, גם לא עם family_fit ריק.

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
- min_age: גיל מינימלי כמספר (בשנים, אפשר עשרוני כמו 0.5), אחרת null
- max_age: גיל מקסימלי כמספר, אחרת null
- price_type: אחד מ- "free" | "fixed" | "range" | null אם לא צוין
- price_amount: מספר (בשקלים) אם price_type הוא fixed, אחרת null
- location_name: שם המקום הכללי (למשל שם הקניון/הפארק), אחרת null
- location_detail: פרטי מיקום נוספים בתוך המקום (קומה, אזור וכו'), אחרת null
- city: שם היישוב/העיר שבו נמצאת הפעילות (למשל "תל אביב", "חיפה", "קרית שמונה"), אחרת null

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
  * "הצפון והעמק": עכו, נהריה, כרמיאל, עפולה, טבריה, קצרין, ראש פינה, קרית שמונה, מגדל העמק, בית שאן, וכלל יישובי העמקים (יזרעאל/חולה) והגליל.
    חשוב: "עכו" ו"נהריה" שייכות לכאן, לצפון - לא לחיפה והקריות, למרות הקרבה הגאוגרפית לחיפה.
  * "השפלה והדרום": רחובות, מודיעין, רמלה, לוד, אשדוד, אשקלון, באר שבע, וכלל יישובי עוטף עזה והערבה
  * "יו"ש והבנימין": אריאל, מודיעין עילית, ביתר עילית, וכלל יישובי השומרון והבנימין

בהודעת המשתמש תקבל גם "רשימת תמונות מהעמוד" - מערך של אובייקטים {url, alt, context} שנאספו מתגי <img> בעמוד.
- image_urls: מערך של כתובות URL מתוך הרשימה הזו (ורק ממנה - אסור להמציא כתובת) שמייצגות בבירור את הפעילות הספציפית הזו, על סמך alt/context שמתאימים לשם/לתיאור שלה. עד 3 כתובות. אם אין תמונה שמתאימה בבירור - החזר מערך ריק [].

החזר תשובה שהיא אך ורק מערך JSON תקני (JSON array) של אובייקטים כאלה, בלי טקסט נוסף לפני או אחרי, ובלי markdown code fences.`;
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

// מפרק את תשובת ה-JSON array שClaude מחזירה, כולל תיקון-קטיעה (עמוד עם הרבה פעילויות עלול
// לגרום לתשובה להיקטע לפני שהמערך נסגר - משחזרים את כל האובייקטים השלמים שכן הגיעו).
export function parseExtractionResponse(raw: string): { activities: unknown[]; truncated: boolean } {
  const balanced = extractBalancedJsonArray(raw);
  // תיקון-קטיעה: בין אם לא נמצא מערך מאוזן בכלל (נקטע), ובין אם נמצא אבל עדיין לא תקין (JSON
  // פגום פנימי, נדיר) - אותו נתיב-הצלה: לחתוך בגבול האובייקט השלם האחרון ("},") ולסגור ידנית.
  const salvage = (text: string): { activities: unknown[]; truncated: boolean } => {
    const lastCompleteObjEnd = text.lastIndexOf('},');
    if (lastCompleteObjEnd === -1) throw new Error('המודל החזיר תשובה פגומה');
    try {
      return { activities: JSON.parse(text.slice(0, lastCompleteObjEnd + 1) + ']'), truncated: true };
    } catch {
      throw new Error('המודל החזיר תשובה פגומה');
    }
  };

  if (!balanced) {
    const start = raw.indexOf('[');
    if (start === -1) throw new Error('המודל לא החזיר תשובה תקינה');
    return salvage(raw.slice(start));
  }
  try {
    return { activities: JSON.parse(balanced), truncated: false };
  } catch {
    return salvage(balanced);
  }
}

// רשת ביטחון ברמת הקוד (לא רק בפרומפט) - תאריך חד-פעמי שכבר עבר לא רלוונטי יותר, גם אם
// המודל בכל זאת החזיר אותו.
// deno-lint-ignore no-explicit-any
export function filterPastOneTimeActivities(activities: any[], todayStr: string): any[] {
  return activities.filter((a) => (
    !(a.schedule_type === 'one_time' && a.one_time_date && a.one_time_date < todayStr)
  ));
}
