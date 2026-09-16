// כל קטגוריית פילטר מתוארת כאן כנתון (לא כקוד UI קשיח).
// FiltersSheet קורא את הרשימה הזו ומצייר את כל הקטגוריות אוטומטית.
// matchMode: 'any' = מתאים אם הפעילות עומדת באחת מהאפשרויות שנבחרו (איחוד)
//            'all' = מתאים רק אם הפעילות עומדת בכל האפשרויות שנבחרו (חיתוך - "חייב לכלול")

import { ISRAELI_CITIES } from './israeliCities';
import categoryValues from './categoryValues.json';
import { t } from '../lib/i18n';
import { categoryLabel, regionLabel, placeName } from '../lib/i18n/format';

// Display labels are locale-aware getters (evaluated when read, i.e. at render time); ids and values
// are canonical and never translated.
function localized(options, labelFor) {
  return options.map((o) => Object.defineProperty({ ...o }, 'label', { enumerable: true, get: () => labelFor(o) }));
}

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
  'פעילות קהילתית': '🤝', 'פעילות עירונית': '🏙️', 'חדרי בריחה': '🔐', 'אחר': '✨',
};

export const CATEGORY_OPTIONS = categoryValues.categories
  .filter((label) => !categoryValues.archiveCategories.includes(label))
  .map((value) => Object.defineProperty({ id: value, emoji: CATEGORY_EMOJI[value] }, 'label', { enumerable: true, get: () => categoryLabel(value) }));

// לשימוש בפילטר "סוג פעילות" (חיפוש/סינון) בלבד - בלי "אחר" (קליטה-לכל, לא קטגוריית-חיפוש
// שימושית). app/add-activity.js ממשיך להשתמש ב-CATEGORY_OPTIONS המלא (כולל "אחר") לתיוג.
export const CATEGORY_FILTER_OPTIONS = CATEGORY_OPTIONS.filter((c) => c.id !== 'אחר');

// חייב להישאר תואם לאילוץ ה-CHECK על locations.region ב-DB (supabase/0007_update_regions.sql).
export const REGION_OPTIONS = localized(categoryValues.regions.map((id) => ({ id })), (o) => regionLabel(o.id));

// לשימוש ב"📍 אזורים שלא להציג" (app/activities.js, app/profile.js) - שם העיר עצמו הוא ה-ID,
// אותו מוסכם בדיוק כמו CATEGORY_OPTIONS (אין טבלת-ערים/FK אמיתי, locations.city הוא טקסט חופשי).
export const CITY_OPTIONS = localized(ISRAELI_CITIES.map((id) => ({ id })), (o) => placeName(o.id));

export const RADIUS_OPTIONS = localized([
  { id: '1', km: 1 },
  { id: '5', km: 5 },
  { id: '10', km: 10 },
  { id: '20', km: 20 },
  { id: '50', km: 50 },
], (o) => t('domain.options.radius', { km: o.km }));

// "🚶 במרחק הליכה" (components/LocationQuickPicker.js) - טווח קבוע בשלב הזה (לא מחושב מזמן
// הליכה אמיתי, אין ל-TuRu מנוע ניווט/routing - ראו ההערה המקבילה ב-app/activities.js ליד
// buildSpontaneousBadge). מוגדר כאן במקום hardcoded בקומפוננטה כדי שהיום שנחליף את זה בחישוב
// זמן-הליכה אמיתי, נצטרך לשנות ערך אחד, לא לחפש "0.75" מפוזר בקוד.
export const WALKING_RADIUS_KM = 0.75;
// רדיוס ברירת המחדל למיקום מדויק (GPS/כתובת) כשלא בוחרים הליכה - אותו ערך בדיוק שכבר היה קבוע
// ב-useCurrentLocation לפני התכונה הזו; מיוצא כאן כדי ש-lib/filterActivities.js (locationWithDrivingTime)
// יוכל לחזור אליו כשעוזבים מצב הליכה, בלי לשכפל את המספר.
export const DEFAULT_PRECISE_RADIUS_KM = 10;

export const DURATION_OPTIONS = localized([
  { id: 'short', min: 0, max: 30 },
  { id: 'medium', min: 30, max: 60 },
  { id: 'long', min: 60, max: 120 },
  { id: 'xlong', min: 120, max: 100000 },
], (o) => t(`domain.options.duration.${o.id}`));

export const PRICE_OPTIONS = localized([
  { id: 'free', min: 0, max: 0 },
  { id: 'u30', min: 0, max: 30 },
  { id: 'u50', min: 0, max: 50 },
  { id: 'u100', min: 0, max: 100 },
  { id: '100p', min: 100, max: 100000 },
], (o) => t(`domain.options.price.${o.id}`));

// שני "buckets" בלבד - "לא משנה" הוא פשוט לא לבחור כלום (או ללחוץ שוב על צ'יפ שנבחר כדי לבטל
// אותו, אותו דפוס בדיוק כמו כל שאר הפילטרים החד-ברירתיים באפליקציה). values הם הערכים
// ב-activities.booking_requirement שכל bucket מייצג (ראו matchesBooking ב-lib/filterActivities.js).
export const BOOKING_OPTIONS = localized([
  { id: 'not_required', values: ['none', 'walk_in', 'available_now'] },
  { id: 'required', values: ['registration_required', 'advance_booking'] },
], (o) => t(`domain.options.booking.${o.id}`));

export const PLACE_TYPE_OPTIONS = localized([
  { id: 'indoor' }, { id: 'outdoor' }, { id: 'both' },
], (o) => t(`domain.options.placeType.${o.id}`));

// weather_suitable נשאר שדה קיים ב-DB (עדיין נקרא, למשל לתצוגה עתידית), אבל הפסיק להיות
// פילטר משתמש - שתי האפשרויות "ממוזג"/"מקורה" ממנו עברו לתוך AMENITY_COMFORT_OPTIONS למטה
// כחלק מ"נגישות ונוחות". הרשימה הזו נשארת מיוצאת רק כי scraping/import-tool עדיין ממלאים אותה.
export const WEATHER_OPTIONS = localized([
  'מתאים ליום חם', 'מתאים ליום גשום', 'ממוזג', 'מוצל', 'מקורה', 'פעילות בחוץ בלבד',
].map((id) => ({ id })), (o) => t(`domain.options.weather.${o.id}`));

// "נגישות ונוחות" - קטגוריה אחת מאוחדת שמציגה רק אפשרויות עם מידע אמיתי במאגר (נבדק מול ה-DB
// החי: אלו הערכים הכי נפוצים מתוך activities.amenities/weather_suitable). כל אופציה מסומנת
// באיזה שדה ב-DB היא נשלפת (field) כי amenities ו-weather_suitable הם שני columns נפרדים -
// ראו matchesAmenityComfort ב-lib/filterActivities.js.
export const AMENITY_COMFORT_OPTIONS = localized([
  { id: 'נגיש לכיסא גלגלים', field: 'amenities' },
  { id: 'מתאים לעגלה', field: 'amenities' },
  { id: 'חניה', field: 'amenities' },
  { id: 'שירותים', field: 'amenities' },
  { id: 'ממוזג', field: 'weather_suitable' },
  { id: 'מקורה', field: 'weather_suitable' },
], (o) => t(`domain.options.amenities.${o.id}`));

// אותם ID-ים בדיוק חייבים להישאר תואמים ל-PROVIDER_VALUES ב-tools/import-tool/server.js (טופס
// ההטבה ב-Admin) - שני runtime נפרדים, אין import משותף אפשרי. "העסק עצמו" לא מופיע כאן בכוונה -
// זו אופציית provider בטופס ההטבה, לא "כרטיס שיש למשתמש" (ראו lib/benefits.js).
export const BENEFIT_PROVIDER_OPTIONS = localized([
  'ישראכרט', 'MAX', 'חבר', 'בהצדעה', 'מפעל הפיס', 'אחר',
].map((id) => ({ id })), (o) => t(`domain.options.benefitProviders.${o.id}`));

// שני צ'יפים אמיתיים בלבד - "כל הפעילויות" הוא ברירת המחדל (0 צ'יפים נבחרים), עקבי עם
// placeType/booking הקיימים שגם הם לא מציגים צ'יפ מפורש ל"לא משנה".
export const BENEFIT_FILTER_OPTIONS = localized([
  { id: 'has_benefit' }, { id: 'my_benefits' },
], (o) => t(`domain.options.benefitFilter.${o.id}`));

// לטופס "הוספת הטבה" (app/activity/[id].js, הוספה מהירה ע"י אדמין ישירות מעמוד הפעילות - לא
// מחליף את כלי הניהול המלא) - בניגוד ל-BENEFIT_PROVIDER_OPTIONS למעלה (מיועד ל"אילו מועדונים יש
// למשתמש"), כאן "העסק עצמו" כן רלוונטי (מי *נותן* את ההטבה). חייב להישאר תואם ל-PROVIDER_VALUES/
// BENEFIT_TYPE_VALUES/REDEMPTION_METHOD_VALUES ב-tools/import-tool/server.js.
export const BENEFIT_PROVIDER_EDIT_OPTIONS = localized([
  'ישראכרט', 'MAX', 'חבר', 'בהצדעה', 'מפעל הפיס', 'העסק עצמו', 'אחר',
].map((id) => ({ id })), (o) => t(`domain.options.benefitProviders.${o.id}`));

export const BENEFIT_TYPE_EDIT_OPTIONS = localized([
  { id: 'percent' }, { id: 'special_price' }, { id: 'one_plus_one' },
  { id: 'second_ticket_discount' }, { id: 'coupon_code' }, { id: 'other' },
], (o) => t(`domain.options.benefitType.${o.id.replace(/_([a-z])/g, (m, c) => c.toUpperCase())}`));

export const REDEMPTION_METHOD_EDIT_OPTIONS = localized([
  { id: 'link' }, { id: 'coupon_code' }, { id: 'show_card' }, { id: 'automatic' }, { id: 'other' },
], (o) => t(`domain.options.redemption.${o.id}`));

export const WHEN_OPTIONS = localized([
  { id: 'now' }, { id: 'today' }, { id: 'tomorrow' }, { id: 'weekend' }, { id: 'week' }, { id: 'specific' },
], (o) => t(`domain.options.when.${o.id}`));

export const HOUR_OPTIONS = localized([
  { id: 'morning', start: '06:00', end: '12:00' },
  { id: 'noon', start: '12:00', end: '15:00' },
  { id: 'afternoon', start: '15:00', end: '18:00' },
  { id: 'evening', start: '18:00', end: '23:00' },
], (o) => t(`domain.options.hour.${o.id}`));

// כל קטגוריה: key (שם השדה במצב הפילטרים), icon, title, type (chips/location/when),
// matchMode (any/all - רלוונטי רק ל-chips), multiple (בחירה מרובה או בודדת בלבד).
// הסדר כאן הוא סדר התצוגה בפועל בסינון המתקדם - מהחשוב לפחות חשוב.
export const FILTER_SCHEMA = [
  { key: 'category', icon: '🎯', type: 'chips', options: CATEGORY_FILTER_OPTIONS, multiple: true, matchMode: 'any' },
  { key: 'location', icon: '📍', type: 'location' },
  { key: 'age', icon: '👶', type: 'chips', options: AGE_OPTIONS, multiple: true, matchMode: 'any' },
  // 'when' משלב יום + שעה בסקשן אחד (WhenSection ב-FiltersSheet.js כותבת גם ל-filters.when
  // וגם ל-filters.hour - שני מפתחות נפרדים ב-state כמו קודם, רק תצוגה מאוחדת).
  { key: 'when', icon: '📅', type: 'when' },
  { key: 'price', icon: '💰', type: 'chips', options: PRICE_OPTIONS, multiple: true, matchMode: 'any' },
  { key: 'placeType', icon: '🏠', type: 'chips', options: PLACE_TYPE_OPTIONS, multiple: false, matchMode: 'any' },
  { key: 'booking', icon: '🎟️', type: 'chips', options: BOOKING_OPTIONS, multiple: false, matchMode: 'any' },
  { key: 'duration', icon: '⏱️', type: 'chips', options: DURATION_OPTIONS, multiple: true, matchMode: 'any' },
  { key: 'amenities', icon: '♿', type: 'chips', options: AMENITY_COMFORT_OPTIONS, multiple: true, matchMode: 'all' },
  { key: 'benefits', icon: '🎟️', type: 'chips', options: BENEFIT_FILTER_OPTIONS, multiple: false, matchMode: 'any' },
].map((section) => Object.defineProperty(section, 'title', { enumerable: true, get: () => t(`domain.filterSections.${section.key}`) }));

export const DEFAULT_FILTERS = {
  q: '',
  location: { mode: null, city: '', region: [], radiusKm: null, coords: null },
  age: [],
  category: [],
  excludeCategory: [],
  excludeCity: [],
  // "⛔ לאן לא תרצו להגיע?" (components/ExcludeAreasPicker.js) - מקביל ל-excludeCity, אבל
  // ערכים הם מזהי REGION_OPTIONS (לא שמות עיר) - מסונן ב-lib/filterActivities.js מול
  // activity.region ישירות, בלי שום מיפוי עיר→אזור.
  excludeRegion: [],
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
