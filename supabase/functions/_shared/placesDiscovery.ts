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
export type MatchOutcome = 'MATCH_CONFIRMED' | 'STRONG_MATCH' | 'POSSIBLE_DUPLICATE' | 'NEEDS_REVIEW' | 'NEW_CANDIDATE';

// 60m -> 100m (2026-09-12): Batch 1 found two real duplicates that fell just outside the old
// 60m cutoff - "פארק יהורם גאון" (64.4m from an identically-named existing activity) and "גן
// שעשועים – פנמה 2, ירושלים" (26m from an existing activity, but the 60m gate is what matters
// here) both slipped through as NEW_CANDIDATE and got auto-approved as duplicates. GPS/geocoding
// jitter between two different data sources describing the same physical playground easily
// exceeds 60m; 100m still comfortably excludes two genuinely distinct nearby playgrounds (real
// ones in this dataset are consistently >150m apart).
const STRONG_MATCH_DISTANCE_METERS = 100;
const STRONG_MATCH_NAME_SIMILARITY = 0.5;
// 2026-09-12 (batch-3 validation): פער מבני נמצא בפועל - שני "duplicates" אמיתיים ב-Batch 3
// ("גן לוטם" מול "גן שעשועים – לילך, עפולה", 11.8m; "...אבן גבירול 46..." מול "...אבן גבירול...",
// 16.4m) היו 0% חפיפת-מילים (שם רשמי אמיתי מול שם גנרי-מבוסס-כתובת שנוצר ע"י מקור אחר לאותו
// מקום עצמו) - ה-AND בין מרחק+שם דרש את שניהם, אז זה נפל ל-NEW_CANDIDATE ואושר אוטומטית כ"חדש".
// תיקון: מרחק-קרוב-מאוד לבדו (VERY_CLOSE) מספיק ל-STRONG_MATCH בלי תלות בשם - אבל בכוונה *לא*
// MATCH_CONFIRMED (זה היה מדלג/משמיט את הרשומה לגמרי בלי שאף אחד יראה אותה): STRONG_MATCH
// ממשיך לתור-בדיקה אנושית (queueForReview) - לעולם לא ממזג/מוחק אוטומטית. הגנה מפני מיזוג-יתר:
// 30m נבחר שמרני בכוונה - קטן משמעותית מ-100m/STRONG_MATCH הרגיל, כי אי-דיוק גיאוקוד בין שני
// מקורות שמתארים אותו מקום פיזי כמעט תמיד נופל הרבה מתחת ל-30m, בעוד ששני גני-שעשועים שונים-
// אמיתיים-אבל-סמוכים (למשל שני מתקנים בפארק אחד גדול) בפועל תמיד רחוקים משמעותית מ-30m
// (הדוגמאות שנבדקו בפועל בסבב הזה: >150m). גם אם ה-heuristic הזה טועה במקרה גבולי - זה מגיע
// לבדיקה אנושית, לא לכפילות-שקטה, ולא ליצירה-שקטה של רשומה חדשה.
const VERY_CLOSE_DISTANCE_METERS = 30;
// 2026-09-12 (post-Batch-6, the "פארק עירוני 76" case - 32.0m, 0% name similarity, fell 2m past
// VERY_CLOSE and got auto-approved as new): a hard 30m/not-30m cliff means 30.0m and 30.1m have
// completely different consequences (STRONG_MATCH+review vs. silent auto-approval). Per explicit
// instruction: do NOT just raise the 30m cutoff (that only moves the cliff, doesn't remove it) -
// instead a genuine third zone. (30m, 50m] is NOT a duplicate confirmation - it's a "look at this
// before approving as new" flag. It intentionally does NOT escalate to STRONG_MATCH even with a
// strong name match (e.g. 45m + near-identical name still routes here, not to STRONG_MATCH) -
// POSSIBLE_DUPLICATE and STRONG_MATCH must stay conceptually separate so an admin reviewer can
// tell "very likely the same place" (STRONG_MATCH) apart from "close enough to check, could go
// either way" (POSSIBLE_DUPLICATE). Beyond 50m, matching falls through to the pre-existing
// distance+name logic unchanged (zone 3).
const BORDERLINE_MAX_METERS = 50;

export interface MatchResult { outcome: MatchOutcome; match: ExistingForMatch | null; nameScore?: number }

// עותק מדויק של match_against_existing (matching.py) - לעולם לא ממציא התאמה: רק place_id
// זהה נחשב MATCH_CONFIRMED ודאי; כל השאר שרק-אולי-דומה הופך STRONG_MATCH/POSSIBLE_DUPLICATE/
// NEEDS_REVIEW, לא נדרס אוטומטית כ"כפילות" (וגם לא נופל בטעות ל"מקום חדש" כשזה כבר קיים).
// מחזיר גם את הרשומה הקיימת שהותאמה (match) - כדי שכל הסוגים האלה יוכלו להצביע על
// existing_activity_id בתור-הבדיקה (incoming_activities), לא רק שם התאמה גולמי (2026-09-11
// תיקון: קודם הוחזר outcome בלבד, וה-caller פשוט דילג/continue על שני הסוגים האלה, בלי שום
// עקבה - התוצאה נעלמה בשקט, בדיוק כמו הבאג שכבר תוקן ב-tools/playground-discovery).
export function matchAgainstExisting(
  discovered: { place_id: string | null; name: string | null; lat: number | null; lon: number | null },
  existing: ExistingForMatch[],
): MatchResult {
  for (const e of existing) {
    if (e.google_place_id && e.google_place_id === discovered.place_id) return { outcome: 'MATCH_CONFIRMED', match: e };
  }

  let bestScore = 0;
  let bestMatch: ExistingForMatch | null = null;
  let closestVeryClose: { match: ExistingForMatch; distM: number } | null = null;
  let closestBorderline: { match: ExistingForMatch; distM: number; nameScore: number } | null = null;
  for (const e of existing) {
    if (e.lat == null || e.lon == null || discovered.lat == null || discovered.lon == null) continue;
    const distM = haversineKm(e.lat, e.lon, discovered.lat, discovered.lon) * 1000;
    if (distM > STRONG_MATCH_DISTANCE_METERS * 3) continue;

    if (distM <= VERY_CLOSE_DISTANCE_METERS) {
      if (!closestVeryClose || distM < closestVeryClose.distM) closestVeryClose = { match: e, distM };
      continue; // Zone 1 - distance alone decides, no need to weigh name evidence here.
    }

    const nameScore = wordOverlapScoreDropStopwords(e.name, discovered.name);
    if (distM <= BORDERLINE_MAX_METERS) {
      // Zone 2 - deliberately does NOT check nameScore against a threshold to escalate to
      // STRONG_MATCH (per explicit instruction: 45m + a highly similar name still stays
      // POSSIBLE_DUPLICATE, not STRONG_MATCH). nameScore is still captured as evidence for the
      // reviewer (attached to MatchResult below), not used to change the routing decision.
      if (!closestBorderline || distM < closestBorderline.distM) closestBorderline = { match: e, distM, nameScore };
      continue;
    }

    // Zone 3 (>50m) - pre-existing logic, unchanged.
    if (distM <= STRONG_MATCH_DISTANCE_METERS && nameScore >= STRONG_MATCH_NAME_SIMILARITY) {
      return { outcome: 'STRONG_MATCH', match: e, nameScore };
    }
    if (nameScore > bestScore) { bestScore = nameScore; bestMatch = e; }
  }
  // מרחק-קרוב-מאוד לבדו, בלי קשר לשם - נבדק אחרי הלולאה (לא early-return בתוכה) כדי לבחור את
  // הקרוב-ביותר אם כמה existing נופלים בטווח, לא סתם את הראשון שנתקלים בו לפי סדר-שרירותי.
  if (closestVeryClose) return { outcome: 'STRONG_MATCH', match: closestVeryClose.match };
  if (closestBorderline) return { outcome: 'POSSIBLE_DUPLICATE', match: closestBorderline.match, nameScore: closestBorderline.nameScore };

  if (bestMatch && bestScore >= 0.3) return { outcome: 'NEEDS_REVIEW', match: bestMatch };
  return { outcome: 'NEW_CANDIDATE', match: null };
}

// 2026-09-12 (batch-3 validation, part 4 of the batch-4-follow-up audit): הוצא מ-index.ts ל-
// כאן במכוון - index.ts קורא ל-Deno.serve() ברמת המודול, אז אי אפשר לייבא אותו בבדיקה בלי
// להפעיל שרת בפועל. הפונקציה הזו טהורה-לחלוטין (מקבלת fetchPage כפרמטר, לא קוראת ל-fetch בעצמה)
// - בדיוק כדי שתהיה ניתנת-לבדיקה עם mock, בלי לגעת ב-API האמיתי של Google (ועלות אמיתית).
// index.ts.searchTextPlaygrounds הוא כעת רק "wrapper" דק שמזריק את קריאת-ה-API האמיתית + delay
// אמיתי; הבדיקות (placesDiscovery.test.ts) מזריקות גרסאות מדומות של שניהם.
export interface PageFetchResult<T> { places: T[]; nextPageToken?: string }
export interface PaginationResult<T> { places: (T & { _page: number })[]; pagesFetched: number }

export async function fetchAllPaginatedResults<T>(
  fetchPage: (pageToken: string | undefined) => Promise<PageFetchResult<T>>,
  opts: { maxPages: number; delayMs: number; sleep: (ms: number) => Promise<void> },
): Promise<PaginationResult<T>> {
  const allResults: (T & { _page: number })[] = [];
  let pageToken: string | undefined;
  let pagesFetched = 0;
  for (let page = 1; page <= opts.maxPages; page++) {
    let result: PageFetchResult<T>;
    try {
      result = await fetchPage(pageToken);
    } catch (err) {
      // עמוד 1 שנכשל - אין כלום לתת, זרוק הלאה (התנהגות זהה לקודם, לא שינוי). עמוד 2+ שנכשל
      // (למשל token לא-תקין/פג-תוקף) - אל תאבד את התוצאות התקינות שכבר נאספו מעמודים קודמים,
      // רק תעצור כאן ותחזיר מה שיש. זה תיקון-אגב שנמצא תוך כדי כתיבת הבדיקות - הקוד המקורי היה
      // מאבד את כל עמוד 1 (שכבר שולם עליו!) אם עמוד 2 נכשל.
      if (page === 1) throw err;
      console.error(`Pagination page ${page} failed, returning ${allResults.length} results from earlier pages:`, err instanceof Error ? err.message : String(err));
      break;
    }
    pagesFetched++;
    for (const p of result.places) allResults.push({ ...p, _page: page });
    pageToken = result.nextPageToken;
    if (!pageToken) break;
    if (page < opts.maxPages) await opts.sleep(opts.delayMs);
  }
  return { places: allResults, pagesFetched };
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
