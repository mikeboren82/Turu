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
  address?: string | null;
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
  // occurrence model (2026-09-14): every dated performance of the activity, sorted; one_time_date /
  // start_time above are the EARLIEST UPCOMING occurrence (display/legacy compatibility only)
  occurrences?: { date: string; start_time: string | null; end_time: string | null }[];
  event_key?: string | null;       // EVENT identity (eventIdentity.ts) - stable across occurrences
  event_key_kind?: string | null;
  entity_type?: string | null;
  official_url?: string | null;
  source_id?: string | null;
  address_source?: string | null;
}

const HEBREW_DAY_ORDER = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// Map one activities row (with embedded location / schedules / images) to the matcher's shape.
// deno-lint-ignore no-explicit-any
export function mapExistingRow(a: any, today = new Date().toISOString().slice(0, 10)): ExistingActivity {
  const rows: any[] = a.activity_schedules || [];
  const occ = rows.filter((s) => s.schedule_type === 'one_time' && s.one_time_date)
    .map((s) => ({ date: String(s.one_time_date), start_time: s.start_time ? String(s.start_time).slice(0, 5) : null, end_time: s.end_time ? String(s.end_time).slice(0, 5) : null }))
    .sort((x, y) => (x.date + (x.start_time || '')).localeCompare(y.date + (y.start_time || '')));
  const next = occ.find((o) => o.date >= today) || occ[0] || null;
  const sched = next ? null : (rows[0] || {});
  return {
    id: a.id, name: a.name, name_source: a.name_source, description: a.description, category: a.category,
    min_age: a.min_age, max_age: a.max_age, price_type: a.price_type, price_amount: a.price_amount,
    booking_requirement: a.booking_requirement, source_url: a.source_url,
    location_name: a.location?.name ?? null, address: a.location?.address ?? null, city: normalizeCityName(a.location?.city ?? null),
    address_source: a.location?.address_source ?? null,
    lat: a.location?.lat ?? null, lng: a.location?.lng ?? null,
    venue_id: a.venue_id ?? null, event_fingerprint: a.event_fingerprint ?? null,
    event_key: a.event_key ?? null, event_key_kind: a.event_key_kind ?? null, official_url: a.official_url ?? null, source_id: a.source_id ?? null, entity_type: a.entity_type ?? null,
    schedule_type: next ? 'one_time' : (sched?.schedule_type ?? null), one_time_date: next ? next.date : (sched?.one_time_date ?? null),
    start_time: next ? next.start_time : (sched?.start_time ? String(sched.start_time).slice(0, 5) : null), end_time: next ? next.end_time : (sched?.end_time ? String(sched.end_time).slice(0, 5) : null),
    recurring_days: rows.map((s) => s.day_of_week).filter(Boolean),
    occurrences: occ,
    has_image: (a.activity_images || []).length > 0,
  };
}

export const EXISTING_ACTIVITY_SELECT = `
      id, name, name_source, description, category, entity_type, min_age, max_age, price_type, price_amount,
      booking_requirement, source_url, venue_id, event_fingerprint, event_key, event_key_kind, official_url, source_id,
      location:locations!inner(name, city, lat, lng, address, address_source),
      activity_schedules(schedule_type, one_time_date, start_time, end_time, day_of_week),
      activity_images(url)
    `;

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
    .select(EXISTING_ACTIVITY_SELECT)
    .in('location.city', cityVariants)
    .eq('status', 'approved');
  if (error) throw error;

  const mapped: ExistingActivity[] = (data || []).map((a: any) => mapExistingRow(a));
  cache.set(norm, mapped);
  return mapped;
}

// dates of a candidate: its explicit occurrences (detail traversal) or its single one_time_date
// deno-lint-ignore no-explicit-any
export function candidateDates(candidate: any): string[] {
  const occ: { date: string }[] = Array.isArray(candidate?.occurrences) ? candidate.occurrences : [];
  const set = new Set<string>(occ.map((o) => o.date).filter(Boolean));
  if (candidate?.one_time_date) set.add(candidate.one_time_date);
  return [...set].sort();
}
export function existingDates(existing: ExistingActivity): string[] {
  const set = new Set<string>((existing.occurrences || []).map((o) => o.date));
  if (existing.one_time_date) set.add(existing.one_time_date);
  return [...set].sort();
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

  const cDates = candidateDates(candidate), eDates = existingDates(existing);
  if (cDates.length && eDates.length) {
    // any-date overlap: the same event's other performance is still the same event's schedule
    breakdown.schedule_match = cDates.some((d) => eDates.includes(d)) ? 1 : 0;
  } else if (candidate.recurring_days?.length && existing.recurring_days?.length) {
    const overlap = candidate.recurring_days.filter((d: string) => existing.recurring_days!.includes(d)).length;
    breakdown.schedule_match = overlap > 0 ? overlap / Math.max(candidate.recurring_days.length, existing.recurring_days.length) : 0;
  } else {
    breakdown.schedule_match = 0;
  }

  let score: number;
  // exact_url_match is identity only for a per-item page. Activities created from a LISTING page
  // all carry that listing URL as source_url, so on its own the signal made every later candidate
  // from the same page an "update" of the first one (2026-09-13: 226 of 261 queued updates, 21
  // activities). It now decides only together with a name or schedule agreement.
  // 2026-09-14: a shared listing page + a coinciding date is NOT identity either (two different shows on
  // the same calendar day; with multi-date events a date coincidence is common) - the name must agree.
  const urlIdentity = breakdown.exact_url_match >= 1 && breakdown.name_overlap >= 0.5;
  if (breakdown.fingerprint_match >= 1 || urlIdentity) {
    score = 0.95;
  } else if (breakdown.venue_match >= 1) {
    // same canonical venue: the date/time carries the decision, the title matters less
    score = (breakdown.name_overlap * 0.3) + (breakdown.venue_match * 0.3) + (breakdown.schedule_match * 0.3) + (breakdown.city_match * 0.1);
    if (breakdown.schedule_match >= 1 && breakdown.name_overlap >= 0.2) score = Math.max(score, 0.92);
  } else {
    score = (breakdown.name_overlap * 0.4) + (breakdown.city_match * 0.15)
      + (breakdown.proximity * 0.25) + (breakdown.schedule_match * 0.2)
      + (breakdown.exact_url_match * 0.1); // same page: a hint, never identity
  }

  return { score: Math.min(1, Math.round(score * 1000) / 1000), breakdown };
}

const DIFF_FIELD_LABELS: Record<string, string> = {
  one_time_date: 'תאריך', start_time: 'שעת התחלה', end_time: 'שעת סיום',
  price_amount: 'מחיר', price_type: 'סוג מחיר', location_name: 'מיקום', city: 'עיר', address: 'כתובת',
  min_age: 'גיל מינימלי', max_age: 'גיל מקסימלי', description: 'תיאור',
  booking_requirement: 'זמינות/הזמנה', has_image: 'תמונה', name: 'שם',
  occurrences: 'מועדים', schedule_type: 'סוג לוח זמנים', event_key: 'זהות אירוע', registration_url: 'קישור הרשמה', entity_type: 'סוג ישות',
};

// an address the record only DERIVED (reverse geocode / centroid) may be replaced by the official page's
const DERIVED_ADDRESS = /^(cleaner:reverse_geocode|geocode:)/;

export interface DiffEntry { label: string; before: unknown; after: unknown }

// משווה רק את השדות שהמשתמש פירט (תאריך/שעה/מחיר/מיקום/גילאים/תיאור/תמונה/קישור/זמינות) -
// מחזיר רק שדות שבאמת שונים, לא את כל הרשומה.
// fields that count as ENRICHMENT (evidence the record lacks) as opposed to wording variance
const ENRICHMENT_FIELDS = new Set(['occurrences', 'schedule_type', 'entity_type', 'price_amount', 'price_type', 'address', 'min_age', 'max_age', 'has_image', 'event_key', 'registration_url']);

// deno-lint-ignore no-explicit-any
export function computeFieldDiff(candidate: any, existing: ExistingActivity, opts: { enrichmentOnly?: boolean } = {}): Record<string, DiffEntry> {
  const full = computeFieldDiffAll(candidate, existing);
  if (!opts.enrichmentOnly) return full;
  const out: Record<string, DiffEntry> = {};
  for (const [k, v] of Object.entries(full)) {
    if (!ENRICHMENT_FIELDS.has(k)) continue;
    // enrichment fills a GAP: never proposes replacing a known price (a record priced 'free' is known) or age
    if (['price_amount', 'price_type'].includes(k) && existing.price_type != null) continue;
    if (['min_age', 'max_age'].includes(k) && v.before != null) continue;
    out[k] = v;
  }
  return out;
}

// deno-lint-ignore no-explicit-any
function computeFieldDiffAll(candidate: any, existing: ExistingActivity): Record<string, DiffEntry> {
  const diff: Record<string, DiffEntry> = {};
  // A less-detailed page must never ERASE known data: a candidate that simply lacks a field is not a
  // change (applyIncomingUpdate applies `after` verbatim, so null here would wipe price/ages on approve).
  const compare = (key: string, before: unknown, after: unknown) => {
    if (after == null) return;
    if (before === after) return;
    diff[key] = { label: DIFF_FIELD_LABELS[key] || key, before, after };
  };

  // OCCURRENCES: when either side knows several dated performances, a date difference is "new
  // occurrences", never a rewrite of "the" date (that used to overwrite an arbitrary schedule row).
  const cOcc: { date: string; start_time: string | null; end_time: string | null }[] = Array.isArray(candidate.occurrences) ? candidate.occurrences : [];
  const eOcc = existing.occurrences || [];
  const multi = cOcc.length >= 2 || eOcc.length >= 2;
  if (multi) {
    const before = eOcc.map((o) => `${o.date}${o.start_time ? ' ' + o.start_time : ''}`);
    const have = new Set(eOcc.map((o) => `${o.date}|${o.start_time || ''}`));
    const cAll = cOcc.length ? cOcc : (candidate.one_time_date ? [{ date: candidate.one_time_date, start_time: candidate.start_time ? String(candidate.start_time).slice(0, 5) : null, end_time: candidate.end_time ? String(candidate.end_time).slice(0, 5) : null }] : []);
    const added = cAll.filter((o) => !have.has(`${o.date}|${o.start_time || ''}`));
    if (added.length) diff.occurrences = { label: DIFF_FIELD_LABELS.occurrences, before, after: added.map((o) => `${o.date}${o.start_time ? ' ' + o.start_time : ''}`) };
    // a listing-side 'recurring' misread corrected by explicit dated performances on the event's page:
    // only from a detail page, only for <= 2 weekday rows, only when the time agrees
    if (candidate.detail_url && cOcc.length >= 2 && (existing.recurring_days || []).length > 0 && (existing.recurring_days || []).length <= 2 && !eOcc.length
      && existing.start_time && cOcc.some((o) => o.start_time === String(existing.start_time).slice(0, 5))) {
      diff.schedule_type = { label: DIFF_FIELD_LABELS.schedule_type, before: 'recurring', after: 'one_time' };
      // dated, ticketed performances are an EVENT: the class / recurring-event label goes with the conversion
      if (candidate.entity_type === 'אירוע' && existing.entity_type && existing.entity_type !== 'אירוע') diff.entity_type = { label: DIFF_FIELD_LABELS.entity_type, before: existing.entity_type, after: 'אירוע' };
    }
  } else {
    compare('one_time_date', existing.one_time_date, candidate.one_time_date);
    compare('start_time', existing.start_time, candidate.start_time);
    compare('end_time', existing.end_time, candidate.end_time);
  }
  compare('price_amount', existing.price_amount, candidate.price_amount);
  compare('price_type', existing.price_type, candidate.price_type);
  compare('location_name', existing.location_name, candidate.location_name);
  compare('city', existing.city, normalizeCityName(candidate.city || null));
  // a later scan that SEES a street address surfaces it as an update: when the record has none, or when
  // the record's address was only derived and the candidate's comes from the event's official page
  if (candidate.address && (!existing.address || (candidate.address_source === 'monster:detail' && DERIVED_ADDRESS.test(existing.address_source || '') && candidate.address !== existing.address))) compare('address', existing.address ?? null, candidate.address);
  if (candidate.event_key && !existing.event_key) compare('event_key', null, candidate.event_key);
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
