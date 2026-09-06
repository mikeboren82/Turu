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

function matchesLocation(activity, location, deviceCoords) {
  if (!location || !location.mode) return true;
  if (location.mode === 'city') {
    if (!location.city) return true;
    return (activity.city || '').includes(location.city.trim());
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
      && (a.city || '').includes(f.location.city.trim());
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
};

function distanceScore(activity, filters, deviceCoords) {
  if (filters?.location?.mode !== 'current' || !deviceCoords || activity.lat == null || activity.lng == null) return 0;
  const km = haversineKm(deviceCoords.latitude, deviceCoords.longitude, activity.lat, activity.lng);
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

// הטבה שמתאימה למועדון שהמשתמש הגדיר בפרופיל מקבלת את הבונוס המלא; הטבה כלשהי בלי התאמה
// אישית (המשתמש לא הגדיר את המועדון הזה, או לא הגדיר כלום) מקבלת עדיין 40% ממנו - אותו דפוס
// "ניטרלי-חיובי-חלקי" בדיוק כמו ageMatchScore כשאין נתון גיל.
function benefitMatchScore(activity, benefitClubs) {
  const benefits = activity.benefits || [];
  if (benefits.length === 0) return 0;
  const hasPersonalMatch = benefits.some((b) => (benefitClubs || []).includes(b.provider));
  return hasPersonalMatch ? SCORE_WEIGHTS.benefitMatch : SCORE_WEIGHTS.benefitMatch * 0.4;
}

export function scoreActivity(activity, filters, deviceCoords, benefitClubs) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  return (
    distanceScore(activity, f, deviceCoords) +
    ageMatchScore(activity, f.age) +
    whenProximityScore(activity, f.when) +
    ratingScore(activity) +
    recencyScore(activity) +
    benefitMatchScore(activity, benefitClubs) +
    completenessScore(activity)
  );
}

// applyFilters + מיון לפי ניקוד רלוונטיות - זה מה ש-app/activities.js קורא בפועל במקום
// applyFilters לבד. שומר על יציבות המיון (Array.sort של JS יציב) כדי שתוצאות עם ניקוד שווה
// לא יקפצו סתם בין רינדורים.
export function rankActivities(activities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities) {
  const matched = applyFilters(activities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities);
  return matched
    .map((a) => ({ activity: a, score: scoreActivity(a, filters, deviceCoords, benefitClubs) }))
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
