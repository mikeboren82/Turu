// TuRu - עותק Deno/TypeScript מדויק של tools/playground-discovery/matching.py (Python) - רק
// שלושת הפונקציות שסקירת גני-שעשועים דרך Google Places (scan-settlement-gaps) צריכה: סיווג
// PLAYGROUND/PARK/וכו', התאמה מול פעילויות קיימות, וחילוץ עיר מכתובת. אותו עיקרון-שכפול-מכוון
// כמו playgroundNaming.ts/cityNaming.ts - Deno לא יכול לעשות import ל-Python, אז זו לא כפילות-
// בטעות. שני הקבצים חייבים להישאר זהים בהתנהגות.

import { normalizeCityName } from './cityNaming.ts';

const PLAYGROUND_KEYWORDS = ['playground', 'גן שעשועים', 'גני שעשועים', 'מתקני משחקים', 'משחקייה'];
const PARK_KEYWORDS = ['park', 'פארק', 'גן ציבורי', 'גן לאומי'];
const PLAYGROUND_TYPES = new Set(['playground']);
const PARK_TYPES = new Set(['park', 'national_park', 'state_park']);
const NOT_RELEVANT_TYPES = new Set([
  'school', 'primary_school', 'secondary_school', 'store', 'shopping_mall',
  'restaurant', 'lodging', 'hotel', 'stadium', 'gym', 'toy_store',
]);

export type PlaceKind = 'PLAYGROUND' | 'PARK_WITH_PLAYGROUND' | 'PARK' | 'UNCERTAIN' | 'NOT_RELEVANT';

export function classifyPlace({ primaryType, types, name }: { primaryType: string | null; types: string[] | null; name: string | null }): PlaceKind {
  const typesSet = new Set(types || []);
  if (primaryType) typesSet.add(primaryType);
  const nameLower = (name || '').toLowerCase();

  for (const t of typesSet) if (NOT_RELEVANT_TYPES.has(t)) return 'NOT_RELEVANT';

  const hasPlaygroundType = [...typesSet].some((t) => PLAYGROUND_TYPES.has(t));
  const hasParkType = [...typesSet].some((t) => PARK_TYPES.has(t));
  const hasPlaygroundWord = PLAYGROUND_KEYWORDS.some((kw) => nameLower.includes(kw));
  const hasParkWord = PARK_KEYWORDS.some((kw) => nameLower.includes(kw));

  if (hasPlaygroundType || hasPlaygroundWord) {
    return (hasParkType || hasParkWord) ? 'PARK_WITH_PLAYGROUND' : 'PLAYGROUND';
  }
  if (hasParkType || hasParkWord) return 'PARK';
  if (typesSet.size > 0 || name) return 'UNCERTAIN';
  return 'NOT_RELEVANT';
}

const COMPARISON_ONLY_STOPWORDS = new Set(['park', 'playground', 'פארק', 'גן', 'שעשועים', 'ציבורי']);

function normalizeForMatch(s: string | null | undefined): string {
  if (!s) return '';
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function wordOverlapScoreDropStopwords(a: string | null | undefined, b: string | null | undefined): number {
  let wa = new Set(normalizeForMatch(a).split(' ').filter((w) => w.length > 1));
  let wb = new Set(normalizeForMatch(b).split(' ').filter((w) => w.length > 1));
  wa = new Set([...wa].filter((w) => !COMPARISON_ONLY_STOPWORDS.has(w)));
  wb = new Set([...wb].filter((w) => !COMPARISON_ONLY_STOPWORDS.has(w)));
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  wa.forEach((w) => { if (wb.has(w)) common++; });
  return common / Math.max(wa.size, wb.size);
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface ExistingForMatch { id: string; name: string | null; google_place_id: string | null; lat: number | null; lon: number | null }
export type MatchOutcome = 'MATCH_CONFIRMED' | 'STRONG_MATCH' | 'NEEDS_REVIEW' | 'NEW_CANDIDATE';

const STRONG_MATCH_DISTANCE_METERS = 60;
const STRONG_MATCH_NAME_SIMILARITY = 0.5;

// עותק מדויק של match_against_existing (matching.py) - לעולם לא ממציא התאמה: רק place_id
// זהה נחשב MATCH_CONFIRMED ודאי; כל השאר שרק-אולי-דומה הופך STRONG_MATCH/NEEDS_REVIEW, לא
// נדרס אוטומטית כ"כפילות" (וגם לא נופל בטעות ל"מקום חדש" כשזה כבר קיים).
export function matchAgainstExisting(
  discovered: { place_id: string | null; name: string | null; lat: number | null; lon: number | null },
  existing: ExistingForMatch[],
): MatchOutcome {
  for (const e of existing) {
    if (e.google_place_id && e.google_place_id === discovered.place_id) return 'MATCH_CONFIRMED';
  }

  let bestScore = 0;
  let bestWithinStrongDistance = false;
  for (const e of existing) {
    if (e.lat == null || e.lon == null || discovered.lat == null || discovered.lon == null) continue;
    const distM = haversineKm(e.lat, e.lon, discovered.lat, discovered.lon) * 1000;
    if (distM > STRONG_MATCH_DISTANCE_METERS * 3) continue;
    const nameScore = wordOverlapScoreDropStopwords(e.name, discovered.name);
    if (distM <= STRONG_MATCH_DISTANCE_METERS && nameScore >= STRONG_MATCH_NAME_SIMILARITY) return 'STRONG_MATCH';
    if (nameScore > bestScore) { bestScore = nameScore; bestWithinStrongDistance = true; }
  }

  if (bestWithinStrongDistance && bestScore >= 0.3) return 'NEEDS_REVIEW';
  return 'NEW_CANDIDATE';
}

// Google's formattedAddress ends with the locality (e.g. "עזר וייצמן 7, הוד השרון", or a bare
// "נהריה" with no comma at all) - last comma-segment is a reliable-enough heuristic. עותק מדויק
// של extract_city_from_address (tools/playground-discovery/supabase_client.py).
export function extractCityFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  return normalizeCityName(parts[parts.length - 1]);
}
