// TuRu - ייבוא חד-פעמי, ארצי, של גני שעשועים מ-OpenStreetMap (Overpass API).
// לא סקריפט מתוזמן/רץ-ברקע - מריצים פעם אחת, ידנית, ומוחקים/משאירים לפי הצורך.
// שימוש חוזר מלא בדפוסים הקיימים: getClient() (tools/import-tool/supabase.js), shape של
// saveNewActivity (server.js) לשמירת locations/activities, ARCHIVE_CATEGORIES/status='approved'
// לתוכן-שנסרק (בדיוק כמו שכל תוכן-שנסרק אחר כבר נכנס למערכת - לא ממציאים workflow חדש).
//
// Google Places API לא נכלל בסבב הזה: אין credentials/billing מוגדרים בפרויקט (אומת ב-audit),
// ויש הגבלת-שימוש אמיתית ב-Google Maps Platform Terms על אחסון-קבע של Places data מחוץ להקשר
// Google Maps - שני אלה הם בדיוק חריגים שהמשתמש עצמו הגדיר לעצירה. OSM בלבד ל-source הזה.

require('dotenv').config();
const { getClient } = require('./supabase');

const DRY_RUN_ONLY = process.argv.includes('--dry-run-only');

// ---- כיסוי גיאוגרפי: 4 אזורים חופפים (bounding boxes), במקום שאילתה ארצית ענקית אחת -
// עמידות טובה יותר ל-timeout/כשל חלקי, מאפשר retry/resume per-region (שלב 22 בבקשה).
const REGIONS = [
  { key: 'north', label: 'צפון (כולל חיפה)', bbox: [32.55, 34.80, 33.35, 35.95] },
  { key: 'center', label: 'מרכז (כולל שרון ות"א)', bbox: [31.70, 34.45, 32.65, 35.30] },
  { key: 'jerusalem', label: 'ירושלים והסביבה', bbox: [31.55, 34.85, 31.95, 35.45] },
  { key: 'south', label: 'דרום (כולל אילת)', bbox: [29.45, 34.20, 31.75, 35.55] },
];

// overpass-api.de/overpass.kumi.systems לא ניתנים להשגה מהרשת של הסביבה הזו (timeout מוחלט,
// אומת ישירות עם curl -v - בעיית-קישוריות-רשת, לא בעיה בשאילתה). overpass.osm.ch כן מגיב אבל
// עם מסד-נתונים ריק/לא-מסונכרן (timestamp_osm_base חשוד, אפס תוצאות גם לשאילתות-סניטי בסיסיות
// כמו amenity=cafe בתל אביב) - הוסר מהרשימה כי "מצליח אבל מחזיר ריק" מסוכן יותר מ"נכשל בגלוי".
// overpass.openstreetmap.fr אומת ידנית כעובד עם נתונים אמיתיים (56 תוצאות אמיתיות בתיבת-בדיקה
// קטנה בתל אביב) - endpoint ראשי. overpass-api.de/kumi נשארים כ-fallback למקרה שהחסימה זמנית.
const OVERPASS_ENDPOINTS = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

function overpassQuery([s, w, n, e]) {
  return `[out:json][timeout:90];(node["leisure"="playground"](${s},${w},${n},${e});way["leisure"="playground"](${s},${w},${n},${e});relation["leisure"="playground"](${s},${w},${n},${e}););out center tags;`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Retry עם exponential backoff, מעבר לendpoint ציבורי חלופי אם הראשי נכשל, timeout, וטיפול
// מפורש ב-429/5xx (שלב 7 בבקשה) - בלי concurrency (בקשה אחת בכל פעם, ברווח בין אזורים).
async function fetchOverpassRegion(region) {
  const query = overpassQuery(region.bbox);
  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain',
            // ללא User-Agent מזהה, כמה מראות Overpass ציבוריות מחזירות 403 (נצפה בפועל,
            // אומת ידנית מול overpass.openstreetmap.fr) - אותה מדיניות בדיוק כמו Nominatim
            // (_shared/geocoding.ts, server.js queryNominatim) שכבר דורשת UA מזהה.
            'User-Agent': 'TuRu-KidsApp/1.0 (one-time playground import; contact: mborenmusic@gmail.com)',
          },
          body: query,
          signal: AbortSignal.timeout(100_000),
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status} מ-${endpoint}`);
          const backoff = 2000 * 2 ** attempt;
          console.log(`  ⏳ ${region.label}: ${lastErr.message}, ממתין ${backoff}ms...`);
          await sleep(backoff);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} מ-${endpoint}`);
        const data = await res.json();
        return data.elements || [];
      } catch (err) {
        lastErr = err;
        console.log(`  ⚠️ ${region.label} ניסיון ${attempt + 1} נכשל: ${err.message}`);
        await sleep(2000 * 2 ** attempt);
      }
    }
    console.log(`  🔁 עובר ל-endpoint חלופי עבור ${region.label}...`);
  }
  throw lastErr || new Error('כל הניסיונות נכשלו');
}

// סיווג-אזור גס לפי קואורדינטות (bounding boxes מקורבים, לא גבולות מדויקים) - הכרחי כי
// locations.region הוא CHECK constraint סגור על 7 ערכים (0007_update_regions.sql), ו-OSM לא
// מתייג "אזור ישראלי" ישירות. משמש רק כפילטר-פאסט משני, לא ליבת-התאמה - קירוב סביר, לא המצאה.
function classifyRegion(lat, lng) {
  if (lat >= 31.55 && lat <= 31.95 && lng >= 34.85 && lng <= 35.45) return 'ירושלים והסביבה';
  if (lng >= 35.15 && lat >= 31.30 && lat <= 32.35) return 'יו"ש והבנימין';
  if (lat >= 32.60 && lat <= 33.05 && lng <= 35.10) return 'חיפה והקריות';
  if (lat > 32.85) return 'הצפון והעמק';
  if (lat < 31.70) return 'השפלה והדרום';
  if (lat >= 31.95 && lat <= 32.25 && lng <= 34.95) return 'גוש דן והמרכז';
  if (lat > 32.25 && lat <= 32.60) return 'השרון';
  return 'גוש דן והמרכז';
}

function normalizeForMatch(s) {
  return (s || '').toLowerCase().replace(/[^֐-׿a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function wordOverlapScore(a, b) {
  const wa = new Set(normalizeForMatch(a).split(' ').filter((w) => w.length > 1));
  const wb = new Set(normalizeForMatch(b).split(' ').filter((w) => w.length > 1));
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  wa.forEach((w) => { if (wb.has(w)) common++; });
  return common / Math.max(wa.size, wb.size);
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// גן-שעשועים ללא name - לא ממציאים שם, משתמשים באותה פונקציה מרכזית שגם המיגרציה החד-פעמית
// (migrate-playground-names.js) קוראת לה - "לא לשכפל לוגיקה" (סעיף 14 בבקשה, playgroundNaming.js).
const { generatePlaygroundDisplayName } = require('./playgroundNaming');

function normalizeElement(el, region) {
  const tags = el.tags || {};
  const lat = el.type === 'node' ? el.lat : el.center?.lat;
  const lng = el.type === 'node' ? el.lon : el.center?.lon;
  if (lat == null || lng == null) return null;
  const regionLabel = classifyRegion(lat, lng);
  const street = tags['addr:street'] ? `${tags['addr:street']}${tags['addr:housenumber'] ? ' ' + tags['addr:housenumber'] : ''}` : null;
  const city = tags['addr:city'] || tags['addr:place'] || null;
  const officialName = tags.name || tags['name:he'] || tags['name:en'] || null;
  const address = [street, city].filter(Boolean).join(', ') || null;
  const hasName = !!officialName;
  const { name: displayName, tier } = generatePlaygroundDisplayName({ officialName, address, city });
  return {
    osmType: el.type,
    osmId: el.id,
    sourceUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    // אין city/street כלל (tier==='no_data') - עדיין לא ממציאים שם; נופל לאזור בתור המוצא-אחרון
    // היחיד שבאמת אין ברירה אחרת (שונה מהמיגרציה על נתונים קיימים, ששם משאירים ללא שינוי -
    // כאן חייבים *איזשהו* name לא-ריק כדי לייבא בכלל, ה-DB לא מאפשר name null).
    name: displayName || `גן שעשועים ציבורי - ${regionLabel}`,
    originalSourceName: officialName,
    nameTier: tier,
    hasName,
    lat, lng,
    street, city,
    address,
    region: regionLabel,
    confidence: hasName ? 0.95 : 0.85,
    tags,
  };
}

async function main() {
  console.log('=== ייבוא גני שעשועים מ-OpenStreetMap - TuRu ===\n');
  console.log('שלב 1: איסוף מ-Overpass API (4 אזורים חופפים)...\n');

  const rawByRegion = {};
  for (const region of REGIONS) {
    console.log(`📍 ${region.label}...`);
    try {
      const elements = await fetchOverpassRegion(region);
      rawByRegion[region.key] = elements;
      console.log(`  ✅ ${elements.length} תוצאות גולמיות`);
    } catch (err) {
      console.log(`  ❌ נכשל לגמרי: ${err.message}`);
      rawByRegion[region.key] = [];
    }
    await sleep(1500); // לא מציפים את Overpass - הפסקה בין אזורים
  }

  const totalRaw = Object.values(rawByRegion).reduce((s, arr) => s + arr.length, 0);
  console.log(`\nסה"כ תוצאות גולמיות (לפני dedup, עם חפיפה בין אזורים): ${totalRaw}`);

  if (totalRaw === 0) {
    console.log('\n🛑 עצירה: אפס תוצאות מכל האזורים - כנראה תקלה מערכתית (Overpass לא זמין / שאילתה שגויה), לא "אין גני שעשועים בישראל". לא ממשיכים לייבוא.');
    process.exit(1);
  }

  console.log('\nשלב 2: נרמול + הסרת כפילויות בתוך המאגר...');
  const byKey = new Map();
  for (const region of REGIONS) {
    for (const el of rawByRegion[region.key] || []) {
      const norm = normalizeElement(el, region);
      if (!norm) continue;
      const key = `${norm.osmType}/${norm.osmId}`;
      if (!byKey.has(key)) byKey.set(key, norm);
    }
  }
  let candidates = [...byKey.values()];
  console.log(`  ייחודי לפי OSM ID: ${candidates.length} (${totalRaw - candidates.length} כפילויות-חפיפה הוסרו)`);

  // dedup פנימי נוסף לפי קרבה (<25מ') - למשל way ממופה גם כ-node נפרד באותו מקום בפועל.
  candidates.sort((a, b) => a.lat - b.lat);
  const keep = [];
  for (const c of candidates) {
    const dup = keep.find((k) => haversineKm(k.lat, k.lng, c.lat, c.lng) * 1000 < 25);
    if (dup) continue;
    keep.push(c);
  }
  const internalDupsRemoved = candidates.length - keep.length;
  candidates = keep;
  console.log(`  אחרי dedup-קרבה פנימי (<25מ'): ${candidates.length} (${internalDupsRemoved} הוסרו)`);

  console.log('\nשלב 3: בדיקת כפילויות מול פעילויות קיימות ב-TuRu...');
  const { client, userId } = await getClient();
  // Supabase מגביל תגובת select ל-1000 שורות כברירת מחדל בשקט (בלי שגיאה!) - בלי pagination
  // מפורש כאן, בדיקת-הכפילויות הייתה "רואה" רק את 1000 הפעילויות הראשונות ומחשיבה הכל שאחרי
  // זה כ"חדש" בטעות (נמצא בפועל בהרצה שנייה: 4925 "מועמדים חדשים" במקום ~8 האמיתיים, כי המערכת
  // כבר מכילה יותר מ-1000 פעילויות אחרי ההרצה הראשונה) - זו בדיוק הסיבה ש-Step 23 (idempotency)
  // דורש בדיקה אמיתית מול *כל* הרשומות הקיימות, לא רק עמוד ראשון.
  let existingActs = [];
  {
    let from = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await client
        .from('activities')
        .select('id, name, source_url, location:locations(lat, lng)')
        .range(from, from + pageSize - 1);
      if (error) throw error;
      existingActs = existingActs.concat(data);
      if (data.length < pageSize) break;
      from += pageSize;
    }
  }
  const existingWithCoords = (existingActs || []).filter((a) => a.location?.lat != null && a.location?.lng != null);
  const existingSourceUrls = new Set((existingActs || []).map((a) => a.source_url).filter(Boolean));
  console.log(`  ${existingActs.length} פעילויות קיימות ב-TuRu (${existingWithCoords.length} עם קואורדינטות)`);

  const fresh = [];
  let skippedAlreadyImported = 0;
  let skippedNearExisting = 0;
  for (const c of candidates) {
    if (existingSourceUrls.has(c.sourceUrl)) { skippedAlreadyImported++; continue; } // idempotency - הרצה חוזרת
    const near = existingWithCoords.find((a) => haversineKm(a.location.lat, a.location.lng, c.lat, c.lng) * 1000 < 60);
    if (near) { skippedNearExisting++; continue; }
    fresh.push(c);
  }
  console.log(`  כבר יובאו בהרצה קודמת (idempotency): ${skippedAlreadyImported}`);
  console.log(`  קרובים מדי לפעילות קיימת (<60מ', כנראה אותו מקום): ${skippedNearExisting}`);
  console.log(`  מועמדים חדשים לייבוא: ${fresh.length}`);

  // ---- דוח Dry Run ----
  console.log('\n=== DRY RUN SUMMARY ===');
  const byRegionCount = {};
  let missingName = 0;
  for (const c of fresh) {
    byRegionCount[c.region] = (byRegionCount[c.region] || 0) + 1;
    if (!c.hasName) missingName++;
  }
  console.log('לפי אזור:', JSON.stringify(byRegionCount, null, 2));
  console.log(`ללא שם מקורי (שם fallback נגזר): ${missingName}`);
  console.log(`confidence ממוצע: ${(fresh.reduce((s, c) => s + c.confidence, 0) / (fresh.length || 1)).toFixed(2)}`);

  if (DRY_RUN_ONLY) {
    console.log('\n(--dry-run-only) עוצר כאן, לא מבצע INSERT.');
    process.exit(0);
  }

  if (fresh.length === 0) {
    console.log('\n✅ אין מועמדים חדשים לייבוא (הכל כבר קיים/קרוב מדי לקיים). סיום נקי, שום דבר לא נכתב.');
    process.exit(0);
  }

  console.log(`\nהכל תקין (>0 מועמדים, איסוף הצליח בלפחות אזור אחד) - ממשיך אוטומטית לייבוא האמיתי...\n`);
  console.log('שלב 4: ייבוא בפועל ל-DB...');

  const importBatchTag = `osm-playgrounds-${new Date().toISOString().slice(0, 10)}`;
  let inserted = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < fresh.length; i++) {
    const c = fresh[i];
    try {
      const { data: loc, error: locErr } = await client
        .from('locations')
        .insert({ name: c.name, address: c.address, city: c.city, region: c.region, lat: c.lat, lng: c.lng })
        .select('id')
        .single();
      if (locErr) throw locErr;

      const { error: actErr } = await client
        .from('activities')
        .insert({
          name: c.name,
          description: null,
          entity_type: 'מקום_קבוע',
          location_id: loc.id,
          category: 'גן שעשועים',
          price_type: 'free',
          price_amount: 0,
          indoor_outdoor: 'outdoor',
          booking_requirement: 'none',
          status: 'approved',
          source: 'scraped',
          source_url: c.sourceUrl,
          created_by: userId,
        });
      if (actErr) throw actErr;
      inserted++;
    } catch (err) {
      failed++;
      errors.push({ candidate: c.name, osmId: `${c.osmType}/${c.osmId}`, error: err.message });
    }
    if ((i + 1) % 50 === 0 || i === fresh.length - 1) {
      console.log(`  התקדמות: ${i + 1}/${fresh.length} (הצליחו: ${inserted}, נכשלו: ${failed})`);
    }
  }

  console.log('\n=== IMPORT SUMMARY ===');
  console.log(`Google raw results: 0 (מקור חסום - ראו דוח)`);
  console.log(`OSM raw results: ${totalRaw}`);
  console.log(`Total candidates (אחרי dedup פנימי): ${candidates.length}`);
  console.log(`Skipped - already imported (idempotency): ${skippedAlreadyImported}`);
  console.log(`Skipped - near existing TuRu activity: ${skippedNearExisting}`);
  console.log(`New candidates attempted: ${fresh.length}`);
  console.log(`Inserted: ${inserted}`);
  console.log(`Failed: ${failed}`);
  console.log(`Import batch tag: ${importBatchTag} (לא קיים שדה batch_id בסכימה - לזיהוי משתמשים ב-source_url שמתחיל ב-https://www.openstreetmap.org/)`);
  if (errors.length) {
    console.log('\nErrors (עד 20 ראשונות):');
    console.log(JSON.stringify(errors.slice(0, 20), null, 2));
  }
  console.log('\nIMPORT COMPLETE');
}

main().catch((err) => {
  console.error('\n🛑 שגיאה קריטית, עוצר:', err);
  process.exit(1);
});
