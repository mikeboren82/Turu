// TuRu - העשרת כתובות לכל פעילות שחסרה כתובת טקסטואלית (לא רק גני שעשועים מ-OSM יותר - הורחב
// לבקשת המשתמש לכסות "כל הפעילויות" חסרות-הכתובת, כל מקור). חד-פעמי, לא recurring, ובכוונה
// מוגבל ל-batch קטן (ברירת מחדל 250) לכל הרצה - לא "הכל בבת אחת" ולא לולאה אוטומטית שרצה שוב
// ושוב לבד. זה ההבדל בין "שימוש סביר, מבוקר, ביוזמת אדם בכל פעם" לבין "bulk/systematic
// geocoding" שמדיניות Nominatim הציבורי אוסרת עליו במפורש - חלוקה לסבבים לא משנה את זה אם
// הסבבים רצים אוטומטית אחד אחרי השני בלי מעורבות. לכן: מריצים את זה שוב באופן ידני (המשתמש
// מבקש סבב נוסף), לא מתזמנים את זה בעצמנו. אותו קצב-בקשות בדיוק כמו queryNominatim הקיים
// ב-server.js. "WHERE address IS NULL" מתפקד כ-cursor טבעי - כל סבב מתקדם אוטומטית כי הרשומות
// שכבר הועשרו כבר לא מתאימות לסינון, בלי צורך במעקב-state נפרד בין הרצות.
//
// שני מסלולי-חיפוש (בדיוק כמו requireVerifiedLocation ב-server.js, אותה מדיניות "לא ממציאים"):
// (1) יש קואורדינטות (lat/lng) - reverse-geocode (מהיר, מדויק, זול-יותר-ב-Nominatim).
// (2) אין קואורדינטות אבל יש location.name/city כטקסט - forward-geocode (מחפש לפי השם).
// פעילות בלי location בכלל, או location בלי גם קואורדינטות וגם שם/עיר שימושיים - מדולגת
// בשקט (אין ממה לשחזר כתובת), נספרת בדוח הסיום כ"לא ניתנת לשחזור" ולא נוגעים בה.

require('dotenv').config();
const { getClient } = require('./supabase');

const BATCH_LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1]) || 250;

const NOMINATIM_USER_AGENT = 'TuRu-KidsApp/1.0 (one-time address enrichment; contact: mborenmusic@gmail.com)';
const MIN_INTERVAL_MS = 1500; // מעט יותר שמרני מ-1 בקשה/שנייה (המקסימום המותר), לא רק צמוד אליו
let lastRequestAt = 0;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function throttle() {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

async function reverseGeocode(lat, lng) {
  await throttle();
  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('format', 'json');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lng));
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('zoom', '18'); // רמת-רחוב, לא עיר/מדינה

  try {
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': NOMINATIM_USER_AGENT },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const addr = data.address || {};
    const road = addr.road || addr.pedestrian || addr.footway || null;
    const houseNumber = addr.house_number || null;
    const city = addr.city || addr.town || addr.village || addr.suburb || addr.municipality || null;
    // בלי road - אין "כתובת" אמיתית להציע (רק עיר לבד לא מוסיף על מה שכבר יש), מוותרים בשקט.
    if (!road) return { city, street: null };
    return { street: houseNumber ? `${road} ${houseNumber}` : road, city };
  } catch {
    return null; // timeout/רשת - מוותרים בשקט על הרשומה הזו, לא קורסים
  }
}

// forward-geocode: מחפשים לפי שם-המקום+עיר (לא הפוך כמו reverseGeocode) - למיקומים שיש להם
// טקסט תיאורי אבל אף פעם לא קיבלו קואורדינטות. אותו throttle/UA/timeout בדיוק.
async function forwardGeocode(name, city) {
  const query = [name, city].filter(Boolean).join(', ');
  if (!query) return null;
  await throttle();
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'il');
  url.searchParams.set('q', `${query}, ישראל`);
  try {
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': NOMINATIM_USER_AGENT },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const results = await res.json();
    if (!Array.isArray(results) || results.length === 0) return null;
    const lat = parseFloat(results[0].lat);
    const lng = parseFloat(results[0].lon);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
    return { lat, lng, displayName: results[0].display_name || null };
  } catch {
    return null;
  }
}

async function main() {
  const isFallbackName = (n) => /^גן שעשועים( ציבורי)? - /.test(n);
  const { client } = await getClient();

  console.log('טוען מועמדים חסרי-כתובת (כל הפעילויות, כל מקור)...');
  let all = [];
  let from = 0;
  while (true) {
    const { data, error } = await client
      .from('activities')
      .select('id, name, location_id, location:locations(id, name, address, city, lat, lng)')
      .range(from, from + 999);
    if (error) throw error;
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }

  const withLocation = all.filter((a) => a.location && !a.location.address);
  const hasCoords = withLocation.filter((a) => a.location.lat != null && a.location.lng != null);
  const needsForward = withLocation.filter((a) => a.location.lat == null && (a.location.name || a.location.city));
  const unrecoverable = all.filter((a) => !a.location || (!a.location.address && a.location.lat == null && !a.location.name && !a.location.city));

  // עדיפות: reverse-geocode (זול/מדויק) קודם, אחר כך forward-geocode; בתוך reverse - שם-אמיתי
  // לפני שם-fallback (כמו קודם).
  const realNamed = hasCoords.filter((a) => !isFallbackName(a.name));
  const fallbackNamed = hasCoords.filter((a) => isFallbackName(a.name));
  const reverseQueue = [...realNamed, ...fallbackNamed];
  const targets = [...reverseQueue, ...needsForward].slice(0, BATCH_LIMIT);
  const targetsReverse = targets.filter((t) => t.location.lat != null);
  const targetsForward = targets.filter((t) => t.location.lat == null);

  console.log(`נותרו סה"כ ${withLocation.length} מועמדים חסרי-כתובת (${hasCoords.length} עם קואורדינטות, ${needsForward.length} בלי קואורדינטות אך עם שם/עיר).`);
  console.log(`${unrecoverable.length} פעילויות נוספות בלי location בכלל, או בלי שום מידע לשחזור - מדולגות, לא ניתנות לשחזור בלי מידע נוסף.`);
  console.log(`הסבב הזה מטפל ב-${targets.length} (מכסה: ${BATCH_LIMIT}: ${targetsReverse.length} reverse-geocode, ${targetsForward.length} forward-geocode).`);
  console.log(`קצב: בקשה כל ${MIN_INTERVAL_MS}ms (~${Math.ceil(targets.length * MIN_INTERVAL_MS / 60000)} דקות משוער).\n`);

  let enriched = 0;
  let noStreetFound = 0;
  let coordsOnlyFound = 0;
  let failed = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (t.location.lat != null) {
      const result = await reverseGeocode(t.location.lat, t.location.lng);
      if (!result) {
        failed++;
      } else if (!result.street) {
        noStreetFound++;
      } else {
        const address = [result.street, result.city].filter(Boolean).join(', ');
        const update = { address };
        if (result.city && !t.location.city) update.city = result.city;
        const { error } = await client.from('locations').update(update).eq('id', t.location.id);
        if (error) { failed++; } else { enriched++; }
      }
    } else {
      const result = await forwardGeocode(t.location.name, t.location.city);
      if (!result) {
        failed++;
      } else {
        // forward-geocode נותן קואורדינטות, לא כתובת-רחוב ישירות - ממלאים קואורדינטות ואז
        // reverse-geocode מיידי (throttled כרגיל) כדי לקבל גם רחוב אמיתי, לא רק "נמצא איפשהו".
        const reverse = await reverseGeocode(result.lat, result.lng);
        const update = { lat: result.lat, lng: result.lng };
        if (reverse?.street) update.address = [reverse.street, reverse.city].filter(Boolean).join(', ');
        if (reverse?.city && !t.location.city) update.city = reverse.city;
        const { error } = await client.from('locations').update(update).eq('id', t.location.id);
        if (error) { failed++; }
        else if (update.address) { enriched++; }
        else { coordsOnlyFound++; } // מיקום נמצא אך בלי רחוב מזוהה - קואורדינטות בכל זאת שימושיות
      }
    }
    if ((i + 1) % 25 === 0 || i === targets.length - 1) {
      console.log(`התקדמות: ${i + 1}/${targets.length} (הועשרו: ${enriched}, קואורדינטות-בלבד: ${coordsOnlyFound}, ללא רחוב מזוהה: ${noStreetFound}, נכשלו: ${failed})`);
    }
  }

  console.log('\n=== ENRICHMENT SUMMARY ===');
  console.log(`נבדקו: ${targets.length}`);
  console.log(`קיבלו כתובת רחוב אמיתית: ${enriched}`);
  console.log(`קיבלו קואורדינטות בלבד (forward-geocode הצליח, רחוב לא זוהה): ${coordsOnlyFound}`);
  console.log(`Nominatim לא זיהה רחוב במיקום (נשאר ללא כתובת, לא הומצא כלום): ${noStreetFound}`);
  console.log(`נכשלו (רשת/timeout/לא נמצא כלל): ${failed}`);
  console.log(`נותרו לסבבים הבאים: ${withLocation.length - targets.length}`);
  console.log(`לא ניתנות לשחזור (אין location/שם/עיר בכלל): ${unrecoverable.length}`);
  console.log('DONE');
}

main().catch((err) => { console.error('שגיאה קריטית:', err); process.exit(1); });
