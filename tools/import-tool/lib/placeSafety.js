// TuRu - PLACE IDENTITY SAFETY, Node twin of supabase/functions/_shared/placeSafety.ts (identical rules; the shared
// table _shared/placeSafety.cases.json runs against both). Compound place labels ("גן החיות ואקווריום ישראל") never
// lend one component's point to another; exact same-name places in one settlement are at least a possible identity.
// See the Deno twin's header for the full rationale (verify_location pilot #5, 2026-09-24).
const { isGenericPlaygroundName } = require('../playgroundNaming');

const PLACE_NOUN = '(?:גן\\s+(?:ה)?חיות|גן\\s+(?:ה)?בוטני|אקווריום|קניון|קולנוע|סינמה|סינמטק|מוזיאון|מרכז|פארק|ספרי(?:י)?ה|ספריית|מתנ["״]?ס|היכל|תיאטרון|תאטרון|אולם|בריכה|מתחם|גלריה|ביתן|חוות?|אודיטוריום|מצפה|פינת\\s+חי|משחקייה|לונה\\s+פארק|ספארי|בית\\s+(?:ה)?(?:תרבות|ספר|קפה))';
const SPLIT_RE = new RegExp(`\\s*[\\/|+&]\\s*|\\s+ו-?(?=(?:ה)?${PLACE_NOUN})`);
const STARTS_WITH_PLACE = new RegExp(`^(?:ה)?${PLACE_NOUN}`);
const fold = (s) => String(s ?? '').toLowerCase().replace(/["'`״׳’”“]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/יי/g, 'י').replace(/וו/g, 'ו').replace(/\s+/g, ' ').trim();

function compoundPlace(label, title) {
  const raw = String(label ?? '').trim();
  const parts = raw.split(SPLIT_RE).map((p) => p.replace(/^ו-?/, '').trim()).filter((p) => p.length >= 2);
  const compound = parts.length >= 2 && parts.every((p) => STARTS_WITH_PLACE.test(p));
  if (!compound) return { compound: false, components: [], titleComponent: null };
  const t = fold(title);
  const hits = parts.map((p, i) => { const f = fold(p); return t.length >= 4 && f.length >= 4 && (t.includes(f) || f.includes(t)) ? i : -1; }).filter((i) => i >= 0);
  return { compound: true, components: parts, titleComponent: hits.length === 1 ? hits[0] : null };
}
function hasEventLocalLocation(c) {
  const cl = c && c.cleaner_location; if (!cl) return false;
  const cls = (cl.verification && cl.verification.class) || cl.confidence;
  return ['source_page', 'detail_page', 'venue_site'].includes(cl.method) && ['HIGH', 'MEDIUM'].includes(cls);
}
function compoundLocationHold(c) {
  const cp = compoundPlace(c && c.location_name, c && c.name);
  if (!cp.compound || cp.titleComponent === null || hasEventLocalLocation(c)) return null;
  return { component: cp.components[cp.titleComponent], label: String(c.location_name) };
}

const GENERIC_PLACE_NAMES = new Set(['ספריה', 'ספריה עירונית', 'הספריה העירונית', 'ספרית', 'מתנס', 'המתנס', 'מרכז קהילתי', 'גן שעשועים', 'גן משחקים', 'פארק', 'גינה', 'גינה ציבורית', 'גן ציבורי', 'בריכה', 'בריכה עירונית', 'בריכת שחיה', 'קניון', 'מרכז מבקרים', 'מגרש', 'מגרש משחקים', 'פינת ליטוף', 'פינת חי', 'מוזיאון', 'גלריה', 'אולם ספורט', 'חוף', 'חוף רחצה', 'משחקיה', 'פארק שעשועים', 'פארק משחקים', 'גינת משחקים', 'גן ילדים', 'מתקני משחק']);
const isPlaceShaped = (x) => !!x && (x.entity_type === 'מקום_קבוע' || x.schedule_type === 'fixed_hours');
// generic once the locality is dropped: a generated "גן שעשועים – תל אביב יפו" is a KIND of place in a city, not one place
function samePlaceName(a, b, city = null) {
  const x = fold(a), y = fold(b);
  if (!x || x !== y || x.length < 4) return false;
  const cityWords = new Set(fold(city).split(' ').filter(Boolean));
  const core = x.split(' ').filter((w) => !cityWords.has(w) && !(w.length > 2 && /^[בל]/.test(w) && cityWords.has(w.slice(1)))).join(' ');
  return !!core && !GENERIC_PLACE_NAMES.has(core) && !GENERIC_PLACE_NAMES.has(x) && !isGenericPlaygroundName(String(a ?? ''));
}
// the identity floor: two place records, not playgrounds (their own twin reconciliation; many share a generated name)
function placeNameIdentity(candidate, existing, sameCity) {
  if (!sameCity || !isPlaceShaped(candidate) || !isPlaceShaped(existing)) return false;
  if (candidate.category === 'גן שעשועים' || existing.category === 'גן שעשועים') return false;
  return samePlaceName(candidate.name, existing.name, candidate.city || existing.city);
}
const foldAddress = (s) => fold(s).replace(/^(רחוב|רח|שדרות|שד|דרך)\s+/, '').replace(/\s*,.*$/, '');
function sameAddress(a, b) {
  const x = foldAddress(String(a ?? '').split(',')[0]), y = foldAddress(String(b ?? '').split(',')[0]);
  return !!x && x === y && /\d/.test(x);
}

module.exports = { compoundPlace, hasEventLocalLocation, compoundLocationHold, isPlaceShaped, samePlaceName, placeNameIdentity, sameAddress, GENERIC_PLACE_NAMES };
