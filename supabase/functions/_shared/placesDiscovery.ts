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

// 2026-09-12 (post-Batch-8, user's explicit instruction): הציון הישן היחיד (wordOverlapScoreDropStopwords
// על הכתובת המלאה) יכול להיראות "גבוה" רק כי שני הצדדים חולקים את שם-העיר - לא הוכחה לרחוב זהה
// בכלל (נצפה בפועל ב-Batch 8: "פארק החורשות" בלי רחוב כלל קיבל addressScore=0.75 מול "לבון,
// תל־אביב–יפו" רק כי "תל אביב יפו" חזר בשני הצדדים). לא הוסר (עדיין מוחזר כ-addressScore, "אל
// תסיר את המדד הקיים") - אבל עכשיו יש גם פירוק לרכיבים נפרדים כדי שרחוב/מספר-בית (אות חזקה בהרבה)
// לא יתערבבו עם חפיפת-עיר-בלבד (אות חלשה) באותו מספר יחיד.
export interface AddressComponents { street: string | null; houseNumber: string | null; city: string | null; neighborhood: string | null }

// כתובות Google/locations בפרויקט הזה הן ברוב המכריע "רחוב [מספר], עיר" (2 מקטעי-פסיק) - לפעמים
// רק "עיר" (בלי רחוב כלל, למשל תוצאות שחסרות formattedAddress מפורט), ולעיתים נדירות 3+ מקטעים
// (שכונה בין הרחוב לעיר). heuristic, לא פענוח-כתובות רשמי - בדיוק כמו extractCityFromAddress
// הקיימת (אותה הנחת "מקטע-הפסיק האחרון = עיר").
export function parseAddressComponents(address: string | null | undefined): AddressComponents {
  if (!address) return { street: null, houseNumber: null, city: null, neighborhood: null };
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { street: null, houseNumber: null, city: null, neighborhood: null };
  if (parts.length === 1) {
    // מקטע יחיד - זו העיר עצמה (למשל "תל אביב-יפו" בלי רחוב בכלל), לא רחוב-בלי-עיר.
    return { street: null, houseNumber: null, city: normalizeCityName(parts[0]), neighborhood: null };
  }
  const city = normalizeCityName(parts[parts.length - 1]);
  const neighborhood = parts.length >= 3 ? parts.slice(1, parts.length - 1).join(', ') : null;
  const streetPart = parts[0];
  // מספר-בית = ספרות (עם אות-המשך אופציונלית, כמו "12א"/"12A") בסוף מקטע-הרחוב.
  const m = streetPart.match(/^(.*?)\s+(\d+[א-תA-Za-z]?)$/u);
  return m
    ? { street: m[1].trim() || null, houseNumber: m[2], city, neighborhood }
    : { street: streetPart || null, houseNumber: null, city, neighborhood };
}

// רחוב-מול-רחוב - אותו מנגנון word-overlap בדיוק (לא ממציא אלגוריתם שני), רק על הרכיב-רחוב-בלבד
// אחרי parseAddressComponents, לא על הכתובת המלאה - כך ששני רחובות זהים בערים-שונות (מקרה נדיר
// אבל אפשרי) לא "מקבלים קרדיט" על שם-העיר שבמקרה חופף.
function streetSimilarity(streetA: string | null, streetB: string | null): number {
  return wordOverlapScoreDropStopwords(streetA, streetB);
}

// 1 = זהה; 0.5 = "קרוב" (הפרש ≤2, בניינים סמוכים לפעמים נרשמים במספר זוגי/אי-זוגי שכן) - אות
// חלקית, לא אפס; 0 = שונה משמעותית; null = לא ניתן להשוואה (אחד הצדדים חסר מספר-בית בכלל -
// "לא ידוע" שונה מ"לא תואם", לא אותו דבר).
function houseNumberMatchScore(numA: string | null, numB: string | null): number | null {
  if (!numA || !numB) return null;
  const a = parseInt(numA.replace(/\D/g, ''), 10);
  const b = parseInt(numB.replace(/\D/g, ''), 10);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a === b) return 1;
  if (Math.abs(a - b) <= 2) return 0.5;
  return 0;
}

// resolveSettlement - injected, לא נבנה כאן: placesDiscovery.ts נשאר טהור (בלי גישת-DB), ה-caller
// (index.ts) בונה Map<normalized-name-or-alias, settlement_id> פעם אחת לכל batch מתוך
// public.settlements (0063, כבר נטען ממילא לבניית רשימת-הבדיקה) + public.settlement_aliases
// (0072, טבלת-כינויים קטנה ומפורשת - "שהם"->"שוהם" וכו', לא fuzzy matching). מחזיר settlement_id
// אמיתי (בטוח) או null (לא הצלחנו לזהות בביטחון - שומר על "אל תמציא התאמה").
export type SettlementResolver = (normalizedCity: string) => string | null;

// city/neighborhood - כבר מנורמלים (normalizeCityName, ועל שכונה - אותה נורמליזציית-טקסט
// הגנרית) - שוויון פשוט, לא word-overlap (אלה שמות-מקום בודדים, לא ביטויים מרובי-מילים).
// null = לא ניתן להשוואה (אחד הצדדים חסר), לא "לא תואם" (boolean false היה מטעה כאן).
//
// 2026-09-12 (post-Batch-10, explicit instruction): "שוהם" מול "שהם" - אותו יישוב אמיתי, אבל
// שתי מחרוזות שונות, אז ההשוואה המילולית הישנה (cityA === cityB) פספסה את זה. תיקון: כשיש
// resolveSettlement, קודם מנסים לפתור את שני הצדדים ל-settlement_id קנוני אמיתי (מהרשימה
// הרשמית + כינויים מפורשים בלבד - לא fuzzy) ולהשוות ID-ים; "מודיעין" מול "מודיעין עילית"/"גני
// מודיעין" ממשיכים NOT to match כי הם settlement_id שונים באמת (יישובים שונים), לא נפילה בטעות
// לאותו אחד. כשאחד הצדדים (או שניהם) לא נפתר בביטחון - נופל בחזרה להשוואת-המחרוזות הקיימת
// (בדיוק ההתנהגות מלפני התיקון), לא מנחש.
function cityMatchFlag(cityA: string | null, cityB: string | null, resolveSettlement?: SettlementResolver): boolean | null {
  if (!cityA || !cityB) return null;
  if (resolveSettlement) {
    const idA = resolveSettlement(cityA);
    const idB = resolveSettlement(cityB);
    if (idA != null && idB != null) return idA === idB;
  }
  return cityA === cityB;
}
function neighborhoodMatchFlag(nA: string | null, nB: string | null): boolean | null {
  if (!nA || !nB) return null;
  return normalizeForMatch(nA) === normalizeForMatch(nB);
}

// address אופציונלי (לא required) בכוונה - matching.test.ts הקיים בונה ExistingForMatch בלי אותו
// (לא רלוונטי לבדיקות-הניתוב שם) - undefined מתנהג זהה ל-null בתוך wordOverlapScoreDropStopwords.
export interface ExistingForMatch { id: string; name: string | null; google_place_id: string | null; lat: number | null; lon: number | null; address?: string | null }
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

// streetScore/houseNumberScore/cityMatch/neighborhoodMatch - רק POSSIBLE_DUPLICATE ממלא אותם
// (ראו matchAgainstExisting) - "display the separate evidence" חל במפורש על אזור 30-50m בלבד,
// לא על שאר ה-outcomes. addressScore (הישן, כתובת-מלאה) נשאר קיים במקביל - לא הוחלף, רק הצטרפו
// אליו רכיבים ממוקדים יותר.
export interface MatchResult {
  outcome: MatchOutcome; match: ExistingForMatch | null; nameScore?: number; addressScore?: number;
  streetScore?: number; houseNumberScore?: number | null; cityMatch?: boolean | null; neighborhoodMatch?: boolean | null;
}

// עותק מדויק של match_against_existing (matching.py) - לעולם לא ממציא התאמה: רק place_id
// זהה נחשב MATCH_CONFIRMED ודאי; כל השאר שרק-אולי-דומה הופך STRONG_MATCH/POSSIBLE_DUPLICATE/
// NEEDS_REVIEW, לא נדרס אוטומטית כ"כפילות" (וגם לא נופל בטעות ל"מקום חדש" כשזה כבר קיים).
// מחזיר גם את הרשומה הקיימת שהותאמה (match) - כדי שכל הסוגים האלה יוכלו להצביע על
// existing_activity_id בתור-הבדיקה (incoming_activities), לא רק שם התאמה גולמי (2026-09-11
// תיקון: קודם הוחזר outcome בלבד, וה-caller פשוט דילג/continue על שני הסוגים האלה, בלי שום
// עקבה - התוצאה נעלמה בשקט, בדיוק כמו הבאג שכבר תוקן ב-tools/playground-discovery).
export function matchAgainstExisting(
  discovered: { place_id: string | null; name: string | null; lat: number | null; lon: number | null; address?: string | null },
  existing: ExistingForMatch[],
  opts: { resolveSettlement?: SettlementResolver } = {},
): MatchResult {
  for (const e of existing) {
    if (e.google_place_id && e.google_place_id === discovered.place_id) return { outcome: 'MATCH_CONFIRMED', match: e };
  }

  let bestScore = 0;
  let bestMatch: ExistingForMatch | null = null;
  let closestVeryClose: { match: ExistingForMatch; distM: number } | null = null;
  let closestBorderline: {
    match: ExistingForMatch; distM: number; nameScore: number; addressScore: number;
    streetScore: number; houseNumberScore: number | null; cityMatch: boolean | null; neighborhoodMatch: boolean | null;
  } | null = null;
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
      // Zone 2 - deliberately does NOT check any of this evidence against a threshold to escalate
      // to STRONG_MATCH (per explicit instruction: 45m + a highly similar name/street still stays
      // POSSIBLE_DUPLICATE, not STRONG_MATCH). Every score here is purely advisory evidence for
      // the human reviewer (attached to MatchResult below, persisted by the caller) - none of it
      // ever changes the routing decision. addressScore (full-address word-overlap, 2026-09-12
      // pre-Batch-8) stays as-is; street/houseNumber/city/neighborhood (2026-09-12 post-Batch-8,
      // explicit instruction) exist *because* addressScore alone can look deceptively high when
      // the only real overlap is the city name (observed in Batch 8: a candidate with no street
      // at all still scored 0.75 against an existing address that only shared the city token) -
      // street-level and house-number agreement are much stronger signals than city-only overlap,
      // so they're now visible as their own fields instead of being averaged into one number.
      const addressScore = wordOverlapScoreDropStopwords(e.address, discovered.address);
      const existingParts = parseAddressComponents(e.address);
      const discoveredParts = parseAddressComponents(discovered.address);
      const streetScore = streetSimilarity(existingParts.street, discoveredParts.street);
      const houseNumberScore = houseNumberMatchScore(existingParts.houseNumber, discoveredParts.houseNumber);
      const cityMatch = cityMatchFlag(existingParts.city, discoveredParts.city, opts.resolveSettlement);
      const neighborhoodMatch = neighborhoodMatchFlag(existingParts.neighborhood, discoveredParts.neighborhood);
      if (!closestBorderline || distM < closestBorderline.distM) {
        closestBorderline = { match: e, distM, nameScore, addressScore, streetScore, houseNumberScore, cityMatch, neighborhoodMatch };
      }
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
  if (closestBorderline) {
    return {
      outcome: 'POSSIBLE_DUPLICATE', match: closestBorderline.match,
      nameScore: closestBorderline.nameScore, addressScore: closestBorderline.addressScore,
      streetScore: closestBorderline.streetScore, houseNumberScore: closestBorderline.houseNumberScore,
      cityMatch: closestBorderline.cityMatch, neighborhoodMatch: closestBorderline.neighborhoodMatch,
    };
  }

  if (bestMatch && bestScore >= 0.3) return { outcome: 'NEEDS_REVIEW', match: bestMatch };
  return { outcome: 'NEW_CANDIDATE', match: null };
}

// SAME_STREET_REVIEW - סיגנל advisory נפרד לגמרי (2026-09-12, post-Batch-10, בקשה מפורשת):
// "This must NOT mean DUPLICATE". רץ רק על מועמדים שכבר קיבלו NEW_CANDIDATE מ-matchAgainstExisting
// (כלומר: לא נופלים לאף אחד משלושת-האזורים - matchAgainstExisting כבר קבע שאין שום existing
// בטווח 0-50m, אז אין צורך לבדוק ">50m" כאן שוב, זה כבר מובטח מבנית). לא נוגע/מחליף את outcome
// של המועמד באף דרך - זו רשומת-evidence *נוספת* (ראו index.ts: נשמרת בטבלה נפרדת לגמרי,
// settlement_scan_same_street_reviews), לא outcome value חדש ולא חסימה של ייבוא/סיווג רגיל.
// "אותו רחוב" = חפיפת-מילים מושלמת (streetSimilarity===1) אחרי parseAddressComponents (מספר-
// בית כבר הוסר) - לא fuzzy, זהות מלאה בין שני שמות-הרחוב המנורמלים. "אותו יישוב" מעדיף
// canonical settlement_id (אם resolveSettlement פותר את שני הצדדים בביטחון), אחרת נופל בחזרה
// להשוואת-מחרוזות פשוטה - בדיוק אותו עיקרון כמו cityMatchFlag למעלה.
export interface SameStreetReviewResult {
  match: ExistingForMatch; distanceM: number; canonicalSettlementId: string | null;
  street: string; nameScore: number; candidateHouseNumber: string | null; existingHouseNumber: string | null;
}

export function findSameStreetReviewMatch(
  discovered: { name: string | null; lat: number | null; lon: number | null; address?: string | null },
  existing: ExistingForMatch[],
  opts: { ceilingMeters: number; resolveSettlement?: SettlementResolver },
): SameStreetReviewResult | null {
  if (discovered.lat == null || discovered.lon == null) return null;
  const dParts = parseAddressComponents(discovered.address);
  if (!dParts.street) return null; // אין רחוב-מועמד בכלל - אין "אותו רחוב" להשוות מולו

  let best: SameStreetReviewResult | null = null;
  for (const e of existing) {
    if (e.lat == null || e.lon == null) continue;
    const distM = haversineKm(e.lat, e.lon, discovered.lat, discovered.lon) * 1000;
    if (distM > opts.ceilingMeters) continue;
    const eParts = parseAddressComponents(e.address);
    if (!eParts.street) continue;
    if (streetSimilarity(dParts.street, eParts.street) < 1) continue;

    const dCanon = dParts.city && opts.resolveSettlement ? opts.resolveSettlement(dParts.city) : null;
    const eCanon = eParts.city && opts.resolveSettlement ? opts.resolveSettlement(eParts.city) : null;
    const sameSettlement = dCanon != null && eCanon != null
      ? dCanon === eCanon
      : (dParts.city != null && dParts.city === eParts.city);
    if (!sameSettlement) continue;

    if (!best || distM < best.distanceM) {
      best = {
        match: e, distanceM: distM, canonicalSettlementId: dCanon ?? eCanon ?? null,
        street: dParts.street, nameScore: wordOverlapScoreDropStopwords(e.name, discovered.name),
        candidateHouseNumber: dParts.houseNumber, existingHouseNumber: eParts.houseNumber,
      };
    }
  }
  return best;
}

// 2026-09-12 (post-Batch-11, explicit instruction): Batch 11 hit "duplicate key value violates
// unique constraint idx_activities_google_place_id" - matchAgainstExisting's MATCH_CONFIRMED
// check already does an exact place_id comparison, but only against the `existing` snapshot
// loaded once at the start of the batch, which can miss a real row (stale snapshot, a category
// filter mismatch, or a race with another process). Fix: index.ts now also does a FRESH,
// authoritative lookup by google_place_id immediately before the INSERT (not a new fuzzy/
// distance rule - an exact-identifier check that is authoritative regardless of what distance/
// name matching concluded). This function is the pure decision on top of that lookup's result,
// so the logic itself is unit-testable without touching Deno.serve/a real DB - the DB round trip
// stays a thin caller in index.ts, same split as everywhere else in this file. The database's
// own unique constraint remains untouched and is still the final safety net if this check is
// ever somehow bypassed (e.g. its own query fails) - see index.ts's error handling around it.
export interface ExactPlaceIdCheckResult { isDuplicate: boolean; existingActivityId: string | null }
export function checkExactPlaceIdDuplicate(
  discoveredPlaceId: string,
  existingRow: { id: string; google_place_id: string | null } | null,
): ExactPlaceIdCheckResult {
  if (existingRow && existingRow.google_place_id === discoveredPlaceId) {
    return { isDuplicate: true, existingActivityId: existingRow.id };
  }
  return { isDuplicate: false, existingActivityId: null };
}

// 2026-09-12 (post-Batch-11, explicit instruction): "פארק החורשות" vs "...לבון, ת"א-יפו" was
// independently rediscovered and logged as a brand-new, disconnected review item in both Batch 9
// and Batch 11 - the admin has no way to tell "this is the third time we've flagged this exact
// pair" from "here's yet another unrelated case". Fix (index.ts's recordReviewCase): a rollup
// table keyed on (google_place_id, existing_activity_id) that increments detection_count and
// bumps last_seen_at on repeat detection, while first_seen_at/first_batch_id/status are never
// touched on a repeat (index.ts's UPDATE payload deliberately excludes them) - so a case an admin
// already triaged doesn't silently reopen, and the original detection timestamp is never lost.
// settlement_scan_candidates keeps logging a full row on every single detection exactly as
// before (unchanged) - this rollup is a dedup VIEW on top of that already-complete history, not
// a replacement for it, so no historical evidence is ever discarded. This function is the pure
// counting decision (given the previous count, if any, what should the new state be) - trivially
// provable to only ever produce a counter increment or a fresh count of 1, never anything that
// could merge/delete/overwrite an activity (it doesn't even receive an activity as input).
export interface ReviewCaseState { detectionCount: number; isFirstDetection: boolean }
export function nextReviewCaseState(previousDetectionCount: number | null | undefined): ReviewCaseState {
  if (previousDetectionCount == null) return { detectionCount: 1, isFirstDetection: true };
  return { detectionCount: previousDetectionCount + 1, isFirstDetection: false };
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
// 2026-09-13: Google sometimes appends a postal code and/or the country ("רחוב, 3090000 זכרון
// יעקב, ישראל" / "כרמיאל, 2198305") - 11 locations ended up with an all-digit city. Drop trailing
// country/postal-code segments and strip a leading postal code inside the locality segment.
const COUNTRY_TOKENS = new Set(['ישראל', 'israel']);
export function extractCityFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean)
    .filter((p) => !COUNTRY_TOKENS.has(p.toLowerCase()) && !/^\d{5,7}$/.test(p));
  if (!parts.length) return null;
  const last = parts[parts.length - 1].replace(/^\d{5,7}\s+/, '').replace(/\s+\d{5,7}$/, '').trim();
  if (!last || /^\d+$/.test(last)) return null;
  return normalizeCityName(last);
}
