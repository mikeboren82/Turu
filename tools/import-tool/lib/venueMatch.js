// TuRu - R12 (2026-09-26, Phase 1 ledger Z-A): automatic venue learning MATCHES existing venues before it creates one.
// Every automatic creator (propose-venues, the Cleaner's venue clusters, escalate-venue) goes through
// venueLearning.createVenueWithAlias, which asks matchExistingVenue first. Regression: the label "גן החיות התנ״כי
// בירושלים" missed the exact alias "גן החיות התנ"כי ירושלים" by one prefix letter and propose-venues created a second
// Jerusalem zoo venue 190 m from the seeded one (then a third) - repaired by Batch F part 2.
//
// No new fuzzy system - the ladder composes rules TuRu already trusts, first decisive level wins:
//   1 external identity    the google_place_id owner (lib/venuePlaceId; follows merged_into)
//   2 alias                venueNaming.resolveVenue: exact normalized alias + city (generic labels: attestation only);
//                          the alias known only in ANOTHER city -> HOLD (unchanged rule)
//   3 same spot            lib/placeIdentity: <= 80 m and name agreement >= 0.8 once locality words are dropped
//   4 same name            every non-locality word equal + same settlement + <= 300 m
// Anything near-identical that no level settles (farther away, no coordinates, two venues) is HELD - never guessed,
// never created. A match on a merged loser lands on its keeper; a deactivated (not merged) venue is a human decision
// -> HOLD. Generic / weak names (placeSafety GENERIC_PLACE_NAMES, generic library labels, a core that locality
// stripping empties - city-only, Arabic) are never level-3/4 evidence on EITHER side: such a candidate is NO_MATCH, and
// the pre-R12 creation policy decides it (never an R12-only hold).
// Identity only: a reuse at ANY level never writes an alias (an inferred label like "ספריית הילדים והנוער" or
// "היכל התרבות" would become a cross-city binding trap) - learning aliases needs its own specificity policy.
const { normalizeCityName, CANONICAL_CITY_ALIASES } = require('../cityNaming');
const { resolveVenue, genericVenueType, sameCityStrict } = require('../venueNaming');
const { placeNameAgreement, placeNameWords, SAME_PLACE_KM, NAME_AGREEMENT } = require('./placeIdentity');
const { GENERIC_PLACE_NAMES } = require('./placeSafety');
const { haversineKm } = require('./canonicalSettlement');
const { canonicalVenueByPlaceId, CODES: PLACE_ID_CODES } = require('./venuePlaceId');

const SAME_NAME_KM = 0.3;
const MAX_HOPS = 5;
const BOX_LAT = 0.003, BOX_LNG = 0.0035; // ~330 m around the candidate, refined by the exact distance
const VENUE_COLS = 'id, name_he, city, lat, lng, is_active, merged_into, venue_type';

function isGenericVenueName(name, city) {
  if (genericVenueType(name)) return true;
  const core = [...placeNameWords(name, city)].join(' ');
  return !core || GENERIC_PLACE_NAMES.has(core);
}

const hold = (level, reason, extra = {}) => ({ verdict: 'HOLD', level, reason, ...extra });
const round = (x, p) => (x == null ? null : Math.round(x * p) / p);

// one existing venue record ({id, name_he, aliases[], city, lat, lng, ...}) against the candidate {label, city, lat, lng}
function compareVenue(cand, rec) {
  const city = cand.city || rec.city || null;
  const names = [rec.name_he, ...(rec.aliases || [])].filter((n) => n && !isGenericVenueName(n, rec.city || city));
  if (!names.length) return { decision: 'NONE' };
  const agreement = Math.max(...names.map((n) => placeNameAgreement(cand.label, n, city)));
  const km = [cand.lat, cand.lng, rec.lat, rec.lng].every((x) => x != null)
    ? haversineKm(Number(cand.lat), Number(cand.lng), Number(rec.lat), Number(rec.lng)) : null;
  const sameCity = sameCityStrict(cand.city, rec.city);
  const at = { agreement: round(agreement, 100), km: round(km, 1000) };
  if (km != null && km <= SAME_PLACE_KM && agreement >= NAME_AGREEMENT) return { decision: 'MATCH', level: 3, reason: 'same spot (<= 80 m), names agree without locality words', ...at };
  if (agreement === 1 && sameCity && km != null && km <= SAME_NAME_KM) return { decision: 'MATCH', level: 4, reason: 'same name without locality words, same settlement, <= 300 m', ...at };
  if (agreement >= NAME_AGREEMENT && (sameCity || (km != null && km <= SAME_NAME_KM))) {
    return { decision: 'AMBIGUOUS', level: null, reason: km == null ? 'agreeing name in the same settlement, no coordinates to compare' : 'agreeing name nearby, but not close enough to be the same place', ...at };
  }
  return { decision: 'NONE', ...at };
}

// pure: levels 3-4 over injected records (merged losers AND their keepers must be included)
// -> { verdict: MATCH | HOLD | NO_MATCH, level, reason, venue?, via?, candidates[] }
function decideVenueMatch(cand, records) {
  if (isGenericVenueName(cand.label, cand.city)) return { verdict: 'NO_MATCH', level: null, reason: 'generic / weak label - no level-3/4 identity evidence; the creation policy decides', candidates: [] };
  const byId = new Map(records.map((r) => [r.id, r]));
  const keeperOf = (r) => { let v = r; for (let i = 0; i < MAX_HOPS && v && v.merged_into; i++) v = byId.get(v.merged_into); return v && !v.merged_into ? v : null; };
  const scored = records.map((rec) => ({ rec, ...compareVenue(cand, rec) })).filter((s) => s.decision !== 'NONE');
  const candidates = scored.map((s) => ({ id: s.rec.id, name: s.rec.name_he, decision: s.decision, level: s.level ?? null, km: s.km, agreement: s.agreement }));
  if (!scored.length) return { verdict: 'NO_MATCH', level: null, reason: 'no existing venue shares an identity signal', candidates };

  const targets = new Map(scored.map((s) => { const k = keeperOf(s.rec); return [k ? k.id : `broken:${s.rec.id}`, k]; }));
  const matches = scored.filter((s) => s.decision === 'MATCH');
  if (!matches.length) return hold(null, scored[0].reason, { candidates });
  if (targets.size !== 1) return hold(Math.min(...matches.map((s) => s.level)), 'identity points at more than one existing venue', { candidates });
  const [keeper] = targets.values();
  if (!keeper) return hold(null, 'matched a merged venue whose merged_into chain does not end at a keeper', { candidates });
  if (!keeper.is_active) return hold(null, `matches deactivated venue ${keeper.name_he} - reviving it is a human decision`, { candidates });
  const best = matches.reduce((a, b) => (a.level <= b.level ? a : b));
  return { verdict: 'MATCH', level: best.level, reason: best.reason, venue: keeper, via: best.rec.id !== keeper.id ? best.rec.id : undefined, candidates };
}

async function rows(q) {
  const { data, error } = await q;
  if (error) throw new Error(error.message || String(error));
  return data || [];
}

// active + merged + deactivated venues in the settlement or within ~300 m, the keepers of any merged ones, and aliases
// the canonical settlement plus only the stored short forms cityNaming's evidence-based table maps to it
// ("תל אביב יפו" also reads venues still stored as "תל אביב") - no fuzzy widening
function storedCityForms(cityNorm) {
  return [cityNorm, ...Object.keys(CANONICAL_CITY_ALIASES).filter((k) => CANONICAL_CITY_ALIASES[k] === cityNorm)];
}

async function loadNearbyVenues(client, { city, lat, lng }) {
  const byId = new Map();
  if (city) for (const r of await rows(client.from('venues').select(VENUE_COLS).in('city', storedCityForms(city)))) byId.set(r.id, r);
  if (lat != null && lng != null) {
    const q = client.from('venues').select(VENUE_COLS).gte('lat', Number(lat) - BOX_LAT).lte('lat', Number(lat) + BOX_LAT).gte('lng', Number(lng) - BOX_LNG).lte('lng', Number(lng) + BOX_LNG);
    for (const r of await rows(q)) byId.set(r.id, r);
  }
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const missing = [...new Set([...byId.values()].map((r) => r.merged_into).filter((id) => id && !byId.has(id)))];
    if (!missing.length) break;
    for (const r of await rows(client.from('venues').select(VENUE_COLS).in('id', missing))) byId.set(r.id, r);
  }
  const ids = [...byId.keys()];
  const aliases = new Map();
  for (let i = 0; i < ids.length; i += 150) {
    for (const a of await rows(client.from('venue_aliases').select('venue_id, alias').in('venue_id', ids.slice(i, i + 150)))) {
      if (!aliases.has(a.venue_id)) aliases.set(a.venue_id, []);
      aliases.get(a.venue_id).push(a.alias);
    }
  }
  return [...byId.values()].map((r) => ({ ...r, aliases: aliases.get(r.id) || [] }));
}

// the full ladder. Never throws: a failed lookup is a HOLD (a venue is never created blind).
async function matchExistingVenue(client, { label, city, lat, lng, googlePlaceId }) {
  const cityNorm = normalizeCityName(city || null);
  try {
    if (googlePlaceId) {
      const r = await canonicalVenueByPlaceId(client, googlePlaceId);
      if (r.venue) return r.inactive ? hold(1, `google_place_id belongs to deactivated venue ${r.venue.name_he}`) : { verdict: 'MATCH', level: 1, reason: 'same google_place_id', venue: r.venue };
      if (r.code !== PLACE_ID_CODES.UNRESOLVED) return hold(1, `google_place_id lookup failed: ${r.error}`);
    }
    const byAlias = await resolveVenue(client, { locationName: label, city: cityNorm });
    if (byAlias) return { verdict: 'MATCH', level: 2, reason: 'exact alias', venue: byAlias };
    if (cityNorm) {
      const elsewhere = await resolveVenue(client, { locationName: label, city: null });
      if (elsewhere) return hold(2, `alias exists as ${elsewhere.name_he} [${elsewhere.city}] - city mismatch, human check`);
    }
    return decideVenueMatch({ label, city: cityNorm, lat, lng }, await loadNearbyVenues(client, { city: cityNorm, lat, lng }));
  } catch (e) {
    return hold(null, `identity lookup failed: ${e.message}`);
  }
}

module.exports = { matchExistingVenue, decideVenueMatch, compareVenue, loadNearbyVenues, isGenericVenueName, storedCityForms, SAME_NAME_KM };
