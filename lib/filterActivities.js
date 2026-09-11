import { AGE_OPTIONS, DURATION_OPTIONS, PRICE_OPTIONS, BOOKING_OPTIONS, AMENITY_COMFORT_OPTIONS, DEFAULT_FILTERS } from '../constants/filterSchema';

function byId(options, id) {
  return options.find((o) => o.id === id);
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// חיפוש טקסט חופשי (תיבת "חפשו פעילות, אירוע או מקום..." בעמוד הראשי) - בודק התאמה חלקית
// (case-insensitive) בשם, תיאור, קטגוריה ומיקום, כדי לתפוס גם חיפוש לפי שם מקום ולא רק סוג פעילות.
function matchesFreeText(activity, query) {
  if (!query || !query.trim()) return true;
  const q = query.trim().toLowerCase();
  const haystack = [activity.title, activity.description, activity.category, activity.locationName, activity.city, activity.region]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

function tagsOf(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// "any" = מתאים אם יש חפיפה עם אחת מהאפשרויות שנבחרו (איחוד)
// "all" = מתאים רק אם כל האפשרויות שנבחרו נמצאות אצל הפעילות (חיתוך - "חייב לכלול")
function matchesTags(activityValue, selectedIds, matchMode) {
  if (!selectedIds || selectedIds.length === 0) return true;
  const tags = tagsOf(activityValue);
  return matchMode === 'all'
    ? selectedIds.every((id) => tags.includes(id))
    : selectedIds.some((id) => tags.includes(id));
}

function matchesAge(activity, selectedIds) {
  if (!selectedIds || selectedIds.length === 0) return true;
  if (activity.min_age == null || activity.max_age == null) return true;
  return selectedIds.some((id) => {
    const band = byId(AGE_OPTIONS, id);
    if (!band) return false;
    return activity.max_age >= band.min && activity.min_age <= band.max;
  });
}

function matchesDuration(activity, selectedIds) {
  if (!selectedIds || selectedIds.length === 0) return true;
  if (activity.duration_minutes == null) return true;
  return selectedIds.some((id) => {
    const bucket = byId(DURATION_OPTIONS, id);
    if (!bucket) return false;
    return activity.duration_minutes >= bucket.min && activity.duration_minutes <= bucket.max;
  });
}

function matchesPrice(activity, selectedIds) {
  if (!selectedIds || selectedIds.length === 0) return true;
  return selectedIds.some((id) => {
    if (id === 'free') return activity.price_type === 'free';
    const bucket = byId(PRICE_OPTIONS, id);
    if (!bucket || activity.price_amount == null) return false;
    return activity.price_amount >= bucket.min && activity.price_amount <= bucket.max;
  });
}

// "לא נדרשת הזמנה" / "נדרשת הזמנה" - שני buckets שכל אחד מקבץ כמה ערכי booking_requirement
// גולמיים (ראו BOOKING_OPTIONS ב-constants/filterSchema.js). בלי נתון בכלל - לא חוסמים.
function matchesBooking(activity, selectedIds) {
  if (!selectedIds || selectedIds.length === 0) return true;
  if (!activity.booking_requirement) return true;
  return selectedIds.some((id) => {
    const bucket = byId(BOOKING_OPTIONS, id);
    return bucket ? bucket.values.includes(activity.booking_requirement) : false;
  });
}

// "כל הפעילויות" (ברירת מחדל, selectedIds ריק) = הכל עובר, בדיוק כמו כל שאר הפילטרים - הטבה
// לעולם לא חוסמת פעילות בברירת המחדל, רק כשהמשתמש בוחר במפורש אחד משני הצ'יפים.
function matchesBenefits(activity, selectedIds, benefitClubs) {
  if (!selectedIds || selectedIds.length === 0) return true;
  const benefits = activity.benefits || [];
  if (selectedIds.includes('has_benefit') && benefits.length > 0) return true;
  if (selectedIds.includes('my_benefits') && benefits.some((b) => (benefitClubs || []).includes(b.provider))) return true;
  return false;
}

function matchesPlaceType(activity, selectedIds) {
  if (!selectedIds || selectedIds.length === 0) return true;
  if (!activity.indoor_outdoor) return true;
  return selectedIds.some((id) => activity.indoor_outdoor === id || activity.indoor_outdoor === 'both');
}

// "נגישות ונוחות" - כל אופציה מגיעה משדה DB אחר (amenities או weather_suitable, ראו
// AMENITY_COMFORT_OPTIONS) - matchMode 'all' כמו amenities הישן (חייב לכלול את כל מה שנבחר).
function matchesAmenityComfort(activity, selectedIds) {
  if (!selectedIds || selectedIds.length === 0) return true;
  return selectedIds.every((id) => {
    const opt = byId(AMENITY_COMFORT_OPTIONS, id);
    if (!opt) return true;
    const source = opt.field === 'weather_suitable' ? activity.weather_suitable : activity.amenities;
    return tagsOf(source).includes(id);
  });
}

// רשויות מקומיות בישראל שהתאחדו רשמית משתי (או שלוש) רשויות נפרדות - חיפוש לפי כל אחד מהשמות
// צריך למצוא פעילויות שסומנו בכל אחד מהם, בלי קשר לאיזה מהם ספציפית קיים ברשומה הבודדת. לדוגמה:
// מקום שכבר ידוע שהוא ב"צורן" ספציפית מסומן "צורן"; מקום שלא ברור סימונו נשאר "קדימה צורן"
// (ברירת המחדל הבטוחה, לא ממציאים סיווג-משנה בלי מקור אמין) - אבל חיפוש "קדימה צורן" עדיין
// צריך למצוא את שניהם. בכוונה *לא* כולל התאמות-מקריות של תת-מחרוזת (כמו "מגדל" מול "מגדל העמק" -
// שני יישובים שונים לגמרי למרות שם חופף חלקית, לא איחוד רשויות) - רק איחודים רשמיים אמיתיים.
const CITY_ALIAS_GROUPS = [
  ['קדימה צורן', 'קדימה', 'צורן'],
  ['תל אביב יפו', 'תל אביב', 'יפו'],
  ['בנימינה גבעת עדה', 'בנימינה', 'גבעת עדה'],
  ['פרדס חנה כרכור', 'פרדס חנה', 'כרכור'],
  ['יהוד מונוסון', 'יהוד', 'מונוסון'],
  ['כוכב יאיר צור יגאל', 'כוכב יאיר', 'צור יגאל'],
  ['מודיעין מכבים רעות', 'מודיעין', 'מכבים', 'רעות'],
  ['בית אריה עופרים', 'בית אריה', 'עופרים'],
];

function cityAliasGroupFor(city) {
  return CITY_ALIAS_GROUPS.find((g) => g.includes(city)) || null;
}

// שם-עיר שהמשתמש מחפש (filterCity) מול שם-עיר שרשום בפעילות (activityCity) - substring-match
// רגיל (activityCity יכול להיות מפורט יותר, למשל "הרצל 5, קדימה" מכיל "קדימה"), ובנוסף: אם
// filterCity הוא חלק מקבוצת-איחוד-רשויות, גם כל שם אחר מאותה קבוצה נחשב התאמה.
function matchesCityFilter(activityCity, filterCity) {
  const trimmed = (filterCity || '').trim();
  if (!trimmed) return true;
  const a = activityCity || '';
  if (a.includes(trimmed)) return true;
  const group = cityAliasGroupFor(trimmed);
  return group ? group.some((name) => a.includes(name)) : false;
}

function matchesLocation(activity, location, deviceCoords) {
  if (!location || !location.mode) return true;
  if (location.mode === 'city') {
    if (!location.city) return true;
    return matchesCityFilter(activity.city, location.city);
  }
  if (location.mode === 'region') {
    if (!location.region || location.region.length === 0) return true;
    return location.region.includes(activity.region);
  }
  if (location.mode === 'current') {
    if (!deviceCoords || activity.lat == null || activity.lng == null) return true;
    if (!location.radiusKm) return true;
    return haversineKm(deviceCoords.latitude, deviceCoords.longitude, activity.lat, activity.lng) <= location.radiusKm;
  }
  // 'address' - כתובת מגואוקדדת (חיפוש חכם, lib/smartSearch.js) - זהה ל-'current' אבל המקור
  // לקואורדינטות הוא location.coords עצמו (כתובת שחיפשו) ולא deviceCoords (GPS המכשיר).
  if (location.mode === 'address') {
    if (!location.coords || activity.lat == null || activity.lng == null) return true;
    if (!location.radiusKm) return true;
    return haversineKm(location.coords.lat, location.coords.lng, activity.lat, activity.lng) <= location.radiusKm;
  }
  return true;
}

// "📍 אזורים שלא להציג" - אותה השוואת-substring כמו matchesLocation(mode:'city') למעלה, כדי
// שחסימה ועקיפה-ע"י-חיפוש-מפורש יתנהגו זהה על אותה מחרוזת עיר.
function isCityExcluded(activity, excludedCities) {
  if (!activity.city || !excludedCities || excludedCities.length === 0) return false;
  return excludedCities.some((c) => activity.city.includes(c));
}

const DAY_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];

function todayLetter(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return DAY_LETTERS[d.getDay()];
}

// עבור אפשרות "מתי" בודדת, מחזיר את כל היסטי הימים (0 = היום, 1 = מחר וכו') הרלוונטיים לה,
// כדי שנוכל גם להתאים וגם לדרג לפי הקרבה בזמן (offset נמוך יותר = קרוב יותר).
function optionDayOffsets(optionId, specificDateIso) {
  if (optionId === 'now' || optionId === 'today') return [0];
  if (optionId === 'tomorrow') return [1];
  if (optionId === 'weekend') {
    const offsets = [];
    for (let i = 0; i <= 6; i++) {
      const letter = todayLetter(i);
      if (letter === 'ו' || letter === 'ש') offsets.push(i);
    }
    return offsets;
  }
  if (optionId === 'week') return [0, 1, 2, 3, 4, 5, 6];
  if (optionId === 'specific' && specificDateIso) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfPicked = new Date(specificDateIso);
    startOfPicked.setHours(0, 0, 0, 0);
    const diffDays = Math.round((startOfPicked - startOfToday) / 86400000);
    return diffDays >= 0 ? [diffDays] : [];
  }
  return [];
}

// ה-offset המינימלי (הקרוב ביותר) שבו הפעילות פעילה, מתוך כל האפשרויות שנבחרו ב"מתי" - או
// null אם היא לא תואמת אף אחת מהן. משמש גם להתאמה (matchesWhen) וגם לניקוד הרלוונטיות.
function whenMatchOffset(activity, when) {
  const options = when?.options || [];
  if (options.length === 0) return 0;
  const days = activity.availableDays || [];
  let minOffset = null;
  for (const optionId of options) {
    for (const offset of optionDayOffsets(optionId, when.date)) {
      if (days.includes(todayLetter(offset)) && (minOffset === null || offset < minOffset)) {
        minOffset = offset;
      }
    }
  }
  return minOffset;
}

function matchesWhen(activity, when) {
  if (!when || !when.options || when.options.length === 0) return true;
  return whenMatchOffset(activity, when) !== null;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function matchesHour(activity, hour) {
  if (!hour || (!hour.option && !hour.custom)) return true;
  if (!activity.openHours) return true;
  const actStart = toMinutes(activity.openHours.start);
  const actEnd = toMinutes(activity.openHours.end);
  const range = hour.custom || hour.option;
  if (!range || !range.start || !range.end) return true;
  const start = toMinutes(range.start);
  const end = toMinutes(range.end);
  return actStart < end && actEnd > start;
}

// ממזג filters שמורים/מועברים (עשויים להגיע ממקור ישן, למשל default_home_filters שנשמר
// לפני שהמעבר ל"מתי" מרובה-בחירה) לתוך אובייקט filters תקין - במיוחד when, ששינה צורה
// מ-{option, date} ל-{options: [], date}.
export function normalizeFilters(raw) {
  const merged = { ...DEFAULT_FILTERS, ...(raw || {}) };
  const when = raw?.when;
  if (when && !Array.isArray(when.options)) {
    merged.when = { options: when.option ? [when.option] : [], date: when.date || null };
  } else {
    merged.when = { ...DEFAULT_FILTERS.when, ...(when || {}) };
  }
  return merged;
}

// הסינון עצמו - חוסם/מעביר. weather/rating/familyFit לא משתתפים כאן בכוונה (ראו rankActivities
// למטה) - הם איתותי דירוג בלבד, אף פעם לא חוסמים תוצאה. כל שאר הפילטרים שהמשתמש בחר במפורש
// כן חוסמים - זה מה ש"אמיתי" מבטיח.
export function applyFilters(activities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  const excluded = excludedCategories || [];
  const excludedCitiesList = [...(excludedCities || []), ...(f.excludeCity || [])];
  return activities.filter((a) => {
    // בחירה מפורשת של המשתמש בקטגוריה/עיר (סינון מתקדם) מנצחת הסתרה קבועה/זמנית של אותו ערך -
    // "הסר פעילויות"/"אזורים שלא להציג" חלים רק על תוצאות כלליות/אוטומטיות, לא על חיפוש מפורש.
    const explicitlyIncluded = (f.category || []).includes(a.category);
    const explicitCityMatch = f.location?.mode === 'city' && f.location.city
      && matchesCityFilter(a.city, f.location.city);
    return (
      (explicitlyIncluded || (!excluded.includes(a.category) && !(f.excludeCategory || []).includes(a.category))) &&
      (explicitCityMatch || !isCityExcluded(a, excludedCitiesList)) &&
      matchesFreeText(a, f.q) &&
      matchesLocation(a, f.location, deviceCoords) &&
      matchesAge(a, f.age) &&
      matchesTags(a.category, f.category, 'any') &&
      matchesWhen(a, f.when) &&
      matchesHour(a, f.hour) &&
      matchesPlaceType(a, f.placeType) &&
      matchesPrice(a, f.price) &&
      matchesDuration(a, f.duration) &&
      matchesBooking(a, f.booking) &&
      matchesAmenityComfort(a, f.amenities) &&
      matchesBenefits(a, f.benefits, benefitClubs)
    );
  });
}

// ---- ניקוד רלוונטיות (relevance scoring) ----
// רץ אך ורק על פעילויות שכבר עברו את applyFilters - כלומר שום גורם "רך" כאן (מרחק/דירוג/
// עדכניות) לא יכול להעלות פעילות שלא עומדת בפילטרים המפורשים שהמשתמש בחר; הוא רק קובע את
// הסדר בין הפעילויות שכבר תואמות. כל המשקלים קטנים ואדיטיביים בכוונה כדי שאף גורם בודד לא
// "יעקוף" גורמים אחרים בצורה קיצונית.
const SCORE_WEIGHTS = {
  distance: 12,      // קרוב יותר = ניקוד גבוה יותר (עד המקסימום, דועך עם המרחק)
  ageMatch: 10,       // התאמת גיל: חפיפה מלאה > חלקית > אין נתון (ניטרלי)
  whenProximity: 8,   // "מתי" קרוב יותר (offset נמוך) מקבל בונוס
  rating: 8,          // דירוג גבוה מקבל בונוס - אבל "אין דירוג" נשאר ניטרלי, לא בתחתית
  recency: 4,         // פעילות שנוספה לאחרונה מקבלת בונוס קטן
  benefitMatch: 4,    // הטבה רלוונטית - בונוס קטן בכוונה (קטן מכל אחד מארבעת המשקלים למעלה,
                       // כדי שלעולם לא "יעקוף" התאמת גיל/מיקום/זמן/דירוג - הטבה היא יתרון, לא תחליף)
  completeness: 3,    // תמונה + תיאור + שעות פתיחה - בונוס קטן לאיכות/שלמות המידע
  openNow: 5,         // "פתוח עכשיו" - איתות-דירוג רך (לא פילטר קשיח, ראו app/activities.js
                       // Discovery Mode) - פעילות שפתוחה ברגע זה מקבלת בונוס קטן, לא נעלמת אם לא.
  spontaneousProximity: 10, // רק כש-🪄 ספונטני פעיל (app/activities.js) - בונוס-קרבה למיקום החי
                       // של המשתמש, בנוסף לכל שאר הניקוד - לא מחליף/מסנן, רק מעדיף "מה שקרוב עכשיו".
  spontaneousOpenNow: 40, // רק כש-ספונטני פעיל - גדול בהרבה מכל שאר המשקלים בכוונה (סעיף 3/12
                       // בבקשת שדרוג הספונטני): "פתוח עכשיו" חייב לדחוף פעילות סגורה אחורה
                       // בפועל, לא רק "קצת", אחרת כמה גורמים קטנים-משוקללים יכולים לגבור עליו.
  spontaneousTimeLeft: 3, // תוספת קטנה בתוך "פתוח עכשיו" בספונטני - עוד זמן לסגירה מנצח "עומד
                       // להיסגר", בין שתי פעילויות שתיהן כן פתוחות (לא גורם ראשי, ראו סעיף 5.5).
};

function distanceScore(activity, filters, deviceCoords) {
  const mode = filters?.location?.mode;
  if (mode !== 'current' && mode !== 'address') return 0;
  if (activity.lat == null || activity.lng == null) return 0;
  // 'current' מודד מ-deviceCoords (GPS מכשיר), 'address' מ-location.coords (כתובת שגואוקדה) -
  // אותו חישוב בדיוק, רק מקור-קואורדינטות שונה.
  const origin = mode === 'current' ? deviceCoords : filters.location.coords;
  if (!origin) return 0;
  const originLat = origin.latitude ?? origin.lat;
  const originLng = origin.longitude ?? origin.lng;
  const km = haversineKm(originLat, originLng, activity.lat, activity.lng);
  const radius = filters.location.radiusKm || 20;
  return Math.max(0, 1 - km / (radius * 1.5)) * SCORE_WEIGHTS.distance;
}

function ageMatchScore(activity, selectedIds) {
  if (!selectedIds || selectedIds.length === 0) return 0;
  if (activity.min_age == null || activity.max_age == null) return SCORE_WEIGHTS.ageMatch * 0.4; // אין נתון = ניטרלי-חיובי קלות
  let best = 0;
  for (const id of selectedIds) {
    const band = byId(AGE_OPTIONS, id);
    if (!band || activity.max_age < band.min || activity.min_age > band.max) continue;
    // חפיפה מלאה (טווח הפעילות מכיל את כל טווח הבחירה) מקבלת ניקוד מלא, חפיפה חלקית פחות.
    const fullyContains = activity.min_age <= band.min && activity.max_age >= band.max;
    best = Math.max(best, fullyContains ? 1 : 0.55);
  }
  return best * SCORE_WEIGHTS.ageMatch;
}

function whenProximityScore(activity, when) {
  const options = when?.options || [];
  if (options.length === 0) return 0;
  const offset = whenMatchOffset(activity, when);
  if (offset == null) return 0;
  return Math.max(0, 1 - offset / 7) * SCORE_WEIGHTS.whenProximity;
}

function ratingScore(activity) {
  if (activity.rating == null) return SCORE_WEIGHTS.rating * 0.5; // אין דירוג = ניטרלי, לא בתחתית
  return Math.min(1, activity.rating / 5) * SCORE_WEIGHTS.rating;
}

function recencyScore(activity) {
  if (!activity.created_at) return 0;
  const ageDays = (Date.now() - new Date(activity.created_at).getTime()) / 86400000;
  return Math.max(0, 1 - ageDays / 30) * SCORE_WEIGHTS.recency; // דועך על פני חודש
}

function completenessScore(activity) {
  let points = 0;
  if (activity.imageUrl) points += 1;
  if (activity.description) points += 1;
  if (activity.openHours?.start) points += 1;
  return (points / 3) * SCORE_WEIGHTS.completeness;
}

// מקור-אמת יחיד ל"פתוח עכשיו" (סעיף 3/4 בבקשת שדרוג ה-ספונטני: "אל תשתמש ב-hardcoded שעות",
// "התבסס על תאריך/שעה/יום נוכחיים") - גם openNowScore הכללי וגם spontaneousOpenNowScore
// (למטה) קוראים לפונקציה הזו, לא מחשבים "פתוח?" בשתי צורות שונות. בלי openHours/availableDays -
// isOpen=false בלי לנחש (לא "כן" כברירת מחדל) - זה בדיוק מה שסעיף 11/24 אוסר ("להציג פעילות
// כספונטנית אם אין מספיק מידע").
export function getOpenNowInfo(activity) {
  if (!activity.openHours?.start || !activity.openHours?.end) {
    return { isOpen: false, hasScheduleData: false, minutesUntilClose: null, minutesUntilOpenToday: null };
  }
  const days = activity.availableDays || [];
  const todayIncluded = days.length === 0 || days.includes(todayLetter(0));
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const start = toMinutes(activity.openHours.start);
  const end = toMinutes(activity.openHours.end);
  if (todayIncluded && nowMinutes >= start && nowMinutes <= end) {
    return { isOpen: true, hasScheduleData: true, minutesUntilClose: end - nowMinutes, minutesUntilOpenToday: null };
  }
  // "נפתח בקרוב" (סעיף 13 בבקשה) - רק אם עדיין היום, עדיין לא נפתח, ואנחנו יודעים בפועל את שעת
  // הפתיחה - לא מסתכל למחר/יום אחר (שם היינו צריכים לנחש אם אותו יום-בשבוע חוזר, מידע שאין לנו
  // מובטח מכל activity.availableDays).
  if (todayIncluded && nowMinutes < start) {
    return { isOpen: false, hasScheduleData: true, minutesUntilClose: null, minutesUntilOpenToday: start - nowMinutes };
  }
  return { isOpen: false, hasScheduleData: true, minutesUntilClose: null, minutesUntilOpenToday: null };
}

// "פתוח עכשיו" - איתות רך בלבד (סעיף 14 בבקשת שדרוג עמוד הפעילויות המקורית): לא פילטר, רק
// בונוס-דירוג קטן, פועל תמיד (גם בלי ספונטני). המשקל הגדול-בהרבה ל"פתוח עכשיו בתוך ספונטני"
// נמצא ב-spontaneousOpenNowScore למטה - שני משקלים נפרדים בכוונה: "עדיפות-קלה" במצב רגיל,
// "עדיפות-דומיננטית" (סעיף 3/12 בבקשת השדרוג: "פעילות סגורה לא צריכה להיות בין המובילות") רק
// כשהמשתמש בפועל ביקש "מה אפשר לעשות עכשיו".
function openNowScore(activity) {
  return getOpenNowInfo(activity).isOpen ? SCORE_WEIGHTS.openNow : 0;
}

// 🪄 ספונטני (app/activities.js) - כשפעיל, מעביר את מיקום ה-GPS החי של המשתמש (לא deviceCoords
// הרגיל, כדי לא להתערבב עם פילטר "current"/"address" שהמשתמש אולי בחר בעצמו) - בונוס-קרבה בלבד,
// לא סינון: פעילות רחוקה עדיין מופיעה, רק נדחקת אחורה. רדיוס-ייחוס רחב (15 ק"מ, "כל מה שבסביבה
// הקרובה"), לא ה-4 ק"מ הצר של הגרסה החד-פעמית הישנה - כי עכשיו זה איתות-דירוג, לא רשימה סגורה.
function spontaneousProximityScore(activity, spontaneousCoords) {
  if (!spontaneousCoords || activity.lat == null || activity.lng == null) return 0;
  const km = haversineKm(spontaneousCoords.latitude, spontaneousCoords.longitude, activity.lat, activity.lng);
  return Math.max(0, 1 - km / 15) * SCORE_WEIGHTS.spontaneousProximity;
}

// "פתוח עכשיו" חייב להיות דומיננטי כש-ספונטני פעיל בפועל (סעיף 3/12 בבקשה: "פעילות סגורה
// כרגע לא צריכה להופיע בין התוצאות המובילות") - משקל גדול משמעותית מכל שאר הגורמים המשולבים,
// כדי שסדר-העדיפויות בפועל יהיה תמיד "פתוח>גיל/סוג>מרחק" ולא ש-2-3 גורמים קטנים-משוקללים
// "יתגברו" במקרה על פער-הפתיחה. בונוס קטן נוסף (spontaneousTimeLeft) מעדיף עוד-הרבה-זמן-לסגירה
// על פני "עוד כמה דקות נסגר" בין שתי פעילויות שתיהן פתוחות - סעיף 5 סעיף-משנה 5, לא גורם ראשי.
function spontaneousOpenNowScore(activity, spontaneousCoords) {
  if (!spontaneousCoords) return 0;
  const info = getOpenNowInfo(activity);
  if (!info.isOpen) return 0;
  const timeLeftBonus = info.minutesUntilClose != null
    ? Math.min(1, info.minutesUntilClose / 120) * SCORE_WEIGHTS.spontaneousTimeLeft
    : 0;
  return SCORE_WEIGHTS.spontaneousOpenNow + timeLeftBonus;
}

// הטבה שמתאימה למועדון שהמשתמש הגדיר בפרופיל מקבלת את הבונוס המלא; הטבה כלשהי בלי התאמה
// אישית (המשתמש לא הגדיר את המועדון הזה, או לא הגדיר כלום) מקבלת עדיין 40% ממנו - אותו דפוס
// "ניטרלי-חיובי-חלקי" בדיוק כמו ageMatchScore כשאין נתון גיל.
function benefitMatchScore(activity, benefitClubs) {
  const benefits = activity.benefits || [];
  if (benefits.length === 0) return 0;
  const hasPersonalMatch = benefits.some((b) => (benefitClubs || []).includes(b.provider));
  return hasPersonalMatch ? SCORE_WEIGHTS.benefitMatch : SCORE_WEIGHTS.benefitMatch * 0.4;
}

export function scoreActivity(activity, filters, deviceCoords, benefitClubs, spontaneousCoords) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  return (
    distanceScore(activity, f, deviceCoords) +
    ageMatchScore(activity, f.age) +
    whenProximityScore(activity, f.when) +
    ratingScore(activity) +
    recencyScore(activity) +
    benefitMatchScore(activity, benefitClubs) +
    completenessScore(activity) +
    openNowScore(activity) +
    spontaneousProximityScore(activity, spontaneousCoords) +
    spontaneousOpenNowScore(activity, spontaneousCoords)
  );
}

// applyFilters + מיון לפי ניקוד רלוונטיות - זה מה ש-app/activities.js קורא בפועל במקום
// applyFilters לבד. שומר על יציבות המיון (Array.sort של JS יציב) כדי שתוצאות עם ניקוד שווה
// לא יקפצו סתם בין רינדורים. spontaneousCoords (אופציונלי) - ראו spontaneousProximityScore.
export function rankActivities(activities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities, spontaneousCoords) {
  const matched = applyFilters(activities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities);
  return matched
    .map((a) => ({ activity: a, score: scoreActivity(a, filters, deviceCoords, benefitClubs, spontaneousCoords) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.activity);
}

export function countActiveFilters(filters) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  let count = 0;
  for (const key of Object.keys(DEFAULT_FILTERS)) {
    // excludeCategory הוא "הסר פעילויות" (הסתרה זמנית/קבועה) - לא נספר בתג "סינון מתקדם", בדיוק
    // כמו ש-buildActiveChips (app/activities.js) כבר לא בונה עבורו chip - לו יש אינדיקציה נפרדת.
    if (key === 'excludeCategory' || key === 'excludeCity') continue;
    const v = f[key];
    if (key === 'location') {
      if (v.mode) count += 1;
    } else if (key === 'when') {
      if (v.options && v.options.length > 0) count += 1;
    } else if (key === 'hour') {
      if (v.option || v.custom) count += 1;
    } else if (Array.isArray(v) && v.length > 0) {
      count += 1;
    }
  }
  return count;
}

export function countForKey(filters, key) {
  const v = filters[key];
  if (key === 'location') return v?.mode ? 1 : 0;
  if (key === 'when') return (v?.options?.length || 0) + (filters.hour?.option || filters.hour?.custom ? 1 : 0);
  if (key === 'hour') return v?.option || v?.custom ? 1 : 0;
  return Array.isArray(v) ? v.length : 0;
}
