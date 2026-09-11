// TuRu - "מקורות מידע": הפונקציה שסורקת מקור אחד (seed URL + עד כמה דפי-רשימה שהתגלו באותו
// דומיין), מחלצת פעילויות (רק מדפים ששונו מאז הסריקה הקודמת - ראו _shared/hashing.ts), מזהה
// חדש/עדכון/כפילות מול המאגר הקיים, ומטמינה הכל בתור incoming_activities לבדיקת מנהל. שום
// דבר לא נכתב ל-activities/locations/וכו' כאן - זה קורה רק דרך אישור מנהל בכלי הניהול
// (POST /api/incoming/:id/approve).
//
// מופעלת דרך HTTP POST {source_id} - או ע"י _dispatch_source_scan (מה-scheduler, pg_cron+
// pg_net) או ישירות מכלי הניהול (כפתור "סרוק עכשיו"). אימות: לא מסתמכים על ברירת המחדל
// verify_jwt=true בלבד (זו הייתה מקבלת גם JWT של משתמש-קצה רגיל) - נדרשת התאמה מפורשת ל-
// SUPABASE_SERVICE_ROLE_KEY (מוזרק אוטומטית לכל Edge Function, אין secret נוסף להגדיר).

import { createClient } from 'npm:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk@0.32';
import * as cheerio from 'npm:cheerio@1.0.0';
import {
  buildExtractionSystemPrompt, extractCandidateImages, parseExtractionResponse,
  filterPastOneTimeActivities, CATEGORY_VALUES, REGION_VALUES, WEATHER_VALUES, AMENITIES_VALUES,
  FAMILY_FIT_VALUES, ENTITY_TYPE_VALUES, PRICE_TYPE_VALUES, INDOOR_OUTDOOR_VALUES, BOOKING_VALUES,
  ARCHIVE_CATEGORIES,
} from '../_shared/extraction.ts';
import { discoverListingLinks } from '../_shared/discovery.ts';
import { normalizeHtmlForHash, computeContentHash } from '../_shared/hashing.ts';
import { geocodeAddress } from '../_shared/geocoding.ts';
import {
  findSimilarActivities, computeConfidence, computeFieldDiff, getConfidenceThresholds,
  type ExistingActivity,
} from '../_shared/matching.ts';
import { generatePlaygroundDisplayName } from '../_shared/playgroundNaming.ts';
import { normalizeCityName } from '../_shared/cityNaming.ts';

// TuRu מציגה רק פעילויות שאפשר להגיע אליהן מתי שרוצים בלי הרשמה/התחייבות מראש (אותו כלל בדיוק
// כמו shouldArchiveForCommitment ב-tools/import-tool/server.js - "פעילות" = חוג/סדנה/פעילות
// חוזרת שדורשת הרשמה, "חוג"/"קייטנה" = ARCHIVE_CATEGORIES). המשתמש ביקש במפורש לא להציף את
// תור הסקירה עם תוכן כזה - מדלגים כבר בזמן הסריקה, לפני יצירת שורת incoming_activities, במקום
// ליצור אותה ולסמוך על כך שהיא תיארכב אוטומטית רק אחרי אישור מנהל.
const ARCHIVE_ENTITY_TYPES = new Set(['פעילות']);
function isCommitmentActivity(candidate: { entity_type: unknown; category: unknown }): boolean {
  return ARCHIVE_ENTITY_TYPES.has(candidate.entity_type as string) || ARCHIVE_CATEGORIES.includes(candidate.category as string);
}

// הוספה ישירה למאגר בלי לחכות לאישור מנהל (בקשת המשתמש) - רק למועמד *חדש* (match_type='new',
// לא update/duplicate - אלה תמיד ממשיכים לדרוש בדיקה כי הם נוגעים בנתון קיים) שעונה על שלושת
// התנאים שהמשתמש קבע: (1) "לא נראה בעייתי" - issues.length===0, כלומר sanitizeCandidate לא
// זיהה אף שדה-חובה חסר; (2) "יש כתובת" - יש גם city וגם location_name (שני האיתותים היחידים
// שקיימים בשלב הזה של מועמד-שנחלץ, לפני geocoding בפועל - מספיקים כדי ש-saveNewActivity-style
// יצירת location תצליח בצורה משמעותית); (3) "יש תמונה" - candidate.images לא ריק.
function autoApproveEligible(candidate: Record<string, unknown>, issues: string[]): boolean {
  return (
    issues.length === 0 &&
    !!candidate.city &&
    !!candidate.location_name &&
    Array.isArray(candidate.images) && (candidate.images as unknown[]).length > 0
  );
}

// מקביל-בפועל ל-saveNewActivity ב-tools/import-tool/server.js (לא שכפול-מקרי - אותה תוצאה
// בדיוק נדרשת: location+activity+schedules+images) אבל ל-Deno/Edge Function, ובלי שני הצעדים
// האחרונים שם (חיפוש-תמונה-אוטומטי/אתר-רשמי) - לא רלוונטיים כאן כי תמונה היא כבר תנאי-סף
// לזכאות (סעיף 3 למעלה), ואתר-רשמי דורש SERPAPI שלא בהכרח מוגדר לסביבת ה-Edge Function.
async function autoApproveNewActivity(
  client: ReturnType<typeof createClient>,
  createdBy: string | null,
  sourceUrl: string,
  candidate: Record<string, unknown>,
): Promise<string> {
  // מנרמל city לצורה קנונית לפני כל כתיבה - מונע וריאציות-איות שמפצלות אותה עיר לכמה ערכים
  // (ראו tools/import-tool/cityNaming.js + migrate-city-names.js, 2026-09-11).
  candidate = { ...candidate, city: normalizeCityName(candidate.city as string | null) };
  let locationId: string | null = null;
  let createdNewLocation = false;
  const locationName = candidate.location_name as string;
  const { data: existingLoc } = await client
    .from('locations').select('id, city, region, lat, lng').ilike('name', locationName).limit(1).maybeSingle();
  if (existingLoc) {
    locationId = (existingLoc as { id: string }).id;
    const fillIn: Record<string, unknown> = {};
    if (!(existingLoc as { city: unknown }).city && candidate.city) fillIn.city = candidate.city;
    if (!(existingLoc as { region: unknown }).region && candidate.region) fillIn.region = candidate.region;
    if (Object.keys(fillIn).length > 0) await client.from('locations').update(fillIn).eq('id', locationId);
  } else {
    const { data: createdLoc, error: locErr } = await client
      .from('locations')
      .insert({ name: locationName, city: candidate.city || null, region: candidate.region || null })
      .select('id').single();
    if (locErr) throw locErr;
    locationId = (createdLoc as { id: string }).id;
    createdNewLocation = true;
  }
  // שער-חובה: בקשת המשתמש - "לעולם לא נכנסת פעילות למאגר אם אין כתובת". geocode (רק אם אין
  // עדיין קואורדינטות) - אותו ספק/מדיניות-שימוש כמו queryNominatim הקיים (Nominatim, לא bulk -
  // קריאה בודדת אחת פר-פעילות-חדשה, כחלק מזרימת יצירה רגילה, לא backfill). כישלון-geocoding
  // עוצר את כל היצירה (לא רק משאיר lat/lng ריקים) - מוחקים location שנוצר-עכשיו-ספציפית (rollback,
  // לא משאירים יתום) וזורקים; הקורא כבר תופס את זה ונופל בחזרה לתור-בדיקה ידנית של מנהל.
  const { data: locRow } = await client.from('locations').select('lat, lng, address, name, city').eq('id', locationId).maybeSingle();
  let hasCoords = !!(locRow && (locRow as { lat: unknown }).lat != null);
  if (locRow && !hasCoords) {
    const l = locRow as { address: string | null; name: string | null; city: string | null };
    const query = [l.address, l.name, l.city].filter(Boolean).join(', ') || l.city;
    if (query) {
      const coords = await geocodeAddress(query);
      if (coords) {
        await client.from('locations').update({ lat: coords.lat, lng: coords.lng }).eq('id', locationId);
        hasCoords = true;
      }
    }
  }
  if (!hasCoords) {
    if (createdNewLocation) await client.from('locations').delete().eq('id', locationId);
    throw new Error(`לא נמצאה כתובת מאומתת למקום "${locationName}"`);
  }

  // גן-שעשועים ללא שם רשמי מקבל שם מבוסס-כתובת - אותה לוגיקה בדיוק כמו saveNewActivity
  // ב-tools/import-tool/server.js (playgroundNaming.js), בעותק Deno (_shared/playgroundNaming.ts).
  let finalName = candidate.name as string;
  let nameSource: string | null = null;
  let originalSourceName: string | null = null;
  if (candidate.category === 'גן שעשועים') {
    const l = locRow as { address: string | null; city: string | null } | null;
    const naming = generatePlaygroundDisplayName({ officialName: finalName, address: l?.address ?? null, city: l?.city ?? null });
    if (naming.name && naming.name !== finalName) {
      originalSourceName = finalName || null;
      finalName = naming.name;
      nameSource = naming.nameSource;
    } else {
      nameSource = 'official';
    }
  }

  const { data: savedActivity, error: actErr } = await client
    .from('activities')
    .insert({
      name: finalName, name_source: nameSource, original_source_name: originalSourceName,
      description: candidate.description || null, entity_type: candidate.entity_type,
      location_id: locationId, location_detail: candidate.location_detail || null,
      min_age: candidate.min_age ?? null, max_age: candidate.max_age ?? null,
      price_type: candidate.price_type || null, price_amount: candidate.price_amount ?? null,
      category: candidate.category || null, duration_minutes: candidate.duration_minutes ?? null,
      indoor_outdoor: candidate.indoor_outdoor || null, booking_requirement: candidate.booking_requirement || null,
      weather_suitable: candidate.weather_suitable || [], amenities: candidate.amenities || [],
      family_fit: candidate.family_fit || [], status: 'approved', source: 'scraped',
      source_url: sourceUrl || null, created_by: createdBy,
    })
    .select('id').single();
  if (actErr) throw actErr;
  const activityId = (savedActivity as { id: string }).id;

  const scheduleRows: Record<string, unknown>[] = [];
  if (candidate.schedule_type === 'recurring' && Array.isArray(candidate.recurring_days) && (candidate.recurring_days as unknown[]).length) {
    for (const day of candidate.recurring_days as string[]) {
      scheduleRows.push({ activity_id: activityId, schedule_type: 'recurring', day_of_week: day, start_time: candidate.start_time || null, end_time: candidate.end_time || null });
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

  return activityId;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

async function loadSettings(client: ReturnType<typeof createClient>) {
  const { data } = await client.from('automation_settings').select('key, value');
  const map: Record<string, unknown> = {};
  for (const row of data || []) map[(row as { key: string }).key] = (row as { value: unknown }).value;
  return map;
}

// fetchError מוחזר עד לקורא (לא רק true/false) - בלעדיו source_scan_logs.error_message תמיד
// נשאר null וא-אפשר לדעת בכלל *למה* דף נכשל (HTTP 403 מ-WAF שחוסם תעבורת-cloud, 404 מקישור
// שגוי, timeout וכו') - נצפה בפועל: מקור אמיתי שנכשל בלי שום מידע מאבחן עד שהוספנו את זה.
async function fetchWithRetry(url: string, timeoutMs: number, retries: number): Promise<{ ok: boolean; html?: string; status?: number; fetchError?: string }> {
  let lastErr: string | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TuruBot/1.0)' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { ok: false, status: res.status, fetchError: `HTTP ${res.status}` };
      return { ok: true, html: await res.text() };
    } catch (err) {
      lastErr = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      if (attempt === retries) return { ok: false, fetchError: lastErr };
    }
  }
  return { ok: false, fetchError: lastErr };
}

// ולידציה הגנתית - כל ערך לא-ברשימה נמחק לפני שהוא נשמר בכלל (לא רק מסתמכים על הפרומפט).
// deno-lint-ignore no-explicit-any
function sanitizeCandidate(raw: any, pageUrl: string): { candidate: any; issues: string[] } {
  const issues: string[] = [];
  const inList = (val: unknown, list: string[]) => (typeof val === 'string' && list.includes(val) ? val : null);

  const candidate: Record<string, unknown> = {
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null,
    entity_type: inList(raw.entity_type, ENTITY_TYPE_VALUES),
    description: typeof raw.description === 'string' ? raw.description.trim() : null,
    schedule_type: inList(raw.schedule_type, ['recurring', 'one_time', 'fixed_hours']),
    recurring_days: Array.isArray(raw.recurring_days) ? raw.recurring_days.filter((d: unknown) => typeof d === 'string') : [],
    start_time: typeof raw.start_time === 'string' ? raw.start_time : null,
    end_time: typeof raw.end_time === 'string' ? raw.end_time : null,
    one_time_date: typeof raw.one_time_date === 'string' ? raw.one_time_date : null,
    min_age: typeof raw.min_age === 'number' ? raw.min_age : null,
    max_age: typeof raw.max_age === 'number' ? raw.max_age : null,
    price_type: inList(raw.price_type, PRICE_TYPE_VALUES),
    price_amount: typeof raw.price_amount === 'number' ? raw.price_amount : null,
    location_name: typeof raw.location_name === 'string' ? raw.location_name : null,
    location_detail: typeof raw.location_detail === 'string' ? raw.location_detail : null,
    city: typeof raw.city === 'string' ? raw.city : null,
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
  // פרובננס-תמונה (0047): לכל URL תמונה, מסמנים אם היא מהדומיין של המקור עצמו (ORIGINAL_SOURCE)
  // או ממקור חיצוני (EXTERNAL_SOURCE, מסומן needs_rights_review - "לא להניח שמותר להשתמש בכל
  // תמונה שנמצאת באינטרנט"). מחושב כאן (לא בטופס האישור) כי רק כאן יש גישה ל-pageUrl.
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
  if (!candidate.price_type) issues.push('מחיר');
  if (!candidate.one_time_date && candidate.schedule_type === 'one_time') issues.push('תאריך');
  if (!candidate.city) issues.push('עיר');

  return { candidate, issues };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  // אימות: Supabase כבר מוודא ברמת ה-gateway (verify_jwt, ברירת המחדל) שה-JWT הזה חתום כחוק
  // עבור הפרויקט הזה - לא הייתי כאן בכלל אחרת. מה שחסר מברירת המחדל בלבד הוא שהיא הייתה מקבלת
  // *כל* JWT חתום-כחוק (גם של משתמש-קצה רגיל), לא רק service_role - אז בודקים כאן במפורש את
  // ה-claim role בתוך ה-payload (בלי לבדוק חתימה בעצמנו - ה-gateway כבר עשה את זה). זה עמיד
  // יותר מהשוואת-מחרוזת מול SUPABASE_SERVICE_ROLE_KEY (שדורשת synchronization ידני מדויק מול
  // Vault, כפי שהתברר בפועל - מפתחות legacy/JWT יכולים "להסתובב" בכמה גרסאות תקפות).
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  let role: string | undefined;
  try {
    let payloadB64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (payloadB64.length % 4 !== 0) payloadB64 += '='; // base64url לא כולל padding, base64 רגיל כן
    role = JSON.parse(atob(payloadB64)).role;
  } catch { /* טוקן לא תקין - role נשאר undefined, נדחה למטה */ }
  if (role !== 'service_role') {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  let body: { source_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid body' }, 400);
  }
  if (!body.source_id) return jsonResponse({ error: 'missing source_id' }, 400);

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

  const { data: logRow } = await client
    .from('source_scan_logs')
    .insert({ source_id: source.id, status: 'running' })
    .select('id')
    .single();
  const scanLogId = logRow?.id as string;

  const counters = {
    pagesChecked: 0, pagesChanged: 0, pagesUnchanged: 0, aiCalls: 0,
    found: 0, newCount: 0, updatedCount: 0, duplicateCount: 0, rejectedCount: 0,
    missingCount: 0, errorCount: 0, autoApprovedCount: 0,
  };
  let errorType: string | null = null;
  let errorMessage: string | null = null;
  const matchedExistingIds = new Set<string>();
  const cityCache = new Map<string, ExistingActivity[]>();

  // תקציב-זמן פנימי: fetch+AI על כמה דפים ברצף (לא מקבילי, כדי לא להציף את ה-AI ולשמור על סדר
  // עדיפויות ברור) יכול לחרוג מזמן-הריצה המקסימלי שהפלטפורמה מתירה ל-Edge Function בודדת - אם
  // זה קורה, הפונקציה "נהרגת" באמצע בלי שהקוד שלנו מקבל הזדמנות לסיים בצורה מסודרת, והשורה
  // ב-source_scan_logs נשארת תקועה לנצח על status='running'. פותרים בשתי שכבות: (1) בודקים
  // תקציב-זמן לפני כל דף חדש ויוצאים בעדינות אם עברנו אותו - הדפים שנותרו יטופלו בסריקה המתוזמנת
  // הבאה (שגם ככה קרובה, כל 15 דקות/scan_frequency_hours), לא אבודים; (2) שומרים התקדמות חלקית
  // אחרי כל דף (persistProgress) כרשת-ביטחון גם אם עדיין נהרגת "לגמרי" - לפחות המצב האחרון שנשמר
  // אמין, לא תקוע ריק-מכל-נתון.
  const scanStartedAt = Date.now();
  const SCAN_TIME_BUDGET_MS = 100_000;

  async function persistProgress() {
    await client.from('source_scan_logs').update({
      pages_checked: counters.pagesChecked, pages_changed: counters.pagesChanged,
      pages_unchanged: counters.pagesUnchanged, ai_calls: counters.aiCalls,
      activities_found: counters.found, new_count: counters.newCount,
      updated_count: counters.updatedCount, duplicate_count: counters.duplicateCount,
      rejected_count: counters.rejectedCount,
    }).eq('id', scanLogId);
  }

  try {
    const seedRes = await fetchWithRetry(source.seed_url, fetchTimeoutMs, retryCount);
    let pageUrls = [source.seed_url];
    if (seedRes.ok && seedRes.html) {
      const $seed = cheerio.load(seedRes.html);
      const extra = discoverListingLinks($seed, source.seed_url, maxPages - 1);
      pageUrls = [source.seed_url, ...extra];
    }

    for (const pageUrl of pageUrls) {
      if (counters.found >= maxActivitiesPerScan) break;
      if (Date.now() - scanStartedAt > SCAN_TIME_BUDGET_MS) {
        errorType = errorType ?? 'rate_limited'; // לא שגיאה אמיתית - רק "נגמר הזמן להיום", דפים שנותרו יטופלו בסריקה הבאה
        break;
      }
      counters.pagesChecked++;

      try {

      const res = pageUrl === source.seed_url && seedRes.ok
        ? seedRes
        : await fetchWithRetry(pageUrl, fetchTimeoutMs, retryCount);
      if (!res.ok || !res.html) {
        counters.errorCount++;
        errorType = errorType ?? 'network';
        errorMessage = errorMessage ?? (res.fetchError || 'unknown fetch failure');
        continue;
      }

      const $ = cheerio.load(res.html);
      const normalized = normalizeHtmlForHash($);
      const hash = await computeContentHash(normalized);

      const { data: snapshot } = await client
        .from('source_page_snapshots')
        .select('content_hash')
        .eq('source_id', source.id).eq('url', pageUrl)
        .maybeSingle();

      if (snapshot && snapshot.content_hash === hash) {
        counters.pagesUnchanged++;
        await client.from('source_page_snapshots')
          .update({ last_fetched_at: new Date().toISOString() })
          .eq('source_id', source.id).eq('url', pageUrl);
        continue;
      }

      counters.pagesChanged++;

      // הערה קריטית: ה-snapshot נשמר רק **אחרי** חילוץ-AI מוצלח (למטה), לא כאן מיד אחרי החישוב.
      // נמצא בפועל: אם ה-upsert קורה כאן ואז קריאת ה-AI נכשלת (תשובה פגומה/timeout), הסריקה
      // הבאה רואה hash זהה ל-snapshot השמור ומדלגת על הדף לגמרי כ"unchanged" - בלי AI, לנצח,
      // עד שתוכן הדף עצמו ישתנה. זה הופך כשל-AI חד-פעמי לאובדן-כיסוי קבוע של מקור תקין. הפתרון:
      // רק סריקה שבה ה-AI *הצליח* (גם אם 0 פעילויות חולצו בפועל) נחשבת "טופל", ונרשמת ב-snapshot.

      if (counters.aiCalls >= maxAiRequests) {
        errorType = errorType ?? 'rate_limited';
        continue;
      }

      const candidateImages = extractCandidateImages($, pageUrl);
      $('script, style, noscript, nav, footer, header, svg, form').remove();
      const text = $('body').text().replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim().slice(0, 18000);
      if (!text) continue;

      let extracted: unknown[];
      try {
        const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });
        const message = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 8192,
          system: buildExtractionSystemPrompt(),
          messages: [{
            role: 'user',
            content: `כתובת המקור: ${pageUrl}\n\nתוכן הדף:\n${text}\n\nרשימת תמונות מהעמוד:\n${JSON.stringify(candidateImages)}`,
          }],
        });
        counters.aiCalls++;
        const raw = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
        const parsed = parseExtractionResponse(raw);
        const todayStr = new Date().toISOString().slice(0, 10);
        extracted = filterPastOneTimeActivities(parsed.activities as never[], todayStr);
      } catch (aiErr) {
        counters.errorCount++;
        errorType = errorType ?? 'ai';
        errorMessage = errorMessage ?? (aiErr instanceof Error ? aiErr.message : String(aiErr));
        continue;
      }

      // חילוץ-AI הצליח (גם אם החזיר 0 פעילויות) - רק עכשיו מותר לסמן את הדף כ"טופל" ל-hash הזה.
      await client.from('source_page_snapshots').upsert({
        source_id: source.id, url: pageUrl, content_hash: hash,
        last_fetched_at: new Date().toISOString(), last_changed_at: new Date().toISOString(),
      }, { onConflict: 'source_id,url' });

      for (const rawCandidate of extracted) {
        if (counters.found >= maxActivitiesPerScan) break;
        const { candidate, issues } = sanitizeCandidate(rawCandidate, pageUrl);
        (candidate as Record<string, unknown>).pageUrl = pageUrl;

        if (issues.length > 0 && !candidate.name) {
          // בלי שם בכלל - אין מה להציג למנהל, נספר כנדחה ולא נוצרת שורה.
          counters.rejectedCount++;
          continue;
        }

        if (isCommitmentActivity(candidate)) {
          // חוג/קייטנה/פעילות-שדורשת-הרשמה - TuRu לעולם לא תציג את זה (ראו isCommitmentActivity
          // למעלה), אז אין טעם להטריד את המנהל בבדיקה שתמיד תיגמר באותה תוצאה. נספר כנדחה,
          // בלי שורת incoming_activities בכלל.
          counters.rejectedCount++;
          continue;
        }

        const similar = candidate.city
          ? await findSimilarActivities(client, candidate, cityCache)
          : [];
        let bestMatch: { activity: ExistingActivity; confidence: ReturnType<typeof computeConfidence> } | null = null;
        for (const existing of similar) {
          const confidence = computeConfidence(candidate, existing, thresholds);
          if (!bestMatch || confidence.score > bestMatch.confidence.score) {
            bestMatch = { activity: existing, confidence };
          }
        }

        let matchType: 'new' | 'update' | 'duplicate' = 'new';
        let status = 'new';
        let existingActivityId: string | null = null;
        let diff: Record<string, unknown> = {};
        let confidenceScore = 0;
        let confidenceBreakdown: Record<string, number> = {};

        if (bestMatch && bestMatch.confidence.score >= thresholds.duplicate) {
          const fieldDiff = computeFieldDiff(candidate, bestMatch.activity);
          existingActivityId = bestMatch.activity.id;
          confidenceScore = bestMatch.confidence.score;
          confidenceBreakdown = bestMatch.confidence.breakdown;
          matchedExistingIds.add(existingActivityId);
          await client.from('activities').update({ last_seen_at: new Date().toISOString(), consecutive_missing_scans: 0 }).eq('id', existingActivityId);
          if (Object.keys(fieldDiff).length === 0) {
            matchType = 'duplicate'; status = 'duplicate';
            counters.duplicateCount++;
          } else {
            matchType = 'update'; status = 'needs_review'; diff = fieldDiff;
            counters.updatedCount++;
          }
        } else if (bestMatch && bestMatch.confidence.score >= thresholds.needsReview) {
          matchType = 'update'; status = 'needs_review';
          existingActivityId = bestMatch.activity.id;
          confidenceScore = bestMatch.confidence.score;
          confidenceBreakdown = bestMatch.confidence.breakdown;
          diff = computeFieldDiff(candidate, bestMatch.activity);
          counters.updatedCount++;
        } else {
          matchType = 'new';
          status = issues.length > 0 ? 'needs_review' : 'new';
          counters.newCount++;
        }

        // הוספה ישירה בלי לחכות לאישור מנהל (ראו autoApproveEligible למעלה) - רק למועמד חדש
        // שעונה על כל שלושת התנאים. שורת incoming_activities עדיין נוצרת (שקיפות/audit trail
        // מלא - "מה נוסף אוטומטית ומתי"), רק כבר עם status='approved' ו-created_activity_id
        // מלא-מראש, במקום 'new' הממתין למנהל. reviewed_by נשאר null בכוונה - זה בדיוק מה
        // שמבדיל "אושר אוטומטית" מ"אושר ע"י מנהל" (שם reviewed_by תמיד מלא), בלי צורך בעמודה
        // חדשה בסכימה.
        let autoApprovedActivityId: string | null = null;
        if (matchType === 'new' && autoApproveEligible(candidate, issues)) {
          try {
            autoApprovedActivityId = await autoApproveNewActivity(client, source.created_by ?? null, pageUrl, candidate);
            status = 'approved';
            existingActivityId = null;
          } catch (saveErr) {
            // כשל ביצירה בפועל (למשל geocoding נכשל בצורה לא-צפויה) - לא "בולעים" את המועמד,
            // נופלים בחזרה לתור-הבדיקה הרגיל של מנהל, בדיוק כמו שהיה קורה בלי אוטומציה בכלל.
            autoApprovedActivityId = null;
            console.error('אישור אוטומטי נכשל, נופל בחזרה לתור בדיקה ידנית:', saveErr);
          }
        }

        const { data: incomingRow } = await client.from('incoming_activities').insert({
          source_id: source.id, scan_log_id: scanLogId, page_url: pageUrl,
          match_type: matchType, existing_activity_id: existingActivityId,
          confidence_score: confidenceScore, confidence_breakdown: confidenceBreakdown,
          source_trust_score: source.source_trust_score,
          extracted_data: candidate, diff, validation_issues: issues,
          raw_source_snapshot: text.slice(0, 4000), status,
          created_activity_id: autoApprovedActivityId,
        }).select('id').maybeSingle();
        if (autoApprovedActivityId) counters.autoApprovedCount++;
        void incomingRow;
        counters.found++;
      }

      } finally {
        await persistProgress();
      }
    }

    // זיהוי "נעלם מהמקור" - רק אחרי שכל הדפים נבדקו, כדי לדעת אילו פעילויות-קיימות-של-המקור-הזה
    // באמת לא נמצאו באף אחד מהדפים בסבב הזה.
    const { data: sourceActivities } = await client
      .from('activities')
      .select('id, name, consecutive_missing_scans')
      .eq('source_id', source.id)
      .eq('status', 'approved');

    for (const act of sourceActivities || []) {
      if (matchedExistingIds.has(act.id)) continue;
      const nextCount = (act.consecutive_missing_scans || 0) + 1;
      await client.from('activities').update({ consecutive_missing_scans: nextCount }).eq('id', act.id);
      if (nextCount >= missingThreshold) {
        counters.missingCount++;
        // unique index (existing_activity_id) where match_type='missing' and status='missing_flagged'
        // מונע כפילות אם כבר יש שורה ממתינה - upsert עם onConflict מטפל בזה בעדינות.
        await client.from('incoming_activities').upsert({
          source_id: source.id, scan_log_id: scanLogId, page_url: source.seed_url,
          match_type: 'missing', existing_activity_id: act.id, status: 'missing_flagged',
          extracted_data: { name: act.name, consecutive_missing_scans: nextCount },
        }, { onConflict: 'existing_activity_id', ignoreDuplicates: true });
      }
    }

    const finalStatus = counters.errorCount === 0 ? 'success' : (counters.found > 0 ? 'partial' : 'error');
    await client.from('source_scan_logs').update({
      finished_at: new Date().toISOString(), status: finalStatus,
      pages_checked: counters.pagesChecked, pages_changed: counters.pagesChanged, pages_unchanged: counters.pagesUnchanged,
      ai_calls: counters.aiCalls, activities_found: counters.found,
      new_count: counters.newCount, updated_count: counters.updatedCount, duplicate_count: counters.duplicateCount,
      rejected_count: counters.rejectedCount, missing_count: counters.missingCount,
      error_count: counters.errorCount, error_type: errorType, error_message: errorMessage,
    }).eq('id', scanLogId);

    await client.from('sources').update({
      last_scan_at: new Date().toISOString(), last_scan_status: finalStatus, last_scan_error: errorMessage,
      next_scan_at: new Date(Date.now() + source.scan_frequency_hours * 3600 * 1000).toISOString(),
      activities_found_total: (source.activities_found_total || 0) + counters.found,
      activities_approved_total: (source.activities_approved_total || 0) + counters.autoApprovedCount,
      scan_errors_total: (source.scan_errors_total || 0) + counters.errorCount,
    }).eq('id', source.id);

    return jsonResponse({ sourceId: source.id, ...counters });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await client.from('source_scan_logs').update({
      finished_at: new Date().toISOString(), status: 'error', error_type: 'other', error_message: message,
    }).eq('id', scanLogId);
    // מקור שבור לא אמור "לפוצץ" את ה-cron כל 15 דקות - עדיין דוחפים next_scan_at קדימה.
    await client.from('sources').update({
      last_scan_at: new Date().toISOString(), last_scan_status: 'error', last_scan_error: message,
      next_scan_at: new Date(Date.now() + source.scan_frequency_hours * 3600 * 1000).toISOString(),
      scan_errors_total: (source.scan_errors_total || 0) + 1,
    }).eq('id', source.id);
    return jsonResponse({ error: message }, 500);
  }
});
