import { supabase } from './supabase';
import { haversineKm } from './filterActivities';
import { getActiveBenefits } from './benefits';
import { summarizeSchedules } from './scheduleSummary';

const GRADIENTS = [
  ['#dcecfb', '#c2ddf3'], ['#faedd6', '#f3dcb0'], ['#ece0f9', '#ddc9f3'],
  ['#fde2e2', '#f8c6c6'], ['#d7f3ee', '#b9e8dc'], ['#fff3d6', '#ffe4a8'],
];

function gradientFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return GRADIENTS[hash % GRADIENTS.length];
}

function formatAgeRange(minAge, maxAge) {
  if (minAge == null && maxAge == null) return 'כל הגילאים';
  if (minAge == null) return `עד גיל ${maxAge}`;
  if (maxAge == null) return `מגיל ${minAge}`;
  if (minAge === maxAge) return `גיל ${minAge}`;
  return `גילאים ${minAge}-${maxAge}`;
}

function formatPrice(priceType, priceAmount) {
  if (priceType === 'free') return 'חינם';
  if (priceType === 'fixed' && priceAmount != null) return `₪${priceAmount}`;
  if (priceType === 'range') return 'טווח מחירים';
  return 'לא צוין';
}

// summarizeSchedules lives in ./scheduleSummary (pure, occurrence-aware, unit-tested)

const SELECT_QUERY = `
  id, name, description, entity_type, min_age, max_age,
  price_type, price_amount, category, placeholder_group, duration_minutes, indoor_outdoor,
  booking_requirement, weather_suitable, amenities, family_fit, rating,
  location_id, location_detail, created_at, source, source_url, official_url, created_by,
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
  const { availableDays, openHours, hours, occurrences, nextDate } = summarizeSchedules(row.activity_schedules);
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
    ageRange: formatAgeRange(row.min_age, row.max_age),
    price_type: row.price_type,
    price_amount: row.price_amount,
    price: formatPrice(row.price_type, row.price_amount),
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
    created_at: row.created_at || null,
    recommendedById: row.created_by || null,
    recommendedBy: null,
    availableDays,
    openHours,
    hours,
    occurrences, // upcoming dated performances [{date, start, end, bookingUrl}] - [] for places / recurring
    nextDate,
    imageUrl: images[0] || null,
    imageUrls: images,
    gradient: gradientFor(row.id),
    benefits: getActiveBenefits(row.activity_benefits),
  };
  return { ...base, requiresTicket: requiresTicketPurchase(base) };
}

export function formatDistance(activity, deviceCoords) {
  if (deviceCoords && activity.lat != null && activity.lng != null) {
    const km = haversineKm(deviceCoords.latitude, deviceCoords.longitude, activity.lat, activity.lng);
    return `${km < 10 ? km.toFixed(1) : Math.round(km)} ק"מ ממך`;
  }
  return activity.locationAddress || activity.city || activity.locationName || 'מיקום לא ידוע';
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
  const kmLabel = `${km < 10 ? km.toFixed(1) : Math.round(km)} ק"מ`;
  return originIsCurrentLocation ? `${kmLabel} ממך` : `${kmLabel} מאזור החיפוש`;
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
export async function fetchApprovedActivities() {
  let data = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data: page, error } = await supabase
      .from('activities')
      .select(SELECT_QUERY)
      .eq('status', 'approved')
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    data = data.concat(page);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return attachRecommenders(data.map(mapActivityRow));
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
    .select(SELECT_QUERY)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const [withRecommender] = await attachRecommenders([mapActivityRow(data)]);
  return withRecommender;
}
