// TuRu - זיהוי-כפילויות/עדכונים ל-scan-source: פורט ל-Deno של הפונקציות הטהורות הקיימות כבר
// ב-tools/import-tool/server.js (normalizeForMatch/wordOverlapScore/haversineKm/
// findSimilarActivities) - אותו אלגוריתם בדיוק, בשימוש היום בפועל בתוך scrapeAndExtract לצירוף
// possibleMatches. server.js עצמו לא נוגעים בו - זה עותק, לא שכפול-לוגי (אין דרך לחלוק קובץ
// Node אחד בין Deno ל-Node).
//
// computeConfidence/computeFieldDiff הם חדשים - היישום הישיר של הדרישה "confidence score
// לכל התאמה" ו-"diff ברור בין השדות שהשתנו".
//
// 2026-09-13: (1) city is normalized on BOTH sides before comparison (it used to be normalized only
// after matching, so "תל אביב-יפו" vs "תל אביב" never matched); (2) venue-aware matching - two items
// at the same canonical venue on the same date/days are the same event even when the two sources
// word the title very differently; (3) computeEventFingerprint - exact pre-check for dated/recurring
// events (the google_place_id of the events world).

import { isGenericPlaygroundName } from './playgroundNaming.ts';
import { normalizeCityName } from './cityNaming.ts';

// deno-lint-ignore no-explicit-any
export type SettingsMap = Record<string, any>;

export function getConfidenceThresholds(settings: SettingsMap) {
  return {
    duplicate: Number(settings.duplicate_confidence_threshold ?? 0.9),
    needsReview: Number(settings.needs_review_confidence_threshold ?? 0.6),
    proximityKm: Number(settings.proximity_km ?? 0.15),
  };
}

export function normalizeForMatch(s: string | null | undefined): string {
  return (s || '').toLowerCase().replace(/[^֐-׿a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

export function wordOverlapScore(a: string | null | undefined, b: string | null | undefined): number {
  const wa = new Set(normalizeForMatch(a).split(' ').filter((w) => w.length > 1));
  const wb = new Set(normalizeForMatch(b).split(' ').filter((w) => w.length > 1));
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  wa.forEach((w) => { if (wb.has(w)) common++; });
  return common / Math.max(wa.size, wb.size);
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface ExistingActivity {
  id: string;
  name: string;
  name_source: string | null;
  description: string | null;
  category: string | null;
  min_age: number | null;
  max_age: number | null;
  price_type: string | null;
  price_amount: number | null;
  booking_requirement: string | null;
  source_url: string | null;
  location_name: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  venue_id: string | null;
  event_fingerprint: string | null;
  schedule_type: string | null;
  one_time_date: string | null;
  start_time: string | null;
  end_time: string | null;
  recurring_days: string[] | null;
  has_image: boolean;
}

const HEBREW_DAY_ORDER = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// Exact-match key for dated/recurring events. null for fixed-hours places (those dedupe by
// google_place_id / proximity). venue_id beats city when known - the same event at the same venue
// is the same event regardless of how each source spells the city.
export function computeEventFingerprint(input: {
  name: string | null | undefined; venueId?: string | null; city?: string | null;
  scheduleType?: string | null; oneTimeDate?: string | null; recurringDays?: string[] | null; startTime?: string | null;
}): string | null {
  const name = normalizeForMatch(input.name);
  if (!name) return null;
  let when: string | null = null;
  if (input.scheduleType === 'one_time' && input.oneTimeDate) when = input.oneTimeDate;
  else if (input.scheduleType === 'recurring' && input.recurringDays?.length) {
    when = [...new Set(input.recurringDays)].sort((a, b) => HEBREW_DAY_ORDER.indexOf(a) - HEBREW_DAY_ORDER.indexOf(b)).join(',');
  }
  if (!when) return null;
  const where = input.venueId ? `v:${input.venueId}` : `c:${normalizeForMatch(normalizeCityName(input.city || null) || '')}`;
  const time = (input.startTime || '').slice(0, 5);
  return `${name}|${where}|${when}|${time}`;
}

// deno-lint-ignore no-explicit-any
export async function getExistingActivitiesForCity(client: any, city: string, cache: Map<string, ExistingActivity[]>): Promise<ExistingActivity[]> {
  const norm = normalizeCityName(city) || city;
  if (!norm) return [];
  if (cache.has(norm)) return cache.get(norm)!;
  const cityVariants = [...new Set([norm, city].filter(Boolean))];
  const { data, error } = await client
    .from('activities')
    .select(`
      id, name, name_source, description, category, min_age, max_age, price_type, price_amount,
      booking_requirement, source_url, venue_id, event_fingerprint,
      location:locations!inner(name, city, lat, lng),
      activity_schedules(schedule_type, one_time_date, start_time, end_time, day_of_week),
      activity_images(url)
    `)
    .in('location.city', cityVariants)
    .eq('status', 'approved');
  if (error) throw error;

  const mapped: ExistingActivity[] = (data || []).map((a: any) => {
    const sched = (a.activity_schedules || [])[0] || {};
    return {
      id: a.id, name: a.name, name_source: a.name_source, description: a.description, category: a.category,
      min_age: a.min_age, max_age: a.max_age, price_type: a.price_type, price_amount: a.price_amount,
      booking_requirement: a.booking_requirement, source_url: a.source_url,
      location_name: a.location?.name ?? null, city: normalizeCityName(a.location?.city ?? null),
      lat: a.location?.lat ?? null, lng: a.location?.lng ?? null,
      venue_id: a.venue_id ?? null, event_fingerprint: a.event_fingerprint ?? null,
      schedule_type: sched.schedule_type ?? null, one_time_date: sched.one_time_date ?? null,
      start_time: sched.start_time ?? null, end_time: sched.end_time ?? null,
      recurring_days: (a.activity_schedules || []).map((s: any) => s.day_of_week).filter(Boolean),
      has_image: (a.activity_images || []).length > 0,
    };
  });
  cache.set(norm, mapped);
  return mapped;
}

// Candidates worth scoring: name overlap, OR same page URL, OR same canonical venue (a venue-hosted
// event can have zero title overlap between two publishers and still be the same thing).
// deno-lint-ignore no-explicit-any
export async function findSimilarActivities(client: any, candidate: any, cache: Map<string, ExistingActivity[]>): Promise<ExistingActivity[]> {
  if (!candidate.name || !candidate.city) return [];
  const existing = await getExistingActivitiesForCity(client, candidate.city, cache);
  return existing
    .map((a) => ({ ...a, _nameScore: wordOverlapScore(candidate.name, a.name) }))
    .filter((a) => a._nameScore >= 0.3 || a.source_url === candidate.pageUrl || (candidate.venue_id && a.venue_id === candidate.venue_id))
    .sort((a, b) => b._nameScore - a._nameScore)
    .slice(0, 8);
}

export interface ConfidenceResult { score: number; breakdown: Record<string, number> }

// משלב כמה אותות: התאמת source_url מדויקת (הכי חזק - כמעט תמיד אותה פעילות אם זו אותה כתובת
// בדיוק), fingerprint זהה, אותו venue קנוני + אותו תאריך, חפיפת-מילים בשם, זהות עיר, קרבה
// גיאוגרפית (אם יש קואורדינטות לשניהם), וחפיפת תאריך/שעה. משוקלל לציון סופי 0-1.
// deno-lint-ignore no-explicit-any
export function computeConfidence(candidate: any, existing: ExistingActivity, thresholds: ReturnType<typeof getConfidenceThresholds>): ConfidenceResult {
  const breakdown: Record<string, number> = {};

  breakdown.exact_url_match = candidate.pageUrl && existing.source_url && candidate.pageUrl === existing.source_url ? 1 : 0;
  breakdown.fingerprint_match = candidate.event_fingerprint && existing.event_fingerprint && candidate.event_fingerprint === existing.event_fingerprint ? 1 : 0;
  breakdown.venue_match = candidate.venue_id && existing.venue_id && candidate.venue_id === existing.venue_id ? 1 : 0;
  breakdown.name_overlap = wordOverlapScore(candidate.name, existing.name);
  const candCity = normalizeCityName(candidate.city || null);
  breakdown.city_match = candCity && existing.city && candCity === existing.city ? 1 : 0;

  if (candidate.lat != null && candidate.lng != null && existing.lat != null && existing.lng != null) {
    const km = haversineKm(candidate.lat, candidate.lng, existing.lat, existing.lng);
    breakdown.proximity = km <= thresholds.proximityKm ? 1 : Math.max(0, 1 - km / (thresholds.proximityKm * 4));
  } else {
    breakdown.proximity = 0;
  }

  if (candidate.one_time_date && existing.one_time_date) {
    breakdown.schedule_match = candidate.one_time_date === existing.one_time_date ? 1 : 0;
  } else if (candidate.recurring_days?.length && existing.recurring_days?.length) {
    const overlap = candidate.recurring_days.filter((d: string) => existing.recurring_days!.includes(d)).length;
    breakdown.schedule_match = overlap > 0 ? overlap / Math.max(candidate.recurring_days.length, existing.recurring_days.length) : 0;
  } else {
    breakdown.schedule_match = 0;
  }

  let score: number;
  if (breakdown.exact_url_match >= 1 || breakdown.fingerprint_match >= 1) {
    score = 0.95;
  } else if (breakdown.venue_match >= 1) {
    // same canonical venue: the date/time carries the decision, the title matters less
    score = (breakdown.name_overlap * 0.3) + (breakdown.venue_match * 0.3) + (breakdown.schedule_match * 0.3) + (breakdown.city_match * 0.1);
    if (breakdown.schedule_match >= 1 && breakdown.name_overlap >= 0.2) score = Math.max(score, 0.92);
  } else {
    score = (breakdown.name_overlap * 0.4) + (breakdown.city_match * 0.15)
      + (breakdown.proximity * 0.25) + (breakdown.schedule_match * 0.2);
  }

  return { score: Math.min(1, Math.round(score * 1000) / 1000), breakdown };
}

const DIFF_FIELD_LABELS: Record<string, string> = {
  one_time_date: 'תאריך', start_time: 'שעת התחלה', end_time: 'שעת סיום',
  price_amount: 'מחיר', price_type: 'סוג מחיר', location_name: 'מיקום', city: 'עיר',
  min_age: 'גיל מינימלי', max_age: 'גיל מקסימלי', description: 'תיאור',
  booking_requirement: 'זמינות/הזמנה', has_image: 'תמונה', name: 'שם',
};

export interface DiffEntry { label: string; before: unknown; after: unknown }

// משווה רק את השדות שהמשתמש פירט (תאריך/שעה/מחיר/מיקום/גילאים/תיאור/תמונה/קישור/זמינות) -
// מחזיר רק שדות שבאמת שונים, לא את כל הרשומה.
// deno-lint-ignore no-explicit-any
export function computeFieldDiff(candidate: any, existing: ExistingActivity): Record<string, DiffEntry> {
  const diff: Record<string, DiffEntry> = {};
  // A less-detailed page must never ERASE known data: a candidate that simply lacks a field is not a
  // change (applyIncomingUpdate applies `after` verbatim, so null here would wipe price/ages on approve).
  const compare = (key: string, before: unknown, after: unknown) => {
    if (after == null) return;
    if (before === after) return;
    diff[key] = { label: DIFF_FIELD_LABELS[key] || key, before, after };
  };

  compare('one_time_date', existing.one_time_date, candidate.one_time_date);
  compare('start_time', existing.start_time, candidate.start_time);
  compare('end_time', existing.end_time, candidate.end_time);
  compare('price_amount', existing.price_amount, candidate.price_amount);
  compare('price_type', existing.price_type, candidate.price_type);
  compare('location_name', existing.location_name, candidate.location_name);
  compare('city', existing.city, normalizeCityName(candidate.city || null));
  compare('min_age', existing.min_age, candidate.min_age);
  compare('max_age', existing.max_age, candidate.max_age);
  compare('booking_requirement', existing.booking_requirement, candidate.booking_requirement);
  if ((candidate.description || '').trim() && candidate.description !== existing.description) {
    compare('description', existing.description, candidate.description);
  }
  const candidateHasImage = Array.isArray(candidate.image_urls) && candidate.image_urls.length > 0;
  if (candidateHasImage && !existing.has_image) {
    compare('has_image', 'אין תמונה', 'נמצאה תמונה');
  }

  // שדרוג שם (סעיף 9 בבקשה - "אם בעתיד יתגלה שם אמיתי"): רק לגני-שעשועים, רק אם למקור הקיים
  // אין כבר name_source='admin_confirmed' (מנהל שאישר שם ידנית > הכל, לעולם לא נדרס אוטומטית),
  // ורק אם המועמד-שנחלץ מציע שם *לא*-גנרי אמיתי שונה מהקיים - לעולם לא דורסים בשם-גנרי אחר.
  if (
    existing.category === 'גן שעשועים' && existing.name_source !== 'admin_confirmed'
    && candidate.name && !isGenericPlaygroundName(candidate.name) && candidate.name !== existing.name
  ) {
    compare('name', existing.name, candidate.name);
  }

  return diff;
}
