// TuRu - is a record filed as "גן שעשועים" (public outdoor playground) really one?
// Regressions (2026-09-17): "פאנקי מאנקי כפר יונה", "ג'ימבו פליי" (פרדסיה) - indoor play centres imported as
// playgrounds by the retired Google settlement scanner (Places type 'playground' + a text search), which
// also imported playground-EQUIPMENT COMPANIES ("... מתקני משחקים בע"מ") as places to visit.
// Deterministic, name-based, and deliberately narrow: only tokens that cannot describe a public playground
// are HIGH. "גן משחקים" / "מגרש משחקים" / "playground" are playgrounds. Ropes / extreme parks are ambiguous
// (a free rope structure in a public garden vs a ticketed park) -> MEDIUM, reported, never auto-changed.
//   -> { kind, category, indoor_outdoor, confidence, token } | null
const { semanticNamePart } = require('../playgroundNaming');
const norm = (s) => String(s || '').toLowerCase().replace(/[׳’`']/g, "'").replace(/[״”]/g, '"').replace(/\s+/g, ' ').trim();

const VENDOR = /(בע"מ|בעמ(\s|$)|\bltd\b|\binc\b|ציוד פנים|יבוא ושיווק|שיווק והפצה)/;
const GYMBOREE = /(ג'ימבורי|גימבורי|ג'מבורי|gymboree|gymbori)/;
const INDOOR_PLAY = /(ג'ימבו|גימבו|jimbo|gymbo|משחקיי?ה(\s|$)|משחקיי?ת\s|משחקיות|פאנקי\s?(מאנקי|וורלד|world|monkey)|funky\s?(monkey|world)|indoor play|soft\s?play|kids\s?(land|club|zone)|play\s?land|בייבי\s?לנד|baby\s?land)/;
// PHASE E (2026-09-21): the attraction-complex and animal vocabularies are no longer private
// hardcoded regexes - they are DERIVED from the shared semantic model
// (constants/categorySemantics.json), so this file cannot drift into a second, competing taxonomy.
// Only each concept's `recallAliases` subset is used: those are the aliases specific enough to be
// evidence ABOUT a record, which is exactly this classifier's job. The bare word 'פארק' is
// deliberately absent from that subset, so a venue is never called an attraction complex for
// merely having "פארק" in its name.
const CATEGORY_SEMANTICS = require('../../../constants/categorySemantics.json');
function aliasRegExp(conceptKey) {
  const parts = CATEGORY_SEMANTICS.concepts[conceptKey].recallAliases
    // A space or hyphen in an alias matches either, or neither: this file's norm() collapses
    // whitespace but does NOT rewrite dashes, so "לונה פארק", "לונה-פארק" and "לונהפארק" must all
    // be reachable from the single alias entry.
    .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[-\s]+/g, '[\\s-]?'));
  return new RegExp(`(${parts.join('|')})`);
}
const AMUSEMENT = aliasRegExp('ATTRACTION_COMPLEX');
// An ANIMAL-primary venue must never be filed as an attraction complex (product decision:
// מדבריום). Checked BEFORE amusement below, so "מדבריום - פארק החיות" resolves to animals even
// though its name also contains "פארק".
const ANIMALS_ZOO = aliasRegExp('ANIMALS_ZOO');
// 2026-09-19 (Google settlement-scanner cohort, place_kind PARK / UNCERTAIN): names that prove another EXISTING
// TURU category - a petting zoo, a botanical garden, a pump track / skate park - are not public playgrounds
const PETTING_ZOO = /(פינת\s?חי|פינת\s?ה?חי(\s|$)|petting\s?zoo)/;
const BOTANICAL = /(גן\s?ה?בוטני|botanic)/;
const SPORTS = /(פאמפ\s?טרק|pump\s?track|סקייט\s?פארק|skate\s?park|מגרש\s?(כדורגל|כדורסל|טניס)|פארק\s?אופניים|bike\s?park)/;
const AMBIGUOUS = /(פארק\s?ה?חבלים|מתחם חבלים|פארק אקסטרים|extreme park|פארק מים|water\s?park|טרמפולינ|trampolin|שלולית\s?חורף|חורשת|חורשה|שמורת)/;

// opts.nameSource = activities.name_source: a generated title is classified on its entity label only (R13) - its street
// tail ("דרך גן החיות", "רחוב הספארי") is never evidence. null = nothing to change (a playground stays a playground).
function classifyPlayVenue(name, { nameSource } = {}) {
  const n = norm(semanticNamePart(name, nameSource));
  if (!n) return null;
  if (VENDOR.test(n)) return { kind: 'not_a_place', category: null, indoor_outdoor: null, confidence: 'HIGH', token: VENDOR.exec(n)[0].trim(), why: 'a company name (equipment vendor / Ltd.), not a place to visit' };
  let m;
  if ((m = GYMBOREE.exec(n))) return { kind: 'indoor_play', category: "ג'ימבורי", indoor_outdoor: 'indoor', confidence: 'HIGH', token: m[0], why: 'gymboree is an indoor play venue' };
  if ((m = INDOOR_PLAY.exec(n))) return { kind: 'indoor_play', category: 'משחקייה', indoor_outdoor: 'indoor', confidence: 'HIGH', token: m[0].trim(), why: 'indoor play centre by name' };
  // Animals first - primary experience wins over the word "פארק" in the name.
  if ((m = ANIMALS_ZOO.exec(n))) return { kind: 'animals_zoo', category: 'חיות וגני חיות', indoor_outdoor: null, confidence: 'HIGH', token: m[0], why: 'zoo / safari / aquarium by name - an animal destination, not an attraction complex' };
  // category stays the LEGACY DB value 'פארק שעשועים'; the product concept is "מתחם אטרקציות"
  // (see categorySemantics.json ATTRACTION_COMPLEX.dbValue). Renaming the stored value is a
  // separate data phase, so this writes what the column actually accepts today.
  if ((m = AMUSEMENT.exec(n))) return { kind: 'amusement_park', category: 'פארק שעשועים', indoor_outdoor: null, confidence: 'HIGH', token: m[0], why: 'attraction complex by name' };
  if ((m = PETTING_ZOO.exec(n))) return { kind: 'petting_zoo', category: 'פינת חי', indoor_outdoor: null, confidence: 'HIGH', token: m[0].trim(), why: 'petting zoo by name' };
  if ((m = BOTANICAL.exec(n))) return { kind: 'botanical_garden', category: 'טבע', indoor_outdoor: 'outdoor', confidence: 'HIGH', token: m[0].trim(), why: 'botanical garden by name' };
  if ((m = SPORTS.exec(n))) return { kind: 'sports_facility', category: 'ספורט', indoor_outdoor: 'outdoor', confidence: 'HIGH', token: m[0].trim(), why: 'sports facility by name (pump track / skate park / court)' };
  if ((m = AMBIGUOUS.exec(n))) return { kind: 'ambiguous_attraction', category: null, indoor_outdoor: null, confidence: 'MEDIUM', token: m[0], why: 'may be a ticketed attraction / nature site or a public play structure - needs evidence' };
  return null;
}

module.exports = { classifyPlayVenue };
