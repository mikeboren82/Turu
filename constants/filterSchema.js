// כל קטגוריית פילטר מתוארת כאן כנתון (לא כקוד UI קשיח).
// FiltersSheet קורא את הרשימה הזו ומצייר את כל הקטגוריות אוטומטית.
// matchMode: 'any' = מתאים אם הפעילות עומדת באחת מהאפשרויות שנבחרו (איחוד)
//            'all' = מתאים רק אם הפעילות עומדת בכל האפשרויות שנבחרו (חיתוך - "חייב לכלול")

import { ISRAELI_CITIES } from './israeliCities';
import categoryValues from './categoryValues.json';

export const AGE_OPTIONS = [
  { id: '0-1', label: '0–1', min: 0, max: 1 },
  { id: '2-3', label: '2–3', min: 2, max: 3 },
  { id: '4-6', label: '4–6', min: 4, max: 6 },
  { id: '7-9', label: '7–9', min: 7, max: 9 },
  { id: '10-12', label: '10–12', min: 10, max: 12 },
  { id: '13+', label: '13+', min: 13, max: 120 },
];

// מקור-אמת-יחיד לערכי הקטגוריה הוא constants/categoryValues.json - קובץ JSON טהור שגם
// tools/import-tool/server.js (Node) וגם ה-Edge Functions (Deno) קוראים ממנו, כדי שלא יהיו
// 3 עותקים ידניים שסוטים זה מזה. ה-JSON כולל גם "חוג"/"קייטנה" (archiveCategories) - ערכים
// שקיימים לצורך זיהוי-וארכוב אוטומטי בצינור החילוץ בלבד (tools/import-tool, Edge Functions),
// ואף פעם לא היו אמורים להיות נגישים באפליקציה עצמה (לא לסינון ולא לתיוג ע"י משתמש-קצה) -
// CATEGORY_OPTIONS כאן ממשיך להחריג אותם, בדיוק כמו לפני המעבר ל-JSON, כדי לשמר את ההתנהגות
// הקיימת בכל מקום שכבר צורך את הקבוע הזה (כולל app/add-activity.js).
// אימוג'י לכל קטגוריה - לתצוגה מסודרת-עם-אייקונים ב-QuickPicker (components/QuickPicker.js
// עובר אוטומטית ל"רשת אייקונים" דו-טורית כשלאופציות יש emoji, במקום ה-pills הצפופות הרגילות)
// במקום להמציא שוב באתחול-הצ'יפים המהירים בעמוד הבית (QUICK_CATEGORY_CHIPS, app/index.js) -
// אלה נשארים נפרדים בכוונה (מיפוי קטגוריה יחידה -> אימוג'י, לא value-set מורכב כמו הצ'יפים).
const CATEGORY_EMOJI = {
  "גן שעשועים": '🛝', "ג'ימבורי": '🤸', 'משחקייה': '🧸', 'סדנה': '🛠️', 'הצגה': '🎭',
  'מוזיאון לילדים': '🏛️', 'פארק': '🌳', 'חווה': '🐄', 'פינת חי': '🐰', 'אטרקציה': '🎢',
  'בריכה': '🏊', 'ספורט': '⚽', 'יצירה': '🎨', 'מוזיקה': '🎵', 'ריקוד': '💃', 'בישול': '👩‍🍳',
  'מדע': '🔬', 'טבע': '🌿', 'בעלי חיים': '🐾', 'פעילות מים': '💦', 'טרמפולינות': '🎪',
  'פארק שעשועים': '🎡', 'קולנוע לילדים': '🎬', 'ספרייה': '📚', 'שעת סיפור': '📖',
  'פעילות קהילתית': '🤝', 'פעילות עירונית': '🏙️', 'אחר': '✨',
};

export const CATEGORY_OPTIONS = categoryValues.categories
  .filter((label) => !categoryValues.archiveCategories.includes(label))
  .map((label) => ({ id: label, label, emoji: CATEGORY_EMOJI[label] }));

// לשימוש בפילטר "סוג פעילות" (חיפוש/סינון) בלבד - בלי "אחר" (קליטה-לכל, לא קטגוריית-חיפוש
// שימושית). app/add-activity.js ממשיך להשתמש ב-CATEGORY_OPTIONS המלא (כולל "אחר") לתיוג.
export const CATEGORY_FILTER_OPTIONS = CATEGORY_OPTIONS.filter((c) => c.id !== 'אחר');

// חייב להישאר תואם לאילוץ ה-CHECK על locations.region ב-DB (supabase/0007_update_regions.sql).
export const REGION_OPTIONS = categoryValues.regions.map((label) => ({ id: label, label }));

// לשימוש ב"📍 אזורים שלא להציג" (app/activities.js, app/profile.js) - שם העיר עצמו הוא ה-ID,
// אותו מוסכם בדיוק כמו CATEGORY_OPTIONS (אין טבלת-ערים/FK אמיתי, locations.city הוא טקסט חופשי).
export const CITY_OPTIONS = ISRAELI_CITIES.map((label) => ({ id: label, label }));

export const RADIUS_OPTIONS = [
  { id: '1', label: 'עד 1 ק"מ', km: 1 },
  { id: '5', label: 'עד 5 ק"מ', km: 5 },
  { id: '10', label: 'עד 10 ק"מ', km: 10 },
  { id: '20', label: 'עד 20 ק"מ', km: 20 },
  { id: '50', label: 'עד 50 ק"מ', km: 50 },
];

export const DURATION_OPTIONS = [
  { id: 'short', label: 'עד 30 דקות', min: 0, max: 30 },
  { id: 'medium', label: '30–60 דקות', min: 30, max: 60 },
  { id: 'long', label: '1–2 שעות', min: 60, max: 120 },
  { id: 'xlong', label: '2+ שעות', min: 120, max: 100000 },
];

export const PRICE_OPTIONS = [
  { id: 'free', label: 'חינם', min: 0, max: 0 },
  { id: 'u30', label: 'עד 30 ₪', min: 0, max: 30 },
  { id: 'u50', label: 'עד 50 ₪', min: 0, max: 50 },
  { id: 'u100', label: 'עד 100 ₪', min: 0, max: 100 },
  { id: '100p', label: 'מעל 100 ₪', min: 100, max: 100000 },
];

// שני "buckets" בלבד - "לא משנה" הוא פשוט לא לבחור כלום (או ללחוץ שוב על צ'יפ שנבחר כדי לבטל
// אותו, אותו דפוס בדיוק כמו כל שאר הפילטרים החד-ברירתיים באפליקציה). values הם הערכים
// ב-activities.booking_requirement שכל bucket מייצג (ראו matchesBooking ב-lib/filterActivities.js).
export const BOOKING_OPTIONS = [
  { id: 'not_required', label: 'לא נדרשת הזמנה', values: ['none', 'walk_in', 'available_now'] },
  { id: 'required', label: 'נדרשת הזמנה', values: ['registration_required', 'advance_booking'] },
];

export const PLACE_TYPE_OPTIONS = [
  { id: 'indoor', label: '🏠 בתוך מבנה' },
  { id: 'outdoor', label: '🌳 בחוץ' },
  { id: 'both', label: '🔄 גם וגם' },
];

// weather_suitable נשאר שדה קיים ב-DB (עדיין נקרא, למשל לתצוגה עתידית), אבל הפסיק להיות
// פילטר משתמש - שתי האפשרויות "ממוזג"/"מקורה" ממנו עברו לתוך AMENITY_COMFORT_OPTIONS למטה
// כחלק מ"נגישות ונוחות". הרשימה הזו נשארת מיוצאת רק כי scraping/import-tool עדיין ממלאים אותה.
export const WEATHER_OPTIONS = [
  'מתאים ליום חם', 'מתאים ליום גשום', 'ממוזג', 'מוצל', 'מקורה', 'פעילות בחוץ בלבד',
].map((label) => ({ id: label, label }));

// "נגישות ונוחות" - קטגוריה אחת מאוחדת שמציגה רק אפשרויות עם מידע אמיתי במאגר (נבדק מול ה-DB
// החי: אלו הערכים הכי נפוצים מתוך activities.amenities/weather_suitable). כל אופציה מסומנת
// באיזה שדה ב-DB היא נשלפת (field) כי amenities ו-weather_suitable הם שני columns נפרדים -
// ראו matchesAmenityComfort ב-lib/filterActivities.js.
export const AMENITY_COMFORT_OPTIONS = [
  { id: 'נגיש לכיסא גלגלים', label: '♿ נגיש לכיסאות גלגלים', field: 'amenities' },
  { id: 'מתאים לעגלה', label: '👶 מתאים לעגלות', field: 'amenities' },
  { id: 'חניה', label: '🅿️ חניה', field: 'amenities' },
  { id: 'שירותים', label: '🚻 שירותים', field: 'amenities' },
  { id: 'ממוזג', label: '❄️ ממוזג', field: 'weather_suitable' },
  { id: 'מקורה', label: '☔ מקורה', field: 'weather_suitable' },
];

// אותם ID-ים בדיוק חייבים להישאר תואמים ל-PROVIDER_VALUES ב-tools/import-tool/server.js (טופס
// ההטבה ב-Admin) - שני runtime נפרדים, אין import משותף אפשרי. "העסק עצמו" לא מופיע כאן בכוונה -
// זו אופציית provider בטופס ההטבה, לא "כרטיס שיש למשתמש" (ראו lib/benefits.js).
export const BENEFIT_PROVIDER_OPTIONS = [
  'ישראכרט', 'MAX', 'חבר', 'בהצדעה', 'מפעל הפיס', 'אחר',
].map((label) => ({ id: label, label }));

// שני צ'יפים אמיתיים בלבד - "כל הפעילויות" הוא ברירת המחדל (0 צ'יפים נבחרים), עקבי עם
// placeType/booking הקיימים שגם הם לא מציגים צ'יפ מפורש ל"לא משנה".
export const BENEFIT_FILTER_OPTIONS = [
  { id: 'has_benefit', label: 'רק פעילויות עם הטבות' },
  { id: 'my_benefits', label: 'רק הטבות שיש לי' },
];

// לטופס "הוספת הטבה" (app/activity/[id].js, הוספה מהירה ע"י אדמין ישירות מעמוד הפעילות - לא
// מחליף את כלי הניהול המלא) - בניגוד ל-BENEFIT_PROVIDER_OPTIONS למעלה (מיועד ל"אילו מועדונים יש
// למשתמש"), כאן "העסק עצמו" כן רלוונטי (מי *נותן* את ההטבה). חייב להישאר תואם ל-PROVIDER_VALUES/
// BENEFIT_TYPE_VALUES/REDEMPTION_METHOD_VALUES ב-tools/import-tool/server.js.
export const BENEFIT_PROVIDER_EDIT_OPTIONS = [
  'ישראכרט', 'MAX', 'חבר', 'בהצדעה', 'מפעל הפיס', 'העסק עצמו', 'אחר',
].map((label) => ({ id: label, label }));

export const BENEFIT_TYPE_EDIT_OPTIONS = [
  { id: 'percent', label: 'אחוז הנחה' },
  { id: 'special_price', label: 'מחיר מיוחד' },
  { id: 'one_plus_one', label: '1+1' },
  { id: 'second_ticket_discount', label: 'כרטיס שני בהנחה' },
  { id: 'coupon_code', label: 'קוד קופון' },
  { id: 'other', label: 'הטבה אחרת' },
];

export const REDEMPTION_METHOD_EDIT_OPTIONS = [
  { id: 'link', label: 'רכישה דרך קישור' },
  { id: 'coupon_code', label: 'קוד קופון' },
  { id: 'show_card', label: 'הצגת כרטיס/חברות' },
  { id: 'automatic', label: 'באופן אוטומטי' },
  { id: 'other', label: 'אחר' },
];

export const WHEN_OPTIONS = [
  { id: 'now', label: 'עכשיו' },
  { id: 'today', label: 'היום' },
  { id: 'tomorrow', label: 'מחר' },
  { id: 'weekend', label: 'סוף השבוע' },
  { id: 'week', label: 'השבוע' },
  { id: 'specific', label: 'תאריך אחר' },
];

export const HOUR_OPTIONS = [
  { id: 'morning', label: 'בוקר', start: '06:00', end: '12:00' },
  { id: 'noon', label: 'צהריים', start: '12:00', end: '15:00' },
  { id: 'afternoon', label: 'אחר הצהריים', start: '15:00', end: '18:00' },
  { id: 'evening', label: 'ערב', start: '18:00', end: '23:00' },
];

// כל קטגוריה: key (שם השדה במצב הפילטרים), icon, title, type (chips/location/when),
// matchMode (any/all - רלוונטי רק ל-chips), multiple (בחירה מרובה או בודדת בלבד).
// הסדר כאן הוא סדר התצוגה בפועל בסינון המתקדם - מהחשוב לפחות חשוב.
export const FILTER_SCHEMA = [
  { key: 'category', icon: '🎯', title: 'סוג פעילות', type: 'chips', options: CATEGORY_FILTER_OPTIONS, multiple: true, matchMode: 'any' },
  { key: 'location', icon: '📍', title: 'מיקום', type: 'location' },
  { key: 'age', icon: '👶', title: 'גיל', type: 'chips', options: AGE_OPTIONS, multiple: true, matchMode: 'any' },
  // 'when' משלב יום + שעה בסקשן אחד (WhenSection ב-FiltersSheet.js כותבת גם ל-filters.when
  // וגם ל-filters.hour - שני מפתחות נפרדים ב-state כמו קודם, רק תצוגה מאוחדת).
  { key: 'when', icon: '📅', title: 'מתי?', type: 'when' },
  { key: 'price', icon: '💰', title: 'מחיר', type: 'chips', options: PRICE_OPTIONS, multiple: true, matchMode: 'any' },
  { key: 'placeType', icon: '🏠', title: 'סוג המקום', type: 'chips', options: PLACE_TYPE_OPTIONS, multiple: false, matchMode: 'any' },
  { key: 'booking', icon: '🎟️', title: 'הזמנה', type: 'chips', options: BOOKING_OPTIONS, multiple: false, matchMode: 'any' },
  { key: 'duration', icon: '⏱️', title: 'משך פעילות', type: 'chips', options: DURATION_OPTIONS, multiple: true, matchMode: 'any' },
  { key: 'amenities', icon: '♿', title: 'נגישות ונוחות', type: 'chips', options: AMENITY_COMFORT_OPTIONS, multiple: true, matchMode: 'all' },
  { key: 'benefits', icon: '🎟️', title: 'הטבות והנחות', type: 'chips', options: BENEFIT_FILTER_OPTIONS, multiple: false, matchMode: 'any' },
];

export const DEFAULT_FILTERS = {
  q: '',
  location: { mode: null, city: '', region: [], radiusKm: null, coords: null },
  age: [],
  category: [],
  excludeCategory: [],
  excludeCity: [],
  when: { options: [], date: null },
  hour: { option: null, custom: null },
  placeType: [],
  weather: [],
  price: [],
  duration: [],
  booking: [],
  amenities: [],
  benefits: [],
  familyFit: [],
  numChildren: [],
  rating: [],
};
