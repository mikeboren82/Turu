// TuRu - "מקורות מידע": הפונקציה שסורקת מקור אחד (seed URL + עד כמה דפי-רשימה שהתגלו באותו
// דומיין), מחלצת פעילויות (רק מדפים ששונו מאז הסריקה הקודמת - ראו _shared/hashing.ts), מזהה
// חדש/עדכון/כפילות מול המאגר הקיים, ומטמינה הכל בתור incoming_activities לבדיקת מנהל -
// חוץ ממועמד *חדש* בביטחון גבוה (autoApproveEligible למטה: מקור מהימן + אין שדות-חובה חסרים +
// תאריך סביר), שנכתב ישירות ל-activities/locations כ-status='approved'.
//
// 2026-09-13 (platform audit): כל פעילות שנוצרת כאן מקבלת source_id + venue_id + event_fingerprint
// + שורת activity_sources ('created'); כל התאמה לפעילות קיימת מקבלת שורת activity_sources
// ('seen'/'updated') במקום להיות רק שורת-כפילות בתור. בריאות המקור מנוהלת ע"י _shared/sourceHealth.ts
// (failing -> backed_off -> attention_required -> auto_paused, לעולם לא "נעלם בשקט").
//
// מופעלת דרך HTTP POST {source_id} - או ע"י _dispatch_source_scan (מה-scheduler, pg_cron+
// pg_net) או ישירות מכלי הניהול (כפתור "סרוק עכשיו"). אימות: נדרש JWT עם role=service_role.

import { createClient } from 'npm:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk@0.32';
import * as cheerio from 'npm:cheerio@1.0.0';
import {
  buildExtractionSystemPrompt, extractCandidateImages, parseExtractionResponse,
  filterPastOneTimeActivities, isPlausibleEventDate, looksLikeStaleRepost, fetchHtml, pageTextForExtraction,
  assessChildRelevance, AUDIENCE_VALUES, cheapPageText, cheapDiscoverLinks, HEAVY_HTML_BYTES,
  EXTRACTION_MODEL, EXTRACTION_MAX_TOKENS, PAGE_TEXT_CHAR_LIMIT, MAX_TEXT_CHUNKS, splitTextForExtraction,
  CATEGORY_VALUES, REGION_VALUES, WEATHER_VALUES, AMENITIES_VALUES,
  FAMILY_FIT_VALUES, ENTITY_TYPE_VALUES, PRICE_TYPE_VALUES, INDOOR_OUTDOOR_VALUES, BOOKING_VALUES,
  ARCHIVE_CATEGORIES,
} from '../_shared/extraction.ts';
import { discoverListingLinks } from '../_shared/discovery.ts';
import { extractJsonLdEvents, applyJsonLdToCandidate, type JsonLdEvent } from '../_shared/jsonld.ts';
import { findEventDetailLinks, findEventDetailLinksCheap, detailLinkFor, sharedLinkUrls, type DetailLink, type DetailMatch, type DetailTraversalConfig } from '../_shared/detailLinks.ts';
import { extractDetailEvidence, applyDetailEvidence, detailPageNamesCandidate } from '../_shared/detailEvidence.ts';
import { parseSitemapUrls, orderForIncrementalScan, isSitemapIndex, type SitemapConfig } from '../_shared/sitemap.ts';
import { enumerateListingCards, cardAccounting, cardWindows, cardsLookLikeEvents, type ListingCard } from '../_shared/listingCards.ts';
// EVENT identity (stable across occurrences) - see eventIdentity.ts. event_fingerprint below stays the
// LEGACY first-occurrence fingerprint used only for the exact pre-checks.
import { computeEventKey, findEventMatch, type EventKeyKind } from '../_shared/eventIdentity.ts';
import { fetchJsonApiText, type JsonApiConfig } from '../_shared/adapters.ts';
import { computeContentHash } from '../_shared/hashing.ts';

// Largest HTML document we are willing to parse per page (see the CPU-guard note in the page loop).
const MAX_HTML_BYTES = 1_500_000;
import { geocodeAddress } from '../_shared/geocoding.ts';
import {
  findSimilarActivities, computeConfidence, computeFieldDiff, getConfidenceThresholds, computeEventFingerprint,
  mapExistingRow, EXISTING_ACTIVITY_SELECT, normalizeForMatch, type ExistingActivity,
} from '../_shared/matching.ts';
import { generatePlaygroundDisplayName } from '../_shared/playgroundNaming.ts';
import { normalizeCityName } from '../_shared/cityNaming.ts';
import { classifyPlaceholderGroup } from '../_shared/placeholderGroup.ts';
import { resolveVenue } from '../_shared/venues.ts';
import {
  readHealthSettings, nextSourceHealthOnFailure, healthOnSuccess, worstFailureKind, type FailureKind,
} from '../_shared/sourceHealth.ts';

type Client = ReturnType<typeof createClient>;

// TuRu מציגה רק פעילויות שאפשר להגיע אליהן מתי שרוצים בלי הרשמה/התחייבות מראש (אותו כלל בדיוק
// כמו shouldArchiveForCommitment ב-tools/import-tool/server.js). מדלגים כבר בזמן הסריקה.
const ARCHIVE_ENTITY_TYPES = new Set(['פעילות']);
function isCommitmentActivity(candidate: { entity_type: unknown; category: unknown }): boolean {
  return ARCHIVE_ENTITY_TYPES.has(candidate.entity_type as string) || ARCHIVE_CATEGORIES.includes(candidate.category as string);
}

// HIGH confidence only (2026-09-13, supersedes the 2026-09-11 "anything with an address" rule per
// the platform brief: "low-confidence records should not be blindly auto-published"):
//   (1) the SOURCE is trusted: is_trusted, or source_trust_score >= auto_approve_min_trust_score;
//   (2) sanitizeCandidate found no missing required field;
//   (3) city + location_name present (needed to create a verified location);
//   (4) one-time events carry a real date within [today, today+event_max_days_ahead];
//   (5) the item does not look like an old post re-imported as a future event.
// Everything else lands in the review queue with its confidence/trust visible to the admin.
interface AutoApproveGate { minTrust: number; maxDaysAhead: number; today: string }
function autoApproveEligible(candidate: Record<string, unknown>, issues: string[], source: { is_trusted: boolean | null; source_trust_score: number | null }, gate: AutoApproveGate): boolean {
  const trusted = !!source.is_trusted || (source.source_trust_score != null && Number(source.source_trust_score) >= gate.minTrust);
  if (!trusted || issues.length > 0 || !candidate.city || !candidate.location_name) return false;
  if (candidate.schedule_type === 'one_time' && !isPlausibleEventDate(candidate.one_time_date as string | null, gate.today, gate.maxDaysAhead)) return false;
  if (looksLikeStaleRepost(candidate as { schedule_type?: string | null; one_time_date?: string | null; source_published_date?: string | null }, gate.today)) return false;
  return true;
}

// מקביל-בפועל ל-saveNewActivity ב-tools/import-tool/server.js (אותה תוצאה: location+activity+
// schedules+images) אבל ל-Deno, ובלי חיפוש-תמונה-אוטומטי/אתר-רשמי (דורשים SERPAPI).
async function autoApproveNewActivity(
  client: Client, createdBy: string | null, sourceId: string, pageUrl: string, candidate: Record<string, unknown>,
): Promise<{ id: string; lat: number | null; lng: number | null }> {
  candidate = { ...candidate, city: normalizeCityName(candidate.city as string | null) };
  let locationId: string | null = null;
  let createdNewLocation = false;
  const locationName = candidate.location_name as string;
  const venueId = (candidate.venue_id as string | null) ?? null;

  // A canonical venue with coordinates is the best possible location - reuse/create the location row
  // from the venue itself so every event at that venue shares one address row.
  // the best address available at ingestion: what the page said, else the canonical venue's address
  const venueRow = candidate.venue as { lat: number | null; lng: number | null; city: string | null; address?: string | null } | undefined;
  const candAddress = (candidate.address as string | null) || null;
  const bestAddress = candAddress || venueRow?.address || null;
  // an address read from the event's own DETAIL page (official source) is HIGH; the listing extractor's is MEDIUM
  const fromDetail = candidate.address_source === 'monster:detail';
  const addressProv = candAddress ? { address_source: fromDetail ? 'monster:detail' : 'monster:extracted', address_confidence: fromDetail ? 'HIGH' : 'MEDIUM' } : venueRow?.address ? { address_source: 'monster:venue', address_confidence: 'HIGH' } : {};
  // an existing location row is matched by venue, else by name WITHIN THE SAME CITY (a global name
  // match bound "ספריית העיר" to another city's row - Cleaner audit 2026-09-14)
  const locQuery = venueId
    ? client.from('locations').select('id, city, region, lat, lng, address').eq('venue_id', venueId)
    : client.from('locations').select('id, city, region, lat, lng, address').ilike('name', locationName).eq('city', candidate.city as string);
  const { data: existingLoc } = await locQuery.limit(1).maybeSingle();
  if (existingLoc) {
    locationId = (existingLoc as { id: string }).id;
    const fillIn: Record<string, unknown> = {};
    if (!(existingLoc as { city: unknown }).city && candidate.city) fillIn.city = candidate.city;
    if (!(existingLoc as { region: unknown }).region && candidate.region) fillIn.region = candidate.region;
    if (!(existingLoc as { address: unknown }).address && bestAddress) { fillIn.address = bestAddress; Object.assign(fillIn, addressProv, { address_resolved_at: new Date().toISOString() }); }
    if (Object.keys(fillIn).length > 0) await client.from('locations').update(fillIn).eq('id', locationId);
  } else {
    const { data: createdLoc, error: locErr } = await client
      .from('locations')
      .insert({
        name: locationName, city: candidate.city || venueRow?.city || null, region: candidate.region || null,
        address: bestAddress, ...addressProv, address_resolved_at: bestAddress ? new Date().toISOString() : null,
        lat: venueRow?.lat ?? null, lng: venueRow?.lng ?? null, venue_id: venueId,
      })
      .select('id').single();
    if (locErr) throw locErr;
    locationId = (createdLoc as { id: string }).id;
    createdNewLocation = true;
  }
  // שער-חובה: "לעולם לא נכנסת פעילות למאגר אם אין כתובת" - geocode רק אם אין עדיין קואורדינטות.
  const { data: locRow } = await client.from('locations').select('lat, lng, address, name, city').eq('id', locationId).maybeSingle();
  let hasCoords = !!(locRow && (locRow as { lat: unknown }).lat != null);
  let finalLat = (locRow as { lat: number | null } | null)?.lat ?? null;
  let finalLng = (locRow as { lng: number | null } | null)?.lng ?? null;
  if (locRow && !hasCoords) {
    const l = locRow as { address: string | null; name: string | null; city: string | null };
    // JSON-LD geo on the page (candidate.lat/lng from applyJsonLdToCandidate) is verified structured data
    const ldLat = candidate.lat as number | null, ldLng = candidate.lng as number | null;
    if (ldLat != null && ldLng != null) {
      await client.from('locations').update({ lat: ldLat, lng: ldLng }).eq('id', locationId).is('lat', null);
      hasCoords = true; finalLat = ldLat; finalLng = ldLng;
    }
    const query = [l.address, l.name, l.city].filter(Boolean).join(', ') || l.city;
    if (!hasCoords && query) {
      const coords = await geocodeAddress(query);
      if (coords) {
        await client.from('locations').update({ lat: coords.lat, lng: coords.lng }).eq('id', locationId);
        hasCoords = true; finalLat = coords.lat; finalLng = coords.lng;
      }
    }
  }
  if (!hasCoords) {
    if (createdNewLocation) await client.from('locations').delete().eq('id', locationId);
    throw new Error(`לא נמצאה כתובת מאומתת למקום "${locationName}"`);
  }

  let finalName = candidate.name as string;
  let nameSource: string | null = null;
  let originalSourceName: string | null = null;
  if (candidate.category === 'גן שעשועים') {
    const l = locRow as { address: string | null; city: string | null } | null;
    const naming = generatePlaygroundDisplayName({ officialName: finalName, address: l?.address ?? null, city: l?.city ?? null });
    if (naming.name && naming.name !== finalName) { originalSourceName = finalName || null; finalName = naming.name; nameSource = naming.nameSource; }
    else nameSource = 'official';
  }

  const hasRealImage = Array.isArray(candidate.images) && (candidate.images as unknown[]).length > 0;
  const placeholderGroup = hasRealImage
    ? null
    : classifyPlaceholderGroup({ category: candidate.category as string | null, name: finalName, description: candidate.description as string | null });

  const { data: savedActivity, error: actErr } = await client
    .from('activities')
    .insert({
      name: finalName, name_source: nameSource, original_source_name: originalSourceName,
      description: candidate.description || null, entity_type: candidate.entity_type,
      location_id: locationId, location_detail: candidate.location_detail || null,
      min_age: candidate.min_age ?? null, max_age: candidate.max_age ?? null,
      price_type: candidate.price_type || null, price_amount: candidate.price_amount ?? null,
      category: candidate.category || null, placeholder_group: placeholderGroup, duration_minutes: candidate.duration_minutes ?? null,
      indoor_outdoor: candidate.indoor_outdoor || null, booking_requirement: candidate.booking_requirement || null,
      weather_suitable: candidate.weather_suitable || [], amenities: candidate.amenities || [],
      family_fit: candidate.family_fit || [], status: 'approved', source: 'scraped',
      source_url: pageUrl || null, source_id: sourceId, venue_id: venueId,
      // LEGACY first-occurrence fingerprint (exact pre-check); event_key = the stable EVENT identity
      event_fingerprint: (candidate.event_fingerprint as string | null) ?? null,
      event_key: (candidate.event_key as string | null) ?? null, event_key_kind: (candidate.event_key_kind as string | null) ?? null,
      organizer_name: (candidate.organizer_name as string | null) || null,
      // registration_url = an explicit booking/registration action only (never the detail page)
      official_url: (candidate.registration_url as string | null) || null,
      created_by: createdBy, last_seen_at: new Date().toISOString(),
    })
    .select('id').single();
  if (actErr) throw actErr;
  const activityId = (savedActivity as { id: string }).id;

  const scheduleRows: Record<string, unknown>[] = [];
  const occurrences = Array.isArray(candidate.occurrences) ? (candidate.occurrences as { date: string; start_time: string | null; end_time: string | null; external_id?: string | null; booking_url?: string | null }[]) : [];
  if (candidate.schedule_type === 'recurring' && Array.isArray(candidate.recurring_days) && (candidate.recurring_days as unknown[]).length) {
    for (const day of candidate.recurring_days as string[]) {
      scheduleRows.push({ activity_id: activityId, schedule_type: 'recurring', day_of_week: day, start_time: candidate.start_time || null, end_time: candidate.end_time || null });
    }
  } else if (candidate.schedule_type === 'one_time' && occurrences.length) {
    // one row per OCCURRENCE, each with its own time / provider id / purchase link (unique on date+time)
    const seen = new Set<string>();
    for (const o of occurrences) {
      if (!o.date || seen.has(`${o.date}|${o.start_time || ''}`)) continue; seen.add(`${o.date}|${o.start_time || ''}`);
      scheduleRows.push({ activity_id: activityId, schedule_type: 'one_time', one_time_date: o.date, start_time: o.start_time || null, end_time: o.end_time || null, external_id: o.external_id || null, booking_url: o.booking_url || null });
    }
  } else if (candidate.schedule_type === 'one_time') {
    scheduleRows.push({ activity_id: activityId, schedule_type: 'one_time', one_time_date: candidate.one_time_date || null, start_time: candidate.start_time || null, end_time: candidate.end_time || null });
  } else if (candidate.schedule_type === 'fixed_hours') {
    scheduleRows.push({ activity_id: activityId, schedule_type: 'fixed_hours', start_time: candidate.start_time || null, end_time: candidate.end_time || null });
  }
  if (scheduleRows.length) await client.from('activity_schedules').insert(scheduleRows);

  const images = (candidate.images as { url: string; source_type?: string; needs_rights_review?: boolean }[])
    .filter((img) => img && typeof img.url === 'string' && img.url.trim())
    .slice(0, 3)
    .map((img) => ({
      activity_id: activityId, url: img.url, uploaded_by: createdBy,
      image_source_url: img.url, image_source_type: img.source_type || 'UNKNOWN',
      needs_rights_review: !!img.needs_rights_review,
    }));
  if (images.length) await client.from('activity_images').insert(images);

  return { id: activityId, lat: finalLat, lng: finalLng };
}

// Provenance row for every detection (created / seen / updated) - idempotent on (activity, page_url).
// url_role (0091) says WHAT the page is: 'listing' (discovery/calendar page), 'detail' (the event's own
// page), 'booking', 'other'. A listing URL is never event identity; only a verified detail URL may be.
type UrlRole = 'listing' | 'detail' | 'booking' | 'other';
async function recordProvenance(client: Client, params: { activityId: string; sourceId: string; pageUrl: string; incomingId: string | null; relation: 'created' | 'seen' | 'updated'; urlRole?: UrlRole }) {
  const now = new Date().toISOString();
  // URL ROLES reach the product (0097): provenance is admin-only, so the VERIFIED event-detail page is also
  // kept on the canonical record, fill-null. It is what the app opens when no explicit booking action is
  // known (official_url > detail_url > source_url) - never the listing, and never written into official_url.
  if (params.urlRole === 'detail' && /^https?:\/\//i.test(params.pageUrl)) {
    await client.from('activities').update({ detail_url: params.pageUrl }).eq('id', params.activityId).is('detail_url', null);
  }
  const { data: existing } = await client.from('activity_sources').select('id, relation, url_role')
    .eq('activity_id', params.activityId).eq('page_url', params.pageUrl).maybeSingle();
  if (existing) {
    // never downgrade the historical 'created' relation when the same page re-detects the activity
    const rel = (existing as { relation: string }).relation === 'created' ? 'created' : params.relation;
    const patch: Record<string, unknown> = { last_seen_at: now, relation: rel, source_id: params.sourceId };
    if (params.urlRole && !(existing as { url_role: string | null }).url_role) patch.url_role = params.urlRole;
    await client.from('activity_sources').update(patch).eq('id', (existing as { id: string }).id);
    return;
  }
  await client.from('activity_sources').insert({
    activity_id: params.activityId, source_id: params.sourceId, page_url: params.pageUrl,
    incoming_activity_id: params.incomingId, relation: params.relation, url_role: params.urlRole || null, first_seen_at: now, last_seen_at: now,
  });
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

async function loadSettings(client: Client) {
  const { data } = await client.from('automation_settings').select('key, value');
  const map: Record<string, unknown> = {};
  for (const row of data || []) map[(row as { key: string }).key] = (row as { value: unknown }).value;
  return map;
}

// ולידציה הגנתית - כל ערך לא-ברשימה נמחק לפני שהוא נשמר בכלל (לא רק מסתמכים על הפרומפט).
// deno-lint-ignore no-explicit-any
function sanitizeCandidate(raw: any, pageUrl: string): { candidate: any; issues: string[] } {
  const issues: string[] = [];
  const inList = (val: unknown, list: string[]) => (typeof val === 'string' && list.includes(val) ? val : null);
  const isoDate = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const httpUrl = (v: unknown) => { if (typeof v !== 'string') return null; try { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) ? u.toString() : null; } catch { return null; } };

  const candidate: Record<string, unknown> = {
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null,
    entity_type: inList(raw.entity_type, ENTITY_TYPE_VALUES),
    description: typeof raw.description === 'string' ? raw.description.trim() : null,
    schedule_type: inList(raw.schedule_type, ['recurring', 'one_time', 'fixed_hours']),
    recurring_days: Array.isArray(raw.recurring_days) ? raw.recurring_days.filter((d: unknown) => typeof d === 'string') : [],
    start_time: typeof raw.start_time === 'string' ? raw.start_time : null,
    end_time: typeof raw.end_time === 'string' ? raw.end_time : null,
    one_time_date: isoDate(raw.one_time_date),
    source_published_date: isoDate(raw.source_published_date),
    min_age: typeof raw.min_age === 'number' ? raw.min_age : null,
    max_age: typeof raw.max_age === 'number' ? raw.max_age : null,
    price_type: inList(raw.price_type, PRICE_TYPE_VALUES),
    price_amount: typeof raw.price_amount === 'number' ? raw.price_amount : null,
    location_name: typeof raw.location_name === 'string' && raw.location_name.trim() ? raw.location_name.trim() : null,
    location_detail: typeof raw.location_detail === 'string' ? raw.location_detail : null,
    // street address as written on the page (2026-09-14: the prompt never asked for it before - 624 of
    // 757 live activities had none, all Cleaner work); a bare city/place name is not an address
    address: typeof raw.address === 'string' && /\d/.test(raw.address) && raw.address.trim().length >= 5 ? raw.address.trim().slice(0, 200) : null,
    city: typeof raw.city === 'string' && raw.city.trim() ? normalizeCityName(raw.city) : null,
    organizer_name: typeof raw.organizer_name === 'string' && raw.organizer_name.trim() ? raw.organizer_name.trim() : null,
    registration_url: httpUrl(raw.registration_url),
    audience: inList(raw.audience, AUDIENCE_VALUES) || 'unknown',
    category: inList(raw.category, CATEGORY_VALUES),
    duration_minutes: typeof raw.duration_minutes === 'number' ? raw.duration_minutes : null,
    indoor_outdoor: inList(raw.indoor_outdoor, INDOOR_OUTDOOR_VALUES),
    booking_requirement: inList(raw.booking_requirement, BOOKING_VALUES),
    weather_suitable: Array.isArray(raw.weather_suitable) ? raw.weather_suitable.filter((v: unknown) => WEATHER_VALUES.includes(v as string)) : [],
    amenities: Array.isArray(raw.amenities) ? raw.amenities.filter((v: unknown) => AMENITIES_VALUES.includes(v as string)) : [],
    family_fit: Array.isArray(raw.family_fit) ? raw.family_fit.filter((v: unknown) => FAMILY_FIT_VALUES.includes(v as string)) : [],
    region: inList(raw.region, REGION_VALUES),
    image_urls: Array.isArray(raw.image_urls) ? raw.image_urls.filter((v: unknown) => typeof v === 'string') : [],
  };
  // פרובננס-תמונה (0047): מסמנים אם התמונה מהדומיין של המקור עצמו או ממקור חיצוני (needs_rights_review).
  candidate.images = (candidate.image_urls as string[]).map((url) => {
    let sourceType = 'UNKNOWN';
    try {
      const imgHost = new URL(url).hostname.replace(/^www\./, '');
      const pageHost = new URL(pageUrl).hostname.replace(/^www\./, '');
      sourceType = imgHost === pageHost ? 'ORIGINAL_SOURCE' : 'EXTERNAL_SOURCE';
    } catch { /* URL לא תקין - נשאר UNKNOWN */ }
    return { url, source_type: sourceType, needs_rights_review: sourceType === 'EXTERNAL_SOURCE' };
  });

  if (!candidate.name) issues.push('שם');
  if (!candidate.entity_type) issues.push('סוג ישות');
  if (!candidate.category) issues.push('קטגוריה');
  // 'מחיר' is a SOFT flag: shown to the admin, but an unknown price stays null (never invented) and
  // must not by itself keep an otherwise HIGH-confidence item out of the catalogue - 496 of the
  // first 569 scanned events had only this "issue". See gatingIssues() below.
  if (!candidate.price_type) issues.push('מחיר');
  if (!candidate.one_time_date && candidate.schedule_type === 'one_time') issues.push('תאריך');
  if (!candidate.city) issues.push('עיר');

  return { candidate, issues };
}

const SOFT_ISSUES = new Set(['מחיר']);
function gatingIssues(issues: string[]): string[] {
  return issues.filter((i) => !SOFT_ISSUES.has(i));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  // אימות: ה-gateway כבר וידא חתימה; בודקים כאן את claim ה-role בתוך ה-payload (service_role בלבד).
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  let role: string | undefined;
  try {
    let payloadB64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (payloadB64.length % 4 !== 0) payloadB64 += '=';
    role = JSON.parse(atob(payloadB64)).role;
  } catch { /* טוקן לא תקין */ }
  if (role !== 'service_role') return jsonResponse({ error: 'unauthorized' }, 401);

  // relay_pages (optional, 0081): pages already fetched + text-extracted by tools/import-tool/
  // relay-scan.js for sources whose sites block cloud IPs. Same pipeline from the hash step on.
  // A relayed page may also be an event DETAIL page (kind 'detail', parent_url = its listing page, html =
  // the raw page): it is EVIDENCE for the listing candidate of the same name, never a page of its own -
  // one canonical owner per event (relay-scan.js buildPages).
  interface RelayPage { url: string; text: string; hash: string; images?: { url: string; alt: string; context: string }[]; kind?: 'listing' | 'detail'; parent_url?: string; link_text?: string; html?: string }
  let body: { source_id?: string; relay_pages?: RelayPage[] };
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid body' }, 400); }
  if (!body.source_id) return jsonResponse({ error: 'missing source_id' }, 400);
  const relayAll = Array.isArray(body.relay_pages) && body.relay_pages.length
    ? body.relay_pages.filter((p) => p && typeof p.url === 'string' && (p.kind === 'detail' ? typeof p.html === 'string' : (typeof p.text === 'string' && typeof p.hash === 'string')))
    : null;
  const relayDetailPages = (relayAll || []).filter((p) => p.kind === 'detail' && p.parent_url);
  const relayListingPages = relayAll ? relayAll.filter((p) => p.kind !== 'detail') : null;
  const relayPages = relayListingPages && relayListingPages.length ? relayListingPages : (relayAll && relayAll.length ? [] : null);

  const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const { data: source, error: sourceErr } = await client.from('sources').select('*').eq('id', body.source_id).maybeSingle();
  if (sourceErr || !source) return jsonResponse({ error: 'source not found' }, 404);
  if (!source.is_active) return jsonResponse({ error: 'source is not active' }, 200);

  const settings = await loadSettings(client);
  const maxPages = Number(settings.max_discovered_pages_per_source ?? 8);
  const maxActivitiesPerScan = Number(settings.max_activities_per_scan ?? 50);
  const maxAiRequests = Number(settings.max_ai_requests_per_scan ?? 20);
  const fetchTimeoutMs = Number(settings.fetch_timeout_ms ?? 15000);
  const retryCount = Number(settings.page_retry_count ?? 1);
  const missingThreshold = Number(settings.missing_scan_threshold ?? 3);
  const thresholds = getConfidenceThresholds(settings);
  const healthSettings = readHealthSettings(settings);
  const todayStr = new Date().toISOString().slice(0, 10);
  const gate: AutoApproveGate = {
    minTrust: Number(settings.auto_approve_min_trust_score ?? 80),
    maxDaysAhead: Number(settings.event_max_days_ahead ?? 180),
    today: todayStr,
  };

  // A previous invocation for this source that never finished (log still 'running' after 10 min)
  // was killed by the runtime (CPU/time limit). Close it as an error and apply the health transition
  // NOW, before this run - otherwise a source that dies every time never reaches finalizeSource,
  // never backs off, and is re-dispatched every hour forever (observed live: Azrieli pages, 2MB each).
  {
    const staleCutoff = new Date(Date.now() - 10 * 60_000).toISOString();
    const { data: stale } = await client.from('source_scan_logs').select('id')
      .eq('source_id', source.id).eq('status', 'running').lt('started_at', staleCutoff);
    if (stale && stale.length) {
      await client.from('source_scan_logs').update({
        status: 'error', finished_at: new Date().toISOString(), error_type: 'other', failure_kind: 'unknown',
        error_message: 'scan did not finish - killed by the runtime (page too heavy / time limit)',
      }).in('id', stale.map((s) => (s as { id: string }).id));
      const failures = (source.consecutive_failures || 0) + 1;
      const t = nextSourceHealthOnFailure({
        consecutiveFailures: failures, failureKind: 'unknown', priority: Number(source.priority ?? 5),
        baseFrequencyHours: Number(source.scan_frequency_hours), settings: healthSettings,
      });
      await client.from('sources').update({
        consecutive_failures: failures, last_failure_kind: 'unknown', health_status: t.healthStatus, is_active: t.isActive,
        disabled_reason: t.disabledReason, last_scan_error: 'previous scan was killed by the runtime',
        next_scan_at: new Date(Date.now() + t.nextScanDelayHours * 3600 * 1000).toISOString(),
        scan_errors_total: (source.scan_errors_total || 0) + 1,
      }).eq('id', source.id);
      source.consecutive_failures = failures;
      source.scan_errors_total = (source.scan_errors_total || 0) + 1;
    }
  }

  const { data: logRow } = await client
    .from('source_scan_logs').insert({ source_id: source.id, status: 'running' }).select('id').single();
  const scanLogId = logRow?.id as string;

  const counters = {
    pagesChecked: 0, pagesChanged: 0, pagesUnchanged: 0, aiCalls: 0,
    found: 0, newCount: 0, updatedCount: 0, duplicateCount: 0, rejectedCount: 0,
    missingCount: 0, errorCount: 0, autoApprovedCount: 0, repairedResponses: 0,
  };
  let errorType: string | null = null;
  let errorMessage: string | null = null;
  const failureKinds: FailureKind[] = [];
  const matchedExistingIds = new Set<string>();
  const cityCache = new Map<string, ExistingActivity[]>();
  const venueCache = new Map<string, Awaited<ReturnType<typeof resolveVenue>>>();
  // Fingerprints already handled in THIS scan (a page can list the same event twice; two pages of one
  // source can repeat it) - the second occurrence must not become a second queue row.
  const seenFingerprints = new Set<string>();
  const seenEventKeys = new Set<string>(); // EVENT keys handled in this scan (one queue row per event)

  // Adapter-controlled bounded DETAIL TRAVERSAL (2026-09-14): sources.adapter_config.detail_traversal =
  // { max_pages, allow_hosts }. A listing card names the event; its detail page carries the address,
  // JSON-LD, image, price and ages. Deterministic evidence only (no extra AI call), merged fill-null
  // into the listing candidate, both URLs kept in provenance. Absent config => nothing changes.
  const detailCfg = ((source.adapter_config || {}) as { detail_traversal?: DetailTraversalConfig }).detail_traversal || null;
  const detailMaxPerPage = Math.min(Number(detailCfg?.max_pages || 0), 12);
  const DETAIL_MAX_PER_SCAN = 24; // hard cap per invocation regardless of config
  // a heavy listing's AI extraction alone can use the 60 s page budget; detail fetches (8 s each, no AI)
  // get their own ceiling that still stays well under the ~150 s edge kill
  const DETAIL_TIME_BUDGET_MS = 105_000;
  const detail = { links: 0, attempted: 0, fetched: 0, failed: 0, unchanged: 0, relay_primed: 0, shared_links: 0, rejected_title_mismatch: 0, filled: {} as Record<string, number>, ms: 0, failed_by: {} as Record<string, number>, ms_ok_max: 0, ms_fail_max: 0, failed_sample: [] as { url: string; kind: string; ms: number }[], unmatched: [] as { name: string; links: string[] }[] };
  // detail evidence per URL for this scan (null = fetched and failed / rejected: never retried in-scan);
  // relayed detail pages are primed lazily from their raw html (the candidate's city anchors the address parse)
  const detailCache = new Map<string, ReturnType<typeof extractDetailEvidence> | null>();
  const relayDetailHtml = new Map<string, string>();
  const relayDetailLinks = new Map<string, DetailLink[]>();
  for (const p of relayDetailPages) {
    const parent = (p.parent_url as string).split('#')[0];
    if (!relayDetailLinks.has(parent)) relayDetailLinks.set(parent, []);
    relayDetailLinks.get(parent)!.push({ url: p.url.split('#')[0], text: (p.link_text || '').slice(0, 160), method: 'detail_text' });
    relayDetailHtml.set(p.url.split('#')[0], (p.html as string).slice(0, MAX_HTML_BYTES));
    detail.relay_primed++;
  }
  const relayDetailEnabled = relayDetailPages.length > 0;

  const scanStartedAt = Date.now();
  // Budget after which no NEW page/window is started. One extraction call on a dense listing window
  // can itself take ~60s (dozens of events => long output), and the edge runtime kills invocations
  // near 150s wall-clock (observed 2026-09-13: Holon's 4-window page left the log stuck 'running').
  // 60s + one in-flight call stays under that; whatever is deferred runs on the next scan.
  const SCAN_TIME_BUDGET_MS = 60_000;

  // DENSE-LISTING RECALL FUNNEL (wave 2): DOM cards detected -> extractor output -> past filter ->
  // accounted cards -> bounded recovery -> rejections / folding / cap. Stored per scan in
  // source_scan_logs.listing_metrics (0095) so recall is a number, not an impression.
  const listing = { pages_with_cards: 0, cards_detected: 0, ai_returned: 0, past_filtered: 0, cards_matched: 0, cards_unaccounted: 0, recovery_calls: 0, recovered: 0, rejected_no_name: 0, rejected_commitment: 0, rejected_adult: 0, twins_folded: 0, capped: 0, skipped_in_scan_duplicate: 0, skipped_pending_in_queue: 0, identity_backfilled: 0, updates_superseded: 0, recovery_error: null as string | null, recovery_skipped: null as string | null, sitemap: null as null | { entities: number; never_scanned: number; picked: number; error?: string }, sample_unaccounted: [] as string[] };
  const RECOVERY_MAX_CARDS = 12;
  const RECOVERY_TIME_LIMIT_MS = 100_000;

  // WHY a detail fetch failed, and how long fetches take (wave 2): "6 timeouts" told nothing - the same
  // pages answer a local IP in < 1.5 s, so an edge-side timeout / 403 is an ACCESS class (geo / WAF), which
  // is fixed by relaying that source's detail pages, never by a longer global timeout.
  const noteDetailFetch = (dr: { ok?: boolean; html?: string | null; failureKind?: string | null; fetchError?: string | null } | null, ms: number, url = '') => {
    if (dr && dr.ok && dr.html) { detail.ms_ok_max = Math.max(detail.ms_ok_max, ms); return; }
    detail.ms_fail_max = Math.max(detail.ms_fail_max, ms);
    const kind = dr?.failureKind || (/abort|timeout/i.test(dr?.fetchError || '') ? 'timeout_network' : 'unknown');
    detail.failed_by[kind] = (detail.failed_by[kind] || 0) + 1;
    if (detail.failed_sample.length < 6) detail.failed_sample.push({ url: url.slice(0, 160), kind, ms });
  };

  async function persistProgress() {
    await client.from('source_scan_logs').update({
      pages_checked: counters.pagesChecked, pages_changed: counters.pagesChanged,
      pages_unchanged: counters.pagesUnchanged, ai_calls: counters.aiCalls,
      activities_found: counters.found, new_count: counters.newCount,
      updated_count: counters.updatedCount, duplicate_count: counters.duplicateCount,
      rejected_count: counters.rejectedCount, auto_approved_count: counters.autoApprovedCount,
      detail_metrics: detailCfg ? detail : null,
      listing_metrics: (listing.pages_with_cards || listing.sitemap) ? listing : null,
    }).eq('id', scanLogId);
  }

  // Source health bookkeeping - one place for both the normal and the crashed path.
  async function finalizeSource(finalStatus: 'success' | 'partial' | 'error', failureKind: FailureKind | null, extra: Record<string, unknown>) {
    const now = new Date();
    const baseUpdate: Record<string, unknown> = {
      last_scan_at: now.toISOString(), last_scan_status: finalStatus, last_scan_error: errorMessage, ...extra,
    };
    if (finalStatus === 'error') {
      const failures = (source.consecutive_failures || 0) + 1;
      const t = nextSourceHealthOnFailure({
        consecutiveFailures: failures, failureKind: failureKind ?? 'unknown', priority: Number(source.priority ?? 5),
        baseFrequencyHours: Number(source.scan_frequency_hours), settings: healthSettings,
      });
      Object.assign(baseUpdate, {
        consecutive_failures: failures, last_failure_kind: failureKind ?? 'unknown', health_status: t.healthStatus,
        is_active: t.isActive, disabled_reason: t.disabledReason,
        next_scan_at: new Date(now.getTime() + t.nextScanDelayHours * 3600 * 1000).toISOString(),
        scan_errors_total: (source.scan_errors_total || 0) + 1,
      });
    } else {
      const ok = healthOnSuccess();
      Object.assign(baseUpdate, {
        consecutive_failures: ok.consecutiveFailures, health_status: ok.healthStatus, disabled_reason: ok.disabledReason,
        last_success_at: now.toISOString(), last_failure_kind: null, // the per-scan kind stays on source_scan_logs
        next_scan_at: new Date(now.getTime() + Number(source.scan_frequency_hours) * 3600 * 1000).toISOString(),
        scan_errors_total: (source.scan_errors_total || 0) + counters.errorCount,
      });
    }
    await client.from('sources').update(baseUpdate).eq('id', source.id);
  }

  try {
    const relayMap = new Map((relayPages || []).map((p) => [p.url, p]));
    // api_json adapter (sources.adapter_config): the listing comes from a JSON service, rendered to
    // text and handed to the page loop exactly like a relayed page (same extraction/dedup/provenance).
    const isJsonApi = source.strategy === 'api_json' && !relayPages;
    if (isJsonApi) {
      const cfg = (source.adapter_config || {}) as JsonApiConfig;
      const api = await fetchJsonApiText(cfg, source.seed_url);
      if (api.ok) {
        relayMap.set(source.seed_url, { url: source.seed_url, text: api.text, hash: await computeContentHash(api.text), images: [] });
        console.log(`json_api: ${api.count} items -> ${api.text.length} chars`);
      } else {
        counters.errorCount++;
        errorType = 'network';
        errorMessage = `json_api: ${api.error}`;
        failureKinds.push(api.status === 404 ? 'gone_404' : api.status === 403 ? 'access_403_waf' : /abort|timeout/i.test(api.error) ? 'timeout_network' : 'unknown');
      }
    }
    const seedRes = (relayPages || isJsonApi) ? { ok: false } as Awaited<ReturnType<typeof fetchHtml>> : await fetchHtml(source.seed_url, { timeoutMs: fetchTimeoutMs, retries: retryCount });
    // relayed pages arrive as <=18k parts (relay-scan.js splits long listings), so allow more of
    // them than discovered HTML pages - unchanged parts cost one hash compare and are skipped.
    let pageUrls = relayPages ? relayPages.slice(0, maxPages * 4).map((p) => p.url) : isJsonApi ? (relayMap.has(source.seed_url) ? [source.seed_url] : []) : [source.seed_url];
    if (!relayPages && !isJsonApi && seedRes.ok && seedRes.html) {
      // heavy seed pages take the DOM-free path too (see the CPU-guard note in the page loop)
      const extra = seedRes.html.length > HEAVY_HTML_BYTES
        ? cheapDiscoverLinks(seedRes.html, source.seed_url, maxPages - 1)
        : discoverListingLinks(cheerio.load(seedRes.html), source.seed_url, maxPages - 1);
      pageUrls = [source.seed_url, ...extra];
    }
    // SITEMAP DISCOVERY (wave 2): the publisher's own index replaces what a script-loaded listing hides
    // (cochav-hanofesh.com/parks: 9 of 54 parks in the HTML). Bounded + incremental - see _shared/sitemap.ts.
    const sitemapCfg = ((source.adapter_config || {}) as { sitemap?: SitemapConfig }).sitemap;
    if (!relayPages && !isJsonApi && sitemapCfg?.url) {
      const sm = await fetchHtml(sitemapCfg.url, { timeoutMs: fetchTimeoutMs, retries: retryCount });
      if (sm.ok && sm.html && !isSitemapIndex(sm.html)) {
        const entityUrls = parseSitemapUrls(sm.html, sitemapCfg.section);
        const { data: snaps } = await client.from('source_page_snapshots').select('url, last_fetched_at').eq('source_id', source.id);
        const fetchedAt = new Map<string, string | null>((snaps || []).map((r) => [(r as { url: string }).url, (r as { last_fetched_at: string | null }).last_fetched_at]));
        const { picked, neverScanned } = orderForIncrementalScan(entityUrls, fetchedAt, Math.min(12, Number(sitemapCfg.max_per_scan ?? maxPages)));
        listing.sitemap = { entities: entityUrls.length, never_scanned: neverScanned, picked: picked.length };
        if (picked.length) pageUrls = picked;
      } else {
        listing.sitemap = { entities: 0, never_scanned: 0, picked: 0, error: sm.fetchError || (sm.html && isSitemapIndex(sm.html) ? 'sitemap index (point adapter_config.sitemap.url at the section sitemap)' : 'unreadable sitemap') };
      }
    }

    for (const pageUrl of pageUrls) {
      if (counters.found >= maxActivitiesPerScan) break;
      if (Date.now() - scanStartedAt > SCAN_TIME_BUDGET_MS) {
        errorType = errorType ?? 'rate_limited'; // לא שגיאה אמיתית - דפים שנותרו יטופלו בסריקה הבאה
        break;
      }
      counters.pagesChecked++;

      try {
        const relayPage = relayMap.get(pageUrl) ?? null;
        let candidateImages: ReturnType<typeof extractCandidateImages>;
        let text: string;
        let hash: string;
        let pageJsonLd: JsonLdEvent[] = []; // structured events on this page (non-relay, non-heavy pages)
        let pageDetailLinks: DetailLink[] = []; // detail links of this listing page (adapter-controlled)
        let pageCards: ListingCard[] = []; // deterministic DOM cards of this listing page (recall funnel)
        // detail pages fetched CONCURRENTLY WITH the AI extraction (the extraction alone can use most of
        // the detail time budget on a dense listing - observed 2026-09-14: 5 of 27 links reached);
        // null = fetched and failed. Links never recorded as detail provenance go first, so rescans
        // rotate through the listing instead of refetching the same first N pages every time.
        const prefetched = new Map<string, string | null>();
        let prefetch: Promise<void> | null = null;
        if (relayPage) {
          candidateImages = (relayPage.images || []).slice(0, 40);
          text = relayPage.text.slice(0, PAGE_TEXT_CHAR_LIMIT * MAX_TEXT_CHUNKS);
          hash = relayPage.hash;
        } else {
          const res = pageUrl === source.seed_url ? seedRes : await fetchHtml(pageUrl, { timeoutMs: fetchTimeoutMs, retries: retryCount });
          if (!res.ok || !res.html) {
            counters.errorCount++;
            errorType = errorType ?? 'network';
            errorMessage = errorMessage ?? (res.fetchError || 'unknown fetch failure');
            if (res.failureKind) failureKinds.push(res.failureKind);
            continue;
          }
          // CPU guard: the edge runtime kills invocations that burn too much CPU. Observed live on
          // 2MB mall pages - the old full-DOM clone/normalize hash (hashing.ts) plus cheerio on the whole
          // document left scans stuck in 'running' forever. Cap the HTML and hash the extracted TEXT
          // instead (content changes <=> text changes; tracking attributes never mattered for that).
          const html = res.html.length > MAX_HTML_BYTES ? res.html.slice(0, MAX_HTML_BYTES) : res.html;
          // Long listing pages are extracted in up to MAX_TEXT_CHUNKS windows (see below), so keep
          // that much text instead of one window - Holon's calendar alone is ~97k chars of events.
          const textBudget = PAGE_TEXT_CHAR_LIMIT * MAX_TEXT_CHUNKS;
          if (html.length > HEAVY_HTML_BYTES) {
            // DOM-free path: no images (they would need the DOM), text via regex stripping
            candidateImages = [];
            if (detailMaxPerPage > 0) { pageDetailLinks = findEventDetailLinksCheap(html, pageUrl, { max: 40, allowHosts: detailCfg?.allow_hosts || [], urlPattern: detailCfg?.url_pattern, listingUrls: pageUrls }); detail.links += pageDetailLinks.length; }
            text = cheapPageText(html, textBudget);
          } else {
            const $ = cheerio.load(html);
            candidateImages = extractCandidateImages($, pageUrl);
            pageJsonLd = extractJsonLdEvents($);
            if (detailMaxPerPage > 0) { pageDetailLinks = findEventDetailLinks($, pageUrl, { max: 40, allowHosts: detailCfg?.allow_hosts || [], linkSelector: detailCfg?.link_selector, urlPattern: detailCfg?.url_pattern, listingUrls: pageUrls }); detail.links += pageDetailLinks.length; }
            // before pageTextForExtraction: it strips nodes from the same DOM
            try { pageCards = enumerateListingCards($, pageUrl); } catch { pageCards = []; }
            text = pageTextForExtraction($, textBudget);
          }
          hash = await computeContentHash(text);
        }
        // relayed listing page: its detail pages arrived in the same payload (kind 'detail'), already fetched
        if (relayPage && relayDetailEnabled) { pageDetailLinks = relayDetailLinks.get(pageUrl.split('#part=')[0]) || []; detail.links += pageDetailLinks.length; }

        const { data: snapshot } = await client
          .from('source_page_snapshots').select('content_hash')
          .eq('source_id', source.id).eq('url', pageUrl).maybeSingle();

        if (snapshot && snapshot.content_hash === hash) {
          counters.pagesUnchanged++;
          await client.from('source_page_snapshots').update({ last_fetched_at: new Date().toISOString() })
            .eq('source_id', source.id).eq('url', pageUrl);
          continue;
        }
        counters.pagesChanged++;

        // ה-snapshot נשמר רק **אחרי** חילוץ-AI מוצלח (למטה) - כשל-AI חד-פעמי לא יהפוך לאובדן-כיסוי קבוע.
        if (counters.aiCalls >= maxAiRequests) { errorType = errorType ?? 'rate_limited'; continue; }

        if (!text || text.length < 200) {
          // HTTP 200 with (almost) no body text = JS challenge page / WAF interstitial / client-side
          // app. Counts as a failure so the health model and the admin can see it (observed: Tel Aviv
          // municipality returned 8 such pages to the edge runtime while serving full HTML to browsers).
          counters.errorCount++;
          errorType = errorType ?? 'network';
          errorMessage = errorMessage ?? `empty page body (${text.length} chars) - JS challenge / WAF / client-rendered page`;
          failureKinds.push('access_403_waf');
          continue;
        }

        if (pageDetailLinks.length && detailMaxPerPage > 0 && !relayPage && detail.attempted < DETAIL_MAX_PER_SCAN && Date.now() - scanStartedAt < DETAIL_TIME_BUDGET_MS) {
          const urls = pageDetailLinks.map((l) => l.url);
          const { data: enrichedRows } = await client.from('activity_sources').select('page_url').eq('url_role', 'detail').in('page_url', urls);
          const enriched = new Set((enrichedRows || []).map((r) => (r as { page_url: string }).page_url));
          const ordered = [...pageDetailLinks.filter((l) => !enriched.has(l.url)), ...pageDetailLinks.filter((l) => enriched.has(l.url))];
          const pick = ordered.slice(0, Math.min(detailMaxPerPage, DETAIL_MAX_PER_SCAN - detail.attempted));
          const queue = [...pick];
          prefetch = (async () => {
            const worker = async () => {
              while (queue.length) {
                const l = queue.shift()!;
                if (Date.now() - scanStartedAt >= DETAIL_TIME_BUDGET_MS) break;
                const t0 = Date.now(); detail.attempted++;
                try {
                  const dr = await fetchHtml(l.url, { timeoutMs: Math.min(fetchTimeoutMs, 8000), retries: 0 });
                  if (dr.ok && dr.html) { detail.fetched++; prefetched.set(l.url, dr.html.length > MAX_HTML_BYTES ? dr.html.slice(0, MAX_HTML_BYTES) : dr.html); }
                  else { detail.failed++; prefetched.set(l.url, null); }
                  noteDetailFetch(dr, Date.now() - t0, l.url);
                } catch { detail.failed++; prefetched.set(l.url, null); noteDetailFetch(null, Date.now() - t0, l.url); }
                detail.ms += Date.now() - t0;
              }
            };
            await Promise.all([worker(), worker(), worker(), worker()]);
          })();
        }

        let extracted: unknown[];
        let pageTruncated = false;
        try {
          const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });
          // One extraction per text window; a long calendar yields several windows, each a separate
          // (bounded) AI call. Windows after the first stop early when the AI budget is exhausted.
          const windows = splitTextForExtraction(text);
          extracted = [];
          const returnedNames: string[] = [];
          for (let w = 0; w < windows.length; w++) {
            if (w > 0 && (counters.aiCalls >= maxAiRequests || Date.now() - scanStartedAt > SCAN_TIME_BUDGET_MS)) {
              // partial page: the snapshot is NOT saved below, so the next scan re-extracts it
              // (dedup absorbs the repeats) instead of silently losing the remaining windows
              pageTruncated = true;
              break;
            }
            const message = await anthropic.messages.create({
              model: EXTRACTION_MODEL,
              max_tokens: EXTRACTION_MAX_TOKENS,
              // deterministic extraction: rescans of an unchanged listing must yield the same candidates
              // (2026-09-14: the same 32-card page returned 15-21 events across three runs at the default)
              temperature: 0,
              system: buildExtractionSystemPrompt(),
              messages: [{
                role: 'user',
                content: `כתובת המקור: ${pageUrl}\n\nתוכן הדף${windows.length > 1 ? ` (חלק ${w + 1} מתוך ${windows.length})` : ''}:\n${windows[w]}\n\nרשימת תמונות מהעמוד:\n${JSON.stringify(w === 0 ? candidateImages : [])}`,
              }],
            });
            counters.aiCalls++;
            const raw = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
            const parsed = parseExtractionResponse(raw);
            if (parsed.repaired) counters.repairedResponses++;
            const keptNow = filterPastOneTimeActivities(parsed.activities as never[], todayStr);
            listing.ai_returned += parsed.activities.length; listing.past_filtered += parsed.activities.length - keptNow.length;
            // deno-lint-ignore no-explicit-any
            for (const a of parsed.activities as any[]) if (a && typeof a.name === 'string') returnedNames.push(a.name);
            extracted = extracted.concat(keptNow);
          }
          // recall accounting + ONE bounded recovery call: cards the extractor never mentioned are sent
          // again as whole, numbered cards (never the giant page, never a raised cap). A page where many
          // cards are unaccounted (adult-heavy venue programmes) is only measured, not re-extracted.
          if (pageCards.length >= 5 && !pageTruncated) {
            listing.pages_with_cards++; listing.cards_detected += pageCards.length;
            let acc = cardAccounting(pageCards, returnedNames);
            if (acc.unaccountedCards.length > 0 && acc.unaccountedCards.length <= RECOVERY_MAX_CARDS && cardsLookLikeEvents(pageCards) && counters.aiCalls < maxAiRequests && Date.now() - scanStartedAt < RECOVERY_TIME_LIMIT_MS) {
              const recoveryWindow = cardWindows(acc.unaccountedCards, PAGE_TEXT_CHAR_LIMIT, RECOVERY_MAX_CARDS)[0];
              try {
                const message = await anthropic.messages.create({ model: EXTRACTION_MODEL, max_tokens: EXTRACTION_MAX_TOKENS, temperature: 0, system: buildExtractionSystemPrompt(), messages: [{ role: 'user', content: `כתובת המקור: ${pageUrl}\n\nתוכן הדף (כרטיסים שלא חולצו בסבב הראשון):\n${recoveryWindow}\n\nרשימת תמונות מהעמוד:\n[]` }] });
                counters.aiCalls++; listing.recovery_calls++;
                const parsed = parseExtractionResponse(message.content.map((b) => (b.type === 'text' ? b.text : '')).join(''));
                // deno-lint-ignore no-explicit-any
                const fresh = (parsed.activities as any[]).filter((a) => a && typeof a.name === 'string' && !returnedNames.some((n) => n === a.name));
                const keptNow = filterPastOneTimeActivities(fresh as never[], todayStr);
                listing.recovered += fresh.length; listing.ai_returned += fresh.length; listing.past_filtered += fresh.length - keptNow.length;
                for (const a of fresh) returnedNames.push(a.name);
                extracted = extracted.concat(keptNow);
                acc = cardAccounting(pageCards, returnedNames);
              } catch (recErr) { listing.recovery_error = (recErr instanceof Error ? recErr.message : String(recErr)).slice(0, 160); /* best effort - the first pass already stands */ }
            }
            if (acc.unaccounted.length && !listing.recovery_calls && !listing.recovery_error) listing.recovery_skipped = acc.unaccountedCards.length > RECOVERY_MAX_CARDS ? 'too_many_unaccounted' : !cardsLookLikeEvents(pageCards) ? 'cards_not_event_like' : counters.aiCalls >= maxAiRequests ? 'ai_budget' : Date.now() - scanStartedAt >= RECOVERY_TIME_LIMIT_MS ? 'time_budget' : 'unknown';
            listing.cards_matched += acc.matched; listing.cards_unaccounted += acc.unaccounted.length;
            for (const t of acc.unaccounted) if (listing.sample_unaccounted.length < 12) listing.sample_unaccounted.push(t);
          }
        } catch (aiErr) {
          counters.errorCount++;
          errorType = errorType ?? 'ai';
          errorMessage = errorMessage ?? (aiErr instanceof Error ? aiErr.message : String(aiErr));
          failureKinds.push('parse_extraction');
          continue;
        }

        if (!pageTruncated) {
          await client.from('source_page_snapshots').upsert({
            source_id: source.id, url: pageUrl, content_hash: hash,
            last_fetched_at: new Date().toISOString(), last_changed_at: new Date().toISOString(),
          }, { onConflict: 'source_id,url' });
        } else {
          errorType = errorType ?? 'rate_limited';
        }

        if (prefetch) { try { await prefetch; } catch { /* individual failures are already counted */ } }
        // ---- pass 1: sanitize + JSON-LD + DETAIL association for every candidate of this page ----
        // deno-lint-ignore no-explicit-any
        const prepared: { candidate: any; issues: string[]; link: DetailMatch | null }[] = [];
        const pageHost = (() => { try { return new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { return ''; } })();
        const allowedHosts = new Set([pageHost, ...(detailCfg?.allow_hosts || []).map((h) => h.replace(/^www\./, ''))]);
        const detailActive = (detailMaxPerPage > 0 || relayDetailEnabled) && pageDetailLinks.length > 0;
        for (const rawCandidate of extracted) {
          const { candidate, issues } = sanitizeCandidate(rawCandidate, pageUrl);
          candidate.pageUrl = pageUrl;
          // deterministic structured data beats nothing: fill address/coordinates/date from the page's
          // JSON-LD Event with the same name (fill-null only - never over what the extractor found)
          if (pageJsonLd.length) { const filled = applyJsonLdToCandidate(candidate, pageJsonLd); if (filled.length) { candidate.jsonld_filled = filled; if (candidate.one_time_date) { const i = issues.indexOf('תאריך'); if (i >= 0) issues.splice(i, 1); } } }
          const link = detailActive ? detailLinkFor(pageDetailLinks, candidate.name as string | null, candidate.registration_url as string | null, allowedHosts) : null;
          // diagnostics for the cohort: which names found no link (first 3 per scan)
          if (detailActive && !link && detail.unmatched.length < 3) detail.unmatched.push({ name: String(candidate.name || '').slice(0, 60), links: pageDetailLinks.slice(0, 3).map((l) => (l.text || decodeURIComponent(l.url.split('/').filter(Boolean).pop() || '')).slice(0, 60)) });
          prepared.push({ candidate, issues, link });
        }
        // a link claimed by two differently-named candidates is a shared page (category / homepage), not
        // an event's page: nobody gets it
        const shared = sharedLinkUrls(prepared.filter((p) => p.link).map((p) => ({ url: p.link!.url, name: String(p.candidate.name || '') })));
        detail.shared_links += shared.size;
        // bounded detail traversal: fetch (or take the relayed html of) each associated page once, gate it
        // on naming the candidate, merge its evidence fill-null
        for (const p of prepared) {
          if (!p.link || shared.has(p.link.url)) { if (p.link) p.link = null; continue; }
          const link = p.link; const candidate = p.candidate;
          let ev = detailCache.get(link.url);
          if (ev === undefined) {
            const relayed = relayDetailHtml.get(link.url);
            const pre = prefetched.get(link.url);
            if (relayed != null) { ev = extractDetailEvidence(relayed, todayStr, { baseUrl: link.url, city: candidate.city as string | null }); detail.fetched++; }
            else if (pre != null) ev = extractDetailEvidence(pre, todayStr, { baseUrl: link.url, city: candidate.city as string | null });
            else if (pre === null) ev = null; // prefetched and failed - never retried in this scan
            else if (detailMaxPerPage <= 0 || detail.attempted >= DETAIL_MAX_PER_SCAN || Date.now() - scanStartedAt >= DETAIL_TIME_BUDGET_MS) { p.link = null; continue; }
            else if ([...detailCache.keys()].filter((u) => pageDetailLinks.some((l) => l.url === u)).length >= detailMaxPerPage) ev = null;
            else {
              const t0 = Date.now(); detail.attempted++;
              const dr = await fetchHtml(link.url, { timeoutMs: Math.min(fetchTimeoutMs, 8000), retries: 0 });
              detail.ms += Date.now() - t0; noteDetailFetch(dr, Date.now() - t0, link.url);
              if (dr.ok && dr.html) { detail.fetched++; ev = extractDetailEvidence(dr.html.length > MAX_HTML_BYTES ? dr.html.slice(0, MAX_HTML_BYTES) : dr.html, todayStr, { baseUrl: link.url, city: candidate.city as string | null }); }
              else { detail.failed++; ev = null; } // detail failure never discards the listing candidate
            }
            detailCache.set(link.url, ev);
          }
          if (!ev) { p.link = null; continue; }
          // the page must NAME the candidate before any of its evidence is trusted
          if (!detailPageNamesCandidate(ev, candidate.name as string | null)) { detail.rejected_title_mismatch++; p.link = null; continue; }
          const filled = applyDetailEvidence(candidate, ev, link.url, pageHost);
          for (const f of filled) detail.filled[f] = (detail.filled[f] || 0) + 1;
          if (filled.length && candidate.one_time_date) { const i = p.issues.indexOf('תאריך'); if (i >= 0) p.issues.splice(i, 1); }
          if (filled.includes('price')) { const i = p.issues.indexOf('מחיר'); if (i >= 0) p.issues.splice(i, 1); }
          // detail-page images go through the same provenance shape sanitizeCandidate builds
          if (filled.includes('image') && Array.isArray(candidate.images)) candidate.images = (candidate.images as { url: string; source_type: string; needs_rights_review: boolean }[]).slice(0, 3);
          candidate.detail_match = { method: link.method, score: link.score, text: link.text.slice(0, 120) };
          candidate.detail_verified = true; // card/title evidence + single claimant + page names the event
        }
        // the same event listed with several dates on ONE page (a calendar repeats a show per performance):
        // fold the later ones into the first as occurrences instead of queueing N candidates
        {
          // deno-lint-ignore no-explicit-any
          const byKey = new Map<string, any>();
          const kept: typeof prepared = [];
          for (const p of prepared) {
            const c = p.candidate;
            if (c.schedule_type !== 'one_time' || !c.name || !c.one_time_date) { kept.push(p); continue; }
            const key = `${normalizeForMatch(c.name as string)}|${normalizeForMatch((c.location_name as string) || '')}|${normalizeForMatch((c.city as string) || '')}|${String(c.start_time || '').slice(0, 5)}`;
            const first = byKey.get(key);
            if (!first) { byKey.set(key, c); kept.push(p); continue; }
            const own: { date: string; start_time: string | null; end_time: string | null }[] = Array.isArray(first.occurrences) ? first.occurrences : [{ date: first.one_time_date, start_time: first.start_time ? String(first.start_time).slice(0, 5) : null, end_time: first.end_time ? String(first.end_time).slice(0, 5) : null }];
            const seen = new Set(own.map((o) => `${o.date}|${o.start_time || ''}`));
            const mine: { date: string; start_time: string | null; end_time: string | null }[] = Array.isArray(c.occurrences) ? c.occurrences : [{ date: c.one_time_date, start_time: c.start_time ? String(c.start_time).slice(0, 5) : null, end_time: c.end_time ? String(c.end_time).slice(0, 5) : null }];
            for (const o of mine) { const k = `${o.date}|${o.start_time || ''}`; if (!seen.has(k)) { seen.add(k); own.push(o); } }
            own.sort((a, b) => (a.date + (a.start_time || '')).localeCompare(b.date + (b.start_time || '')));
            first.occurrences = own; first.one_time_date = own[0].date; if (!first.start_time && own[0].start_time) first.start_time = own[0].start_time;
            first.merged_listing_twins = (first.merged_listing_twins || 0) + 1; listing.twins_folded++;
          }
          prepared.length = 0; prepared.push(...kept);
        }

        // ---- pass 2: identity, dedup, routing, persistence ----
        for (const p of prepared) {
          if (counters.found >= maxActivitiesPerScan) { listing.capped += prepared.length - prepared.indexOf(p); break; }
          const candidate = p.candidate; const issues = p.issues;

          if (issues.length > 0 && !candidate.name) { counters.rejectedCount++; listing.rejected_no_name++; continue; }
          if (isCommitmentActivity(candidate)) { counters.rejectedCount++; listing.rejected_commitment++; continue; }
          // child-relevance gate: adult content from mixed municipal calendars never reaches the queue;
          // unclear audience is reviewable but never auto-published.
          const relevance = assessChildRelevance(candidate);
          if (relevance === 'reject') { counters.rejectedCount++; listing.rejected_adult++; continue; }
          if (relevance === 'review') issues.push('קהל יעד לא ברור');
          if (looksLikeStaleRepost(candidate, todayStr)) issues.push('תאריך פרסום ישן');

          // WHERE: canonical venue (curated aliases only - never an unsafe auto-link).
          const venueKey = `${candidate.location_name}|${candidate.city}`;
          if (!venueCache.has(venueKey)) venueCache.set(venueKey, await resolveVenue(client, { locationName: candidate.location_name, city: candidate.city }));
          const venue = venueCache.get(venueKey) ?? null;
          candidate.venue_id = venue?.id ?? null;
          candidate.venue = venue;
          if (venue) {
            if (!candidate.city && venue.city) candidate.city = normalizeCityName(venue.city);
            if (venue.lat != null) { candidate.lat = venue.lat; candidate.lng = venue.lng; }
            // the 'עיר' issue was pushed by sanitize before the venue could supply the city
            // (24 Ramot-mall items sat in review with a valid city because of it, 2026-09-13)
            if (candidate.city) { const i = issues.indexOf('עיר'); if (i >= 0) issues.splice(i, 1); }
          }
          // LEGACY occurrence-level fingerprint (first/earliest occurrence): exact pre-check only
          candidate.event_fingerprint = computeEventFingerprint({
            name: candidate.name, venueId: candidate.venue_id, city: candidate.city, scheduleType: candidate.schedule_type,
            oneTimeDate: candidate.one_time_date, recurringDays: candidate.recurring_days, startTime: candidate.start_time,
          });
          // EVENT identity, stable across occurrences (eventIdentity.ts): provider id > verified detail URL >
          // provider key > exact title + canonical venue + source (conservative fallback)
          {
            const ek = computeEventKey({ sourceId: source.id, title: candidate.name as string | null, venueId: candidate.venue_id as string | null, externalEventId: (candidate.external_event_id as string | null) || null, detailUrl: (candidate.detail_url as string | null) || null, detailVerified: !!candidate.detail_verified });
            candidate.event_key = ek?.key ?? null; candidate.event_key_kind = ek?.kind ?? null;
          }

          // Exact pre-check (the events' google_place_id): identical fingerprint already live => same event.
          let fingerprintMatchId: string | null = null;
          if (candidate.event_fingerprint) {
            // (a) same event twice within this scan => count as duplicate, no second queue row
            if (seenFingerprints.has(candidate.event_fingerprint)) { counters.duplicateCount++; listing.skipped_in_scan_duplicate++; continue; }
            seenFingerprints.add(candidate.event_fingerprint);
            const { data: fpRow } = await client.from('activities').select('id').eq('event_fingerprint', candidate.event_fingerprint).eq('status', 'approved').limit(1).maybeSingle();
            fingerprintMatchId = (fpRow as { id: string } | null)?.id ?? null;
            // (b) already waiting in the review queue from an earlier scan (cron + relay + scan-now can
            // hit the same page minutes apart) => don't queue it again. The 2026-09-13 bulk approval
            // turned exactly these twins into 57 duplicate activities.
            if (!fingerprintMatchId) {
              const { data: pendingRow } = await client.from('incoming_activities').select('id')
                .eq('extracted_data->>event_fingerprint', candidate.event_fingerprint)
                .in('status', ['new', 'needs_review']).limit(1).maybeSingle();
              if (pendingRow) { counters.duplicateCount++; listing.skipped_pending_in_queue++; continue; }
            }
          }
          // EVENT match (same event, possibly other performances): by event_key across the live catalogue,
          // then the occurrence-series fallback among this city's activities
          let eventMatch: ReturnType<typeof findEventMatch> = null;
          if (!fingerprintMatchId) {
            if (candidate.event_key) {
              if (seenEventKeys.has(candidate.event_key)) { counters.duplicateCount++; listing.skipped_in_scan_duplicate++; continue; }
              const { data: keyRows } = await client.from('activities').select(EXISTING_ACTIVITY_SELECT).eq('event_key', candidate.event_key).eq('status', 'approved').limit(3);
              eventMatch = findEventMatch(candidate, (keyRows || []).map((r) => mapExistingRow(r, todayStr)), source.id, todayStr);
              if (!eventMatch) {
                const { data: pendingKey } = await client.from('incoming_activities').select('id')
                  .eq('extracted_data->>event_key', candidate.event_key).in('status', ['new', 'needs_review']).limit(1).maybeSingle();
                if (pendingKey) { counters.duplicateCount++; listing.skipped_pending_in_queue++; continue; }
              }
            }
            if (!eventMatch && candidate.city) eventMatch = findEventMatch(candidate, await findSimilarActivities(client, candidate, cityCache), source.id, todayStr);
            if (candidate.event_key) seenEventKeys.add(candidate.event_key);
          }

          const similar = !fingerprintMatchId && !eventMatch && candidate.city ? await findSimilarActivities(client, candidate, cityCache) : [];
          let bestMatch: { activity: ExistingActivity; confidence: ReturnType<typeof computeConfidence> } | null = null;
          for (const existing of similar) {
            const confidence = computeConfidence(candidate, existing, thresholds);
            if (!bestMatch || confidence.score > bestMatch.confidence.score) bestMatch = { activity: existing, confidence };
          }

          // An "update" whose ONLY content is the event identity of a row that has none (rows created before
          // wave 1) is not a change a person can judge - it is bookkeeping. It is written fill-null on the
          // confirmed match (exact fingerprint / event match) and the candidate counts as a duplicate, instead
          // of adding one review item per legacy row per scan (2026-09-17: 4 of 13 Ra'anana "updates").
          const backfillIdentityOnly = async (activityId: string, d: Record<string, unknown>): Promise<boolean> => {
            const keys = Object.keys(d);
            if (keys.length !== 1 || keys[0] !== 'event_key' || !candidate.event_key) return false;
            const entry = d.event_key as { before?: unknown };
            if (entry && entry.before != null) return false; // a DIFFERENT existing key is a real identity question
            const { data: w } = await client.from('activities').update({ event_key: candidate.event_key, event_key_kind: candidate.event_key_kind ?? null }).eq('id', activityId).is('event_key', null).select('id');
            if (w && w.length) listing.identity_backfilled++;
            return true;
          };

          let matchType: 'new' | 'update' | 'duplicate' = 'new';
          let status = 'new';
          let existingActivityId: string | null = null;
          let diff: Record<string, unknown> = {};
          let confidenceScore = 0;
          let confidenceBreakdown: Record<string, number | string> = {};

          if (fingerprintMatchId) {
            existingActivityId = fingerprintMatchId;
            confidenceScore = 0.97; confidenceBreakdown = { fingerprint_match: 1 };
            // the same occurrence re-detected: still an UPDATE when this scan carries ENRICHMENT the record
            // lacks (detail-page price / address / performances / ages / identity / image) - otherwise the
            // Monster would knowingly leave Cleaner debt it just found the answer to. Wording-only
            // differences (description) are ignored here: they are extraction variance, not evidence.
            let enrichment: Record<string, unknown> = {};
            if (candidate.detail_url || candidate.event_key) {
              const { data: exRow } = await client.from('activities').select(EXISTING_ACTIVITY_SELECT).eq('id', fingerprintMatchId).maybeSingle();
              if (exRow) enrichment = computeFieldDiff(candidate, mapExistingRow(exRow, todayStr), { enrichmentOnly: true });
            }
            if (Object.keys(enrichment).length && !(await backfillIdentityOnly(fingerprintMatchId, enrichment))) { matchType = 'update'; status = 'needs_review'; diff = enrichment; counters.updatedCount++; }
            else { matchType = 'duplicate'; status = 'duplicate'; counters.duplicateCount++; }
          } else if (eventMatch) {
            // same EVENT: new occurrences / stronger evidence become an UPDATE for review, else a duplicate.
            // Enrichment only - a re-detected event must not re-enter the queue for wording variance.
            const fieldDiff = computeFieldDiff(candidate, eventMatch.activity, { enrichmentOnly: true });
            existingActivityId = eventMatch.activity.id;
            confidenceScore = eventMatch.reason === 'event_key' ? 0.96 : 0.93; confidenceBreakdown = { ...eventMatch.breakdown, [eventMatch.reason]: 1 };
            if (Object.keys(fieldDiff).length === 0 || (await backfillIdentityOnly(eventMatch.activity.id, fieldDiff))) { matchType = 'duplicate'; status = 'duplicate'; counters.duplicateCount++; }
            else { matchType = 'update'; status = 'needs_review'; diff = fieldDiff; counters.updatedCount++; }
          } else if (bestMatch && bestMatch.confidence.score >= thresholds.duplicate) {
            const fieldDiff = computeFieldDiff(candidate, bestMatch.activity);
            existingActivityId = bestMatch.activity.id;
            confidenceScore = bestMatch.confidence.score; confidenceBreakdown = bestMatch.confidence.breakdown;
            if (Object.keys(fieldDiff).length === 0) { matchType = 'duplicate'; status = 'duplicate'; counters.duplicateCount++; }
            else { matchType = 'update'; status = 'needs_review'; diff = fieldDiff; counters.updatedCount++; }
          } else if (bestMatch && bestMatch.confidence.score >= thresholds.needsReview) {
            matchType = 'update'; status = 'needs_review';
            existingActivityId = bestMatch.activity.id;
            confidenceScore = bestMatch.confidence.score; confidenceBreakdown = bestMatch.confidence.breakdown;
            diff = computeFieldDiff(candidate, bestMatch.activity);
            counters.updatedCount++;
          } else {
            matchType = 'new';
            status = gatingIssues(issues).length > 0 ? 'needs_review' : 'new';
            counters.newCount++;
          }

          if (existingActivityId) {
            matchedExistingIds.add(existingActivityId);
            await client.from('activities').update({ last_seen_at: new Date().toISOString(), consecutive_missing_scans: 0 }).eq('id', existingActivityId);
          }

          let autoApprovedActivityId: string | null = null;
          if (matchType === 'new' && autoApproveEligible(candidate, gatingIssues(issues), source, gate)) {
            try {
              const approved = await autoApproveNewActivity(client, source.created_by ?? null, source.id, pageUrl, candidate);
              autoApprovedActivityId = approved.id;
              status = 'approved';
              // מונע כפילויות תוך-סריקה - cityCache נטען פעם אחת, אז מוסיפים את מה שנוצר עכשיו.
              if (candidate.city) {
                const list = cityCache.get(candidate.city) || [];
                list.push({
                  id: approved.id, name: candidate.name, name_source: null, description: candidate.description, category: candidate.category,
                  min_age: candidate.min_age, max_age: candidate.max_age, price_type: candidate.price_type, price_amount: candidate.price_amount,
                  booking_requirement: candidate.booking_requirement, source_url: pageUrl, location_name: candidate.location_name, city: candidate.city,
                  lat: approved.lat, lng: approved.lng, venue_id: candidate.venue_id, event_fingerprint: candidate.event_fingerprint,
                  event_key: candidate.event_key ?? null, event_key_kind: candidate.event_key_kind ?? null, official_url: candidate.registration_url ?? null, source_id: source.id,
                  schedule_type: candidate.schedule_type, one_time_date: candidate.one_time_date, start_time: candidate.start_time, end_time: candidate.end_time,
                  recurring_days: candidate.recurring_days || [], has_image: Array.isArray(candidate.images) && candidate.images.length > 0,
                  occurrences: Array.isArray(candidate.occurrences) ? candidate.occurrences.map((o: { date: string; start_time: string | null; end_time: string | null }) => ({ date: o.date, start_time: o.start_time, end_time: o.end_time })) : (candidate.one_time_date ? [{ date: candidate.one_time_date, start_time: candidate.start_time ? String(candidate.start_time).slice(0, 5) : null, end_time: candidate.end_time ? String(candidate.end_time).slice(0, 5) : null }] : []),
                });
                cityCache.set(candidate.city, list);
              }
            } catch (saveErr) {
              autoApprovedActivityId = null;
              console.error('אישור אוטומטי נכשל, נופל בחזרה לתור בדיקה ידנית:', saveErr);
            }
          }

          const { venue: _venueObj, ...storedCandidate } = candidate;
          const incomingPayload = {
            source_id: source.id, scan_log_id: scanLogId, page_url: pageUrl,
            match_type: matchType, existing_activity_id: existingActivityId,
            confidence_score: confidenceScore, confidence_breakdown: confidenceBreakdown,
            source_trust_score: source.source_trust_score,
            extracted_data: storedCandidate, diff, validation_issues: issues,
            raw_source_snapshot: text.slice(0, 4000), status,
            created_activity_id: autoApprovedActivityId,
          };
          // ONE pending update per (activity, source): a rescan SUPERSEDES the update still waiting for review
          // instead of stacking another row (2026-09-17: 109 activities had stacked rows, up to 30 for one).
          // The newest evidence wins; a row a person already decided is never touched (status guard).
          let incomingId: string | null = null;
          if (matchType === 'update' && existingActivityId) {
            const { data: pendingUpd } = await client.from('incoming_activities').select('id')
              .eq('existing_activity_id', existingActivityId).eq('source_id', source.id).eq('match_type', 'update').eq('status', 'needs_review')
              .order('found_at', { ascending: false }).limit(1).maybeSingle();
            if (pendingUpd) {
              const { data: upd } = await client.from('incoming_activities').update({ ...incomingPayload, found_at: new Date().toISOString() })
                .eq('id', (pendingUpd as { id: string }).id).eq('status', 'needs_review').select('id').maybeSingle();
              if (upd) { incomingId = (upd as { id: string }).id; listing.updates_superseded++; }
            }
          }
          if (!incomingId) {
            const { data: incomingRow } = await client.from('incoming_activities').insert(incomingPayload).select('id').maybeSingle();
            incomingId = (incomingRow as { id: string } | null)?.id ?? null;
          }

          if (autoApprovedActivityId) {
            counters.autoApprovedCount++;
            await recordProvenance(client, { activityId: autoApprovedActivityId, sourceId: source.id, pageUrl, incomingId, relation: 'created', urlRole: 'listing' });
            // both the listing and the detail page are provenance (detail traversal) - with their roles
            if (candidate.detail_url) await recordProvenance(client, { activityId: autoApprovedActivityId, sourceId: source.id, pageUrl: candidate.detail_url as string, incomingId, relation: 'seen', urlRole: 'detail' });
          } else if (existingActivityId) {
            await recordProvenance(client, { activityId: existingActivityId, sourceId: source.id, pageUrl, incomingId, relation: matchType === 'update' ? 'updated' : 'seen', urlRole: 'listing' });
            if (candidate.detail_url) await recordProvenance(client, { activityId: existingActivityId, sourceId: source.id, pageUrl: candidate.detail_url as string, incomingId, relation: 'seen', urlRole: 'detail' });
          }
          counters.found++;
        }
      } finally {
        await persistProgress();
      }
    }

    // זיהוי "נעלם מהמקור" - רק אחרי שכל הדפים נבדקו. עובד עכשיו בפועל כי source_id נכתב (0078 + כאן).
    const { data: sourceActivities } = await client
      .from('activities').select('id, name, consecutive_missing_scans')
      .eq('source_id', source.id).eq('status', 'approved');
    for (const act of sourceActivities || []) {
      if (matchedExistingIds.has(act.id)) continue;
      const nextCount = (act.consecutive_missing_scans || 0) + 1;
      await client.from('activities').update({ consecutive_missing_scans: nextCount }).eq('id', act.id);
      if (nextCount >= missingThreshold) {
        counters.missingCount++;
        await client.from('incoming_activities').upsert({
          source_id: source.id, scan_log_id: scanLogId, page_url: source.seed_url,
          match_type: 'missing', existing_activity_id: act.id, status: 'missing_flagged',
          extracted_data: { name: act.name, consecutive_missing_scans: nextCount },
        }, { onConflict: 'existing_activity_id', ignoreDuplicates: true });
      }
    }

    const finalStatus: 'success' | 'partial' | 'error' = counters.errorCount === 0 ? 'success' : (counters.found > 0 ? 'partial' : 'error');
    // content_changed: pages changed, AI ran fine, nothing extracted, although this source used to yield.
    if (finalStatus === 'success' && counters.pagesChanged > 0 && counters.found === 0 && (source.activities_found_total || 0) > 0) failureKinds.push('content_changed');
    const failureKind = worstFailureKind(failureKinds);

    await client.from('source_scan_logs').update({
      finished_at: new Date().toISOString(), status: finalStatus,
      pages_checked: counters.pagesChecked, pages_changed: counters.pagesChanged, pages_unchanged: counters.pagesUnchanged,
      ai_calls: counters.aiCalls, activities_found: counters.found,
      new_count: counters.newCount, updated_count: counters.updatedCount, duplicate_count: counters.duplicateCount,
      rejected_count: counters.rejectedCount, missing_count: counters.missingCount, auto_approved_count: counters.autoApprovedCount,
      error_count: counters.errorCount, error_type: errorType, error_message: errorMessage, failure_kind: failureKind,
      listing_metrics: (listing.pages_with_cards || listing.sitemap) ? listing : null,
    }).eq('id', scanLogId);

    await finalizeSource(finalStatus, failureKind, {
      activities_found_total: (source.activities_found_total || 0) + counters.found,
      activities_approved_total: (source.activities_approved_total || 0) + counters.autoApprovedCount,
    });

    return jsonResponse({ sourceId: source.id, ...counters, failureKind });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errorMessage = message;
    await client.from('source_scan_logs').update({
      finished_at: new Date().toISOString(), status: 'error', error_type: 'other', error_message: message, failure_kind: 'unknown',
    }).eq('id', scanLogId);
    await finalizeSource('error', worstFailureKind(failureKinds) ?? 'unknown', {});
    return jsonResponse({ error: message }, 500);
  }
});
