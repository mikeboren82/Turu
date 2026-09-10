// TuRu - עטיפת Geocoding עבור "חיפוש חכם" (smart-search): הופכת "רחוב הרצל, תל אביב" לקואורדינטות.
// Nominatim/OpenStreetMap (חינמי, ללא מפתח) - אותו ספק בדיוק כמו tools/import-tool/server.js
// (queryNominatim/geocodeLocation, לזיהוי מיקומי פעילויות בזמן ייבוא) - לא Google Maps/Places,
// שאין להם שום אינטגרציה קיימת בפרויקט הזה. הפונקציה הזו רק מזהה "איפה נמצא הרחוב" - היא
// *לא* מקור הפעילויות של TuRu (ראו הערת הכותרת ב-smart-search/index.ts).
//
// ממשק מופשט (geocodeAddress) כדי שאפשר יהיה בעתיד להחליף ספק (למשל Google Geocoding) דרך
// GEOCODING_PROVIDER env var בלי לגעת בקוד הקורא - כרגע יש רק ספק אחד ממומש בפועל.

const NOMINATIM_USER_AGENT = 'TuRu-KidsApp/1.0 (contact: mborenmusic@gmail.com)';

export interface GeocodeResult { lat: number; lng: number }

async function geocodeWithNominatim(query: string): Promise<GeocodeResult | null> {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'il');
  url.searchParams.set('q', `${query}, ישראל`);
  try {
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': NOMINATIM_USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const results = await res.json();
    if (!Array.isArray(results) || results.length === 0) return null;
    const lat = parseFloat(results[0].lat);
    const lng = parseFloat(results[0].lon);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
    return { lat, lng };
  } catch {
    return null; // רשת/timeout (נצפה גם מול Nominatim ידנית מדי פעם - שירות חינמי, לא מובטח) -
    // fallback הטיפול (city-only search) קורה אצל הקורא, לא כאן; החיפוש לא קורס בגלל זה.
  }
}

// query בנוי כבר כ"רחוב, עיר" או "עיר" בלבד - הבנייה עצמה קורית ב-smart-search/index.ts,
// כדי שהעטיפה הזו תישאר ספק-אגנוסטית (רק "geocode(string)").
export async function geocodeAddress(query: string): Promise<GeocodeResult | null> {
  if (!query || !query.trim()) return null;
  const provider = Deno.env.get('GEOCODING_PROVIDER') || 'nominatim';
  if (provider === 'nominatim') return geocodeWithNominatim(query);
  return null; // ספק לא-ידוע - לא מנחשים, מחזירים null (הקורא נופל בחזרה ל-city-only)
}
