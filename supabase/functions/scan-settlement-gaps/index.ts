// TuRu - סריקה יומית זולה של "כפילויות-כיסוי" ברמת-יישוב: הגרסה המתוזמנת-קבוע של הזרימה
// שהופעלה ידנית ב-2026-09-11 (tools/playground-discovery/settlement_gap_check.py +
// settlement_gap_fill.py) - "כמה גני-שעשועים גוגל מוצא ליד היישוב הזה, מול כמה יש ב-TuRu כבר".
//
// שני שלבים בכל הרצה, לפי התקציב שנקבע ב-automation_settings (בלי deploy קוד כדי לשנות):
//   1. בדיקה זולה (Nearby Search, IDs-only field mask = Google's Essentials SKU, כמעט חינם) על
//      אצווה של יישובים (settlement_scan_batch_size ליישוב-לגל, לא כולם בבת אחת - כך שהעלות
//      היומית נשארת קטנה וקבועה). cursor ב-automation_settings מתקדם בכל הרצה - בלי לגלגל-חזור
//      לתחילת הרשימה: בקשת המשתמש המפורשת (2026-09-11) - "אין סיבה שזה ירוץ לנצח... ירוץ עד
//      שיכסה את כל הארץ לחלוטין ואז יסיים". כשה-cursor מגיע לסוף הרשימה, ה-batch האחרון נחתך
//      (לא עוטף), ו-settlement_scan_enabled מוכבה אוטומטית ל-false + settlement_scan_completed_at
//      נרשם - הריצה הבאה של ה-cron (וכל _dispatch_settlement_scan עתידי) פשוט לא-עושה-כלום
//      מהרגע הזה, בלי לכבות את ה-cron job עצמו. reset_settlement_scan() (RPC, ראו 0060) מאפשר
//      סבב-סקירה מלא נוסף בעתיד בלי לצטרך migration/deploy נוספים.
//   2. לכל יישוב שדוח-הפער (google_count - turu_count) עבר סף (settlement_scan_gap_threshold,
//      כמו GAP_THRESHOLD הקיים) - חיפוש-טקסט אמיתי (Pro-tier, יקר משמעותית). מוגבל בפועל
//      ל-settlement_scan_daily_pro_budget יישובים/הרצה (הכי-גדול-פער קודם) כדי שהעלות היקרה
//      תישאר חסומה-תקציב ולא תגדל בלי גבול אם יום אחד מתגלים הרבה פערים בבת אחת.
//      2026-09-11 תיקון (בקשת המשתמש: "אם המקור נראה לגיטימי ויש כתובת - לאשר אוטומטית, אחרת
//      לבדיקה"): רק תוצאה עם סוג-מקום ברור (PLAYGROUND/PARK_WITH_PLAYGROUND) + כתובת בפועל +
//      NEW_CANDIDATE מול הקטלוג הקיים נכנסת ישר כ-approved. כל השאר (PARK/UNCERTAIN, בלי
//      כתובת, או STRONG_MATCH/NEEDS_REVIEW מול פעילות קיימת) נכנס ל-incoming_activities
//      (status='needs_review') - לפני התיקון הזה זה פשוט דולג בשקט, בלי עקבה בשום מקום.
//
// city מנורמל (normalizeCityName, _shared/cityNaming.ts) בזמן בניית רשימת-היישובים - בניגוד
// ל-tools/playground-discovery/supabase_client.py fetch_settlement_centroids (Python, לא
// מנרמל) שגרם בפועל ל"קדימה - צורן"/"קדימה צורן" ו"קרית"/"קריית" להיחשב שני יישובים נפרדים
// בסבב הידני מ-2026-09-11 - כאן זה נפתר בשורש, לא ברשימת-חריגים ידנית.
//
// מופעלת ע"י pg_cron+pg_net (ראו supabase/0060_settlement_scan_scheduler.sql), אותה תבנית
// בדיוק כמו scan-source. GOOGLE_MAPS_API_KEY כבר מוגדר כ-secret של הפרויקט (בשימוש גם ע"י
// place-photo).
//
// בסוף כל הרצה (בין אם היתה זו הרצה רגילה או ההרצה האחרונה שסיימה את הסבב) - מייל יומי דרך
// Resend (RESEND_API_KEY, secret קיים - אותו דפוס בדיוק כמו send-contact-email) עם כמה גני
// שעשועים חדשים נמצאו היום ועוד כמה ימים נשארו לסיום הסבב המלא - בקשת המשתמש המפורשת
// (2026-09-11). כשל בשליחת המייל לא מפיל את הסריקה עצמה - ה-cursor וההוספות ל-DB כבר בוצעו
// והמייל נשלח מתוך try/catch נפרד.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { classifyPlace, matchAgainstExisting, extractCityFromAddress, fetchAllPaginatedResults, type ExistingForMatch } from '../_shared/placesDiscovery.ts';
import { generatePlaygroundDisplayName, isGenericPlaygroundName } from '../_shared/playgroundNaming.ts';
import { normalizeCityName } from '../_shared/cityNaming.ts';

const PLACES_BASE_URL = 'https://places.googleapis.com/v1';
const IDS_ONLY_FIELD_MASK = 'places.id';
const DISCOVERY_FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.primaryType,places.googleMapsUri';
// גבולות ישראל הרחבים - זהים בדיוק ל-DEFAULT_ISRAEL_BOUNDS (tools/playground-discovery/israel_geo.py) -
// לא שכפול-בטעות, שני runtimes (Python CLI מקומי מול Deno Edge Function) לא יכולים לחלוק קובץ אחד.
const ISRAEL_BOUNDS = { minLat: 29.45, maxLat: 33.35, minLon: 34.20, maxLon: 35.95 };
// 2026-09-12 (batch-3 validation): נמצא בפועל שיש 9 activities עם category='פארק שעשועים'
// (מילה נרדפת ל-'גן שעשועים' - אותו מושג ממש, ניסוח אחר) - היו בלתי-נראים לחלוטין למניעת-
// כפילויות, בלי קשר לתיקון ה-pagination (שני באגים שונים לגמרי: זה סינון-לפי-ערך, לא חיתוך-
// שורות). גרם בפועל לניסיון-ייבוא כפול של "פארק יהורם גאון" ב-Batch 3. לא כולל 'פארק' הכללי
// (35 שורות) או 'משחקייה' (13 שורות, סוג-מקום שונה - חדר-משחקים מקורה, לא גן-שעשועים חיצוני) -
// אלה מושגים אחרים בפועל, לא מילים-נרדפות לאותו דבר.
const PLAYGROUND_CATEGORIES = ['גן שעשועים', 'פארק שעשועים'];

const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

// אותו דפוס בדיוק כמו send-contact-email (RESEND_API_KEY כבר secret קיים בפרויקט, אותו נמען
// קבוע) - הודעה יומית "כמה גני-שעשועים חדשים נמצאו היום, כמה ימים נשארו לסיום הסבב המלא" -
// בקשת המשתמש המפורשת (2026-09-11). כשל בשליחת המייל עצמו לא אמור להפיל את הסריקה/ה-cursor -
// נקרא מתוך try/catch בקריאה, לא כאן.
const NOTIFY_EMAIL = 'mborenmusic@gmail.com';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}

async function sendDailySummaryEmail(params: {
  imported: number; importedNames: string[]; checked: number; totalSettlements: number;
  nextCursor: number; daysRemaining: number; completed: boolean; errorCount: number; queuedForReview: number;
}) {
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) { console.warn('RESEND_API_KEY not configured - skipping daily summary email'); return; }

  const { imported, importedNames, checked, totalSettlements, nextCursor, daysRemaining, completed, errorCount, queuedForReview } = params;
  const subject = completed
    ? `TuRu - סריקת גני השעשועים הארצית הסתיימה (${imported} חדשים היום)`
    : `TuRu - סריקה יומית: ${imported} גני שעשועים חדשים, עוד ${daysRemaining} ימים לסיום`;

  const progressLine = completed
    ? `<p><b>הסבב הארצי הושלם!</b> ${nextCursor} מתוך ${totalSettlements} יישובים נבדקו. הסריקה כובתה אוטומטית ולא תרוץ שוב עד הפעלה חדשה.</p>`
    : `<p>התקדמות: ${nextCursor} מתוך ${totalSettlements} יישובים נבדקו עד כה. נותרו בערך <b>${daysRemaining} ימים</b> לסיום הסבב המלא.</p>`;

  const namesList = importedNames.length
    ? `<ul>${importedNames.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
    : '<p>לא נמצאו גני שעשועים חדשים בבדיקה של היום.</p>';

  const errorLine = errorCount > 0 ? `<p style="color:#b45309">⚠️ ${errorCount} שגיאות בהרצה הזו - ראו לוגי ה-Edge Function לפרטים.</p>` : '';
  // 2026-09-11 fix - מקומות לא-חד-משמעיים (בלי כתובת/סוג לא-בטוח/חשד-כפילות) לא נכנסים יותר
  // אוטומטית ולא נעלמים בשקט - הם מצטרפים לתור incoming_activities לבדיקה ידנית.
  const reviewLine = queuedForReview > 0
    ? `<p>${queuedForReview} מועמדים נוספים נכנסו לתור בדיקה (לא ברור מספיק כדי לאשר אוטומטית).</p>`
    : '';

  const html = `<div dir="rtl" style="font-family: Arial, sans-serif; font-size: 15px; line-height: 1.6;">` +
    `<p>נבדקו ${checked} יישובים היום.</p>` +
    `<p><b>${imported} גני שעשועים חדשים נוספו:</b></p>` +
    namesList + reviewLine + progressLine + errorLine +
    `</div>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'TuRu <onboarding@resend.dev>', to: [NOTIFY_EMAIL], subject, html }),
  });
  if (!res.ok) console.error('Daily summary email failed:', res.status, await res.text());
}

async function callPlaces(apiKey: string, path: string, body: Record<string, unknown>, fieldMask: string) {
  const res = await fetch(`${PLACES_BASE_URL}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': fieldMask },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Places API ${path} failed: HTTP ${res.status} - ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// RequestStats - סופר לפי סוג-בקשה, לא "Google calls" אחיד (בקשת המשתמש 2026-09-12: "המערכת
// צריכה לדעת להבדיל בין ID-only, Pro Search ו-Place Details"). מועבר במפורש לכל פונקציית-
// קריאה במקום global mutable - כל הרצת Deno.serve מקבלת אובייקט stats טרי משלה.
interface RequestStats {
  idOnly: number; textSearch: number; nearbySearch: number; placeDetails: number;
  googleResults: number; rejected: number; duplicates: number;
  textSearchPages: number; settlementsWithExtraPages: number;
}
function newRequestStats(): RequestStats {
  return {
    idOnly: 0, textSearch: 0, nearbySearch: 0, placeDetails: 0, googleResults: 0, rejected: 0, duplicates: 0,
    textSearchPages: 0, settlementsWithExtraPages: 0,
  };
}

async function countNearbyIds(apiKey: string, lat: number, lon: number, radiusM: number, stats: RequestStats): Promise<number> {
  stats.idOnly++;
  const data = await callPlaces(apiKey, 'places:searchNearby', {
    locationRestriction: { circle: { center: { latitude: lat, longitude: lon }, radius: radiusM } },
    maxResultCount: 20, rankPreference: 'DISTANCE', includedTypes: ['playground', 'park'],
  }, IDS_ONLY_FIELD_MASK);
  return (data.places || []).length;
}

// 2026-09-12 תיקון (בקשת המשתמש - batch-3 validation round): עד עכשיו כל חיפוש-טקסט קרא רק את
// העמוד הראשון (maxResultCount:20) ומעולם לא בדק את nextPageToken של Google - כלומר יישוב עם
// יותר מ-20 גני-שעשועים אמיתיים ברדיוס תמיד "איבד" את היתר בשקט. עכשיו ממשיך לעמודים נוספים
// (עד MAX_PAGES - Google עצמו לא מחזיר בפועל יותר מ-~60 תוצאות/3 עמודים לחיפוש טקסט אחד, גם אם
// מבקשים יותר) - כל עמוד הוא קריאת Text Search נפרדת וחייבת-לחיוב בדיוק כמו הראשונה, אז stats.
// textSearch++ קורה פר-עמוד, לא פר-יישוב. Google דורש השהייה קצרה לפני ש-nextPageToken תקף
// (מתועד ב-API - לא רק ניחוש) - 2 שניות, כמו שממומש בפועל בפרויקטים אחרים מול Places API.
const MAX_TEXT_SEARCH_PAGES = 3;
const PAGE_TOKEN_DELAY_MS = 2000;
interface RawPlaceResult { id?: string; displayName?: { text?: string }; formattedAddress?: string; location?: { latitude?: number; longitude?: number }; types?: string[]; primaryType?: string; googleMapsUri?: string }
export type PlaceResult = RawPlaceResult & { _page: number };
// דק בכוונה - כל לוגיקת הפאג'ינציה עצמה חיה ב-fetchAllPaginatedResults (_shared/placesDiscovery.ts,
// ראו הבדיקות שם) כדי שתהיה ניתנת-לבדיקה בלי Deno.serve/API אמיתי. כאן רק מזריקים את קריאת-ה-API
// האמיתית + setTimeout אמיתי.
async function searchTextPlaygrounds(apiKey: string, lat: number, lon: number, radiusM: number, stats: RequestStats): Promise<PlaceResult[]> {
  const { places, pagesFetched } = await fetchAllPaginatedResults<RawPlaceResult>(
    async (pageToken) => {
      stats.textSearch++;
      const body: Record<string, unknown> = {
        textQuery: 'גן שעשועים',
        locationBias: { circle: { center: { latitude: lat, longitude: lon }, radius: radiusM } },
        maxResultCount: 20, languageCode: 'he', regionCode: 'IL',
      };
      if (pageToken) body.pageToken = pageToken;
      const data = await callPlaces(apiKey, 'places:searchText', body, DISCOVERY_FIELD_MASK);
      const pagePlaces = (data.places || []) as RawPlaceResult[];
      stats.googleResults += pagePlaces.length;
      return { places: pagePlaces, nextPageToken: data.nextPageToken as string | undefined };
    },
    { maxPages: MAX_TEXT_SEARCH_PAGES, delayMs: PAGE_TOKEN_DELAY_MS, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
  );
  stats.textSearchPages += pagesFetched;
  if (pagesFetched > 1) stats.settlementsWithExtraPages++;
  return places;
}
// עותק מדויק של has_photos (tools/playground-discovery/google_places.py) - Place Details עם
// field mask "photos" בלבד, לא שומר את התמונה/photo name בעצמה (תנאי-שימוש של Google Maps
// Platform מתירים אחסון-קבע רק ל-place_id) - ראו supabase/functions/place-photo שמפענח את
// זה חדש בכל בקשה. נבדק אוטומטית לכל גן-שעשועים חדש שהריצה הזו עצמה מייבאת (ראו למטה) - בקשת
// המשתמש המפורשת (2026-09-11: "לבדוק אם אפשר למצוא תמונות לגני שעשועים אחרים בקלות") - בלי זה,
// תמונות היו נשארות חסרות עד שמישהו מריץ ידנית את tools/playground-discovery/enrich_images.py.
async function hasPhotos(apiKey: string, placeId: string, stats: RequestStats): Promise<boolean> {
  stats.placeDetails++;
  const res = await fetch(`${PLACES_BASE_URL}/places/${placeId}`, {
    headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'photos' },
  });
  if (!res.ok) throw new Error(`Places API details failed: HTTP ${res.status}`);
  const data = await res.json();
  return !!(data.photos && data.photos.length > 0);
}

function isInBounds(lat: number | null, lon: number | null): boolean {
  if (lat == null || lon == null) return false;
  return lat >= ISRAEL_BOUNDS.minLat && lat <= ISRAEL_BOUNDS.maxLat && lon >= ISRAEL_BOUNDS.minLon && lon <= ISRAEL_BOUNDS.maxLon;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  let role: string | undefined;
  try {
    let payloadB64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (payloadB64.length % 4 !== 0) payloadB64 += '=';
    role = JSON.parse(atob(payloadB64)).role;
  } catch { /* טוקן לא תקין - role נשאר undefined, נדחה למטה */ }
  if (role !== 'service_role') return jsonResponse({ error: 'unauthorized' }, 401);

  const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const apiKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
  if (!apiKey) return jsonResponse({ error: 'GOOGLE_MAPS_API_KEY is not configured' }, 500);

  const { data: settingsRows } = await client.from('automation_settings').select('key, value')
    .in('key', [
      'settlement_scan_enabled', 'settlement_scan_cursor', 'settlement_scan_batch_size',
      'settlement_scan_daily_pro_budget', 'settlement_scan_gap_threshold', 'settlement_scan_radius_m',
      'settlement_scan_excluded_cities', 'settlement_scan_price_id_only_usd', 'settlement_scan_price_text_search_usd',
      'settlement_scan_price_nearby_search_usd', 'settlement_scan_price_place_details_usd',
      'settlement_scan_max_batch_cost_usd',
    ]);
  const settings: Record<string, unknown> = {};
  for (const row of settingsRows || []) settings[(row as { key: string }).key] = (row as { value: unknown }).value;

  if (settings.settlement_scan_enabled === false) return jsonResponse({ skipped: 'disabled' });

  const batchSize = Number(settings.settlement_scan_batch_size ?? 40);
  const dailyProBudget = Number(settings.settlement_scan_daily_pro_budget ?? 8);
  const gapThreshold = Number(settings.settlement_scan_gap_threshold ?? 3);
  const radiusM = Number(settings.settlement_scan_radius_m ?? 3000);
  const excludedCities = new Set((settings.settlement_scan_excluded_cities as string[] | undefined) || ['Qalqilya']);
  let cursor = Number(settings.settlement_scan_cursor ?? 0);
  const priceIdOnly = Number(settings.settlement_scan_price_id_only_usd ?? 0);
  const priceTextSearch = Number(settings.settlement_scan_price_text_search_usd ?? 0.032);
  const priceNearbySearch = Number(settings.settlement_scan_price_nearby_search_usd ?? 0.032);
  const pricePlaceDetails = Number(settings.settlement_scan_price_place_details_usd ?? 0.005);
  const maxBatchCostUsd = Number(settings.settlement_scan_max_batch_cost_usd ?? 2.0);
  const stats = newRequestStats();

  // רשימת-יישובים אמיתית ועצמאית (supabase/0063_settlements.sql, 1,316 יישובים מ-data.gov.il/
  // CBS, 2026-09-11) - במקום לגזור "יישובים" מתוך activities קיימות (הגישה הישנה, cityBuckets):
  // הגישה הישנה הייתה עיוורת ליישוב שאין לו היום אף פעילות אחת - בדיוק היישובים שהכי כדאי לבדוק
  // אם חסרים בהם גני שעשועים. turuCount עדיין נספר לפי שם-עיר מנורמל מתוך activities (אין דרך
  // אחרת לדעת "כמה יש כבר ב-TuRu"), רק מקור-רשימת-היישובים-לבדיקה עצמו השתנה.
  const settlementRows: { settlement_id: string; name_he: string; name_en: string | null; lat: number; lng: number }[] = [];
  {
    const pageSize = 1000;
    let offset = 0;
    // deno-lint-ignore no-explicit-any
    let page: any[];
    do {
      const { data, error } = await client.from('settlements')
        .select('settlement_id, name_he, name_en, lat, lng')
        .not('lat', 'is', null)
        .order('settlement_id')
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      page = data || [];
      settlementRows.push(...(page as typeof settlementRows));
      offset += pageSize;
    } while (page.length === pageSize);
  }

  // כמה גני-שעשועים כבר יש ב-TuRu, לפי שם-עיר מנורמל (locations.city) - נספר פעם אחת על כל
  // ה-activities, לא per-settlement (אותה עלות-שאילתה כמו הגישה הישנה, רק לא מגדירה יותר את
  // רשימת-היישובים עצמה).
  const cityPlaygroundCounts = new Map<string, number>();
  {
    const pageSize = 1000;
    let offset = 0;
    // deno-lint-ignore no-explicit-any
    let page: any[];
    do {
      const { data, error } = await client.from('activities')
        .select('category, location:locations(city)')
        .in('category', PLAYGROUND_CATEGORIES)
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      page = data || [];
      for (const row of page) {
        const loc = row.location as { city: string | null } | null;
        const cityRaw = loc?.city?.trim();
        if (!cityRaw) continue;
        const city = normalizeCityName(cityRaw)!;
        cityPlaygroundCounts.set(city, (cityPlaygroundCounts.get(city) || 0) + 1);
      }
      offset += pageSize;
    } while (page.length === pageSize);
  }

  // שני השמות (עברי+לועזי) נבדקים מול excludedCities - הרשימה הישנה שהוגדרה כברירת מחדל
  // ('Qalqilya') הייתה באנגלית; הרשימה הרשמית של רשות האוכלוסין לא כוללת בפועל את קלקיליה (עיר
  // פלסטינית, לא נמצאה ב-public.settlements) - אבל היא כן כוללת כמה יישובים ביו"ש/שטח פלסטיני
  // מנוהל שהיו רשומים היסטורית (למשל "חברון") שכדאי לשקול הוספה מפורשת ל-settlement_scan_
  // excluded_cities אם הם לא רלוונטיים לשוק-המטרה של TuRu - לא הוחלט/הוסר כאן באופן חד-צדדי.
  const settlements = settlementRows
    .map((s) => ({
      settlementId: s.settlement_id,
      city: normalizeCityName(s.name_he) || s.name_he, nameEn: s.name_en,
      lat: s.lat, lng: s.lng,
      turuCount: cityPlaygroundCounts.get(normalizeCityName(s.name_he) || s.name_he) || 0,
    }))
    .filter((s) => !excludedCities.has(s.city) && !(s.nameEn && excludedCities.has(s.nameEn)))
    .sort((a, b) => a.city.localeCompare(b.city)); // סדר יציב - כדי שה-cursor יתקדם בעקביות בין הרצות

  if (settlements.length === 0) return jsonResponse({ error: 'no settlements found' }, 500);
  // בלי גלגול-חזור (modulo) - ה-cursor רק מתקדם, לעולם לא חוזר ל-0 מעצמו. אם cursor ישן חורג
  // ממספר-היישובים הנוכחי (למשל אחרי reset_settlement_scan עם רשימה שהצטמצמה) - קלאמפ בטוח.
  cursor = Math.min(cursor, settlements.length);
  const batchEnd = Math.min(cursor + batchSize, settlements.length);
  const batch = settlements.slice(cursor, batchEnd);
  const isLastBatch = batchEnd >= settlements.length;

  // תקציב-מוקדם (בקשת המשתמש 2026-09-12: "לפני כל Batch חשב estimated cost. אם העלות הצפויה
  // גבוהה מה-budget שהוגדר - עצור לפני ביצוע") - worst-case: כל היישובים באצווה עוברים בדיקה
  // זולה + עד dailyProBudget מילויים יקרים, כל אחד עם בדיקת-תמונה - לא התוצאה בפועל (שעדיין
  // לא ידועה בשלב הזה), חסם עליון אמיתי לפני שמתבצעת ולו קריאת API אחת.
  // MAX_TEXT_SEARCH_PAGES כפול priceTextSearch - 2026-09-12: כל עמוד-פאג'ינציה של Google הוא
  // Text Search נפרד וחייב-בתשלום כמו הראשון, אז worst-case חייב להניח שכל יישוב-מילוי ממצה
  // את כל העמודים, לא רק עמוד אחד.
  const worstCaseCost = batch.length * priceIdOnly
    + dailyProBudget * (priceTextSearch * MAX_TEXT_SEARCH_PAGES + pricePlaceDetails);
  if (worstCaseCost > maxBatchCostUsd) {
    await client.from('settlement_scan_runs').insert({
      status: 'aborted_budget', completed_at: new Date().toISOString(),
      settlements_processed: 0, settlements_remaining: settlements.length - cursor,
      settlement_ids: batch.map((s) => s.settlementId),
      estimated_cost_usd: worstCaseCost,
      last_settlement_id: batch.length ? batch[0].settlementId : null,
      notes: `Aborted before any API calls - worst-case estimate $${worstCaseCost.toFixed(4)} exceeds settlement_scan_max_batch_cost_usd=$${maxBatchCostUsd}`,
    });
    return jsonResponse({ aborted: 'budget_exceeded', estimated_cost_usd: worstCaseCost, max_batch_cost_usd: maxBatchCostUsd });
  }

  const { data: runRow, error: runInsertError } = await client.from('settlement_scan_runs').insert({
    status: 'running',
    settlements_processed: batch.length,
    settlement_ids: batch.map((s) => s.settlementId),
    estimated_cost_usd: worstCaseCost,
  }).select('id').single();
  if (runInsertError) console.error('Failed to insert settlement_scan_runs row:', runInsertError.message);
  const runId = (runRow as { id: string } | null)?.id ?? null;

  // שלב 1: בדיקה זולה (Essentials SKU) על האצווה הזו בלבד.
  const flagged: { city: string; lat: number; lng: number; turuCount: number; googleCount: number; gap: number }[] = [];
  const checkErrors: { city: string; error: string }[] = [];
  for (const s of batch) {
    try {
      const googleCount = await countNearbyIds(apiKey, s.lat, s.lng, radiusM, stats);
      const gap = googleCount - s.turuCount;
      if (gap >= gapThreshold) flagged.push({ ...s, googleCount, gap });
    } catch (err) {
      checkErrors.push({ city: s.city, error: err instanceof Error ? err.message : String(err) });
    }
  }
  flagged.sort((a, b) => b.gap - a.gap);
  const toFill = flagged.slice(0, dailyProBudget);

  // שלב 2: חיפוש-טקסט אמיתי (Pro-tier) רק על מה שאושר ע"י הסף+תקציב, ומייבא ישירות (בלי תור-
  // בדיקה) - בדיוק כמו settlement_gap_fill.py, כולל אותו הגנת-כפילויות-תוך-ריצה (existing
  // מתעדכן אחרי כל ייבוא, לא רק נטען פעם אחת - ראו 2026-09-11, אותו באג שתוקן ב-scan-source
  // וב-playground_discovery.py).
  //
  // 2026-09-12 תיקון קריטי: קריאה בלי .range() מקבלת בשקט רק את 1000 השורות הראשונות
  // (מגבלת ברירת-המחדל של PostgREST/Supabase) - מתוך 4,850 גני-שעשועים בפועל, כלומר ~79%
  // מהקטלוג היו "בלתי-נראים" לבדיקת-הכפילויות מאז ומעולם. זה מה שגרם ל-14 שגיאות
  // idx_activities_google_place_id ב-Batch 2 (מקומות שכבר קיימים ולא היו ב-1000 שהוחזרו,
  // אז matchAgainstExisting פספס אותם וה-insert נכשל רק בזכות ה-unique constraint שהציל
  // אותנו מכפילות אמיתית). דפדוף מלא בעמודים של 1000 - לא רק להעלות limit, כי הקטלוג רק יגדל.
  const existingRows: { id: string; name: string | null; google_place_id: string | null; location: unknown }[] = [];
  const PAGE_SIZE = 1000;
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: page, error: pageErr } = await client.from('activities')
      .select('id, name, google_place_id, location:locations(lat, lng)')
      .in('category', PLAYGROUND_CATEGORIES)
      .range(from, from + PAGE_SIZE - 1);
    if (pageErr) { console.error('Failed to page existing activities:', pageErr.message); break; }
    existingRows.push(...(page || []) as typeof existingRows);
    if (!page || page.length < PAGE_SIZE) break;
  }
  const existing: ExistingForMatch[] = (existingRows || []).map((r) => {
    const loc = r.location as { lat: number | null; lng: number | null } | null;
    return { id: r.id as string, name: r.name as string | null, google_place_id: r.google_place_id as string | null, lat: loc?.lat ?? null, lon: loc?.lng ?? null };
  });

  // 2026-09-11 fix - "אם המקור נראה לגיטימי ויש כתובת, לאשר אוטומטית; אחרת - לבדיקה" (בקשת
  // המשתמש המפורשת). לפני התיקון: PARK/UNCERTAIN וגם STRONG_MATCH/NEEDS_REVIEW (מול פעילות
  // קיימת) פשוט דולגו (continue) בלי עקבה כלשהי - שום מקום באפליקציה לא הראה אותם למנהל.
  // עכשיו הם נכתבים ל-incoming_activities (status='needs_review', אותו תור-בדיקה שכבר קיים
  // ל-scan-source) - הכתיבה קלה כאן: ה-Edge Function רץ עם service_role (עוקף RLS), בניגוד
  // ל-tools/playground-discovery/supabase_client.py (בוט מאומת, נדרשה מדיניות INSERT נפרדת -
  // ראו migration 0062). "לא רלוונטי בעליל" (NOT_RELEVANT) עדיין מדולג בשקט - זה לא מקרה-גבול,
  // זו טעות-סוג ברורה (למשל בית ספר/חנות), אין למי להציג לבדיקה.
  async function queueForReview(params: {
    pageUrl: string | null; matchType: 'new' | 'duplicate'; existingActivityId: string | null;
    confidenceScore: number; issue: string; city: string; placeId: string; name: string | null;
    address: string | null; lat: number | null; lon: number | null; kind: string;
  }) {
    const { error } = await client.from('incoming_activities').insert({
      page_url: params.pageUrl || 'https://www.google.com/maps',
      match_type: params.matchType,
      existing_activity_id: params.existingActivityId,
      confidence_score: params.confidenceScore,
      status: 'needs_review',
      validation_issues: [params.issue],
      extracted_data: {
        name: params.name, formatted_address: params.address, lat: params.lat, lon: params.lon,
        google_place_id: params.placeId, place_kind: params.kind, city: params.city,
      },
    });
    if (error) importErrors.push({ city: params.city, error: `incoming_activities insert failed: ${error.message}` });
    else queuedForReview++;
  }

  let imported = 0;
  let queuedForReview = 0;
  const importErrors: { city: string; error: string }[] = [];
  const importedNames: string[] = [];
  const seenPlaceIds = new Set<string>(); // candidates_found = ייחודי, google_results = גולמי (stats.googleResults)
  // Funnel - בקשת המשתמש (batch-3 validation): לדעת כמה שרדו כל שלב סינון בנפרד, לא רק "נדחו
  // בסך הכל". סדר תואם בדיוק לסדר-הבדיקות בפועל למטה: מרחק -> סוג -> כפילות.
  let candidatesAfterDistanceFilter = 0;
  let candidatesAfterTypeFilter = 0;
  let candidatesAfterDuplicateFilter = 0;

  // עותק-אחת-לכל-מועמד-שעבר-fill ל-settlement_scan_candidates (0066) - בקשת המשתמש המפורשת:
  // "שמור source settlement ID/name כדי שבעתיד נוכל לדעת מאיזה settlement החיפוש יצר אותו".
  // כשל בכתיבת-הלוג עצמו לעולם לא אמור להפיל את הסריקה (זה תיעוד, לא לוגיקה) - console.error
  // בלבד, לא throw.
  async function logCandidate(params: {
    settlementId: string; settlementName: string; placeId: string | null; name: string | null;
    address: string | null; lat: number | null; lon: number | null; kind: string | null;
    distanceM: number | null; page: number; outcome: string;
    matchedActivityId?: string | null; createdActivityId?: string | null;
  }) {
    const { error } = await client.from('settlement_scan_candidates').insert({
      batch_id: runId, settlement_id: params.settlementId, settlement_name: params.settlementName,
      google_place_id: params.placeId, name: params.name, formatted_address: params.address,
      lat: params.lat, lon: params.lon, place_kind: params.kind,
      distance_from_settlement_m: params.distanceM, page_number: params.page, outcome: params.outcome,
      matched_existing_activity_id: params.matchedActivityId ?? null,
      created_activity_id: params.createdActivityId ?? null,
    });
    if (error) console.error('Failed to log settlement_scan_candidates row:', error.message);
  }

  for (const s of toFill) {
    let places: PlaceResult[];
    try {
      places = await searchTextPlaygrounds(apiKey, s.lat, s.lng, radiusM, stats);
    } catch (err) {
      importErrors.push({ city: s.city, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    for (const p of places) {
      const placeId = p.id;
      const page = p._page ?? 1;
      if (!placeId) {
        stats.rejected++;
        await logCandidate({ settlementId: s.settlementId, settlementName: s.city, placeId: null, name: (p.displayName || {}).text ?? null, address: p.formattedAddress ?? null, lat: null, lon: null, kind: null, distanceM: null, page, outcome: 'rejected_missing_place_id' });
        continue;
      }
      seenPlaceIds.add(placeId);
      const lat = p.location?.latitude ?? null;
      const lon = p.location?.longitude ?? null;
      const name = (p.displayName || {}).text || null;
      const address = p.formattedAddress as string | null;
      const distanceM = lat != null && lon != null ? Math.round(haversineKm(s.lat, s.lng, lat, lon) * 1000) : null;
      if (!isInBounds(lat, lon)) {
        stats.rejected++;
        await logCandidate({ settlementId: s.settlementId, settlementName: s.city, placeId, name, address, lat, lon, kind: null, distanceM, page, outcome: 'rejected_out_of_bounds' });
        continue;
      }
      // 2026-09-12 fix - נמצא בפועל ב-Batch 1 הראשון: places:searchText עם locationBias (לא
      // locationRestriction) הוא רק "העדפה" ל-Google, לא הגבלה קשיחה - תוצאות רלוונטיות-לטקסט
      // אבל רחוקות ממש (נצפו בפועל עד 41 ק"מ, מ-radiusM=3 ק"מ!) חוזרות בכל זאת ל"מילוי" יישובים
      // קטנים בלי הרבה תוצאות אמיתיות משלהם. איך זה נתפס: 23/63 מהתוצאות שנכתבו ל-incoming_
      // activities ב-Batch 1 היו מעל 6 ק"מ מהיישוב שחיפשנו סביבו (חלקן עד פארק איינשטיין בנתניה
      // כשחיפשנו סביב "אבירים" בגליל המערבי!). בדיקת-מרחק מפורשת כאן - לא רק isInBounds (שבודק
      // רק "בישראל", תיבה ענקית) - חייבת לרוץ *לפני* הסיווג/הצירוף לתור, אחרת תוצאות רחוקות
      // ממשיכות "לזהם" גם את תור-הבדיקה. סף 2x הרדיוס המבוקש (לא בדיוק הרדיוס) - מרווח סביר
      // לאי-דיוק גיאוקוד של מרכז-היישוב עצמו, לא ניחוש שרירותי.
      if (haversineKm(s.lat, s.lng, lat, lon) > (radiusM / 1000) * 2) {
        stats.rejected++;
        await logCandidate({ settlementId: s.settlementId, settlementName: s.city, placeId, name, address, lat, lon, kind: null, distanceM, page, outcome: 'rejected_distance' });
        continue;
      }
      candidatesAfterDistanceFilter++;
      const kind = classifyPlace({ primaryType: p.primaryType ?? null, types: p.types || [], name });
      if (kind === 'NOT_RELEVANT') {
        stats.rejected++; // טעות-סוג ברורה (למשל חנות/בית ספר) - לא גבולי, אין מה לבדוק
        await logCandidate({ settlementId: s.settlementId, settlementName: s.city, placeId, name, address, lat, lon, kind, distanceM, page, outcome: 'rejected_not_relevant' });
        continue;
      }
      candidatesAfterTypeFilter++;

      const { outcome, match } = matchAgainstExisting({ place_id: placeId, name, lat, lon }, existing);
      if (outcome === 'MATCH_CONFIRMED') {
        stats.duplicates++; // ודאי כבר קיים - אין מה לבדוק, אין מה לייבא
        await logCandidate({ settlementId: s.settlementId, settlementName: s.city, placeId, name, address, lat, lon, kind, distanceM, page, outcome: 'duplicate_confirmed', matchedActivityId: match?.id !== 'pending' ? match?.id : null });
        continue;
      }

      if (outcome === 'STRONG_MATCH' || outcome === 'POSSIBLE_DUPLICATE' || outcome === 'NEEDS_REVIEW') {
        // 2026-09-12 (post-Batch-6 three-zone model): POSSIBLE_DUPLICATE gets its own confidence
        // tier (between STRONG_MATCH's 0.6 and the weak NEEDS_REVIEW's 0.3) and its own distinct
        // validation_issues tag - per explicit instruction, it must stay visible as its own
        // reviewer-facing category, not folded into STRONG_MATCH's wording or count.
        const confidenceScore = outcome === 'STRONG_MATCH' ? 0.6 : outcome === 'POSSIBLE_DUPLICATE' ? 0.45 : 0.3;
        await queueForReview({
          pageUrl: p.googleMapsUri ?? null, matchType: 'duplicate',
          existingActivityId: match && match.id !== 'pending' ? match.id : null,
          confidenceScore,
          issue: `possible_duplicate_of_existing:${outcome}`, city: s.city, placeId, name, address, lat, lon, kind,
        });
        const candidateOutcome = outcome === 'STRONG_MATCH' ? 'strong_match' : outcome === 'POSSIBLE_DUPLICATE' ? 'possible_duplicate' : 'needs_review_possible_duplicate';
        await logCandidate({ settlementId: s.settlementId, settlementName: s.city, placeId, name, address, lat, lon, kind, distanceM, page, outcome: candidateOutcome, matchedActivityId: match?.id !== 'pending' ? match?.id : null });
        continue;
      }
      candidatesAfterDuplicateFilter++;

      // outcome === 'NEW_CANDIDATE' מכאן - "לגיטימי" = סוג-מקום ברור (לא PARK/UNCERTAIN,
      // שדורשים עין אדם: פארק בלי סימן-משחקים מובהק, או סוג לא-חד-משמעי) + יש כתובת בפועל.
      const legitType = kind === 'PLAYGROUND' || kind === 'PARK_WITH_PLAYGROUND';
      if (!legitType || !address) {
        await queueForReview({
          pageUrl: p.googleMapsUri ?? null, matchType: 'new', existingActivityId: null,
          confidenceScore: !legitType ? 0.4 : 0.5,
          issue: !legitType ? `uncertain_type:${kind}` : 'missing_address', city: s.city, placeId, name, address, lat, lon, kind,
        });
        await logCandidate({ settlementId: s.settlementId, settlementName: s.city, placeId, name, address, lat, lon, kind, distanceM, page, outcome: !legitType ? 'needs_review_uncertain_type' : 'needs_review_missing_address' });
        continue;
      }

      let finalName = name || 'גן שעשועים';
      let nameSource: string | null = null;
      if (!isGenericPlaygroundName(finalName)) {
        nameSource = 'official';
      } else {
        const naming = generatePlaygroundDisplayName({ officialName: finalName, address, city: extractCityFromAddress(address) });
        if (naming.name) { finalName = naming.name; nameSource = naming.nameSource; }
      }

      const { data: locRow, error: locErr } = await client.from('locations')
        .insert({ name: finalName, address, city: extractCityFromAddress(address), lat, lng: lon })
        .select('id').single();
      if (locErr) { importErrors.push({ city: s.city, error: locErr.message }); continue; }

      const { data: actRow, error: actErr } = await client.from('activities').insert({
        name: finalName, name_source: nameSource, entity_type: 'מקום_קבוע', location_id: (locRow as { id: string }).id,
        category: 'גן שעשועים', placeholder_group: 'PLAY_AND_FUN', price_type: 'free', price_amount: 0,
        indoor_outdoor: 'outdoor', booking_requirement: 'none', status: 'approved', source: 'scraped',
        source_url: p.googleMapsUri ?? null, google_place_id: placeId, created_by: null,
      }).select('id').single();
      if (actErr) { importErrors.push({ city: s.city, error: actErr.message }); continue; }

      imported++;
      importedNames.push(`${finalName} (${s.city})`);
      existing.push({ id: 'pending', name: finalName, google_place_id: placeId, lat, lon }); // מונע כפילות תוך-ריצה
      await logCandidate({ settlementId: s.settlementId, settlementName: s.city, placeId, name: finalName, address, lat, lon, kind, distanceM, page, outcome: 'new', createdActivityId: (actRow as { id: string }).id });

      // תמונה אמיתית מיד, לא רק שם/כתובת - קריאת Place Details נוספת (photos בלבד) פר-גן-חדש,
      // מוגבל טבעית ל-daily_pro_budget מקומות/יום (אותו גבול-תקציב כמו החיפוש עצמו) - לא עלות
      // בלתי-חסומה. כשל בבדיקת-תמונה לא נחשב import error (הגן עצמו כבר נשמר בהצלחה).
      try {
        if (await hasPhotos(apiKey, placeId, stats)) {
          await client.from('activity_images').insert({
            activity_id: (actRow as { id: string }).id,
            url: `${Deno.env.get('SUPABASE_URL')}/functions/v1/place-photo/${placeId}`,
            uploaded_by: null, image_source_type: 'PROVIDER', image_source_url: p.googleMapsUri ?? null,
          });
        }
      } catch (err) {
        console.error('Photo check failed for', placeId, err instanceof Error ? err.message : String(err));
      }
    }
  }

  const nextCursor = batchEnd;
  const rows: { key: string; value: unknown }[] = [{ key: 'settlement_scan_cursor', value: nextCursor }];
  if (isLastBatch) {
    // סבב שלם הושלם - מכבה את עצמו (לא רק את ה-cron job, שנשאר רשום: הריצה הבאה תבדוק את
    // הדגל הזה ותצא מיד, בלי לבצע שום קריאת API). settlement_scan_completed_at מבדיל את זה
    // מ"מישהו כיבה ידנית" - ראו reset_settlement_scan() (0060) להפעלת סבב נוסף בעתיד.
    rows.push({ key: 'settlement_scan_enabled', value: false });
    rows.push({ key: 'settlement_scan_completed_at', value: new Date().toISOString() });
  }
  await client.from('automation_settings').upsert(rows);

  // סגירת שורת-הלוג (settlement_scan_runs, 0064) - זה מה שפותר את "אי אפשר לדעת בדיעבד כמה
  // API calls בוצעו" (בקשת המשתמש 2026-09-12): התוצאה האמיתית נשמרת ב-DB ישירות, לא רק
  // ב-JSON-תגובה שהולך ל-pg_net (שלא שומר תגובות בפרויקט הזה - ראו Batch 1).
  const totalErrors = checkErrors.length + importErrors.length;
  const failedCities = new Set([...checkErrors, ...importErrors].map((e) => e.city));
  const totalGoogleRequests = stats.idOnly + stats.textSearch + stats.nearbySearch + stats.placeDetails;
  const actualEstimatedCost = stats.idOnly * priceIdOnly + stats.textSearch * priceTextSearch
    + stats.nearbySearch * priceNearbySearch + stats.placeDetails * pricePlaceDetails;
  if (runId) {
    await client.from('settlement_scan_runs').update({
      completed_at: new Date().toISOString(),
      status: totalErrors > 0 ? 'partial' : 'success',
      settlements_processed: batch.length,
      settlements_failed: failedCities.size,
      settlements_remaining: settlements.length - nextCursor,
      id_only_requests: stats.idOnly,
      text_search_requests: stats.textSearch,
      nearby_search_requests: stats.nearbySearch,
      place_details_requests: stats.placeDetails,
      total_google_requests: totalGoogleRequests,
      google_results: stats.googleResults,
      candidates_found: seenPlaceIds.size,
      new_playgrounds: imported,
      duplicates: stats.duplicates,
      needs_review: queuedForReview,
      rejected: stats.rejected,
      estimated_cost_usd: actualEstimatedCost,
      last_settlement_id: batch.length ? batch[batch.length - 1].settlementId : null,
      error_count: totalErrors,
      error_message: totalErrors > 0 ? [...checkErrors, ...importErrors][0]?.error ?? null : null,
      settlements_with_expensive_fill: toFill.length,
      candidates_after_distance_filter: candidatesAfterDistanceFilter,
      candidates_after_type_filter: candidatesAfterTypeFilter,
      candidates_after_duplicate_filter: candidatesAfterDuplicateFilter,
      text_search_pages: stats.textSearchPages,
      settlements_with_extra_pages: stats.settlementsWithExtraPages,
    }).eq('id', runId);
  }

  const daysRemaining = Math.max(0, Math.ceil((settlements.length - nextCursor) / batchSize));
  try {
    await sendDailySummaryEmail({
      imported, importedNames, checked: batch.length, totalSettlements: settlements.length,
      nextCursor, daysRemaining, completed: isLastBatch,
      errorCount: checkErrors.length + importErrors.length, queuedForReview,
    });
  } catch (err) {
    console.error('Daily summary email threw:', err instanceof Error ? err.message : String(err));
  }

  return jsonResponse({
    total_settlements: settlements.length, checked: batch.length, next_cursor: nextCursor,
    completed: isLastBatch, days_remaining: daysRemaining,
    flagged: flagged.length, filled: toFill.length, imported, imported_names: importedNames,
    queued_for_review: queuedForReview,
    check_errors: checkErrors, import_errors: importErrors,
  });
});
