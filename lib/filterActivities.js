import {
  AGE_OPTIONS, DURATION_OPTIONS, PRICE_OPTIONS, BOOKING_OPTIONS, AMENITY_COMFORT_OPTIONS, DEFAULT_FILTERS,
  DEFAULT_PRECISE_RADIUS_KM,
} from '../constants/filterSchema';

function byId(options, id) {
  return options.find((o) => o.id === id);
}

// עוברים מ-"🚶 במרחק הליכה" ל-travelMode: 'driving' - בין אם המשתמש לחץ ידנית על צ'יפ נסיעה
// (components/LocationQuickPicker.js) ובין אם זו הרחבת-חיפוש אחרי "אין תוצאות במרחק הליכה"
// (app/activities.js) - אותה טרנספורמציה בדיוק, לא לשכפל אותה: radiusKm חוזר לברירת המחדל
// הרגילה (לא נשאר תקוע על WALKING_RADIUS_KM) רק במצב מדויק (current/address) - במצב city
// radiusKm ממילא לא משפיע על matchesLocation, אז אין טעם לגעת בו.
export function locationWithDrivingTime(location, minutes) {
  const isPrecise = location.mode === 'current' || location.mode === 'address';
  return {
    ...location,
    travelMode: 'driving',
    travelMinutes: minutes,
    radiusKm: isPrecise ? DEFAULT_PRECISE_RADIUS_KM : location.radiusKm,
  };
}

// "לא משנה לי המרחק" - travel mode עצמאי (sibling ל-walking/driving), לא ערך בתוך driving time.
// מסיר את אילוץ-המרחק המפורש: radiusKm null/undefined גורם ל-matchesLocation למעלה להתעלם
// מרחק לגמרי (if (!location.radiusKm) return true) - בדיוק "התנהגות ברירת המחדל שכבר קיימת
// במערכת" (לא Smart Radius חדש). travelMinutes נשאר כמו שהוא בכוונה (לא null, לא נמחק) - אם
// המשתמש יעבור בחזרה ל-driving, components/LocationQuickPicker.js משחזר את הבחירה האחרונה
// שלו; הוא פשוט לא נקרא כלל כל עוד travelMode !== 'driving', אז אין לו שום השפעה על החיפוש.
export function locationWithAnyDistance(location) {
  const isPrecise = location.mode === 'current' || location.mode === 'address';
  return {
    ...location,
    travelMode: 'any',
    radiusKm: isPrecise ? null : location.radiusKm,
  };
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
  // 'nationwide' ("בכל הארץ", 2026-09-16) - בחירה מפורשת ב"בלי הגבלה גאוגרפית": מסנן כלום, בדיוק
  // כמו mode:null, אבל הוא מצב נפרד ושונה סמנטית - null הוא "עדיין לא נבחר/לא ידוע" (ה-Home מבקש
  // GPS ופותח פיקר, ראו handleGo ב-app/index.js), 'nationwide' הוא "המשתמש בחר במודע לראות הכל".
  // אין לו נקודת-מוצא: searchOriginCoords (app/activities.js) מחזיר null, אז Smart Radius לא
  // מתרחב ו-distanceScore מחזיר 0 - אין דירוג-מרחק מדומה ממקור שלא קיים.
  if (location.mode === 'nationwide') return true;
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

// "⛔ לאן לא תרצו להגיע?" (אזורים, components/ExcludeAreasPicker.js) - אותו עיקרון בדיוק כמו
// isCityExcluded, אבל משווה ישירות מול activity.region (REGION_OPTIONS/locations.region) -
// אין צורך/מיפוי עיר→אזור בכלל, האזור כבר שדה קיים ומדויק בכל פעילות בפני עצמו.
function isRegionExcluded(activity, excludedRegions) {
  if (!activity.region || !excludedRegions || excludedRegions.length === 0) return false;
  return excludedRegions.includes(activity.region);
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
// days-from-today of each upcoming dated performance (occurrence model, 2026-09-14): a show three
// months away must not match "השבת הקרובה" just because it falls on a Saturday
function occurrenceOffsets(activity) {
  const occ = activity.occurrences || [];
  if (!occ.length) return null;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return occ.map((o) => Math.round((new Date(o.date).setHours(0, 0, 0, 0) - start) / 86400000)).filter((n) => n >= 0);
}

function whenMatchOffset(activity, when) {
  const options = when?.options || [];
  if (options.length === 0) return 0;
  const days = activity.availableDays || [];
  const occOffsets = occurrenceOffsets(activity);
  let minOffset = null;
  for (const optionId of options) {
    for (const offset of optionDayOffsets(optionId, when.date)) {
      const hit = occOffsets ? occOffsets.includes(offset) : days.includes(todayLetter(offset));
      if (hit && (minOffset === null || offset < minOffset)) {
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
export function applyFilters(activities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities, excludedRegions) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  const excluded = excludedCategories || [];
  const excludedCitiesList = [...(excludedCities || []), ...(f.excludeCity || [])];
  const excludedRegionsList = [...(excludedRegions || []), ...(f.excludeRegion || [])];
  return activities.filter((a) => {
    // בחירה מפורשת של המשתמש בקטגוריה/עיר/אזור (סינון מתקדם) מנצחת הסתרה קבועה/זמנית של אותו
    // ערך - "הסר פעילויות"/"⛔ לאן לא תרצו להגיע?" חלים רק על תוצאות כלליות/אוטומטיות, לא על
    // חיפוש מפורש.
    const explicitlyIncluded = (f.category || []).includes(a.category);
    const explicitCityMatch = f.location?.mode === 'city' && f.location.city
      && matchesCityFilter(a.city, f.location.city);
    const explicitRegionMatch = f.location?.mode === 'region' && (f.location.region || []).includes(a.region);
    return (
      (explicitlyIncluded || (!excluded.includes(a.category) && !(f.excludeCategory || []).includes(a.category))) &&
      (explicitCityMatch || !isCityExcluded(a, excludedCitiesList)) &&
      (explicitRegionMatch || !isRegionExcluded(a, excludedRegionsList)) &&
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

// originCoords (אופציונלי, פרמטר חדש) - נקודת-ייחוס שכבר נפתרה מראש עבור מצב 'city' (מרכז-
// יישוב מטבלת settlements, ראו fetchSettlementCoords ב-lib/activities.js ו-resolveSearchOrigin
// ב-app/activities.js) - עד עכשיו mode==='city' תמיד קיבל 0 כאן (אין קואורדינטה בכלל ל"עיר"
// כמושג), אז קריאות קיימות שלא מעבירות originCoords ממשיכות להתנהג בדיוק כמו היום (city→0).
function distanceScore(activity, filters, deviceCoords, originCoords) {
  const mode = filters?.location?.mode;
  if (activity.lat == null || activity.lng == null) return 0;
  // 'current' מודד מ-deviceCoords (GPS מכשיר), 'address' מ-location.coords (כתובת שגואוקדה),
  // 'city' (חדש) מ-originCoords שהועבר מבחוץ - שלושתם אותו חישוב בדיוק, רק מקור-קואורדינטות שונה.
  let origin = null;
  if (mode === 'current') origin = deviceCoords;
  else if (mode === 'address') origin = filters.location.coords;
  else if (mode === 'city') origin = originCoords || null;
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
  // a dated event is "today" only when one of its performances is today (not merely the same weekday)
  const occOffsets = occurrenceOffsets(activity);
  const todayIncluded = occOffsets ? occOffsets.includes(0) : (days.length === 0 || days.includes(todayLetter(0)));
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

export function scoreActivity(activity, filters, deviceCoords, benefitClubs, spontaneousCoords, originCoords) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  return (
    distanceScore(activity, f, deviceCoords, originCoords) +
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

function activityCompleteness(activity) {
  let points = 0;
  if (activity.imageUrl) points += 1;
  if (activity.description) points += 1;
  if (activity.openHours?.start) points += 1;
  return points;
}

// רשת-ביטחון בתצוגה בלבד (לא מוחקת מה-DB) מפני כרטיסים כפולים לאותו מקום פיזי: מקומות
// שנוצרו ע"י scan-source/playground-discovery מקבלים שם-תיאורי מבוסס-כתובת ("X – רחוב, עיר") -
// כשכתובת המקור היא רק שם-רחוב בלי מספר בית, כמה חילוצים-אוטומטיים של אותו מקום בפועל יכולים
// ליצור כמה שורות עם השם התיאורי הזהה אבל קואורדינטות מעט שונות (geocoding לא יציב לכתובת-
// רחוב-בלבד) - נצפה בפועל: "גן שעשועים – יצחק רבין, צורן" פעם 7. NEAR_DUPLICATE_KM נבחר לפי
// הפיזור שנצפה בין חילוצים כפולים כאלה (עד כ-0.6 ק"מ) - לא נועד לאחד שני מקומות אמיתיים ושונים
// שבמקרה חולקים שם גנרי-לגמרי (כמו "גן שעשועים ציבורי - השרון") אבל פזורים על פני עיר/אזור שלם.
const NEAR_DUPLICATE_KM = 0.75;

function dedupeNearIdentical(activities) {
  const byTitle = new Map();
  for (const a of activities) {
    const key = (a.title || '').trim().toLowerCase();
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(a);
  }

  const dropped = new Set();
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    const withCoords = group.filter((a) => a.lat != null && a.lng != null);
    for (let i = 0; i < withCoords.length; i++) {
      const a = withCoords[i];
      if (dropped.has(a.id)) continue;
      for (let j = i + 1; j < withCoords.length; j++) {
        const b = withCoords[j];
        if (dropped.has(b.id)) continue;
        if (haversineKm(a.lat, a.lng, b.lat, b.lng) > NEAR_DUPLICATE_KM) continue;
        const loser = activityCompleteness(b) > activityCompleteness(a) ? a : b;
        dropped.add(loser.id);
        if (loser === a) break; // a עצמו נפל - אין טעם להשוות אותו לעוד b-ים בקבוצה
      }
    }
  }
  return dropped.size ? activities.filter((a) => !dropped.has(a.id)) : activities;
}

// applyFilters + מיון לפי ניקוד רלוונטיות - זה מה ש-app/activities.js קורא בפועל במקום
// applyFilters לבד. שומר על יציבות המיון (Array.sort של JS יציב) כדי שתוצאות עם ניקוד שווה
// לא יקפצו סתם בין רינדורים. spontaneousCoords (אופציונלי) - ראו spontaneousProximityScore.
// originCoords (אופציונלי, חדש) - מועבר הלאה ל-scoreActivity/distanceScore, ראו ההערה שם.
export function rankActivities(activities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities, spontaneousCoords, originCoords, excludedRegions) {
  const matched = dedupeNearIdentical(applyFilters(activities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities, excludedRegions));
  return matched
    .map((a) => ({ activity: a, score: scoreActivity(a, filters, deviceCoords, benefitClubs, spontaneousCoords, originCoords) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.activity);
}

// --- 🚗 Smart Radius Expansion ---
// המטרה: אם החיפוש ב"אזור המבוקש" (city boundary / הרדיוס הקיים) מחזיר מעט מדי תוצאות, מרחיבים
// אוטומטית עד 10 ק"מ ואז עד 15 ק"מ מאותה נקודת-ייחוס (originCoords) - בלי לדרוש חיפוש נוסף
// מהמשתמש, ובלי לגעת בשום פילטר אחר (קטגוריה/גיל/מתי/וכו' - applyFilters מופעל זהה בכל שלב).
// לא רץ מקבילית ל-matchesLocation/haversineKm הקיימים - כל שלב פשוט קורא ל-applyFilters הרגיל
// עם location.radiusKm שונה (וmode='address' זמנית, כדי לעשות שימוש חוזר בענף radius-מקואורדינטות
// הקיים של matchesLocation, בלי לכתוב תנאי-מרחק מקביל). "🚶 הליכה" הוא אילוץ מפורש של המשתמש -
// לעולם לא מורחב מעבר לטווח ההליכה (ראו WALKING_RADIUS_KM, constants/filterSchema.js).
const SMART_RADIUS_MIN_RESULTS = 10;
const SMART_RADIUS_STAGES_KM = [10, 15];

// מפעיל applyFilters פעם אחת עבור "שלב" הרחבה נתון (רדיוס X ק"מ מ-originCoords), בלי לשנות את
// שאר האובייקט filters. מוחזר רק אם originCoords קיים בפועל - שלב הרחבה בלי נקודת-ייחוס פשוט
// לא רץ (activity/מיקום בלי coordinates לא "שוברים" את החיפוש, רק לא משתתפים בהרחבה - סעיף 12).
function applyFiltersAtRadius(activities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities, originCoords, radiusKm, excludedRegions) {
  if (!originCoords) return [];
  const stageFilters = {
    ...filters,
    location: { ...filters.location, mode: 'address', coords: originCoords, radiusKm },
  };
  return applyFilters(activities, stageFilters, deviceCoords, excludedCategories, benefitClubs, excludedCities, excludedRegions);
}

// שלב 1 (ההתנהגות הקיימת בדיוק, ללא שינוי) + עד שני שלבי הרחבה (10/15 ק"מ) רק אם צריך.
// מחזיר { activities, radiusExpanded } - radiusExpanded הוא null (לא הורחב) או 10/15 (הורחב
// בפועל עד הרדיוס הזה - "בפועל" = השלב הזה באמת הוסיף תוצאות חדשות, לא רק "ניסינו").
export function applyFiltersWithSmartRadius(activities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities, originCoords, excludedRegions) {
  const stage1 = applyFilters(activities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities, excludedRegions);
  const travelMode = filters?.location?.travelMode;
  const canExpand = !!originCoords && travelMode !== 'walking' && stage1.length < SMART_RADIUS_MIN_RESULTS;
  if (!canExpand) return { activities: stage1, radiusExpanded: null };

  const seen = new Set(stage1.map((a) => a.id));
  const combined = [...stage1];
  let radiusExpanded = null;
  for (const km of SMART_RADIUS_STAGES_KM) {
    const stageMatches = applyFiltersAtRadius(activities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities, originCoords, km, excludedRegions);
    let addedAny = false;
    for (const a of stageMatches) {
      if (!seen.has(a.id)) {
        seen.add(a.id);
        combined.push(a);
        addedAny = true;
      }
    }
    if (addedAny) radiusExpanded = km;
    if (combined.length >= SMART_RADIUS_MIN_RESULTS) break;
  }
  return { activities: combined, radiusExpanded };
}

// rankActivities + Smart Radius Expansion. דירוג/מיון נשארים זהים לגמרי ל-rankActivities הרגיל
// (ניקוד משולב קיים, לא distance-ascending strict) - ההרחבה משפיעה רק על *אילו* פעילויות בכלל
// נכנסות למאגר-המועמדים, לא על סדר התצוגה שלהן. originCoords גם מוזן ל-scoreActivity, כדי
// שבמצב 'city' (שלא היה לו בעבר שום ניקוד-מרחק) מרחק יתחיל לשחק תפקיד בדירוג גם הוא - "distance
// כגורם חזק יותר כשיש מיקום", בלי לדרוס את שאר האיתותים הקיימים (גיל/דירוג/עדכניות/וכו').
// Metadata שהוחזר ל-UI - מבנה שטוח ומינימלי (לא כפוי framework חדש): resultCount/radiusExpanded/
// effectiveRadiusKm מתארים את ההרחבה עצמה; searchOriginType/searchOriginLabel (UI-facing, נגזרים
// מ-filters.location שרק ה-caller מכיר) מתווספים ע"י app/activities.js, לא כאן - שמירה על הפרדה:
// הפונקציה הזו יודעת גיאוגרפיה/ניקוד, לא "איך מציגים למשתמש את סוג המיקום שבחר".
export function rankActivitiesWithSmartRadius(activities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities, spontaneousCoords, originCoords, excludedRegions) {
  const { activities: matched, radiusExpanded: effectiveRadiusKm } = applyFiltersWithSmartRadius(
    activities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities, originCoords, excludedRegions
  );
  const deduped = dedupeNearIdentical(matched);
  const ranked = deduped
    .map((a) => ({ activity: a, score: scoreActivity(a, filters, deviceCoords, benefitClubs, spontaneousCoords, originCoords) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.activity);
  return {
    activities: ranked,
    resultCount: ranked.length,
    radiusExpanded: effectiveRadiusKm !== null,
    effectiveRadiusKm,
  };
}

export function countActiveFilters(filters) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  let count = 0;
  for (const key of Object.keys(DEFAULT_FILTERS)) {
    // excludeCategory/excludeCity/excludeRegion הם "הסר פעילויות"/"⛔ לאן לא תרצו להגיע?"
    // (הסתרה זמנית/קבועה) - לא נספרים בתג "סינון מתקדם", בדיוק כמו ש-buildActiveChips
    // (app/activities.js) כבר לא בונה עבורם chip - להם יש אינדיקציה נפרדת (hiddenAreaCount).
    if (key === 'excludeCategory' || key === 'excludeCity' || key === 'excludeRegion') continue;
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
