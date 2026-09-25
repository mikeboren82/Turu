import { supabase } from './supabase';
import { haversineKm } from './filterActivities';
import { getActiveBenefits } from './benefits';
import { summarizeSchedules } from './scheduleSummary';
import { t } from './i18n';
import { scheduleHoursLabel, formatKm, placeName } from './i18n/format';
import { verifiedFieldUpdate, isSuccess, describe } from './verifiedWrite';

const GRADIENTS = [
  ['#dcecfb', '#c2ddf3'], ['#faedd6', '#f3dcb0'], ['#ece0f9', '#ddc9f3'],
  ['#fde2e2', '#f8c6c6'], ['#d7f3ee', '#b9e8dc'], ['#fff3d6', '#ffe4a8'],
];

function gradientFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return GRADIENTS[hash % GRADIENTS.length];
}

// תיקון-סמנטיקה (2026-09-20, "reliability pass" audit סעיף 2): min_age/max_age חסרים-שניהם
// (הטופס ב-app/add-activity.js משאיר אותם null כשלא הוזנו - אין checkbox/דגל נפרד ל"כל הגילאים"
// במודל-הנתונים) פירושם "לא ידוע", לא "מתאים לכל גיל" - "כל הגילאים" הייתה טענה חיובית ממציאה
// מידע שלא קיים. אם המשתמש בפועל הזין טווח מפורש שמכסה את כולם (כמו min_age=0,max_age=99) זו
// כבר לא הענף הזה בכלל (שני הערכים לא-null) - אותה הבחנה בין "לא הוזן" ל"הוזן מפורשות" ממשיכה
// לעבוד בדיוק כמו קודם, רק הניסוח של מקרה-החוסר-המלא השתנה מ"כל הגילאים" ל"לא צוין"
// (domain.activityMeta.ageUnknown, אותו ניסוח בדיוק כמו priceUnknown למטה - לא טענה חדשה).
export function formatAgeRange(minAge, maxAge) {
  if (minAge == null && maxAge == null) return t('domain.activityMeta.ageUnknown');
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
// status: only for the activity page's share gate (lib/activityPage.js#isPubliclyShareable) - an
// admin or creator can read a pending/archived row here, anonymous recipients cannot (RLS).
const DETAIL_SELECT_QUERY = `
  id, name, description, entity_type, min_age, max_age, status,
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
    // null when the query didn't select it (LIST_SELECT_QUERY) - only DETAIL_SELECT_QUERY does.
    status: row.status ?? null,
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
  // Assigned in place, not `{ ...a, recommendedBy }`: every caller passes objects freshly built by
  // mapActivityRow in the same call, and a spread would copy ageRange/price/hours out of their
  // locale-aware getters into plain strings frozen in the language active at fetch time - which
  // the shared catalogue cache (lib/catalogueCache.js) would then keep serving after a language
  // switch.
  for (const a of activities) a.recommendedBy = a.recommendedById ? byId[a.recommendedById] || null : null;
  return activities;
}

// Supabase/PostgREST מגביל תגובת select ל-1000 שורות כברירת מחדל בשקט (בלי שגיאה!) - אותו באג
// בדיוק שכבר תועד ותוקן בכמה סקריפטים בכלי-הניהול (server.js /api/manage/activities,
// import-playgrounds-osm.js) אבל מעולם לא תוקן כאן - בפונקציה שטוענת את *כל* הפעילויות לאפליקציה
// עצמה. נמצא בפועל 2026-09-11: עם 6,000+ פעילויות במאגר וה-order לפי created_at desc, האפליקציה
// טענה בשקט רק את 1000 הפעילויות החדשות ביותר - כל פעילות ותיקה יותר (כולל רוב ייבוא ה-OSM
// המקורי) פשוט לא הייתה קיימת מבחינת חיפוש/סינון בצד הלקוח, בלי שום שגיאה שמעידה על כך.
const PAGE_SIZE = 1000;
// Keyset paging in two id lanes (2026-09-25, "Activities Loading + Client Cache Performance"),
// replacing "count page + up to 8 parallel OFFSET pages" (2026-09-20, "Performance Phase 1").
// Measured against the live backend (3 runs each, same select, same session):
//   old  count + 5 parallel offset pages: 16.4s / 18.4s / 14.3s - one run of three FAILED with
//        two "57014 canceling statement due to statement timeout" pages. Parallel pages queued to
//        7-15s each: the backend is CPU-bound per statement, so fan-out bought no wall-clock time,
//        only timeouts (the "intermittent failures on repeated hard reloads").
//   new  2 lanes x serial keyset pages: 14.7s / 11.7s, 0 errors (serial single lane: 22.3s / 14.0s).
// Each request is `id >= laneStart [and id > lastSeenId] and id < laneEnd order by id limit 1000` -
// a primary-key range scan whose cost does not grow with depth (OFFSET 5000 had to walk and discard
// 5000 embedded rows first), and no count(*) round trip. At most FETCH_LANES statements are ever in
// flight, however large the catalogue grows. ids are random UUIDs (uniform), so splitting the id
// space at 0x80... gives two ~equal halves.
// Keyset is also consistent under concurrent writes: a row published mid-fetch is either before
// the cursor (not seen this time) or after it (seen once) - never twice, unlike offset paging where
// every insert shifts later offsets. order('id') remains the stable, unique sort key (see the
// 2026-09-20 note: nothing downstream depends on the raw array order; it is re-ranked anyway).
const FETCH_LANES = 2;
const UUID_MIN = '00000000-0000-0000-0000-000000000000';

function laneBound(i) {
  if (i === 0) return UUID_MIN;
  if (i >= FETCH_LANES) return null;
  return Math.floor((i * 0x100000000) / FETCH_LANES).toString(16).padStart(8, '0') + '-0000-0000-0000-000000000000';
}

async function fetchApprovedLane(lowerInclusive, upperExclusive) {
  const rows = [];
  let lastId = null;
  for (;;) {
    let query = supabase.from('activities').select(LIST_SELECT_QUERY).eq('status', 'approved');
    query = lastId ? query.gt('id', lastId) : query.gte('id', lowerInclusive);
    if (upperExclusive) query = query.lt('id', upperExclusive);
    const { data, error } = await query.order('id', { ascending: true }).limit(PAGE_SIZE);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
    lastId = data[data.length - 1].id;
  }
}

// exported for tests only (tests/fetchApprovedActivitiesPaging.test.js, tests/catalogueCache.test.js);
// fetchApprovedActivities below is the one API the app calls.
export async function fetchAllApprovedRows() {
  const lanes = await Promise.all(
    Array.from({ length: FETCH_LANES }, (_, i) => fetchApprovedLane(laneBound(i), laneBound(i + 1))),
  );
  // Lanes are disjoint id ranges and keyset pages cannot overlap, so this never drops anything in
  // practice - it only guarantees one card per activity even if a future change breaks that.
  const seen = new Set();
  return lanes.flat().filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
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

// אימות-כתיבה (2026-09-21, "zero-row hardening" audit): update().eq('id', ...) בלי .select() לא
// יכול להבחין בין "נכתב בהצלחה" ל"0 שורות הותאמו, error=null" - בדיוק התבנית שגרמה לשני ארכובים
// שקטים-כושלים ב-duplicate Resolution Batch #1 (ראו lib/activityArchive.js). כאן אין ערך-קודם
// צפוי לשמור עליו (עריכת אדמין כותבת את מה שבטופס, לא תלויה בערך הישן) - guardStillHolds תמיד
// אמת, ולכן תוצאת 0-שורות יכולה להיות רק ROW_NOT_FOUND או WRITE_DENIED, לא PRECONDITION_CHANGED.
export async function updateActivityAsAdmin(activity, fields, location) {
  const safeFields = {};
  for (const key of ACTIVITY_EDITABLE_FIELDS) {
    if (key in fields) safeFields[key] = fields[key];
  }
  if (Object.keys(safeFields).length > 0) {
    const result = await verifiedFieldUpdate(supabase, {
      table: 'activities', id: activity.id, patch: safeFields, guardStillHolds: () => true,
    });
    if (!isSuccess(result)) throw new Error(`updateActivityAsAdmin: ${describe(result)}`);
  }

  if (location) {
    if (activity.locationId) {
      const result = await verifiedFieldUpdate(supabase, {
        table: 'locations', id: activity.locationId, patch: location, guardStillHolds: () => true,
      });
      if (!isSuccess(result)) throw new Error(`updateActivityAsAdmin (location): ${describe(result)}`);
    } else if (location.name) {
      const { data: created, error } = await supabase.from('locations').insert(location).select('id').single();
      if (error) throw error;
      const relink = await verifiedFieldUpdate(supabase, {
        table: 'activities', id: activity.id, patch: { location_id: created.id }, guardStillHolds: () => true,
      });
      if (!isSuccess(relink)) throw new Error(`updateActivityAsAdmin (location relink): ${describe(relink)}`);
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
