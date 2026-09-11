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
//      כמו GAP_THRESHOLD הקיים) - חיפוש-טקסט אמיתי (Pro-tier, יקר משמעותית) שמייבא ישירות את
//      התוצאות שאינן כפילות. מוגבל בפועל ל-settlement_scan_daily_pro_budget יישובים/הרצה (הכי-
//      גדול-פער קודם) כדי שהעלות היקרה תישאר חסומה-תקציב ולא תגדל בלי גבול אם יום אחד מתגלים
//      הרבה פערים בבת אחת.
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
import { classifyPlace, matchAgainstExisting, extractCityFromAddress, type ExistingForMatch } from '../_shared/placesDiscovery.ts';
import { generatePlaygroundDisplayName, isGenericPlaygroundName } from '../_shared/playgroundNaming.ts';
import { normalizeCityName } from '../_shared/cityNaming.ts';

const PLACES_BASE_URL = 'https://places.googleapis.com/v1';
const IDS_ONLY_FIELD_MASK = 'places.id';
const DISCOVERY_FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.primaryType,places.googleMapsUri';
// גבולות ישראל הרחבים - זהים בדיוק ל-DEFAULT_ISRAEL_BOUNDS (tools/playground-discovery/israel_geo.py) -
// לא שכפול-בטעות, שני runtimes (Python CLI מקומי מול Deno Edge Function) לא יכולים לחלוק קובץ אחד.
const ISRAEL_BOUNDS = { minLat: 29.45, maxLat: 33.35, minLon: 34.20, maxLon: 35.95 };

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
  nextCursor: number; daysRemaining: number; completed: boolean; errorCount: number;
}) {
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) { console.warn('RESEND_API_KEY not configured - skipping daily summary email'); return; }

  const { imported, importedNames, checked, totalSettlements, nextCursor, daysRemaining, completed, errorCount } = params;
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

  const html = `<div dir="rtl" style="font-family: Arial, sans-serif; font-size: 15px; line-height: 1.6;">` +
    `<p>נבדקו ${checked} יישובים היום.</p>` +
    `<p><b>${imported} גני שעשועים חדשים נוספו:</b></p>` +
    namesList + progressLine + errorLine +
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

async function countNearbyIds(apiKey: string, lat: number, lon: number, radiusM: number): Promise<number> {
  const data = await callPlaces(apiKey, 'places:searchNearby', {
    locationRestriction: { circle: { center: { latitude: lat, longitude: lon }, radius: radiusM } },
    maxResultCount: 20, rankPreference: 'DISTANCE', includedTypes: ['playground', 'park'],
  }, IDS_ONLY_FIELD_MASK);
  return (data.places || []).length;
}

// deno-lint-ignore no-explicit-any
async function searchTextPlaygrounds(apiKey: string, lat: number, lon: number, radiusM: number): Promise<any[]> {
  const data = await callPlaces(apiKey, 'places:searchText', {
    textQuery: 'גן שעשועים',
    locationBias: { circle: { center: { latitude: lat, longitude: lon }, radius: radiusM } },
    maxResultCount: 20, languageCode: 'he', regionCode: 'IL',
  }, DISCOVERY_FIELD_MASK);
  return data.places || [];
}

function isInBounds(lat: number | null, lon: number | null): boolean {
  if (lat == null || lon == null) return false;
  return lat >= ISRAEL_BOUNDS.minLat && lat <= ISRAEL_BOUNDS.maxLat && lon >= ISRAEL_BOUNDS.minLon && lon <= ISRAEL_BOUNDS.maxLon;
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
      'settlement_scan_excluded_cities',
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

  // רשימת-יישובים + מרכז-משוער + כמה גני-שעשועים יש כבר - זהה בעקרון ל-fetch_settlement_
  // centroids (Python), רק עם עיר מנורמלת (ראו הערת-הכותרת) כדי שלא ליצור "יישוב כפול" מאיות שונה.
  const cityBuckets = new Map<string, { latSum: number; lonSum: number; n: number; playgroundCount: number }>();
  {
    const pageSize = 1000;
    let offset = 0;
    // deno-lint-ignore no-explicit-any
    let page: any[];
    do {
      const { data, error } = await client.from('activities')
        .select('category, location:locations(city, lat, lng)')
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      page = data || [];
      for (const row of page) {
        const loc = row.location as { city: string | null; lat: number | null; lng: number | null } | null;
        const cityRaw = loc?.city?.trim();
        if (!cityRaw || loc?.lat == null || loc?.lng == null) continue;
        const city = normalizeCityName(cityRaw)!;
        if (excludedCities.has(city)) continue;
        const bucket = cityBuckets.get(city) || { latSum: 0, lonSum: 0, n: 0, playgroundCount: 0 };
        bucket.latSum += loc.lat; bucket.lonSum += loc.lng; bucket.n += 1;
        if (row.category === 'גן שעשועים') bucket.playgroundCount += 1;
        cityBuckets.set(city, bucket);
      }
      offset += pageSize;
    } while (page.length === pageSize);
  }
  const settlements = [...cityBuckets.entries()]
    .map(([city, b]) => ({ city, lat: b.latSum / b.n, lng: b.lonSum / b.n, turuCount: b.playgroundCount }))
    .sort((a, b) => a.city.localeCompare(b.city)); // סדר יציב - כדי שה-cursor יתקדם בעקביות בין הרצות

  if (settlements.length === 0) return jsonResponse({ error: 'no settlements found' }, 500);
  // בלי גלגול-חזור (modulo) - ה-cursor רק מתקדם, לעולם לא חוזר ל-0 מעצמו. אם cursor ישן חורג
  // ממספר-היישובים הנוכחי (למשל אחרי reset_settlement_scan עם רשימה שהצטמצמה) - קלאמפ בטוח.
  cursor = Math.min(cursor, settlements.length);
  const batchEnd = Math.min(cursor + batchSize, settlements.length);
  const batch = settlements.slice(cursor, batchEnd);
  const isLastBatch = batchEnd >= settlements.length;

  // שלב 1: בדיקה זולה (Essentials SKU) על האצווה הזו בלבד.
  const flagged: { city: string; lat: number; lng: number; turuCount: number; googleCount: number; gap: number }[] = [];
  const checkErrors: { city: string; error: string }[] = [];
  for (const s of batch) {
    try {
      const googleCount = await countNearbyIds(apiKey, s.lat, s.lng, radiusM);
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
  const { data: existingRows } = await client.from('activities')
    .select('id, name, google_place_id, location:locations(lat, lng)')
    .eq('category', 'גן שעשועים');
  const existing: ExistingForMatch[] = (existingRows || []).map((r) => {
    const loc = r.location as { lat: number | null; lng: number | null } | null;
    return { id: r.id as string, name: r.name as string | null, google_place_id: r.google_place_id as string | null, lat: loc?.lat ?? null, lon: loc?.lng ?? null };
  });

  let imported = 0;
  const importErrors: { city: string; error: string }[] = [];
  const importedNames: string[] = [];
  for (const s of toFill) {
    // deno-lint-ignore no-explicit-any
    let places: any[];
    try {
      places = await searchTextPlaygrounds(apiKey, s.lat, s.lng, radiusM);
    } catch (err) {
      importErrors.push({ city: s.city, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    for (const p of places) {
      const placeId = p.id as string | undefined;
      if (!placeId) continue;
      const lat = p.location?.latitude ?? null;
      const lon = p.location?.longitude ?? null;
      if (!isInBounds(lat, lon)) continue;
      const name = (p.displayName || {}).text || null;
      const kind = classifyPlace({ primaryType: p.primaryType ?? null, types: p.types || [], name });
      if (kind !== 'PLAYGROUND' && kind !== 'PARK_WITH_PLAYGROUND') continue; // PARK/UNCERTAIN - סקירה ידנית, לא אוטומטי (ראו הערת-הכותרת)
      const outcome = matchAgainstExisting({ place_id: placeId, name, lat, lon }, existing);
      if (outcome !== 'NEW_CANDIDATE') continue;

      const address = p.formattedAddress as string | null;
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

      const { error: actErr } = await client.from('activities').insert({
        name: finalName, name_source: nameSource, entity_type: 'מקום_קבוע', location_id: (locRow as { id: string }).id,
        category: 'גן שעשועים', placeholder_group: 'PLAY_AND_FUN', price_type: 'free', price_amount: 0,
        indoor_outdoor: 'outdoor', booking_requirement: 'none', status: 'approved', source: 'scraped',
        source_url: p.googleMapsUri ?? null, google_place_id: placeId, created_by: null,
      }).select('id').single();
      if (actErr) { importErrors.push({ city: s.city, error: actErr.message }); continue; }

      imported++;
      importedNames.push(`${finalName} (${s.city})`);
      existing.push({ id: 'pending', name: finalName, google_place_id: placeId, lat, lon }); // מונע כפילות תוך-ריצה
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

  const daysRemaining = Math.max(0, Math.ceil((settlements.length - nextCursor) / batchSize));
  try {
    await sendDailySummaryEmail({
      imported, importedNames, checked: batch.length, totalSettlements: settlements.length,
      nextCursor, daysRemaining, completed: isLastBatch,
      errorCount: checkErrors.length + importErrors.length,
    });
  } catch (err) {
    console.error('Daily summary email threw:', err instanceof Error ? err.message : String(err));
  }

  return jsonResponse({
    total_settlements: settlements.length, checked: batch.length, next_cursor: nextCursor,
    completed: isLastBatch, days_remaining: daysRemaining,
    flagged: flagged.length, filled: toFill.length, imported, imported_names: importedNames,
    check_errors: checkErrors, import_errors: importErrors,
  });
});
