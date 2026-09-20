import { supabase } from './supabase';
import { haversineKm } from './filterActivities';
import { getActiveBenefits } from './benefits';
import { summarizeSchedules } from './scheduleSummary';
import { t } from './i18n';
import { scheduleHoursLabel, formatKm, placeName } from './i18n/format';

const GRADIENTS = [
  ['#dcecfb', '#c2ddf3'], ['#faedd6', '#f3dcb0'], ['#ece0f9', '#ddc9f3'],
  ['#fde2e2', '#f8c6c6'], ['#d7f3ee', '#b9e8dc'], ['#fff3d6', '#ffe4a8'],
];

function gradientFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return GRADIENTS[hash % GRADIENTS.length];
}

export function formatAgeRange(minAge, maxAge) {
  if (minAge == null && maxAge == null) return t('domain.activityMeta.ageAll');
  if (minAge == null) return t('domain.activityMeta.ageUpTo', { max: maxAge });
  if (maxAge == null) return t('domain.activityMeta.ageFrom', { min: minAge });
  if (minAge === maxAge) return t('domain.activityMeta.ageExact', { min: minAge });
  return t('domain.activityMeta.ageRange', { min: minAge, max: maxAge });
}

// Currency stays ₪ in every locale (Israeli product, no conversion).
export function formatPrice(priceType, priceAmount) {
  if (priceType === 'free') return t('domain.activityMeta.priceFree');
  if (priceType === 'fixed' && priceAmount != null) return `₪${priceAmount}`;
  if (priceType === 'range') return t('domain.activityMeta.priceRange');
  return t('domain.activityMeta.priceUnknown');
}

// summarizeSchedules lives in ./scheduleSummary (pure, occurrence-aware, unit-tested)

// DETAIL_SELECT_QUERY - הסט המלא, בשימוש רק ב-fetchActivityById (מסך פרטי-פעילות בודד): כולל
// את כל השדות detail-only למטה (official_url/detail_url/location_detail/source/family_fit) -
// שם, ורק שם, הם נקראים בפועל (app/activity/[id].js).
const DETAIL_SELECT_QUERY = `
  id, name, description, entity_type, min_age, max_age,
  price_type, price_amount, category, placeholder_group, duration_minutes, indoor_outdoor,
  booking_requirement, weather_suitable, amenities, family_fit, rating,
  location_id, location_detail, created_at, source, source_url, official_url, detail_url, created_by,
  location:locations(id, name, address, region, lat, lng, city),
  activity_schedules(schedule_type, day_of_week, start_time, end_time, one_time_date, booking_url),
  activity_images(url),
  activity_benefits(id, provider, benefit_type, value, special_price, valid_from, valid_until, redemption_method, redemption_url, coupon_code, terms, status, last_verified_at)
`;

// LIST_SELECT_QUERY (2026-09-20, "Performance Phase 1" audit סעיף 3) - הגרסה המצומצמת שבה
// fetchApprovedActivities (הקטלוג המלא, נטען פעם אחת ל-Home+Results) משתמשת - חמישה שדות
// detail-only הוסרו אחרי מעקב בפועל אחר כל קורא בקוד (לא רק לפי הנחת ה-audit ש"נראים לא
// בשימוש"):
//   - family_fit: אין אף קורא ב-app/lib/components כולו (רק נכתב ב-submitActivity.js) - מת-לגמרי.
//   - location_detail/official_url/detail_url: נקראים אך ורק ב-app/activity/[id].js (מסך-פרטים) -
//     detail-only אמיתי, מאומת בגריפ מלא של הריפו.
//   - source (לא source_url!): נכתב אבל אין אף קורא בפועל - מת-לגמרי, שונה מ-source_url למטה.
// בכוונה *לא* הוסרו (בניגוד להצעת ה-audit הראשוני, שהתבססה רק על "נראה לא בשימוש" בלי מעקב-קוד
// מלא - בדיוק המלכודת שהוראות השלב הזה הזהירו מפניה):
//   - activity_benefits: מסונן וממוין עליו בפועל בכל הקטלוג (matchesBenefits/benefitMatchScore
//     ב-lib/filterActivities.js) - הטבלה ריקה היום (0 שורות) אבל זו עובדת-תוכן, לא באג בקוד;
//     הסרת ה-embed הייתה שוברת בשקט את הפילטר "יש לי הטבה"/"ההטבות שלי" ברגע שתתמלא הטבלה.
//     activity_benefits(0 שורות)
//   - source_url: בשימוש ב-isExemptFromScheduleEvidence (lib/filterActivities.js) - "חריגת מקום
//     ציבורי קבוע" ש-4,397 גני-שעשועים מ-OSM תלויים בה כדי להיחשב זמינים בחיפושי-תאריך/שעה
//     למרות שאין להם schedule. הסרתו הייתה שוברת בשקט חיפוש-תאריך על כל גני-המשחקים מ-OSM.
//   - created_by: בשימוש דרך attachRecommenders (למטה) לתגית "הומלץ ע"י" שמוצגת על כרטיסים
//     ב-Home/Results (components/ActivityCard.js) - לא detail-only כמו שנראה על פניו.
//   - description: לפי הנחיה מפורשת של השלב הזה (בשימוש בחיפוש-חופשי, matchesFreeText).
const LIST_SELECT_QUERY = `
  id, name, description, entity_type, min_age, max_age,
  price_type, price_amount, category, placeholder_group, duration_minutes, indoor_outdoor,
  booking_requirement, weather_suitable, amenities, rating,
  location_id, created_at, source_url, created_by,
  location:locations(id, name, address, region, lat, lng, city),
  activity_schedules(schedule_type, day_of_week, start_time, end_time, one_time_date, booking_url),
  activity_images(url),
  activity_benefits(id, provider, benefit_type, value, special_price, valid_from, valid_until, redemption_method, redemption_url, coupon_code, terms, status, last_verified_at)
`;

// פעילות "דורשת קניית כרטיס ותשלום" אם יש לה עלות אמיתית (price_type='fixed' עם סכום, או
// 'range') וגם כתובת חיצונית לעבור אליה בפועל (source_url) - בלי קישור אין לאן לשלוח את
// המשתמש, אז לא מציגים כפתור "רכישה" שמוביל לשום מקום. זה שדה נגזר (לא עמודה ב-DB) שמחושב
// כאן פעם אחת עבור כל פעילות - ולכן חל אוטומטית על כל פעילות קיימת ועתידית, בלי תהליך נפרד.
export function requiresTicketPurchase(activity) {
  const hasCost = (activity.price_type === 'fixed' && activity.price_amount > 0) || activity.price_type === 'range';
  return hasCost && !!activity.sourceUrl;
}

export function mapActivityRow(row) {
  const { availableDays, openHours, occurrences, nextDate, recurringDays, hoursByDay, intervalsByDay } = summarizeSchedules(row.activity_schedules);
  const images = (row.activity_images || []).map((i) => i.url).filter(Boolean);

  const base = {
    id: row.id,
    title: row.name,
    description: row.description || null,
    type: row.category || row.entity_type,
    category: row.category,
    placeholderGroup: row.placeholder_group || null,
    entity_type: row.entity_type,
    locationId: row.location_id || row.location?.id || null,
    city: row.location?.city || null,
    locationName: row.location?.name || null,
    locationAddress: row.location?.address || null,
    locationDetail: row.location_detail || null,
    region: row.location?.region || null,
    lat: row.location?.lat ?? null,
    lng: row.location?.lng ?? null,
    min_age: row.min_age,
    max_age: row.max_age,

    price_type: row.price_type,
    price_amount: row.price_amount,

    duration_minutes: row.duration_minutes,
    indoor_outdoor: row.indoor_outdoor,
    booking_requirement: row.booking_requirement,
    weather_suitable: row.weather_suitable || [],
    amenities: row.amenities || [],
    family_fit: row.family_fit || [],
    rating: row.rating ?? null,
    source: row.source || null,
    sourceUrl: row.source_url || null,
    officialUrl: row.official_url || null,
    // סולם ה"ישירוּת" של קישור-הפעולה (0097) - רק כתובות מאומתות, לעולם לא ניחוש: פעולת-הרשמה/רכישה מפורשת
    // (official_url) > עמוד-האירוע עצמו (detail_url) > עמוד-הרשימה שממנו נאסף המידע (source_url). בלי זה
    // כפתור "קניית כרטיסים" נפתח על לוח-האירועים העירוני כולו במקום על האירוע.
    detailUrl: row.detail_url || null,
    actionUrl: row.official_url || row.detail_url || row.source_url || null,
    created_at: row.created_at || null,
    recommendedById: row.created_by || null,
    recommendedBy: null,
    availableDays,
    openHours,
    hoursByDay: hoursByDay || {}, // per-weekday hours (recurring/fixed_hours only) - lib/filterActivities.js#hourMatchesOnOffset
    // per-weekday MULTIPLE intervals (2026-09-20, Opening Hours foundation, architecture audit
    // section 7) - additive alongside hoursByDay above, not yet consumed by any live filter/badge;
    // see lib/hoursResolver.js's `useIntervalsByDay` option.
    intervalsByDay: intervalsByDay || {},
    recurringDays: recurringDays || [],
    occurrences, // upcoming dated performances [{date, start, end, bookingUrl}] - [] for places / recurring
    nextDate,
    imageUrl: images[0] || null,
    imageUrls: images,
    gradient: gradientFor(row.id),
    benefits: getActiveBenefits(row.activity_benefits),
  };
  // ageRange/price/hours are display text: enumerable getters, so they are re-evaluated in the active
  // locale whenever the activity object is read or spread into props (e.g. <ActivityCard {...a} />).
  Object.defineProperties(base, {
    ageRange: { enumerable: true, get() { return formatAgeRange(this.min_age, this.max_age); } },
    price: { enumerable: true, get() { return formatPrice(this.price_type, this.price_amount); } },
    hours: { enumerable: true, get() { return scheduleHoursLabel(this); } },
  });
  base.requiresTicket = requiresTicketPurchase(base);
  return base;
}

export function formatDistance(activity, deviceCoords) {
  if (deviceCoords && activity.lat != null && activity.lng != null) {
    const km = haversineKm(deviceCoords.latitude, deviceCoords.longitude, activity.lat, activity.lng);
    return t('domain.distance.fromYou', { km: formatKm(km) });
  }
  return activity.locationAddress || placeName(activity.city) || activity.locationName || t('domain.distance.unknown');
}

// כמו formatDistance, אבל עם נקודת-ייחוס גנרית (originCoords - GPS/כתובת מגואוקדדת/מרכז-יישוב,
// ראו searchOriginCoords ב-app/activities.js) ולא רק deviceCoords - כדי שגם חיפוש-לפי-עיר יציג
// מרחק אמיתי במקום ליפול ל-fallback הטקסטואלי. הניסוח שונה לפי סוג המקור (סעיף L בבקשה): "ממך"
// רק כשמדובר במיקום-נוכחי אמיתי של המשתמש (originIsCurrentLocation) - אחרת "מאזור החיפוש", כי
// "ממך" יהיה מטעה כשהמרחק בפועל נמדד ממרכז-עיר/כתובת שהוזנה, לא מהמשתמש עצמו.
export function formatSearchDistance(activity, originCoords, originIsCurrentLocation) {
  if (!originCoords || activity.lat == null || activity.lng == null) {
    return formatDistance(activity, null);
  }
  const originLat = originCoords.lat ?? originCoords.latitude;
  const originLng = originCoords.lng ?? originCoords.longitude;
  const km = haversineKm(originLat, originLng, activity.lat, activity.lng);
  return t(originIsCurrentLocation ? 'domain.distance.fromYou' : 'domain.distance.fromSearchArea', { km: formatKm(km) });
}

// 🚗 Smart Radius Expansion (app/activities.js, lib/filterActivities.js) - כשהחיפוש הוא לפי
// עיר/יישוב (location.mode==='city') וצריך להרחיב רדיוס, דרושה נקודת-ייחוס (lat/lng) ל"עיר"
// שאין לה ייצוג כזה במקום אחר בפרויקט. settlements (supabase/0063_settlements.sql) היא הכי
// קרובה שיש: 1,316 יישובים עם lat/lng אמיתיים, יובאה בעבר לכלי-הסריקה הנפרד
// (tools/playground-discovery) אבל מעולם לא נקראה מהאפליקציה עצמה - כבר public-read
// (RLS: settlements_read using(true)), אין צורך בשום migration/RLS חדש כדי לקרוא ממנה כאן.
// התאמה ב-ILIKE פשוטה (לא alias groups של matchesCityFilter - זו בעיה שונה: איתור-נקודה בודדת
// ב-DB, לא סינון-רשימת-פעילויות בזיכרון) - אם אין התאמה (יישוב נדיר/לא ברשימה), פשוט מחזיר null
// וההרחבה לא רצה בכלל, בלי לשבור את שאר החיפוש (סעיף 12: "location בלי coordinates לא שוברת").
export async function fetchSettlementCoords(cityName) {
  const trimmed = (cityName || '').trim();
  if (!trimmed) return null;
  const { data, error } = await supabase
    .from('settlements')
    .select('name_he, lat, lng')
    .not('lat', 'is', null)
    .ilike('name_he', `%${trimmed}%`)
    .limit(5);
  if (error || !data || data.length === 0) return null;
  const match = data.find((s) => s.name_he === trimmed) || data[0];
  return { lat: match.lat, lng: match.lng };
}

// created_by לא נחשף דרך profiles (RLS חוסם), אז שולפים כינוי+כוכבים+role דרך public_profiles
// (ראו supabase/0020_recommendation_stars.sql, supabase/0021_public_profiles_role.sql) - אותו
// דפוס בדיוק כמו fetchCommunityNotes ב-lib/interactions.js.
// "הומלץ ע"י" מוצג רק על המלצות של משתמשים חיצוניים רגילים - לא על מה שהבוט ייבא
// (role='importer') ולא על מה שהאדמין העלה בעצמו (role='admin').
async function attachRecommenders(activities) {
  const ids = [...new Set(activities.map((a) => a.recommendedById).filter(Boolean))];
  if (ids.length === 0) return activities;
  const { data, error } = await supabase.from('public_profiles').select('id, nickname, stars, role').in('id', ids);
  if (error) return activities;
  const byId = Object.fromEntries(
    (data || [])
      .filter((p) => (p.role || 'user') === 'user')
      .map((p) => [p.id, { nickname: p.nickname, stars: p.stars ?? 0 }])
  );
  return activities.map((a) => ({ ...a, recommendedBy: a.recommendedById ? byId[a.recommendedById] || null : null }));
}

// Supabase/PostgREST מגביל תגובת select ל-1000 שורות כברירת מחדל בשקט (בלי שגיאה!) - אותו באג
// בדיוק שכבר תועד ותוקן בכמה סקריפטים בכלי-הניהול (server.js /api/manage/activities,
// import-playgrounds-osm.js) אבל מעולם לא תוקן כאן - בפונקציה שטוענת את *כל* הפעילויות לאפליקציה
// עצמה. נמצא בפועל 2026-09-11: עם 6,000+ פעילויות במאגר וה-order לפי created_at desc, האפליקציה
// טענה בשקט רק את 1000 הפעילויות החדשות ביותר - כל פעילות ותיקה יותר (כולל רוב ייבוא ה-OSM
// המקורי) פשוט לא הייתה קיימת מבחינת חיפוש/סינון בצד הלקוח, בלי שום שגיאה שמעידה על כך.
const PAGE_SIZE = 1000;
// המקסימום-מקבילי (2026-09-20, "Performance Phase 1" audit סעיף 1) - לא Promise.all על *כל*
// הדפים בבת-אחת: אם הקטלוג יגדל דרמטית (עשרות-אלפי פעילויות), זה יבטיח שלעולם לא נפתחות יותר מ-8
// בקשות-רשת מקבילות בזמן נתון, במקום עומס-בקשות שגדל בלי הגבלה עם גודל הקטלוג. עם 5,693 שורות
// היום (6 דפים) זה בפועל אומר "כל הדפים במקביל" - ההגבלה קיימת כרשת-ביטחון לעתיד, לא כי היא
// משנה משהו כרגע.
const MAX_CONCURRENT_PAGES = 8;

async function fetchApprovedActivitiesPage(offset, { withCount = false } = {}) {
  let query = supabase.from('activities').select(LIST_SELECT_QUERY, withCount ? { count: 'exact' } : undefined);
  query = query.eq('status', 'approved');
  // order('id') לא order('created_at') (2026-09-20, "Performance Phase 1" audit סעיף 2, ראו
  // המחקר המלווה בהודעת ה-commit): id הוא primary key, אז יש לו אינדקס-מובנה ממש כמו שה-audit
  // המקורי מדד ("50-row page, order=id" הגיע לרצפת-הרשת ~0.42s, לעומת ~1.2-1.9s עם order=created_at
  // הלא-מאונדקס). חשוב לא פחות: id הוא ייחודי-לחלוטין (created_at לא - שתי פעילויות יכולות
  // להיווצר באותה מילישנייה), אז זה גם ה"מפתח-עימוד" הבטוח-ביותר ל-.range() - order לפי מפתח
  // לא-ייחודי יכול (תיאורטית) להחזיר את אותה שורה בשני דפים שונים או להחסיר שורה בין שני עימודים
  // נפרדים אם יש קשרי-שוויון. שום קוד קיים לא תלוי בסדר created_at-desc של המערך הגולמי שמוחזר
  // מכאן (דורג/מסונן/ממוין-מחדש תמיד בהמשך ב-lib/filterActivities.js לפני תצוגה) - נבדק במיוחד:
  // בחירת-קרוסלת-הבית (homeDiscovery.js), שבירת-שוויון בניקוד, ו-dedupeNearIdentical.
  query = query.order('id', { ascending: true }).range(offset, offset + PAGE_SIZE - 1);
  const { data, count, error } = await query;
  if (error) throw error;
  return { data, count };
}

// עימוד-מקבילי (2026-09-20, "Performance Phase 1") - במקום לולאה סריאלית שמגלה את מספר-הדפים
// בהדרגה (דף-אחר-דף, מחכה לכל אחד שיחזור לפני ששולחת את הבא), מבקשים את הספירה-המדויקת *באותה*
// בקשה של הדף הראשון (select(..., {count:'exact'}) - לא סיבוב-רשת נפרד רק לספירה), ואז שולחים את
// כל שאר הדפים ב-batches מקביליים (עד MAX_CONCURRENT_PAGES בכל פעם). נמדד: 12.4s סריאלי -> 3.9s
// מקבילי על הקטלוג האמיתי (5,693 שורות), אותן שורות בדיוק, אותו סדר. אם הקטלוג *גדל* בין רגע
// ספירת-הדף-הראשון לרגע שליפת הדפים האחרונים (כתיבות-מתחרות), הבדיקה בסוף (while האחרון) ממשיכה
// לעמד באופן סריאלי כל עוד הדף-האחרון-שהתקבל מלא (PAGE_SIZE שורות) - בדיוק אותה תכונה
// self-terminating שהייתה בלולאה המקורית, כדי שלעולם לא נחסיר שורות חדשות בטעות.
// exported רק לצורך בדיקות (tests/fetchApprovedActivitiesPaging.test.js) - סימולציית עמוד-דף
// עם supabase מדומה; fetchApprovedActivities עצמה (למטה) נשארת ה-API הציבורי היחיד שהאפליקציה
// בפועל קוראת לו.
export async function fetchAllApprovedRows() {
  const first = await fetchApprovedActivitiesPage(0, { withCount: true });
  if (first.data.length === 0) return [];

  const total = first.count ?? first.data.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pages = [first.data];

  for (let nextPage = 1; nextPage < pageCount; ) {
    const batch = [];
    for (; batch.length < MAX_CONCURRENT_PAGES && nextPage < pageCount; nextPage++) {
      batch.push(nextPage);
    }
    const results = await Promise.all(batch.map((p) => fetchApprovedActivitiesPage(p * PAGE_SIZE)));
    for (const r of results) pages.push(r.data);
  }

  // רשת-ביטחון: אם הדף האחרון שכבר יש לנו מלא (PAGE_SIZE), אולי נוספו שורות בין ספירת-הדף-הראשון
  // לביצוע-בפועל - ממשיכים לעמד סריאלית עד שמתקבל דף לא-מלא (או ריק), בדיוק כמו הלולאה המקורית.
  while (pages[pages.length - 1].length === PAGE_SIZE) {
    const nextOffset = pages.length * PAGE_SIZE;
    const { data } = await fetchApprovedActivitiesPage(nextOffset);
    if (data.length === 0) break;
    pages.push(data);
  }

  return pages.flat();
}

export async function fetchApprovedActivities() {
  const rows = await fetchAllApprovedRows();
  return attachRecommenders(rows.map(mapActivityRow));
}

// עריכה/מחיקה ישירות מתוך עמוד הפעילות (לא רק מ-tools/import-tool) - ה-RLS כבר מאפשר את זה
// לאדמין בפועל (activities_update/activities_delete/locations_update ב-supabase/schema.sql
// כבר בודקות is_admin(), בלי תלות בזה שהעריכה מגיעה מהכלי הנפרד) - כל עוד המשתמש מחובר
// כ-role='admin' בטבלת profiles, אין צורך בשום מיגרציה חדשה כדי שזה יעבוד.
const ACTIVITY_EDITABLE_FIELDS = [
  'name', 'description', 'category', 'entity_type', 'min_age', 'max_age',
  'price_type', 'price_amount', 'duration_minutes', 'indoor_outdoor', 'booking_requirement',
];

export async function updateActivityAsAdmin(activity, fields, location) {
  const safeFields = {};
  for (const key of ACTIVITY_EDITABLE_FIELDS) {
    if (key in fields) safeFields[key] = fields[key];
  }
  if (Object.keys(safeFields).length > 0) {
    const { error } = await supabase.from('activities').update(safeFields).eq('id', activity.id);
    if (error) throw error;
  }

  if (location) {
    if (activity.locationId) {
      const { error } = await supabase.from('locations').update(location).eq('id', activity.locationId);
      if (error) throw error;
    } else if (location.name) {
      const { data: created, error } = await supabase.from('locations').insert(location).select('id').single();
      if (error) throw error;
      await supabase.from('activities').update({ location_id: created.id }).eq('id', activity.id);
    }
  }
}

export async function deleteActivityAsAdmin(activityId) {
  const { error } = await supabase.from('activities').delete().eq('id', activityId);
  if (error) throw error;
}

export async function fetchActivityById(id) {
  const { data, error } = await supabase
    .from('activities')
    .select(DETAIL_SELECT_QUERY)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const [withRecommender] = await attachRecommenders([mapActivityRow(data)]);
  return withRecommender;
}
