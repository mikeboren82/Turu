require('dotenv').config();
const express = require('express');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const { renderPage } = require('./page');
const { renderManagePage } = require('./manage');
const { renderMembersPage } = require('./members');
const { renderContributorsPage } = require('./contributors');
const { renderFeedbackPage } = require('./feedback');
const { renderMessagesPage } = require('./messages');
const { renderDashboardPage } = require('./dashboard');
const { getClient } = require('./supabase');

const app = express();
// המגבלה הרגילה (100kb) קטנה מדי להעלאת תמונה ידנית (base64 בגוף הבקשה) - כלי פנימי
// למנהל אחד, אין חשש אבטחה מיוחד בהגדלת המגבלה.
app.use(express.json({ limit: '12mb' }));
// לוגיקה משותפת שחייבת להתנהג זהה בכמה עמודים (זיהוי "בעיות"/"דורש עדכון", טוגל תפריט הניווט) -
// ראו public/admin-shared.js. עמודי ה-render כוללים <script src="/admin-shared.js"> במקום לשכפל
// את הפונקציות האלה (בניגוד ל-escapeHtml/date-format הקטנים שכבר משוכפלים בכל קובץ בלי בעיה).
app.use(express.static(require('path').join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// חייב להישאר תואם ל-CATEGORY_OPTIONS / WEATHER_OPTIONS / AMENITIES_OPTIONS / FAMILY_FIT_OPTIONS
// ב-constants/filterSchema.js של האפליקציה - אם משנים שם, לעדכן גם כאן
const CATEGORY_VALUES = [
  'גן שעשועים', "ג'ימבורי", 'משחקייה', 'סדנה', 'חוג', 'הצגה', 'מוזיאון לילדים',
  'פארק', 'חווה', 'פינת חי', 'אטרקציה', 'בריכה', 'ספורט', 'יצירה',
  'מוזיקה', 'ריקוד', 'בישול', 'מדע', 'טבע', 'בעלי חיים', 'פעילות מים',
  'טרמפולינות', 'פארק שעשועים', 'קולנוע לילדים', 'ספרייה', 'שעת סיפור',
  'פעילות קהילתית', 'פעילות עירונית', 'אחר',
];
const WEATHER_VALUES = ['מתאים ליום חם', 'מתאים ליום גשום', 'ממוזג', 'מוצל', 'מקורה', 'פעילות בחוץ בלבד'];
const AMENITIES_VALUES = [
  'חניה', 'שירותים', 'חניה נגישה', 'שירותים נגישים', 'נגיש לכיסא גלגלים',
  'מתאים לעגלה', 'עמדת החתלה', 'מקום ישיבה להורים', 'בית קפה', 'מזנון',
  'מים לשתייה', 'Wi-Fi', 'הצללה', 'מיזוג', 'תחבורה ציבורית קרובה',
];
const FAMILY_FIT_VALUES = [
  'מתאים לילד ולהורה', 'פעילות לילדים בלבד', 'הורה חייב להישאר', 'אפשר להשאיר את הילד',
  'מתאים לאחים בגילאים שונים', 'מתאים לקבוצות', 'מתאים ליום הולדת',
];
// חייב להישאר תואם ל-REGION_OPTIONS ב-constants/filterSchema.js ולאילוץ ה-CHECK על
// locations.region ב-DB (supabase/0007_update_regions.sql) - אם משנים כאן, לעדכן גם שם.
const REGION_VALUES = [
  'גוש דן והמרכז', 'השרון', 'ירושלים והסביבה', 'חיפה והקריות',
  'הצפון והעמק', 'השפלה והדרום', 'יו"ש והבנימין',
];
const ENTITY_TYPE_VALUES = ['מקום_קבוע', 'פעילות', 'אירוע_קבוע', 'אירוע'];
const PRICE_TYPE_VALUES = ['free', 'fixed', 'range'];
const INDOOR_OUTDOOR_VALUES = ['indoor', 'outdoor', 'both'];
const BOOKING_VALUES = ['none', 'walk_in', 'registration_required', 'advance_booking', 'available_now'];
const STATUS_VALUES = ['pending', 'approved', 'rejected', 'archived'];

// חייב להישאר תואם ל-BENEFIT_PROVIDER_OPTIONS ב-constants/filterSchema.js של האפליקציה (למעט
// "העסק עצמו" - זו אופציית provider בטופס ההטבה בלבד, לא "כרטיס שיש למשתמש") - אם משנים כאן,
// לעדכן גם שם. תוקף ה-CHECK constraint על activity_benefits.provider (supabase/0038).
const PROVIDER_VALUES = ['ישראכרט', 'MAX', 'חבר', 'בהצדעה', 'מפעל הפיס', 'העסק עצמו', 'אחר'];
const BENEFIT_TYPE_VALUES = ['percent', 'special_price', 'one_plus_one', 'second_ticket_discount', 'coupon_code', 'other'];
const BENEFIT_TYPE_LABELS = {
  percent: 'אחוז הנחה', special_price: 'מחיר מיוחד', one_plus_one: '1+1',
  second_ticket_discount: 'כרטיס שני בהנחה', coupon_code: 'קוד קופון', other: 'הטבה אחרת',
};
const REDEMPTION_METHOD_VALUES = ['link', 'coupon_code', 'show_card', 'automatic', 'other'];
const REDEMPTION_METHOD_LABELS = {
  link: 'רכישה דרך קישור', coupon_code: 'קוד קופון', show_card: 'הצגת כרטיס/חברות',
  automatic: 'באופן אוטומטי', other: 'אחר',
};
const BENEFIT_STATUS_VALUES = ['active', 'needs_review', 'expired'];
const BENEFIT_STATUS_LABELS = { active: '🟢 פעילה', needs_review: '🟡 דורשת בדיקה', expired: '🔴 פגה' };

function buildExtractionSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `אתה עוזר שמחלץ מידע מובנה על פעילויות ואירועים לילדים מתוך טקסט גולמי של עמוד אינטרנט.
קיבלת את תוכן הטקסט של עמוד (יכול להכיל כמה פעילויות/אירועים בעמוד אחד, כמו לוח אירועים של קניון).

היום הנוכחי הוא ${today}. זה חשוב לכמה מטרות:
1. אם יש תאריך מפורש לאירוע חד-פעמי (one_time_date) שכבר עבר לפני היום הנוכחי - אל תכלול את הפעילות הזו בתשובה בכלל, היא לא רלוונטית יותר.
2. תוכן שקשור לחג ספציפי (פסח, שבועות, סוכות, פורים, חנוכה, ראש השנה, יום העצמאות וכו') בלי תאריך מפורש - היזהר מאוד: אתרי "מה עושים" רבים מפרסמים דפים כאלה פעם בשנה ולא מעדכנים אותם, כך שתוכן על "אירועי שבועות" עלול להיות משנה שעברה. אל תכלול פעילות כזו בתשובה, אלא אם כן ברור מהטקסט שמדובר במקום/פעילות שפועלים כל השנה (למשל שם של גן חיות שיש בו גם אירוע חג - את הגן עצמו כן אפשר לכלול, את "אירוע החג" הספציפי בו לא, אלא אם יש תאריך עתידי מפורש).
3. חשוב מאוד: **אל תסמכו על כותרות כמו "אירועים קרובים" / "השבוע" / "עכשיו" בעמוד עצמו כהוכחה לרלוונטיות**. אתרים רבים משאירים כותרות כאלה קבועות בעיצוב העמוד גם כשהתוכן מתחתיהן ישן ולא עודכן. הכותרת "אירועים קרובים" בפני עצמה, בלי תאריך מפורש (יום+חודש, או לפחות חודש) ליד כל פריט, היא לא ערובה לכך שמדובר במשהו שקורה בקרוב. אם פריט תחת כותרת כזו קשור לחג ספציפי (ראו סעיף 2) ואין לידו תאריך מפורש - אל תכלילו אותו, גם אם הכותרת שמעליו אומרת "קרוב" או "עכשיו".

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
  * "יו\"ש והבנימין": אריאל, מודיעין עילית, ביתר עילית, וכלל יישובי השומרון והבנימין

בהודעת המשתמש תקבל גם "רשימת תמונות מהעמוד" - מערך של אובייקטים {url, alt, context} שנאספו מתגי <img> בעמוד.
- image_urls: מערך של כתובות URL מתוך הרשימה הזו (ורק ממנה - אסור להמציא כתובת) שמייצגות בבירור את הפעילות הספציפית הזו, על סמך alt/context שמתאימים לשם/לתיאור שלה. עד 3 כתובות. אם אין תמונה שמתאימה בבירור - החזר מערך ריק [].

החזר תשובה שהיא אך ורק מערך JSON תקני (JSON array) של אובייקטים כאלה, בלי טקסט נוסף לפני או אחרי, ובלי markdown code fences.`;
}

// TuRu מציגה רק פעילויות שאפשר להגיע אליהן מתי שרוצים בלי הרשמה/התחייבות מראש.
// "פעילות" (entity_type) מוגדר בפרומפט החילוץ עצמו כ"חוג/סדנה/פעילות חוזרת שהילדים משתתפים בה באופן פעיל" -
// זה בדיוק ההגדרה של דבר שדורש הרשמה/התחייבות, לא רק כשה-category הוא ממש "חוג" (הרבה חוגים מתויגים
// לפי הנושא שלהם - ספורט/בישול/יצירה/ריקוד וכו', לא לפי category="חוג" עצמו).
// "קייטנה" מדגם נפרד שנשאר entity_type="מקום_קבוע" אבל תמיד דורש הרשמה למחזור/שבוע.
const ARCHIVE_ENTITY_TYPES = new Set(['פעילות']);
const ARCHIVE_CATEGORIES = new Set(['חוג', 'קייטנה']);

function shouldArchiveForCommitment(activity) {
  return ARCHIVE_ENTITY_TYPES.has(activity.entity_type) || ARCHIVE_CATEGORIES.has(activity.category);
}

const MERGE_SYSTEM_PROMPT = `אתה עוזר שבודק אם שתי רשומות פעילות מייצגות את אותה פעילות אמיתית בעולם (אולי תוארה קצת אחרת בשני אתרים שונים), ואם כן - מציע כיצד לשלב מידע מהרשומה החדשה לתוך הרשומה הקיימת כדי להעשיר אותה, בלי לפגוע במידע קיים טוב.

קיבלת "רשומה קיימת" (כבר שמורה במאגר) ו"רשומה חדשה" (זוהתה זה עתה מאתר נוסף).

שלב 1 - החלטה: isMatch - האם אלה באמת אותה פעילות/מקום פיזי, ולא רק שם דומה למשהו שונה? היו שמרנים - אם יש ספק סביר שזה לא אותו דבר, סמנו false.

שלב 2 - אם isMatch=true, הצע שילוב:
- mergedFields: אובייקט עם *רק* השדות שכדאי לעדכן ברשומה הקיימת, מתוך: description, min_age, max_age, price_type, price_amount, duration_minutes, indoor_outdoor, booking_requirement, weather_suitable, amenities, family_fit, category.
  כללים מחייבים: אל תחליפו ערך קיים לא-ריק בערך פחות טוב או פחות מפורט. מלאו רק שדות שהיו null/ריקים ברשומה הקיימת, או שפרו תיאור קצר/חסר לתיאור מלא ומדויק יותר. אם הקיים כבר טוב - אל תגעו בו.
  לגבי weather_suitable/amenities/family_fit (מערכים) - אפשר להציע איחוד (הערכים הקיימים + חדשים רלוונטיים שלא היו שם).
- image_urls_to_add: מערך כתובות URL מתוך "רשומה חדשה" (ורק ממנה) שכדאי להוסיף לרשומה הקיימת - רק אם יש לרשומה הקיימת פחות מ-3 תמונות.
- reasoning: משפט אחד קצר בעברית שמסביר את ההחלטה.

אם isMatch=false, החזירו mergedFields: {} ו-image_urls_to_add: [].

החזירו תשובה שהיא אך ורק אובייקט JSON תקני (בלי טקסט נוסף, בלי markdown), בפורמט:
{"isMatch": true/false, "reasoning": "...", "mergedFields": {...}, "image_urls_to_add": [...]}`;

const MERGE_ALLOWED_FIELDS = new Set([
  'description', 'min_age', 'max_age', 'price_type', 'price_amount',
  'duration_minutes', 'indoor_outdoor', 'booking_requirement',
  'weather_suitable', 'amenities', 'family_fit', 'category',
]);

function normalizeForMatch(s) {
  return (s || '').toLowerCase().replace(/[^֐-׿a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function wordOverlapScore(a, b) {
  const wa = new Set(normalizeForMatch(a).split(' ').filter((w) => w.length > 1));
  const wb = new Set(normalizeForMatch(b).split(' ').filter((w) => w.length > 1));
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  wa.forEach((w) => { if (wb.has(w)) common++; });
  return common / Math.max(wa.size, wb.size);
}

// מרחק בק"מ בין שתי נקודות (Haversine) - לזיהוי כפילויות לפי קרבה גיאוגרפית ב-/api/duplicates.
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function dismissKey(idA, idB) {
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

async function getExistingActivitiesForCity(client, city, cache) {
  if (cache.has(city)) return cache.get(city);
  const { data: locs, error: locErr } = await client.from('locations').select('id').eq('city', city);
  if (locErr) throw locErr;
  const locationIds = (locs || []).map((l) => l.id);
  if (locationIds.length === 0) {
    cache.set(city, []);
    return [];
  }
  const { data: acts, error } = await client
    .from('activities')
    .select('id, name, description, activity_images(url)')
    .in('location_id', locationIds);
  if (error) throw error;
  cache.set(city, acts || []);
  return acts || [];
}

async function findSimilarActivities(client, name, city, cache) {
  if (!name || !city) return [];
  const existing = await getExistingActivitiesForCity(client, city, cache);
  return existing
    .map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      imageCount: (a.activity_images || []).length,
      score: wordOverlapScore(name, a.name),
    }))
    .filter((a) => a.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function extractCandidateImages($, baseUrl) {
  const seen = new Set();
  const images = [];
  $('img').each((_, el) => {
    const $el = $(el);
    // אתרים רבים טוענים תמונות "עצלנית" (lazy load): ה-src המקורי הוא placeholder (base64 data: URI
    // או תמונת פיקסל), והתמונה האמיתית יושבת ב-data-src/data-lazy-src/data-original. בודקים קודם
    // את התכונות האלה, ורק בסוף חוזרים ל-src הרגיל - כדי לא "ליפול" על ה-placeholder.
    const src = [$el.attr('data-src'), $el.attr('data-lazy-src'), $el.attr('data-original'), $el.attr('src')]
      .find((s) => s && !s.startsWith('data:'));
    if (!src) return;
    let absolute;
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

app.get('/', (req, res) => {
  res.type('html').send(renderDashboardPage());
});

app.get('/activities', (req, res) => {
  res.type('html').send(renderManagePage());
});

// "איכות נתונים" מוזג לתוך "פעילויות" (טאב "🔴 דורש טיפול") - הפניה כדי שסימניות/קישורים ישנים לא יישברו.
app.get('/quality', (req, res) => {
  res.redirect('/activities');
});

app.get('/import', (req, res) => {
  res.type('html').send(renderPage());
});

// כשפעילות נשמרת בלי אף תמונה (העמוד שממנו יובאה לא הכיל תמונה מתאימה, או שאין בכלל עמוד
// מקור) - מנסים לחפש תמונה של המקום בעצמנו בגוגל, דרך SERPAPI (serpapi.com). אם אין מפתח
// מוגדר, או שהחיפוש נכשל/לא מצא כלום - פשוט מוותרים בשקט; הפעילות תמשיך להופיע ב"פעילויות
// ללא תמונה" בכלי הניהול כדי שאפשר יהיה לטפל בה ידנית.
async function searchGoogleImage(query) {
  if (!process.env.SERPAPI_KEY || !query) return null;
  try {
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'google_images');
    url.searchParams.set('q', query);
    url.searchParams.set('api_key', process.env.SERPAPI_KEY);
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = await res.json();
    const results = Array.isArray(data.images_results) ? data.images_results : [];
    const first = results.find((r) => typeof r.original === 'string' && r.original.trim());
    return first ? first.original : null;
  } catch (err) {
    console.error('חיפוש תמונה אוטומטי בגוגל נכשל:', err);
    return null;
  }
}

// אתר רשמי (activities.official_url) - כשפעילות נכנסת לאפליקציה, מחפשים אם יש לה אתר משלה
// שונה מ"אתר המקור" (source_url יכול להיות לוח אירועים/אתר ריכוז חיצוני, לא האתר של הפעילות
// עצמה). חיפוש עמוד יחיד בלבד (לא כמו serpApiWebSearch שמריץ כמה עמודים לכיסוי מקסימלי -
// כאן מספיקה תוצאה אחת טובה, אין טעם לשלם על יותר). אם לא נמצא אתר רשמי (או שאין מפתח
// SERPAPI) - official_url נשאר null וה-UI ימשיך להציג את "המידע נאסף מהאתר הזה" כמו היום.
async function findOfficialWebsite(name, city) {
  if (!process.env.SERPAPI_KEY || !name) return null;
  try {
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'google');
    url.searchParams.set('q', [name, city, 'אתר רשמי'].filter(Boolean).join(' '));
    url.searchParams.set('hl', 'he');
    url.searchParams.set('gl', 'il');
    url.searchParams.set('num', '5');
    url.searchParams.set('api_key', process.env.SERPAPI_KEY);
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = await res.json();
    const organic = Array.isArray(data.organic_results) ? data.organic_results : [];
    const first = organic.find((r) => {
      if (typeof r.link !== 'string' || !r.link) return false;
      try {
        const host = new URL(r.link).hostname.replace(/^www\./, '');
        return !DISCOVERY_EXCLUDED_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
      } catch {
        return false;
      }
    });
    return first ? first.link : null;
  } catch (err) {
    console.error('חיפוש אתר רשמי נכשל:', err);
    return null;
  }
}

// Geocoding (Nominatim/OpenStreetMap, חינמי - לא דורש מפתח API): הופך שם מקום/כתובת/עיר לקואורדינטות
// (lat/lng) לצורך הצגה על המפה באפליקציה. יש להם מדיניות שימוש שמגבילה לבקשה אחת בשנייה ודורשת
// User-Agent מזהה - lastGeocodeRequestAt/GEOCODE_MIN_INTERVAL_MS דואגים לקצב, וה-User-Agent כולל
// פרטי קשר כנדרש. אם לא נמצאה תוצאה - פשוט מוותרים בשקט, בדיוק כמו בחיפוש תמונה אוטומטי; המיקום
// פשוט לא יופיע על המפה עד שיתעדכן ידנית.
const NOMINATIM_USER_AGENT = 'TuRu-KidsApp/1.0 (contact: mborenmusic@gmail.com)';
const GEOCODE_MIN_INTERVAL_MS = 1100;
let lastGeocodeRequestAt = 0;

async function queryNominatim(query) {
  const wait = GEOCODE_MIN_INTERVAL_MS - (Date.now() - lastGeocodeRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeocodeRequestAt = Date.now();

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'il');
  url.searchParams.set('q', `${query}, ישראל`);
  const geoRes = await fetch(url.toString(), { headers: { 'User-Agent': NOMINATIM_USER_AGENT } });
  if (!geoRes.ok) return null;
  const results = await geoRes.json();
  if (!Array.isArray(results) || results.length === 0) return null;
  const lat = parseFloat(results[0].lat);
  const lng = parseFloat(results[0].lon);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  return { lat, lng };
}

// Nominatim מבוסס OpenStreetMap, שמכיל בעיקר כבישים/שכונות/אתרים ציבוריים - הרבה עסקים קטנים
// (חדרי בריחה, סטודיו טניס וכו') לא ימופו שם בכלל, אז חיפוש עם שם העסק המדויק נכשל הרבה פעמים.
// לכן: קודם מנסים את השאילתה המלאה (כתובת/שם המקום/עיר), ואם זה נכשל - fallback לעיר בלבד, כדי
// לפחות לקבל פין מקורב באזור הנכון במקום כלום.
async function geocodeLocation(location) {
  const full = [location.address, location.name, location.city].filter(Boolean).join(', ');
  const attempts = [];
  if (full) attempts.push(full);
  if (location.city && location.city !== full) attempts.push(location.city);
  if (attempts.length === 0) return null;

  for (const query of attempts) {
    try {
      const coords = await queryNominatim(query);
      if (coords) return coords;
    } catch (err) {
      console.error('geocoding נכשל עבור "' + query + '":', err);
    }
  }
  return null;
}

// עוזר משותף: אם למיקום הנתון עדיין אין קואורדינטות - מנסה לאתר ולמלא אותן. נקרא אחרי כל יצירה/עדכון
// של מיקום (שמירת פעילות חדשה, עריכת מיקום בטופס הניהול) כדי שקואורדינטות יתמלאו אוטומטית מרגע
// שיש שם/כתובת/עיר, בלי שהמנהל יצטרך לבקש את זה במפורש.
async function geocodeAndFillLocation(client, locationId, { force = false } = {}) {
  if (!locationId) return null;
  const { data: loc, error } = await client
    .from('locations')
    .select('id, name, address, city, lat, lng')
    .eq('id', locationId)
    .maybeSingle();
  if (error || !loc) return null;
  if (!force && loc.lat != null && loc.lng != null) return { lat: loc.lat, lng: loc.lng };
  const coords = await geocodeLocation(loc);
  if (coords) {
    await client.from('locations').update({ lat: coords.lat, lng: coords.lng }).eq('id', locationId);
  }
  return coords;
}

// גילוי אתרים אוטומטי (SERPAPI): כמה עמודי תוצאות לכל שאילתה, וכמה שאילתות (המקורית + וריאציות
// שקלוד מציע) - כדי לכסות יותר אתרים בלי להריץ עשרות חיפושים בתשלום על כל לחיצה.
const DISCOVERY_PAGES_PER_QUERY = 3;
const DISCOVERY_QUERY_VARIATIONS = 2; // בנוסף לשאילתה המקורית - עד 3 שאילתות סה"כ
const DISCOVERY_EXCLUDED_DOMAINS = ['facebook.com', 'instagram.com', 'youtube.com', 'tiktok.com', 'x.com', 'twitter.com', 'linkedin.com'];

const SEARCH_EXPANSION_PROMPT = `אתה עוזר שמרחיב שאילתת חיפוש של הורה שמחפש פעילויות לילדים בישראל, כדי שאפשר יהיה לחפש בגוגל גם ניסוחים קרובים ולמצוא עוד אתרים רלוונטיים שלא היו עולים בחיפוש המקורי.

קיבלת את שאילתת החיפוש המקורית. החזר מערך JSON של עד 2 שאילתות חיפוש נוספות בעברית - קרובות במשמעות לשאילתה המקורית אך מנוסחות אחרת (מילים נרדפות, זווית מעט שונה, למשל "אתרים לפעילות עם ילדים" במקום "גן שעשועים"). אל תחזור בדיוק על אותה שאילתה.

החזר תשובה שהיא אך ורק מערך JSON של מחרוזות (למשל ["שאילתה א", "שאילתה ב"]), בלי טקסט נוסף לפני או אחרי, ובלי markdown code fences.`;

async function expandSearchQueries(query) {
  if (!process.env.ANTHROPIC_API_KEY) return [];
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: SEARCH_EXPANSION_PROMPT,
      messages: [{ role: 'user', content: query }],
    });
    const raw = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const variations = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(variations)) return [];
    return variations.filter((v) => typeof v === 'string' && v.trim()).slice(0, DISCOVERY_QUERY_VARIATIONS);
  } catch (err) {
    console.error('הרחבת שאילתת חיפוש נכשלה:', err);
    return [];
  }
}

async function serpApiWebSearch(query) {
  if (!process.env.SERPAPI_KEY) return [];
  const results = [];
  for (let page = 0; page < DISCOVERY_PAGES_PER_QUERY; page++) {
    try {
      const url = new URL('https://serpapi.com/search.json');
      url.searchParams.set('engine', 'google');
      url.searchParams.set('q', query);
      url.searchParams.set('hl', 'he');
      url.searchParams.set('gl', 'il');
      url.searchParams.set('num', '10');
      url.searchParams.set('start', String(page * 10));
      url.searchParams.set('api_key', process.env.SERPAPI_KEY);
      const res = await fetch(url.toString());
      if (!res.ok) break;
      const data = await res.json();
      const organic = Array.isArray(data.organic_results) ? data.organic_results : [];
      if (organic.length === 0) break;
      for (const r of organic) {
        if (typeof r.link === 'string' && r.link) {
          results.push({ url: r.link, title: r.title || '', snippet: r.snippet || '' });
        }
      }
    } catch (err) {
      console.error('חיפוש SERPAPI נכשל עבור "' + query + '" (עמוד ' + (page + 1) + '):', err);
      break;
    }
  }
  return results;
}

async function scrapeAndExtract(urlString) {
  const parsedUrl = new URL(urlString);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('הקישור לא תקין');

  const pageRes = await fetch(parsedUrl.toString(), {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WabbitImportBot/1.0)' },
  });
  if (!pageRes.ok) {
    const err = new Error(`לא הצלחתי לטעון את הדף (סטטוס ${pageRes.status})`);
    err.status = 502;
    throw err;
  }
  const html = await pageRes.text();

  const $ = cheerio.load(html);
  const candidateImages = extractCandidateImages($, parsedUrl.toString());
  $('script, style, noscript, nav, footer, header, svg, form').remove();
  const text = $('body').text().replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim().slice(0, 18000);

  if (!text) {
    const err = new Error('לא נמצא טקסט קריא בעמוד הזה');
    err.status = 422;
    throw err;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('לא הוגדר ANTHROPIC_API_KEY בקובץ .env');
    err.status = 500;
    throw err;
  }

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8192,
    system: buildExtractionSystemPrompt(),
    messages: [
      {
        role: 'user',
        content: `כתובת המקור: ${parsedUrl.toString()}\n\nתוכן הדף:\n${text}\n\nרשימת תמונות מהעמוד:\n${JSON.stringify(candidateImages)}`,
      },
    ],
  });

  const raw = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    const err = new Error('המודל לא החזיר JSON תקני');
    err.status = 502;
    throw err;
  }

  let activities;
  let truncated = false;
  try {
    activities = JSON.parse(jsonMatch[0]);
  } catch (parseErr) {
    // כנראה שהתשובה נקטעה (הרבה פעילויות בעמוד אחד) - ננסה לשחזר את כל האובייקטים השלמים שכן הגיעו
    const text2 = jsonMatch[0];
    const lastCompleteObjEnd = text2.lastIndexOf('},');
    if (lastCompleteObjEnd === -1) {
      console.error('JSON parse failed, no repair possible:', parseErr, raw);
      const err = new Error('המודל החזיר JSON פגום ולא ניתן לתקן. נסו שוב, או נסו קישור עם פחות פעילויות בעמוד אחד.');
      err.status = 502;
      throw err;
    }
    try {
      activities = JSON.parse(text2.slice(0, lastCompleteObjEnd + 1) + ']');
      truncated = true;
    } catch (repairErr) {
      console.error('JSON repair also failed:', repairErr, raw);
      const err = new Error('המודל החזיר JSON פגום ולא ניתן לתקן. נסו שוב, או נסו קישור עם פחות פעילויות בעמוד אחד.');
      err.status = 502;
      throw err;
    }
  }

  // רשת ביטחון ברמת הקוד (לא רק בפרומפט) - תאריך חד-פעמי שכבר עבר לא רלוונטי יותר,
  // גם אם המודל בכל זאת החזיר אותו.
  const todayStr = new Date().toISOString().slice(0, 10);
  activities = activities.filter((a) => (
    !(a.schedule_type === 'one_time' && a.one_time_date && a.one_time_date < todayStr)
  ));

  const { client } = await getClient();
  const matchCache = new Map();
  for (const a of activities) {
    a.possibleMatches = await findSimilarActivities(client, a.name, a.city, matchCache);
    a.willArchive = shouldArchiveForCommitment(a);
  }

  return { sourceUrl: parsedUrl.toString(), activities, truncated };
}

// "חפש אינפורמציה חסרה" (עמוד איכות נתונים) - מנסה למלא שדה חסר בודד (גיל/מחיר/כתובת/שעות)
// עבור פעילות קיימת, בדיוק כמו שחיפוש תמונה אוטומטי (searchGoogleImage) עושה לתמונות: מעדיפים
// את עמוד המקור/הרשמי הידוע של הפעילות עצמה (רלוונטי יותר מחיפוש כללי), ורק אם אין - מחפשים
// ב-SERPAPI. אם לא נמצא מידע בטוח - מוותרים בשקט (לא מנחשים), בדיוק כמו בשאר החיפושים האוטומטיים.
// missing_coords/no_photo/broken_link לא כאן - יש להם כלים ייעודיים משלהם (geocode-missing/
// search-photo/אין דרך "לחפש" קישור חלופי אמין).
const MISSING_INFO_SEARCH_TERM = {
  missing_age: 'גילאים מתאימים',
  missing_price: 'מחיר כניסה',
  missing_address: 'כתובת',
  missing_hours: 'שעות פתיחה',
};

const MISSING_INFO_FIELD_PROMPT = {
  missing_age: 'טווח הגילאים המתאים לפעילות הזו (לדוגמה 3 עד 8). אם אין מידע ברור וספציפי על גילאים בטקסט, השאר null - אל תנחש.',
  missing_price: 'מחיר הכניסה/ההשתתפות בפעילות הזו. אם היא חינמית ציין זאת. אם אין מידע ברור, השאר null.',
  missing_address: 'הכתובת המדויקת (רחוב ומספר בית, אם מופיע) של המקום. אם אין כתובת ברורה בטקסט, השאר null.',
  missing_hours: 'שעות פעילות/פתיחה קבועות של המקום (לא לוח זמנים משתנה של שיעורים). אם אין שעות קבועות וברורות, השאר null.',
};

const MISSING_INFO_SCHEMA = {
  missing_age: '{"min_age": מספר או null, "max_age": מספר או null}',
  missing_price: '{"price_type": "free" או "fixed" או "range" או null, "price_amount": מספר או null}',
  missing_address: '{"address": מחרוזת או null}',
  missing_hours: '{"start_time": "HH:MM" או null, "end_time": "HH:MM" או null}',
};

async function fetchPageTextForExtraction(pageUrl) {
  const pageRes = await fetch(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WabbitImportBot/1.0)' } });
  if (!pageRes.ok) return null;
  const html = await pageRes.text();
  const $ = cheerio.load(html);
  $('script, style, noscript, nav, footer, header, svg, form').remove();
  const text = $('body').text().replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim().slice(0, 10000);
  return text || null;
}

async function findMissingFieldValue(activity, issueCode) {
  const searchTerm = MISSING_INFO_SEARCH_TERM[issueCode];
  if (!searchTerm || !process.env.ANTHROPIC_API_KEY) return null;

  const namePart = activity.name || '';
  const cityPart = activity.location?.city || '';

  let pageUrl = activity.official_url || activity.source_url || null;
  let text = null;
  if (pageUrl) {
    try { text = await fetchPageTextForExtraction(pageUrl); } catch { text = null; }
  }
  if (!text) {
    const results = await serpApiWebSearch([namePart, cityPart, searchTerm].filter(Boolean).join(' '));
    for (const r of results.slice(0, 3)) {
      try {
        text = await fetchPageTextForExtraction(r.url);
        if (text) break;
      } catch { /* ננסה את התוצאה הבאה */ }
    }
  }
  if (!text) return null;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: `אתה עוזר שמחלץ פרט מידע ספציפי אחד מתוך תוכן דף אינטרנט, על פעילות/מקום לילדים בישראל.
המשימה: ${MISSING_INFO_FIELD_PROMPT[issueCode]}
החזר אך ורק אובייקט JSON יחיד בפורמט: ${MISSING_INFO_SCHEMA[issueCode]} - בלי טקסט נוסף לפני/אחרי, בלי markdown code fences.`,
      messages: [{ role: 'user', content: `שם הפעילות: ${namePart}\nעיר: ${cityPart}\n\nתוכן הדף:\n${text}` }],
    });
    const raw = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('חילוץ מידע חסר נכשל:', err);
    return null;
  }
}

app.post('/api/import', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'חסר קישור' });
  }
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'הקישור לא תקין' });
  }

  try {
    const result = await scrapeAndExtract(url);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'שגיאה לא צפויה' });
  }
});

async function crossCheckScrapedSources(client, unique) {
  let knownStatus = new Map();
  if (unique.length > 0) {
    const { data: known, error } = await client.from('scraped_sources').select('url, status').in('url', unique.map((r) => r.url));
    if (error) throw error;
    knownStatus = new Map((known || []).map((k) => [k.url, k.status]));
  }
  const candidates = unique.filter((r) => !knownStatus.has(r.url));
  const alreadySeenList = unique.filter((r) => knownStatus.has(r.url)).map((r) => ({ url: r.url, status: knownStatus.get(r.url) }));
  return { candidates, alreadySeenList };
}

app.post('/api/discover/manual', async (req, res) => {
  const { urls } = req.body || {};
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'לא נשלחו קישורים' });
  }
  try {
    const { client } = await getClient();
    const seenInBatch = new Set();
    const unique = [];
    for (const raw of urls) {
      if (typeof raw !== 'string') continue;
      let parsed;
      try { parsed = new URL(raw.trim()); } catch { continue; }
      const url = parsed.toString();
      if (seenInBatch.has(url)) continue;
      seenInBatch.add(url);
      unique.push({ url, title: url, snippet: '', domain: parsed.hostname });
    }

    const { candidates, alreadySeenList } = await crossCheckScrapedSources(client, unique);
    res.json({ candidates, totalFound: unique.length, alreadySeen: alreadySeenList.length, alreadySeenList });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'שגיאה בבדיקת קישורים' });
  }
});

app.post('/api/discover/google-search', async (req, res) => {
  const { query } = req.body || {};
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'חסרה שאילתת חיפוש' });
  }
  if (!process.env.SERPAPI_KEY) {
    return res.status(500).json({ error: 'לא הוגדר SERPAPI_KEY בקובץ .env - אי אפשר לחפש אוטומטית בגוגל' });
  }
  try {
    const trimmedQuery = query.trim();
    const variations = await expandSearchQueries(trimmedQuery);
    const queriesUsed = [trimmedQuery, ...variations];

    const rawResults = [];
    for (const q of queriesUsed) {
      const results = await serpApiWebSearch(q);
      rawResults.push(...results);
    }

    const seenUrls = new Set();
    const unique = [];
    for (const r of rawResults) {
      let parsed;
      try { parsed = new URL(r.url); } catch { continue; }
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      const normalized = parsed.toString();
      if (seenUrls.has(normalized)) continue;
      const domain = parsed.hostname.replace(/^www\./, '');
      if (DISCOVERY_EXCLUDED_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d))) continue;
      seenUrls.add(normalized);
      unique.push({ url: normalized, title: r.title, snippet: r.snippet, domain: parsed.hostname });
    }

    const { client } = await getClient();
    const { candidates, alreadySeenList } = await crossCheckScrapedSources(client, unique);

    res.json({
      candidates,
      totalFound: unique.length,
      alreadySeen: alreadySeenList.length,
      alreadySeenList,
      queriesUsed,
    });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'שגיאה בחיפוש בגוגל' });
  }
});

app.post('/api/discover/skip', async (req, res) => {
  const { url, title, searchQuery } = req.body || {};
  if (!url) return res.status(400).json({ error: 'חסר קישור' });
  try {
    const { client, userId } = await getClient();
    let domain = null;
    try { domain = new URL(url).hostname; } catch {}
    const { error } = await client.from('scraped_sources').upsert(
      { url, domain, title: title || null, search_query: searchQuery || null, status: 'skipped', scraped_by: userId, scraped_at: new Date().toISOString() },
      { onConflict: 'url' }
    );
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה' });
  }
});

app.post('/api/discover/scrape', async (req, res) => {
  const { urls, searchQuery } = req.body || {};
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'לא נבחרו קישורים' });
  }
  try {
    const { client, userId } = await getClient();
    const results = [];
    for (const url of urls) {
      let domain = null;
      try { domain = new URL(url).hostname; } catch {}
      try {
        const { activities, truncated } = await scrapeAndExtract(url);
        await client.from('scraped_sources').upsert(
          { url, domain, search_query: searchQuery || null, status: 'scraped', activities_found: activities.length, scraped_by: userId, scraped_at: new Date().toISOString() },
          { onConflict: 'url' }
        );
        results.push({ sourceUrl: url, activities, truncated, error: null });
      } catch (err) {
        console.error('discover/scrape failed for', url, err);
        await client.from('scraped_sources').upsert(
          { url, domain, search_query: searchQuery || null, status: 'error', error_message: err.message, scraped_by: userId, scraped_at: new Date().toISOString() },
          { onConflict: 'url' }
        );
        results.push({ sourceUrl: url, activities: [], truncated: false, error: err.message });
      }
    }
    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה' });
  }
});

app.post('/api/save', async (req, res) => {
  const { sourceUrl, activity } = req.body || {};
  if (!activity || !activity.name || !activity.entity_type) {
    return res.status(400).json({ error: 'חסרים שדות חובה (שם, סוג)' });
  }
  try {
    const { client, userId } = await getClient();
    const archived = shouldArchiveForCommitment(activity);

    let locationId = null;
    if (activity.location_name) {
      const { data: existing, error: findErr } = await client
        .from('locations')
        .select('id, city, region')
        .ilike('name', activity.location_name)
        .limit(1)
        .maybeSingle();
      if (findErr) throw findErr;
      if (existing) {
        locationId = existing.id;
        // אם למיקום הקיים כבר אין עיר/אזור, וההפעלה הזו מספקת אותם - נשלים (לא דורסים ערך קיים)
        const fillIn = {};
        if (!existing.city && activity.city) fillIn.city = activity.city;
        if (!existing.region && activity.region) fillIn.region = activity.region;
        if (Object.keys(fillIn).length > 0) {
          const { error: updErr } = await client.from('locations').update(fillIn).eq('id', locationId);
          if (updErr) throw updErr;
        }
      } else {
        const { data: created, error: locErr } = await client
          .from('locations')
          .insert({ name: activity.location_name, city: activity.city || null, region: activity.region || null })
          .select('id')
          .single();
        if (locErr) throw locErr;
        locationId = created.id;
      }
      await geocodeAndFillLocation(client, locationId);
    }

    const { data: savedActivity, error: actErr } = await client
      .from('activities')
      .insert({
        name: activity.name,
        description: activity.description || null,
        entity_type: activity.entity_type,
        location_id: locationId,
        location_detail: activity.location_detail || null,
        min_age: activity.min_age ?? null,
        max_age: activity.max_age ?? null,
        price_type: activity.price_type || null,
        price_amount: activity.price_amount ?? null,
        category: activity.category || null,
        duration_minutes: activity.duration_minutes ?? null,
        indoor_outdoor: activity.indoor_outdoor || null,
        booking_requirement: activity.booking_requirement || null,
        weather_suitable: activity.weather_suitable || [],
        amenities: activity.amenities || [],
        family_fit: activity.family_fit || [],
        status: archived ? 'archived' : 'approved',
        source: 'scraped',
        source_url: sourceUrl || null,
        created_by: userId,
      })
      .select('id')
      .single();
    if (actErr) throw actErr;

    const scheduleRows = [];
    if (activity.schedule_type === 'recurring' && Array.isArray(activity.recurring_days) && activity.recurring_days.length) {
      for (const day of activity.recurring_days) {
        scheduleRows.push({
          activity_id: savedActivity.id,
          schedule_type: 'recurring',
          day_of_week: day,
          start_time: activity.start_time || null,
          end_time: activity.end_time || null,
        });
      }
    } else if (activity.schedule_type === 'one_time') {
      scheduleRows.push({
        activity_id: savedActivity.id,
        schedule_type: 'one_time',
        one_time_date: activity.one_time_date || null,
        start_time: activity.start_time || null,
        end_time: activity.end_time || null,
      });
    } else if (activity.schedule_type === 'fixed_hours') {
      scheduleRows.push({
        activity_id: savedActivity.id,
        schedule_type: 'fixed_hours',
        start_time: activity.start_time || null,
        end_time: activity.end_time || null,
      });
    }
    if (scheduleRows.length) {
      const { error: schedErr } = await client.from('activity_schedules').insert(scheduleRows);
      if (schedErr) throw schedErr;
    }

    let imageAdded = false;
    if (Array.isArray(activity.image_urls) && activity.image_urls.length) {
      const imageRows = activity.image_urls
        .filter((url) => typeof url === 'string' && url.trim())
        .slice(0, 3)
        .map((url) => ({ activity_id: savedActivity.id, url, uploaded_by: userId }));
      if (imageRows.length) {
        const { error: imgErr } = await client.from('activity_images').insert(imageRows);
        if (imgErr) throw imgErr;
        imageAdded = true;
      }
    }

    // לא נמצאה תמונה בעמוד המקור - מנסים לחפש תמונה של המקום בעצמנו (רק לפעילויות שבאמת
    // יוצגו באפליקציה, אין טעם לבזבז חיפוש בתשלום על משהו שממילא יעבור לארכיון).
    if (!imageAdded && !archived) {
      const query = [activity.name, activity.city].filter(Boolean).join(' ');
      const foundUrl = await searchGoogleImage(query);
      if (foundUrl) {
        const { error: autoImgErr } = await client
          .from('activity_images')
          .insert({ activity_id: savedActivity.id, url: foundUrl, uploaded_by: userId });
        if (autoImgErr) console.error('שמירת תמונה שנמצאה אוטומטית נכשלה:', autoImgErr);
      }
    }

    // חיפוש אתר רשמי - כנ"ל, רק לפעילויות שבאמת יוצגו באפליקציה.
    if (!archived) {
      const officialUrl = await findOfficialWebsite(activity.name, activity.city);
      if (officialUrl) {
        const { error: officialUrlErr } = await client
          .from('activities')
          .update({ official_url: officialUrl })
          .eq('id', savedActivity.id);
        if (officialUrlErr) console.error('שמירת אתר רשמי שנמצא אוטומטית נכשלה:', officialUrlErr);
      }
    }

    res.json({ ok: true, activityId: savedActivity.id, archived });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בשמירה' });
  }
});

app.post('/api/suggest-merge', async (req, res) => {
  const { existingActivityId, candidate } = req.body || {};
  if (!existingActivityId || !candidate) {
    return res.status(400).json({ error: 'חסרים נתונים' });
  }
  try {
    const { client } = await getClient();
    const { data: existing, error } = await client
      .from('activities')
      .select(`
        id, name, description, entity_type, min_age, max_age, price_type, price_amount,
        category, duration_minutes, indoor_outdoor, booking_requirement,
        weather_suitable, amenities, family_fit,
        location:locations(name, city, region), activity_images(url)
      `)
      .eq('id', existingActivityId)
      .maybeSingle();
    if (error) throw error;
    if (!existing) return res.status(404).json({ error: 'הפעילות הקיימת לא נמצאה - ייתכן שנמחקה' });

    const { possibleMatches, ...candidateForPrompt } = candidate;

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: MERGE_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `רשומה קיימת:\n${JSON.stringify(existing)}\n\nרשומה חדשה שזוהתה:\n${JSON.stringify(candidateForPrompt)}`,
        },
      ],
    });

    const raw = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      const err = new Error('המודל לא החזיר JSON תקני');
      err.status = 502;
      throw err;
    }
    const result = JSON.parse(jsonMatch[0]);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'שגיאה בבדיקת שילוב' });
  }
});

app.post('/api/merge', async (req, res) => {
  const { existingActivityId, mergedFields, imageUrlsToAdd, deleteActivityId } = req.body || {};
  if (!existingActivityId) {
    return res.status(400).json({ error: 'חסר מזהה פעילות' });
  }
  try {
    const { client, userId } = await getClient();

    const safeFields = {};
    for (const [key, value] of Object.entries(mergedFields || {})) {
      if (MERGE_ALLOWED_FIELDS.has(key)) safeFields[key] = value;
    }
    if (Object.keys(safeFields).length > 0) {
      const { error: updErr } = await client.from('activities').update(safeFields).eq('id', existingActivityId);
      if (updErr) throw updErr;
    }

    if (Array.isArray(imageUrlsToAdd) && imageUrlsToAdd.length > 0) {
      const { data: existingImages, error: imgSelErr } = await client
        .from('activity_images')
        .select('url')
        .eq('activity_id', existingActivityId);
      if (imgSelErr) throw imgSelErr;
      const existingUrls = new Set((existingImages || []).map((i) => i.url));
      const rows = imageUrlsToAdd
        .filter((u) => typeof u === 'string' && u.trim() && !existingUrls.has(u))
        .slice(0, 3)
        .map((u) => ({ activity_id: existingActivityId, url: u, uploaded_by: userId }));
      if (rows.length) {
        const { error: imgInsErr } = await client.from('activity_images').insert(rows);
        if (imgInsErr) throw imgInsErr;
      }
    }

    // כשמיזוג נעשה מעמוד הכפילויות (לא בזמן scraping) - שתי הרשומות כבר קיימות ב-DB, אז אחרי
    // שקיפלנו את השדות של הנפטרת (loser) לתוך הזוכה (keeper) צריך גם למחוק את הנפטרת בפועל,
    // אחרת שתיהן ימשיכו להתקיים. בזרימת ה-scraping הרגילה אין deleteActivityId (אין רשומה שנייה
    // למחוק - המועמד עוד לא נשמר).
    if (deleteActivityId) {
      const { error: delErr } = await client.from('activities').delete().eq('id', deleteActivityId);
      if (delErr) throw delErr;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בשילוב' });
  }
});

// שני מעברי זיהוי: (1) exact - כמו קודם, אותו שם+שם מיקום מדויק (case-insensitive). (2) proximity -
// שתי פעילויות בקואורדינטות קרובות (≤150 מטר) עם דמיון-שם חלקי (word overlap ≥0.4, סף נמוך יותר
// מה-0.5 שמשמש בזמן scraping כי קרבה גיאוגרפית היא כבר איתות חזק בפני עצמו). proximity תמיד
// מפיקה זוגות (לא קבוצות רב-חברים) כדי ש"השאר נפרדות" יהיה תמיד חד-משמעי. תשואת ה-JSON נשארת
// {groups:[...]} כמו קודם - page.js משתמש ב-endpoint הזה גם הוא (checkDuplicates), ולא נוגעים בו.
const PROXIMITY_KM = 0.15;
const PROXIMITY_NAME_SCORE = 0.4;

app.get('/api/duplicates', async (req, res) => {
  try {
    const { client } = await getClient();
    const [{ data, error }, { data: dismissedRows, error: dismErr }] = await Promise.all([
      client
        .from('activities')
        .select('id, name, entity_type, status, source, source_url, created_at, location:locations(name, lat, lng)')
        .order('created_at', { ascending: false }),
      client.from('dismissed_duplicates').select('activity_id_a, activity_id_b'),
    ]);
    if (error) throw error;
    if (dismErr) throw dismErr;

    const dismissed = new Set((dismissedRows || []).map((r) => dismissKey(r.activity_id_a, r.activity_id_b)));
    const toActivity = (r) => ({
      id: r.id, status: r.status, source: r.source, sourceUrl: r.source_url,
      createdAt: r.created_at, entityType: r.entity_type,
    });

    // מעבר 1: exact match
    const exactGroups = new Map();
    for (const row of data) {
      const key = (row.name || '').trim().toLowerCase() + '|' + (row.location?.name || '').trim().toLowerCase();
      if (!exactGroups.has(key)) exactGroups.set(key, []);
      exactGroups.get(key).push(row);
    }
    const duplicateGroups = Array.from(exactGroups.values())
      .filter((rows) => rows.length > 1)
      .filter((rows) => !(rows.length === 2 && dismissed.has(dismissKey(rows[0].id, rows[1].id))))
      .map((rows) => ({
        matchType: 'exact',
        name: rows[0].name,
        locationName: rows[0].location?.name || null,
        activities: rows.map(toActivity),
      }));

    // מעבר 2: proximity - רק פעילויות עם קואורדינטות, זוגות בלבד, לא כאלה שכבר ב-exact group
    const exactIds = new Set();
    for (const rows of exactGroups.values()) {
      if (rows.length > 1) rows.forEach((r) => exactIds.add(r.id));
    }
    const withCoords = data.filter((r) => !exactIds.has(r.id) && r.location?.lat != null && r.location?.lng != null);
    const usedInProximity = new Set();
    for (let i = 0; i < withCoords.length; i++) {
      if (usedInProximity.has(withCoords[i].id)) continue;
      let best = null;
      for (let j = i + 1; j < withCoords.length; j++) {
        if (usedInProximity.has(withCoords[j].id)) continue;
        const a = withCoords[i];
        const b = withCoords[j];
        const distKm = haversineKm(a.location.lat, a.location.lng, b.location.lat, b.location.lng);
        if (distKm > PROXIMITY_KM) continue;
        const nameScore = wordOverlapScore(a.name, b.name);
        if (nameScore < PROXIMITY_NAME_SCORE) continue;
        if (dismissed.has(dismissKey(a.id, b.id))) continue;
        if (!best || nameScore > best.nameScore) best = { other: b, nameScore, distKm };
      }
      if (best) {
        usedInProximity.add(withCoords[i].id);
        usedInProximity.add(best.other.id);
        duplicateGroups.push({
          matchType: 'proximity',
          name: withCoords[i].name,
          locationName: withCoords[i].location?.name || null,
          distanceMeters: Math.round(best.distKm * 1000),
          nameScore: Math.round(best.nameScore * 100) / 100,
          activities: [toActivity(withCoords[i]), toActivity(best.other)],
        });
      }
    }

    res.json({ groups: duplicateGroups });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בבדיקת כפילויות' });
  }
});

app.post('/api/manage/dismiss-duplicate', async (req, res) => {
  const { idA, idB } = req.body || {};
  if (!idA || !idB) return res.status(400).json({ error: 'חסרים מזהי פעילויות' });
  try {
    const { client } = await getClient();
    const [first, second] = idA < idB ? [idA, idB] : [idB, idA];
    const { error } = await client
      .from('dismissed_duplicates')
      .upsert({ activity_id_a: first, activity_id_b: second }, { onConflict: 'activity_id_a,activity_id_b' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בסימון "השאר נפרדות"' });
  }
});

// "התעלם" מבעיית איכות-נתונים בודדת (עמוד איכות נתונים) - תומך בכמה ids בבת אחת (סימון-הכל
// לקטגוריה). לא "פותר" את הנתון עצמו, רק מסמן שהמנהל בחר במודע לא לטפל - ראו computeIssues.
app.post('/api/manage/dismiss-issue', async (req, res) => {
  const { ids, issueCode } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0 || !issueCode) {
    return res.status(400).json({ error: 'חסרים נתונים' });
  }
  try {
    const { client } = await getClient();
    const rows = ids.map((activity_id) => ({ activity_id, issue_code: issueCode }));
    const { error } = await client
      .from('dismissed_issues')
      .upsert(rows, { onConflict: 'activity_id,issue_code' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בסימון "התעלם"' });
  }
});

// "חפש אינפורמציה חסרה" עבור פעילות בודדת אחת (עמוד איכות נתונים) - הלקוח לולא על הפעילויות
// המסומנות וקורא לזה אחת-אחת, באותו דפוס בדיוק כמו missingPhotosBulkSearchBtn/searchPhotoFor
// ב-manage.js. אם נמצא ונשמר מידע - הפעילות המעודכנת חוזרת כדי שהלקוח יעדכן את המצב המקומי
// (ואז computeIssues כבר לא יסמן אותה, כי השדה עצמו התמלא).
app.post('/api/manage/fill-missing-info', async (req, res) => {
  const { id, issueCode } = req.body || {};
  if (!id || !issueCode) return res.status(400).json({ error: 'חסרים נתונים' });
  try {
    const { client } = await getClient();
    const { data: activity, error: findErr } = await client
      .from('activities')
      .select('id, name, official_url, source_url, location:locations(id, city)')
      .eq('id', id)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!activity) return res.status(404).json({ error: 'הפעילות לא נמצאה' });

    const found = await findMissingFieldValue(activity, issueCode);
    if (!found) return res.json({ ok: true, found: false });

    if (issueCode === 'missing_age' && (found.min_age != null || found.max_age != null)) {
      const { error } = await client.from('activities')
        .update({ min_age: found.min_age ?? null, max_age: found.max_age ?? null })
        .eq('id', id);
      if (error) throw error;
    } else if (issueCode === 'missing_price' && found.price_type) {
      const { error } = await client.from('activities')
        .update({ price_type: found.price_type, price_amount: found.price_amount ?? null })
        .eq('id', id);
      if (error) throw error;
    } else if (issueCode === 'missing_address' && found.address && activity.location?.id) {
      const { error } = await client.from('locations').update({ address: found.address }).eq('id', activity.location.id);
      if (error) throw error;
    } else if (issueCode === 'missing_hours' && found.start_time) {
      const { error } = await client.from('activity_schedules').insert({
        activity_id: id, schedule_type: 'fixed_hours', start_time: found.start_time, end_time: found.end_time || null,
      });
      if (error) throw error;
    } else {
      return res.json({ ok: true, found: false });
    }

    const { data: updated, error: reloadErr } = await client.from('activities').select(MANAGE_SELECT).eq('id', id).single();
    if (reloadErr) throw reloadErr;
    res.json({ ok: true, found: true, activity: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בחיפוש מידע חסר' });
  }
});

app.post('/api/delete-activities', async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'לא נבחרו פעילויות למחיקה' });
  }
  try {
    const { client } = await getClient();
    const results = {};
    for (const id of ids) {
      const { data, error } = await client.from('activities').delete().eq('id', id).select('id');
      if (error) {
        results[id] = { ok: false, error: error.message };
        continue;
      }
      const ok = Array.isArray(data) && data.length > 0;
      results[id] = ok
        ? { ok: true }
        : { ok: false, error: 'אין הרשאה למחוק (כנראה כבר אושרה, או שלא נוצרה על ידי הבוט)' };
    }
    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה במחיקה' });
  }
});

app.get('/api/activities', async (req, res) => {
  try {
    const { client } = await getClient();
    const { data, error } = await client
      .from('activities')
      .select('id, name, category, entity_type, status, source, source_url, created_at, location:locations(name)')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({
      activities: data.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        entityType: r.entity_type,
        status: r.status,
        source: r.source,
        sourceUrl: r.source_url,
        createdAt: r.created_at,
        locationName: r.location?.name || null,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בטעינת הפעילויות' });
  }
});

app.post('/api/set-status', async (req, res) => {
  const { id, status } = req.body || {};
  if (!id || !['pending', 'approved', 'rejected', 'archived'].includes(status)) {
    return res.status(400).json({ error: 'בקשה לא תקינה' });
  }
  try {
    const { client } = await getClient();
    const { data, error } = await client.from('activities').update({ status }).eq('id', id).select('id, status');
    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(403).json({ error: 'אין הרשאה לעדכן פעילות זו (כנראה לא נוצרה על ידי הבוט)' });
    }
    res.json({ ok: true, status: data[0].status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בעדכון הסטטוס' });
  }
});

const MANAGE_SELECT = `
  id, name, description, entity_type, min_age, max_age, price_type, price_amount,
  category, duration_minutes, indoor_outdoor, booking_requirement,
  weather_suitable, amenities, family_fit, status, source, source_url, official_url, created_at,
  location_detail, photo_skipped, last_verified_at, next_review_at, link_broken, link_checked_at,
  location:locations(id, name, city, region, address, lat, lng),
  activity_images(id, url, status),
  activity_schedules(schedule_type, day_of_week, start_time, end_time, one_time_date),
  dismissed_issues(issue_code),
  activity_benefits(id, provider, benefit_type, value, special_price, valid_from, valid_until, redemption_method, redemption_url, coupon_code, terms, status, last_verified_at)
`;

const ACTIVITY_UPDATE_FIELDS = new Set([
  'name', 'description', 'entity_type', 'min_age', 'max_age', 'price_type', 'price_amount',
  'category', 'duration_minutes', 'indoor_outdoor', 'booking_requirement',
  'weather_suitable', 'amenities', 'family_fit', 'status', 'location_detail', 'photo_skipped',
]);

app.get('/manage', (req, res) => {
  res.redirect(301, '/activities');
});

app.get('/api/manage/options', (req, res) => {
  res.json({
    category: CATEGORY_VALUES,
    weather: WEATHER_VALUES,
    amenities: AMENITIES_VALUES,
    familyFit: FAMILY_FIT_VALUES,
    region: REGION_VALUES,
    entityType: ENTITY_TYPE_VALUES,
    priceType: PRICE_TYPE_VALUES,
    indoorOutdoor: INDOOR_OUTDOOR_VALUES,
    booking: BOOKING_VALUES,
    status: STATUS_VALUES,
    benefitProvider: PROVIDER_VALUES,
    benefitType: BENEFIT_TYPE_VALUES,
    benefitTypeLabels: BENEFIT_TYPE_LABELS,
    redemptionMethod: REDEMPTION_METHOD_VALUES,
    redemptionMethodLabels: REDEMPTION_METHOD_LABELS,
    benefitStatus: BENEFIT_STATUS_VALUES,
    benefitStatusLabels: BENEFIT_STATUS_LABELS,
  });
});

app.get('/api/manage/reports', async (req, res) => {
  try {
    const { client } = await getClient();
    const { data: reports, error } = await client
      .from('reports')
      .select('id, target_id, reason, status, created_at')
      .eq('target_type', 'activity')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const activityIds = [...new Set(reports.map((r) => r.target_id))];
    let activityById = new Map();
    if (activityIds.length > 0) {
      const { data: activities, error: actErr } = await client
        .from('activities')
        .select('id, name, status')
        .in('id', activityIds);
      if (actErr) throw actErr;
      activityById = new Map((activities || []).map((a) => [a.id, a]));
    }

    const result = reports.map((r) => ({
      id: r.id,
      reason: r.reason,
      status: r.status,
      createdAt: r.created_at,
      activity: activityById.get(r.target_id) || null,
      activityId: r.target_id,
    }));

    res.json({ reports: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בטעינת דיווחים' });
  }
});

app.post('/api/manage/report-status', async (req, res) => {
  const { id, status } = req.body || {};
  if (!id || !['pending', 'resolved'].includes(status)) {
    return res.status(400).json({ error: 'בקשה לא תקינה' });
  }
  try {
    const { client } = await getClient();
    const { data, error } = await client.from('reports').update({ status }).eq('id', id).select('id, status');
    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(403).json({ error: 'אין הרשאה לעדכן דיווח זה' });
    }
    res.json({ ok: true, status: data[0].status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בעדכון הדיווח' });
  }
});

app.get('/api/manage/pending-photos', async (req, res) => {
  try {
    const { client } = await getClient();
    const { data, error } = await client
      .from('activity_images')
      .select('id, url, status, created_at, uploaded_by, activity:activities(id, name)')
      .eq('status', 'pending')
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ photos: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בטעינת תמונות ממתינות' });
  }
});

app.post('/api/manage/photo-status', async (req, res) => {
  const { id, status } = req.body || {};
  if (!id || !['approved', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'בקשה לא תקינה' });
  }
  try {
    const { client } = await getClient();
    const { data, error } = await client.from('activity_images').update({ status }).eq('id', id).select('id, status');
    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(403).json({ error: 'אין הרשאה לעדכן תמונה זו' });
    }
    res.json({ ok: true, status: data[0].status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בעדכון התמונה' });
  }
});

app.get('/api/manage/activities', async (req, res) => {
  try {
    const { client } = await getClient();
    const { data, error } = await client
      .from('activities')
      .select(MANAGE_SELECT)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ activities: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בטעינת הפעילויות' });
  }
});

app.post('/api/manage/delete-photo', async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'חסר מזהה תמונה' });
  try {
    const { client } = await getClient();
    const { data: img, error: findErr } = await client.from('activity_images').select('url').eq('id', id).maybeSingle();
    if (findErr) throw findErr;

    const { data, error } = await client.from('activity_images').delete().eq('id', id).select('id');
    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(403).json({ error: 'אין הרשאה למחוק תמונה זו' });
    }

    if (img && img.url && img.url.includes('/activity-photos/')) {
      const path = decodeURIComponent(img.url.split('/activity-photos/')[1] || '');
      if (path) await client.storage.from('activity-photos').remove([path]);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה במחיקת התמונה' });
  }
});

// 🎟️ הטבות והנחות - טבלת-בת (activity_benefits, supabase/0038) עם כמה שורות אפשריות לכל
// פעילות, אז מטופלת ב-3 endpoints ייעודיים (לא דרך ACTIVITY_UPDATE_FIELDS/update הכללי, שמיועד
// רק לשדות סקלריים על activities עצמה) - אותו דפוס בדיוק כמו delete-photo/manual-photo למעלה.
const BENEFIT_FIELDS = [
  'provider', 'benefit_type', 'value', 'special_price', 'valid_from', 'valid_until',
  'redemption_method', 'redemption_url', 'coupon_code', 'terms', 'status',
];
function pickBenefitFields(fields) {
  const safe = {};
  for (const key of BENEFIT_FIELDS) {
    if (key in (fields || {})) safe[key] = fields[key];
  }
  return safe;
}

app.post('/api/manage/benefit-add', async (req, res) => {
  const { activityId, fields } = req.body || {};
  if (!activityId) return res.status(400).json({ error: 'חסר מזהה פעילות' });
  const safeFields = pickBenefitFields(fields);
  if (!safeFields.provider || !safeFields.benefit_type) {
    return res.status(400).json({ error: 'חסרים שדות חובה (נותן ההטבה / סוג ההטבה)' });
  }
  try {
    const { client, userId } = await getClient();
    const { data, error } = await client
      .from('activity_benefits')
      .insert({ activity_id: activityId, created_by: userId, ...safeFields })
      .select('id, provider, benefit_type, value, special_price, valid_from, valid_until, redemption_method, redemption_url, coupon_code, terms, status, last_verified_at')
      .single();
    if (error) throw error;
    res.json({ ok: true, benefit: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בהוספת ההטבה' });
  }
});

app.post('/api/manage/benefit-update', async (req, res) => {
  const { id, fields } = req.body || {};
  if (!id) return res.status(400).json({ error: 'חסר מזהה הטבה' });
  const safeFields = pickBenefitFields(fields);
  safeFields.last_verified_at = new Date().toISOString(); // עריכה = אימות, כמו activities.last_verified_at
  try {
    const { client } = await getClient();
    const { data, error } = await client
      .from('activity_benefits')
      .update(safeFields)
      .eq('id', id)
      .select('id, provider, benefit_type, value, special_price, valid_from, valid_until, redemption_method, redemption_url, coupon_code, terms, status, last_verified_at');
    if (error) throw error;
    if (!data || data.length === 0) return res.status(403).json({ error: 'אין הרשאה לעדכן הטבה זו' });
    res.json({ ok: true, benefit: data[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בעדכון ההטבה' });
  }
});

app.post('/api/manage/benefit-delete', async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'חסר מזהה הטבה' });
  try {
    const { client } = await getClient();
    const { data, error } = await client.from('activity_benefits').delete().eq('id', id).select('id');
    if (error) throw error;
    if (!data || data.length === 0) return res.status(403).json({ error: 'אין הרשאה למחוק הטבה זו' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה במחיקת ההטבה' });
  }
});

app.post('/api/manage/search-photo', async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'חסר מזהה פעילות' });
  try {
    const { client, userId } = await getClient();
    const { data: activity, error: findErr } = await client
      .from('activities')
      .select('id, name, location:locations(city)')
      .eq('id', id)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!activity) return res.status(404).json({ error: 'הפעילות לא נמצאה' });

    const query = [activity.name, activity.location?.city].filter(Boolean).join(' ');
    const foundUrl = await searchGoogleImage(query);
    if (!foundUrl) return res.json({ ok: true, found: false });

    // status: 'pending' בכוונה - התמונה נמצאה אוטומטית וטרם נצפתה ע"י אדם, אז היא ממתינה
    // לאישור ידני (בדיוק כמו תמונה שמשתמש קצה מעלה) ולא מוצגת באפליקציה עד שמאשרים אותה.
    const { data: image, error: imgErr } = await client
      .from('activity_images')
      .insert({ activity_id: id, url: foundUrl, uploaded_by: userId, status: 'pending' })
      .select('id, url, status')
      .single();
    if (imgErr) throw imgErr;

    res.json({ ok: true, found: true, image });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בחיפוש תמונה' });
  }
});

app.post('/api/manage/manual-photo', async (req, res) => {
  const { id, imageDataUrl } = req.body || {};
  if (!id || !imageDataUrl) return res.status(400).json({ error: 'חסרים נתונים' });
  const match = /^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/.exec(imageDataUrl);
  if (!match) return res.status(400).json({ error: 'פורמט תמונה לא תקין' });
  const [, mime, base64] = match;
  const ext = mime.split('/')[1].replace('jpeg', 'jpg').split('+')[0];
  try {
    const { client, userId } = await getClient();
    const buffer = Buffer.from(base64, 'base64');
    const path = `${id}/${userId}-${Date.now()}.${ext}`;
    const { error: uploadErr } = await client.storage.from('activity-photos').upload(path, buffer, { contentType: mime });
    if (uploadErr) throw uploadErr;
    const { data: pub } = client.storage.from('activity-photos').getPublicUrl(path);

    const { data: image, error: imgErr } = await client
      .from('activity_images')
      .insert({ activity_id: id, url: pub.publicUrl, uploaded_by: userId })
      .select('id, url, status')
      .single();
    if (imgErr) throw imgErr;

    res.json({ ok: true, image });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בהעלאת התמונה' });
  }
});

app.post('/api/manage/update', async (req, res) => {
  const { id, fields, location } = req.body || {};
  if (!id) return res.status(400).json({ error: 'חסר מזהה פעילות' });
  try {
    const { client } = await getClient();

    let locationId = null;
    if (location) {
      const { data: current, error: curErr } = await client
        .from('activities')
        .select('location_id')
        .eq('id', id)
        .maybeSingle();
      if (curErr) throw curErr;
      locationId = current?.location_id || null;

      const locFields = {};
      if (typeof location.name === 'string') locFields.name = location.name;
      if (typeof location.city === 'string') locFields.city = location.city || null;
      if (typeof location.region === 'string') locFields.region = location.region || null;
      if (typeof location.address === 'string') locFields.address = location.address || null;

      if (locationId) {
        if (Object.keys(locFields).length > 0) {
          const { error: updLocErr } = await client.from('locations').update(locFields).eq('id', locationId);
          if (updLocErr) throw updLocErr;
        }
      } else if (locFields.name) {
        const { data: created, error: createErr } = await client.from('locations').insert(locFields).select('id').single();
        if (createErr) throw createErr;
        locationId = created.id;
      }
      await geocodeAndFillLocation(client, locationId);
    }

    const safeFields = {};
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        if (ACTIVITY_UPDATE_FIELDS.has(key)) safeFields[key] = value;
      }
    }
    if (locationId) safeFields.location_id = locationId;
    // עריכה נחשבת אימות - כל שמירה (גם אם רק שדה מיקום השתנה) "מגעת" בפעילות, אז מעדכנים
    // last_verified_at כדי שהיא תרד מרשימת "דורשות עדכון" בדשבורד בלי צורך בפעולה נפרדת.
    safeFields.last_verified_at = new Date().toISOString();

    if (Object.keys(safeFields).length > 0) {
      const { error: updErr } = await client.from('activities').update(safeFields).eq('id', id);
      if (updErr) throw updErr;
    }

    const { data: updated, error: fetchErr } = await client
      .from('activities')
      .select(MANAGE_SELECT)
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) throw fetchErr;

    res.json({ ok: true, activity: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בעדכון' });
  }
});

// פרימיטיב מרוכז יחיד: מעדכן את אותם שדות (מתוך אותה רשימה מותרת ACTIVITY_UPDATE_FIELDS) על
// כמה פעילויות בבת אחת - מכסה אשר-מרוכז ({status:'approved'}), שינוי קטגוריה מרוכז וכו',
// בלי לכתוב endpoint נפרד לכל פעולה מרוכזת.
app.post('/api/manage/bulk-update', async (req, res) => {
  const { ids, fields } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'לא נבחרו פעילויות' });
  }
  const safeFields = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (ACTIVITY_UPDATE_FIELDS.has(key)) safeFields[key] = value;
  }
  if (Object.keys(safeFields).length === 0) {
    return res.status(400).json({ error: 'אין שדות תקינים לעדכון' });
  }
  safeFields.last_verified_at = new Date().toISOString();
  try {
    const { client } = await getClient();
    const { data, error } = await client.from('activities').update(safeFields).in('id', ids).select('id');
    if (error) throw error;
    res.json({ ok: true, updated: (data || []).length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בעדכון מרוכז' });
  }
});

// "אימות" מרוכז - בלי לשנות שום שדה תוכן, רק לסמן שהמנהל בדק ואישר שהמידע עדיין נכון.
// days null = בלי תזכורת מפורשת (נופל לחלון הגלובלי של 90 יום ב-admin-shared.js).
const VERIFY_REVIEW_DAYS = new Set([30, 60, 90]);
app.post('/api/manage/bulk-verify', async (req, res) => {
  const { ids, days } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'לא נבחרו פעילויות' });
  }
  if (days != null && !VERIFY_REVIEW_DAYS.has(days)) {
    return res.status(400).json({ error: 'ערך תזכורת לא תקין' });
  }
  const now = new Date();
  const nextReview = days ? new Date(now.getTime() + days * 86400000).toISOString() : null;
  try {
    const { client } = await getClient();
    const { data, error } = await client
      .from('activities')
      .update({ last_verified_at: now.toISOString(), next_review_at: nextReview })
      .in('id', ids)
      .select('id');
    if (error) throw error;
    res.json({ ok: true, verified: (data || []).length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה באימות מרוכז' });
  }
});

// שינוי אזור מרוכז - האזור שייך למיקום (locations.region), לא לפעילות עצמה, אז מאתרים את
// מזהי המיקום הייחודיים לפעילויות שנבחרו ומעדכנים אותם - נכון גם כשכמה פעילויות חולקות מיקום.
app.post('/api/manage/bulk-region', async (req, res) => {
  const { ids, region } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'לא נבחרו פעילויות' });
  }
  if (!REGION_VALUES.includes(region)) {
    return res.status(400).json({ error: 'אזור לא תקין' });
  }
  try {
    const { client } = await getClient();
    const { data: activities, error: findErr } = await client
      .from('activities')
      .select('location_id')
      .in('id', ids);
    if (findErr) throw findErr;
    const locationIds = [...new Set((activities || []).map((a) => a.location_id).filter(Boolean))];
    if (locationIds.length === 0) {
      return res.json({ ok: true, updated: 0 });
    }
    const { data, error } = await client.from('locations').update({ region }).in('id', locationIds).select('id');
    if (error) throw error;
    res.json({ ok: true, updated: (data || []).length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בשינוי אזור מרוכז' });
  }
});

// כפתור ידני בטופס העריכה - מאתר מחדש קואורדינטות למיקום גם אם כבר יש לו כאלה (למשל אחרי שהמנהל
// תיקן כתובת שגויה).
app.post('/api/manage/geocode-location', async (req, res) => {
  const { locationId } = req.body || {};
  if (!locationId) return res.status(400).json({ error: 'חסר מזהה מיקום' });
  try {
    const { client } = await getClient();
    const coords = await geocodeAndFillLocation(client, locationId, { force: true });
    if (!coords) return res.status(404).json({ error: 'לא הצלחנו לאתר קואורדינטות עבור המיקום הזה' });
    res.json({ ok: true, lat: coords.lat, lng: coords.lng });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה באיתור קואורדינטות' });
  }
});

// גיבוי ומילוי בבת אחת של כל המיקומים שעדיין אין להם קואורדינטות (בעיקר לשימוש חד-פעמי על מיקומים
// ישנים שנוצרו לפני שהוספנו geocoding אוטומטי). קצב הבקשות ל-Nominatim מוגבל לאחת בשנייה, אז זה
// יכול לקחת כמה דקות על הרבה מיקומים - הכפתור בממשק הניהול מציג את זה.
app.post('/api/manage/geocode-missing', async (req, res) => {
  try {
    const { client } = await getClient();
    const { data: locations, error } = await client
      .from('locations')
      .select('id, name, address, city')
      .or('lat.is.null,lng.is.null');
    if (error) throw error;

    let geocoded = 0;
    let failed = 0;
    for (const loc of locations) {
      const coords = await geocodeLocation(loc);
      if (coords) {
        const { error: updErr } = await client.from('locations').update({ lat: coords.lat, lng: coords.lng }).eq('id', loc.id);
        if (updErr) { failed++; continue; }
        geocoded++;
      } else {
        failed++;
      }
    }
    res.json({ ok: true, total: locations.length, geocoded, failed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בהשלמת קואורדינטות' });
  }
});

// ניקוי פעילויות שפג תוקפן - קורא ל-RPC יחיד (0028_cleanup_expired_activities.sql) שעושה
// את כל הסינון והמחיקה בתוך Postgres במשפט SQL בודד. dryRun=true (ברירת מחדל בצד השרת גם
// כאן) מחזיר תצוגה מקדימה לאישור לפני מחיקה בפועל.
app.post('/api/manage/cleanup-expired', async (req, res) => {
  const dryRun = req.body?.dryRun !== false;
  try {
    const { client } = await getClient();
    const { data, error } = await client.rpc('cleanup_expired_activities', { dry_run: dryRun });
    if (error) throw error;
    res.json({ ok: true, dryRun, activities: data || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בניקוי פעילויות שפג תוקפן' });
  }
});

// בדיקת קישורים שבורים - בודקת source_url/official_url לפעילויות שעדיין לא נבדקו או שנבדקו
// לפני יותר משבוע. HEAD קודם (זול), נופל ל-GET אם השרת דוחה HEAD (405/403 נפוצים). concurrency
// קטן (chunks של 5, לא בקשה-בקשה כמו geocode) כי אלה בקשות ל-domains שונים לגמרי (לא Nominatim
// עם מגבלת קצב) - אין סיבה לחכות. תקרה של 60 לריצה כדי שכפתור בודד לא ירוץ דקות ארוכות.
const LINK_CHECK_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const LINK_CHECK_BATCH_LIMIT = 60;
const LINK_CHECK_CONCURRENCY = 5;
const LINK_CHECK_TIMEOUT_MS = 6000;

async function checkOneLink(url) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(url, { method, signal: AbortSignal.timeout(LINK_CHECK_TIMEOUT_MS), redirect: 'follow' });
      if (res.ok) return false;
      if (res.status && res.status < 400) return false;
      if (method === 'HEAD' && (res.status === 405 || res.status === 403)) continue; // ננסה GET
      return true;
    } catch {
      if (method === 'HEAD') continue; // כמה שרתים חוסמים HEAD לגמרי - ננסה GET לפני שמוותרים
    }
  }
  return true;
}

app.post('/api/manage/check-links', async (req, res) => {
  try {
    const { client } = await getClient();
    // שליפה מלאה + סינון ב-JS (לא שני .or() מחוברים) - הטבלה קטנה, ופחות שביר מהרכבת שאילתת
    // PostgREST מורכבת עם שני תנאי or נפרדים.
    const { data: activities, error } = await client
      .from('activities')
      .select('id, source_url, official_url, link_checked_at');
    if (error) throw error;

    const staleBeforeMs = Date.now() - LINK_CHECK_STALE_MS;
    const targets = (activities || [])
      .map((a) => ({ id: a.id, url: a.official_url || a.source_url, checkedAt: a.link_checked_at }))
      .filter((a) => a.url && (!a.checkedAt || new Date(a.checkedAt).getTime() < staleBeforeMs))
      .slice(0, LINK_CHECK_BATCH_LIMIT);

    let checked = 0;
    let broken = 0;
    for (let i = 0; i < targets.length; i += LINK_CHECK_CONCURRENCY) {
      const chunk = targets.slice(i, i + LINK_CHECK_CONCURRENCY);
      const results = await Promise.all(chunk.map(async (t) => ({ id: t.id, isBroken: await checkOneLink(t.url) })));
      const checkedAt = new Date().toISOString();
      for (const r of results) {
        checked++;
        if (r.isBroken) broken++;
        const { error: updErr } = await client
          .from('activities')
          .update({ link_broken: r.isBroken, link_checked_at: checkedAt })
          .eq('id', r.id);
        if (updErr) console.error('עדכון link_broken נכשל עבור', r.id, updErr);
      }
    }
    res.json({ ok: true, checked, broken, remaining: Math.max(0, targets.length - checked) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בבדיקת קישורים' });
  }
});

app.get('/members', (req, res) => {
  res.type('html').send(renderMembersPage());
});

app.get('/api/manage/members', async (req, res) => {
  try {
    const { client } = await getClient();
    const { data: profiles, error } = await client
      .from('profiles')
      .select('id, nickname, phone, email, role, banned, created_at')
      .eq('role', 'user')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const ids = profiles.map((p) => p.id);
    const imagesByUser = new Map();
    if (ids.length > 0) {
      const { data: images, error: imgErr } = await client
        .from('activity_images')
        .select('id, url, status, uploaded_by, activity:activities(id, name)')
        .in('uploaded_by', ids);
      if (imgErr) throw imgErr;
      for (const img of images || []) {
        if (!imagesByUser.has(img.uploaded_by)) imagesByUser.set(img.uploaded_by, []);
        imagesByUser.get(img.uploaded_by).push(img);
      }
    }

    const members = profiles.map((p) => ({ ...p, images: imagesByUser.get(p.id) || [] }));
    res.json({ members });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בטעינת רשימת החברים' });
  }
});

app.get('/contributors', (req, res) => {
  res.type('html').send(renderContributorsPage());
});

// מי שתרם/ה בפועל פעילות אחת לפחות (created_by על activities) - role='user' בלבד, כדי לא
// לערבב פנימה את הבוט (role='importer') או את חשבון האדמין (role='admin'), אותו עיקרון בדיוק
// כמו "הומלץ ע"י" באפליקציה עצמה (ראו lib/activities.js attachRecommenders).
app.get('/api/manage/contributors', async (req, res) => {
  try {
    const { client } = await getClient();
    const { data: activities, error } = await client
      .from('activities')
      .select('id, name, status, category, entity_type, created_at, created_by, location:locations(name, city)')
      .not('created_by', 'is', null)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const activitiesByUser = new Map();
    for (const a of activities || []) {
      if (!activitiesByUser.has(a.created_by)) activitiesByUser.set(a.created_by, []);
      activitiesByUser.get(a.created_by).push({
        id: a.id,
        name: a.name,
        status: a.status,
        category: a.category,
        entityType: a.entity_type,
        createdAt: a.created_at,
        locationName: a.location?.name || null,
        city: a.location?.city || null,
      });
    }

    const ids = [...activitiesByUser.keys()];
    if (ids.length === 0) return res.json({ contributors: [] });

    const { data: profiles, error: profErr } = await client
      .from('profiles')
      .select('id, nickname, phone, email, stars, role, created_at')
      .in('id', ids)
      .eq('role', 'user');
    if (profErr) throw profErr;

    const contributors = (profiles || []).map((p) => ({
      id: p.id,
      nickname: p.nickname,
      phone: p.phone,
      email: p.email,
      stars: p.stars ?? 0,
      createdAt: p.created_at,
      activities: activitiesByUser.get(p.id) || [],
    }));

    res.json({ contributors });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בטעינת רשימת התורמים' });
  }
});

app.get('/feedback', (req, res) => {
  res.type('html').send(renderFeedbackPage());
});

// דיווחי "משהו לא עובד? דווח לנו" (ראו supabase/0022_app_feedback.sql, 0027 להוספת name,
// lib/feedback.js) - כל אחד יכול לשלוח בלי התחברות. name הוא שם חופשי שהמשתמש הקליד (ל-
// משתמש רשום הוא ממולא מראש בכינוי אבל אפשר לשנות/למחוק) - הוא קודם ל-nickname שנפתר
// דרך user_id, כי הוא מה שהמשתמש בפועל בחר להציג. "אנונימי" רק אם אין אף אחד מהשניים.
app.get('/api/manage/feedback', async (req, res) => {
  try {
    const { client } = await getClient();
    const { data: feedback, error } = await client
      .from('app_feedback')
      .select('id, message, page, name, user_id, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const userIds = [...new Set(feedback.map((f) => f.user_id).filter(Boolean))];
    let nicknameById = new Map();
    if (userIds.length > 0) {
      const { data: profiles, error: profErr } = await client
        .from('profiles')
        .select('id, nickname')
        .in('id', userIds);
      if (profErr) throw profErr;
      nicknameById = new Map((profiles || []).map((p) => [p.id, p.nickname]));
    }

    res.json({
      feedback: feedback.map((f) => ({
        id: f.id,
        message: f.message,
        page: f.page,
        createdAt: f.created_at,
        nickname: f.name || (f.user_id ? nicknameById.get(f.user_id) || null : null),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בטעינת הדיווחים' });
  }
});

app.get('/messages', (req, res) => {
  res.type('html').send(renderMessagesPage());
});

// פניות מ"צרו קשר" (ראו supabase/0026_contact_messages.sql) - נשמרות אוטומטית ע"י
// send-contact-email, ומוצגות כאן לטיפול. תשובה נשלחת דרך send-contact-reply (Edge Function
// נפרדת, כי צריך RESEND_API_KEY שיושב רק בסודות Supabase, לא בכלי הזה).
app.get('/api/manage/contact-messages', async (req, res) => {
  try {
    const { client } = await getClient();
    const { data, error } = await client
      .from('contact_messages')
      .select('id, email, message, status, admin_reply, replied_at, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ messages: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בטעינת ההודעות' });
  }
});

app.post('/api/manage/contact-reply', async (req, res) => {
  const { id, replyText } = req.body || {};
  if (!id || !replyText || !replyText.trim()) {
    return res.status(400).json({ error: 'חסר מזהה הודעה או תוכן תשובה' });
  }
  try {
    const { client } = await getClient();
    const { data, error } = await client.functions.invoke('send-contact-reply', {
      body: { messageId: id, replyText: replyText.trim() },
    });
    if (error) {
      if (error.context && typeof error.context.json === 'function') {
        const body = await error.context.json().catch(() => null);
        if (body?.error) return res.status(500).json({ error: body.error });
      }
      throw error;
    }
    if (data?.error) return res.status(500).json({ error: data.error });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בשליחת התשובה' });
  }
});

app.post('/api/manage/member-ban', async (req, res) => {
  const { id, banned } = req.body || {};
  if (!id || typeof banned !== 'boolean') {
    return res.status(400).json({ error: 'בקשה לא תקינה' });
  }
  try {
    const { client } = await getClient();
    const { data, error } = await client.from('profiles').update({ banned }).eq('id', id).select('id, banned');
    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(403).json({ error: 'אין הרשאה לעדכן משתמש זה' });
    }
    res.json({ ok: true, banned: data[0].banned });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בעדכון המשתמש' });
  }
});

const PORT = process.env.PORT || 4321;
app.listen(PORT, () => {
  console.log(`כלי הייבוא של TuRu רץ בכתובת http://localhost:${PORT}`);
});
