// TuRu - is a record filed as "גן שעשועים" (public outdoor playground) really one?
// Regressions (2026-09-17): "פאנקי מאנקי כפר יונה", "ג'ימבו פליי" (פרדסיה) - indoor play centres imported as
// playgrounds by the retired Google settlement scanner (Places type 'playground' + a text search), which
// also imported playground-EQUIPMENT COMPANIES ("... מתקני משחקים בע"מ") as places to visit.
// Deterministic, name-based, and deliberately narrow: only tokens that cannot describe a public playground
// are HIGH. "גן משחקים" / "מגרש משחקים" / "playground" are playgrounds. Ropes / extreme parks are ambiguous
// (a free rope structure in a public garden vs a ticketed park) -> MEDIUM, reported, never auto-changed.
//   -> { kind, category, indoor_outdoor, confidence, token } | null
const norm = (s) => String(s || '').toLowerCase().replace(/[׳’`']/g, "'").replace(/[״”]/g, '"').replace(/\s+/g, ' ').trim();

const VENDOR = /(בע"מ|בעמ(\s|$)|\bltd\b|\binc\b|ציוד פנים|יבוא ושיווק|שיווק והפצה)/;
const GYMBOREE = /(ג'ימבורי|גימבורי|ג'מבורי|gymboree|gymbori)/;
const INDOOR_PLAY = /(ג'ימבו|גימבו|jimbo|gymbo|משחקיי?ה(\s|$)|משחקיי?ת\s|משחקיות|פאנקי\s?(מאנקי|וורלד|world|monkey)|funky\s?(monkey|world)|indoor play|soft\s?play|kids\s?(land|club|zone)|play\s?land|בייבי\s?לנד|baby\s?land)/;
const AMUSEMENT = /(לונה\s?פארק|luna\s?park)/;
const AMBIGUOUS = /(פארק\s?ה?חבלים|מתחם חבלים|פארק אקסטרים|extreme park|פארק מים|water\s?park|טרמפולינ|trampolin)/;

function classifyPlayVenue(name) {
  const n = norm(name);
  if (!n) return null;
  if (VENDOR.test(n)) return { kind: 'not_a_place', category: null, indoor_outdoor: null, confidence: 'HIGH', token: VENDOR.exec(n)[0].trim(), why: 'a company name (equipment vendor / Ltd.), not a place to visit' };
  let m;
  if ((m = GYMBOREE.exec(n))) return { kind: 'indoor_play', category: "ג'ימבורי", indoor_outdoor: 'indoor', confidence: 'HIGH', token: m[0], why: 'gymboree is an indoor play venue' };
  if ((m = INDOOR_PLAY.exec(n))) return { kind: 'indoor_play', category: 'משחקייה', indoor_outdoor: 'indoor', confidence: 'HIGH', token: m[0].trim(), why: 'indoor play centre by name' };
  if ((m = AMUSEMENT.exec(n))) return { kind: 'amusement_park', category: 'פארק שעשועים', indoor_outdoor: null, confidence: 'HIGH', token: m[0], why: 'amusement park by name' };
  if ((m = AMBIGUOUS.exec(n))) return { kind: 'ambiguous_attraction', category: null, indoor_outdoor: null, confidence: 'MEDIUM', token: m[0], why: 'may be a ticketed attraction or a public play structure - needs evidence' };
  return null;
}

module.exports = { classifyPlayVenue };
