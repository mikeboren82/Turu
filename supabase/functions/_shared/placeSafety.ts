// TuRu - PLACE IDENTITY SAFETY (2026-09-24, verify_location pilot #5). Pure, deterministic, no I/O.
// Node twin: tools/import-tool/lib/placeSafety.js; shared table: _shared/placeSafety.cases.json.
//
// 1. COMPOUND PLACE LABELS. "גן החיות ואקווריום ישראל" names TWO independently actionable places. The candidate
//    "אקווריום ישראל" carried it as its location label; the resolver matched the compound canonical venue, whose point
//    is the ZOO's (~1 km from the aquarium), and the row would have been written there. A label is compound only
//    when it splits on "/", "|", "+", "&" or a ו-prefixed PLACE NOUN ("ואקווריום", "ומרכז", "והספרייה") and EVERY
//    side itself names a place - "מרכז שטיינברג לתרבות ואמנות" / "היכל התרבות והספורט" are ordinary single names.
//    When the title names exactly ONE component (a sub-place), the compound label's point may not stand in for it:
//    the canonical policy holds (location_compound_label) unless the location came from event-local page evidence.
//    A title naming the whole complex (both components) or neither is not a sub-place claim.
// 2. SAME-NAME PLACES. Two place records (מקום_קבוע / fixed hours) with the exact same non-generic name in the same
//    settlement are at least a POSSIBLE identity (review), even when their coordinates disagree - a wrong point must
//    not turn an existing place into a "new" one. The name alone never makes a duplicate: a same address or the same
//    canonical venue does. Generic names ("ספרייה עירונית", "גן שעשועים") never get the floor (branches).
import { isGenericPlaygroundName } from './playgroundNaming.ts';

const PLACE_NOUN = '(?:גן\\s+(?:ה)?חיות|גן\\s+(?:ה)?בוטני|אקווריום|קניון|קולנוע|סינמה|סינמטק|מוזיאון|מרכז|פארק|ספרי(?:י)?ה|ספריית|מתנ["״]?ס|היכל|תיאטרון|תאטרון|אולם|בריכה|מתחם|גלריה|ביתן|חוות?|אודיטוריום|מצפה|פינת\\s+חי|משחקייה|לונה\\s+פארק|ספארי|בית\\s+(?:ה)?(?:תרבות|ספר|קפה))';
const SPLIT_RE = new RegExp(`\\s*[\\/|+&]\\s*|\\s+ו-?(?=(?:ה)?${PLACE_NOUN})`);
const STARTS_WITH_PLACE = new RegExp(`^(?:ה)?${PLACE_NOUN}`);
const fold = (s: unknown) => String(s ?? '').toLowerCase().replace(/["'`״׳’”“]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/יי/g, 'י').replace(/וו/g, 'ו').replace(/\s+/g, ' ').trim();

export interface CompoundPlace { compound: boolean; components: string[]; titleComponent: number | null }
export function compoundPlace(label: unknown, title: unknown): CompoundPlace {
  const raw = String(label ?? '').trim();
  const parts = raw.split(SPLIT_RE).map((p) => p.replace(/^ו-?/, '').trim()).filter((p) => p.length >= 2);
  const compound = parts.length >= 2 && parts.every((p) => STARTS_WITH_PLACE.test(p));
  if (!compound) return { compound: false, components: [], titleComponent: null };
  const t = fold(title);
  const hits = parts.map((p, i) => { const f = fold(p); return t.length >= 4 && f.length >= 4 && (t.includes(f) || f.includes(t)) ? i : -1; }).filter((i) => i >= 0);
  return { compound: true, components: parts, titleComponent: hits.length === 1 ? hits[0] : null };
}

// the item's coordinates came from ITS OWN page (a map pin / JSON-LD / an address bound to it) - event-local evidence
// that identifies the component, which the compound label alone cannot
// deno-lint-ignore no-explicit-any
export function hasEventLocalLocation(c: any): boolean {
  const cl = c?.cleaner_location; if (!cl) return false;
  const cls = cl.verification?.class || cl.confidence;
  return ['source_page', 'detail_page', 'venue_site'].includes(cl.method) && ['HIGH', 'MEDIUM'].includes(cls);
}
// deno-lint-ignore no-explicit-any
export function compoundLocationHold(c: any): { component: string; label: string } | null {
  const cp = compoundPlace(c?.location_name, c?.name);
  if (!cp.compound || cp.titleComponent === null || hasEventLocalLocation(c)) return null;
  return { component: cp.components[cp.titleComponent], label: String(c.location_name) };
}

// ---- same-name places ----
const GENERIC_PLACE_NAMES = new Set(['ספריה', 'ספריה עירונית', 'הספריה העירונית', 'ספרית', 'מתנס', 'המתנס', 'מרכז קהילתי', 'גן שעשועים', 'גן משחקים', 'פארק', 'גינה', 'גינה ציבורית', 'גן ציבורי', 'בריכה', 'בריכה עירונית', 'בריכת שחיה', 'קניון', 'מרכז מבקרים', 'מגרש', 'מגרש משחקים', 'פינת ליטוף', 'פינת חי', 'מוזיאון', 'גלריה', 'אולם ספורט', 'חוף', 'חוף רחצה', 'משחקיה', 'פארק שעשועים', 'פארק משחקים', 'גינת משחקים', 'גן ילדים', 'מתקני משחק']);
// deno-lint-ignore no-explicit-any
export const isPlaceShaped = (x: any) => !!x && (x.entity_type === 'מקום_קבוע' || x.schedule_type === 'fixed_hours');
// generic once the locality is dropped: a generated "גן שעשועים – תל אביב יפו" is a KIND of place in a city, not one place
export function samePlaceName(a: unknown, b: unknown, city: unknown = null): boolean {
  const x = fold(a), y = fold(b);
  if (!x || x !== y || x.length < 4) return false;
  const cityWords = new Set(fold(city).split(' ').filter(Boolean));
  const core = x.split(' ').filter((w) => !cityWords.has(w) && !(w.length > 2 && /^[בל]/.test(w) && cityWords.has(w.slice(1)))).join(' ');
  return !!core && !GENERIC_PLACE_NAMES.has(core) && !GENERIC_PLACE_NAMES.has(x) && !isGenericPlaygroundName(String(a ?? ''));
}
// the identity floor: two place records, not playgrounds (they have their own twin reconciliation - many share a
// generated name), the same non-generic name, the same settlement
// deno-lint-ignore no-explicit-any
export function placeNameIdentity(candidate: any, existing: any, sameCity: boolean): boolean {
  if (!sameCity || !isPlaceShaped(candidate) || !isPlaceShaped(existing)) return false;
  if (candidate.category === 'גן שעשועים' || existing.category === 'גן שעשועים') return false;
  return samePlaceName(candidate.name, existing.name, candidate.city || existing.city);
}
const foldAddress = (s: unknown) => fold(s).replace(/^(רחוב|רח|שדרות|שד|דרך)\s+/, '').replace(/\s*,.*$/, '');
export function sameAddress(a: unknown, b: unknown): boolean {
  const x = foldAddress(String(a ?? '').split(',')[0]), y = foldAddress(String(b ?? '').split(',')[0]);
  return !!x && x === y && /\d/.test(x); // a street without a house number is not one place
}
