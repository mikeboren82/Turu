// TuRu Cleaner - MISSING_CITY: a published activity with coordinates but no canonical city.
// Evidence hierarchy (strongest canonical knowledge first, external request last):
//   V  the linked canonical venue's city
//   A  a settlement named in the stored address (Google formatted address / source text)
//   R  reverse geocode of the coordinates (existing Cleaner reverse.js, throttled + cached)
// Every raw locality goes RAW -> normalizeCityName -> canonical settlement (lib/canonicalSettlement.js)
// -> geographic consistency (CBS centroid distance, agreement between V / A / R) -> confidence.
// The raw geocoder value is never written. Nothing is guessed: an unknown locality, an administrative
// area ("מועצה אזורית ...") or disagreeing signals leave the city empty with an explanation.
// This case never touches an existing city (that would be CITY_MAYBE_WRONG - reported, not repaired here).
const { resolveSettlement, settlementFromAddress, heKey, isMissingCity, isAdministrativeArea, centroidCheck, nearestSettlements, classifyCityValue } = require('../lib/canonicalSettlement');

const WEAK_SOURCES = new Set(['geocode:city_centroid', 'geocode:city_centroid_suspected']);
// generous frame around Israel + the territories; anything outside is not a usable coordinate
const FRAME = { latMin: 29.3, latMax: 33.5, lngMin: 34.1, lngMax: 36.0 };
const FOREIGN = new Set(['jo', 'eg', 'lb', 'sy', 'sa', 'cy']);

function validCoords(lat, lng) {
  const a = Number(lat), b = Number(lng);
  if (lat == null || lng == null || !Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a === 0 && b === 0) return false;
  return a >= FRAME.latMin && a <= FRAME.latMax && b >= FRAME.lngMin && b <= FRAME.lngMax;
}

// first locality-level reverse field that is a canonical settlement; administrative areas are skipped
function settlementFromReverse(index, rev) {
  const seen = [];
  for (const l of rev?.localities || []) {
    if (isAdministrativeArea(l.value)) { seen.push({ ...l, skipped: 'administrative_area' }); continue; }
    const s = resolveSettlement(index, l.value);
    if (s) return { settlement: s, field: l.field, raw: l.value, seen };
    seen.push({ ...l, skipped: 'not_a_canonical_settlement' });
  }
  return { settlement: null, seen };
}

// subject: { lat, lng, city, address, region, address_source, address_confidence, venue_city, replace_city? }
//   replace_city (CITY_NOT_CANONICAL, 0099): the caller asserts the stored city is NOT canonical (a regional
//   council, a spelling variant, an unknown locality string) and asks for the canonical value; the stored
//   value is evidence (a council must agree with the resolved settlement's council), never identity, and it
//   is returned as `previous_city` so the write can be guarded on it. Without the flag an existing city is
//   never touched (ALREADY_FIXED).
// deps: { index, reverse(lat,lng) -> reverse.js shape | null | throws }
// -> { klass, confidence, city, settlement_id, region, raw, normalized, method, signals[], evidence, reason, previous_city }
//    klass: AUTO_FIX_HIGH | NEEDS_CORROBORATION | CONFLICT | UNRESOLVED | INVALID_COORDINATES | ALREADY_FIXED | OTHER | RETRY
//    OTHER reasons: outside_israel (Jordan / Egypt / Lebanon / Gaza - service-area archive) |
//                   palestinian_locality (country ps, no CBS settlement within 2 km - a service-area DECISION, not a repair)
async function proposeCity(subject, { index, reverse, stats = {} }) {
  const signals = []; const evidence = {};
  const previous = subject.replace_city ? subject.city : null;
  const done = (klass, confidence, extra = {}) => ({ klass, confidence, city: null, settlement_id: null, region: null, raw: null, normalized: null, method: null, signals, evidence, previous_city: previous, ...extra });
  let stored = null;
  if (!isMissingCity(subject.city)) {
    if (!subject.replace_city) return done('ALREADY_FIXED', null, { reason: 'city already present: ' + subject.city });
    stored = classifyCityValue(index, subject.city);
    if (!stored) return done('ALREADY_FIXED', null, { reason: 'city is already canonical: ' + subject.city });
    signals.push(`stored_${stored.kind}(${subject.city})`);
    evidence.stored = { value: subject.city, ...stored };
  }
  if (!validCoords(subject.lat, subject.lng)) return done('INVALID_COORDINATES', null, { reason: 'coordinates missing or outside the service frame' });
  const lat = Number(subject.lat), lng = Number(subject.lng);
  const weak = WEAK_SOURCES.has(subject.address_source) || subject.address_confidence === 'LOW';
  if (weak) signals.push('weak_coordinates(' + (subject.address_source || 'LOW') + ')');
  // a pure spelling / alias variant of a settlement whose centroid fits the coordinates: normalize through the
  // shared resolver, no external request; a variant whose settlement is far from the point falls through to evidence
  if (stored && stored.kind === 'variant') {
    const S = index.byId.get(String(stored.settlement_id));
    const c = centroidCheck(S, lat, lng, 'city');
    if (!c || c.plausible) { evidence.centroid = c; signals.push('variant_normalized'); return done('AUTO_FIX_HIGH', 'HIGH', { city: S.city, settlement_id: S.settlement_id, region: S.region, raw: subject.city, normalized: heKey(subject.city), method: 'spelling_normalization' }); }
    signals.push(`variant_far_from_centroid(${c.km}km)`);
  }
  const storedCouncil = stored && stored.kind === 'administrative_area' ? stored.council : null;

  // V - canonical venue locality
  let V = null;
  if (subject.venue_city) { V = resolveSettlement(index, subject.venue_city); signals.push(V ? `venue_city=${V.city}` : `venue_city_unresolved(${subject.venue_city})`); if (V) evidence.venue = { raw: subject.venue_city, city: V.city, how: V.how }; }
  // A - address text
  const addr = settlementFromAddress(index, subject.address, lat, lng);
  let A = addr?.settlement || null;
  if (A) { signals.push(`address_city=${A.city}(${addr.token})`); evidence.address = { token: addr.token, city: A.city, how: A.how, centroid: addr.centroid }; }
  if (addr?.rejected?.length) { signals.push('address_token_implausible:' + addr.rejected.map((r) => `${r.token}@${r.km}km`).join('|')); evidence.address_rejected = addr.rejected; }

  // R - reverse geocode (the only external request; skipped when V and A already agree)
  let R = null, rev = null, Rfield = null;
  if (!(V && A && V.settlement_id === A.settlement_id)) {
    stats.reverseAttempts = (stats.reverseAttempts || 0) + 1;
    try { rev = await reverse(lat, lng); } catch (e) { return done('RETRY', null, { reason: 'reverse geocode failed: ' + (e.message || e) }); }
    if (!rev) return done('RETRY', null, { reason: 'reverse geocode unavailable (rate limit / timeout / no answer)' });
    stats.reverseSuccess = (stats.reverseSuccess || 0) + 1;
    evidence.reverse = { localities: rev.localities, country: rev.countryCode, display: rev.raw };
    if (/רצועת עזה|غزة|gaza/i.test(rev.state || '')) return done('OTHER', 'HIGH', { reason: 'outside_israel', raw: rev.raw, method: 'reverse_geocode', signals: [...signals, 'state=' + rev.state] });
    if (rev.countryCode && FOREIGN.has(String(rev.countryCode).toLowerCase())) return done('OTHER', 'HIGH', { reason: 'outside_israel', raw: rev.raw, method: 'reverse_geocode', signals: [...signals, 'country=' + rev.countryCode] });
    // a bare one-token address that is the very street the geocoder reports is a street, not a city
    if (A && addr.single && rev.street && heKey(rev.street) === heKey(addr.token)) { signals.push('address_token_is_street(' + addr.token + ')'); delete evidence.address; A = null; }
    const r = settlementFromReverse(index, rev);
    R = r.settlement; Rfield = r.field || null; evidence.reverse.seen = r.seen;
    if (R) { signals.push(`reverse_${r.field}=${R.city}${R.how !== 'exact' ? '(' + R.how + ')' : ''}`); evidence.reverse.matched = { field: r.field, raw: r.raw, how: R.how }; }
    else signals.push('reverse_no_canonical_settlement(' + (r.seen.map((x) => x.value).join('|') || 'no locality') + ')');
  } else signals.push('reverse_skipped(venue+address agree)');

  let found = [V && ['venue', V], A && ['address', A], R && ['reverse', R]].filter(Boolean);
  // a stored regional council that contradicts the resolved settlement's own council is a conflict, not a repair
  if (storedCouncil && found.length) {
    const disagree = found.filter(([, s]) => s.council && heKey(s.council) !== heKey(storedCouncil));
    if (disagree.length) return done('CONFLICT', 'LOW', { reason: `stored council ${storedCouncil} disagrees with ${disagree.map(([k, s]) => `${k}=${s.city} (${s.council})`).join(', ')}`, raw: R?.raw || null });
    signals.push('stored_council_agrees');
  }
  // N - rural points: OSM has no village polygon, the geocoder only knows the regional council. Two
  // independent signals together name the village: the council boundary (OSM, or the stored council value)
  // equals the CBS council of the NEAREST settlement centroid, which is close (<= 1 km) and clearly
  // dominant (next one >= 1.8x farther).
  if (!found.length && rev) {
    const council = (rev.localities || []).map((l) => /^מועצה\s+א[י]?זורית\s+(.+)$/.exec(String(l.value).trim())).find(Boolean);
    const councilName = council ? council[1] : storedCouncil;
    const near = nearestSettlements(index, lat, lng, 2);
    evidence.nearest = near;
    if (councilName && near[0] && near[0].km <= 1.0 && (!near[1] || near[1].km >= near[0].km * 1.8) && near[0].council && heKey(near[0].council) === heKey(councilName)) {
      const N = { ...index.byId.get(near[0].settlement_id), how: 'nearest_centroid+council', raw: council ? council[0] : subject.city, normalized: near[0].city };
      found = [['nearest_settlement+council', N]]; Rfield = 'small';
      signals.push(`nearest=${N.city}@${near[0].km}km(next ${near[1] ? near[1].city + '@' + near[1].km + 'km' : 'none'})`, 'council_agrees=' + councilName + (council ? '' : '(stored)'));
    }
  }
  // Palestinian locality (Area A/B): the geocoder says country ps and no CBS settlement is within 2 km. The
  // locality is CORRECT, it is just not a TURU settlement - a service-area decision, never a rename.
  if (!found.length && rev && String(rev.countryCode || '').toLowerCase() === 'ps') {
    const near = nearestSettlements(index, lat, lng, 1); evidence.nearest = near;
    if (!near[0] || near[0].km > 2) return done('OTHER', 'HIGH', { reason: 'palestinian_locality', raw: (rev.localities || [])[0]?.value || rev.raw || null, method: 'reverse_geocode', signals: [...signals, 'country=ps', near[0] ? `nearest_cbs=${near[0].city}@${near[0].km}km` : 'no_cbs_settlement'] });
  }
  if (!found.length) {
    stats.normalizationFailure = (stats.normalizationFailure || 0) + 1;
    evidence.nearest = nearestSettlements(index, lat, lng, 3);
    const admin = (rev?.localities || []).find((l) => isAdministrativeArea(l.value));
    return done('UNRESOLVED', 'LOW', { raw: (rev?.localities || [])[0]?.value || null, reason: admin && !(rev.localities || []).some((l) => !isAdministrativeArea(l.value)) ? 'only an administrative area is known (' + admin.value + ') - not a city' : 'no locality resolves to a canonical settlement' });
  }
  stats.settlementMatch = (stats.settlementMatch || 0) + 1;
  const ids = new Set(found.map(([, s]) => s.settlement_id));
  if (ids.size > 1) return done('CONFLICT', 'LOW', { reason: 'signals disagree: ' + found.map(([k, s]) => `${k}=${s.city}`).join(' vs '), raw: R?.raw || null });

  const S = found[0][1];
  const kind = R ? (Rfield === 'city' ? 'city' : Rfield === 'town' ? 'town' : 'small') : (found[0][0].startsWith('nearest') ? 'small' : 'text');
  const c = centroidCheck(S, lat, lng, kind);
  evidence.centroid = c;
  const pick = { city: S.city, settlement_id: S.settlement_id, region: S.region, raw: S.raw, normalized: S.normalized, method: found.map(([k]) => k).join('+') };
  if (subject.region && S.region && subject.region !== S.region) signals.push(`region_differs(stored=${subject.region},settlement=${S.region})`);
  if (c && !c.plausible) return done('CONFLICT', 'LOW', { ...pick, city: null, proposed: S.city, reason: `coordinates are ${c.km} km from ${S.city} (limit ${c.withinKm} km)` });
  const independent = found.filter(([k]) => k === 'venue' || k === 'address').length; // signals that do not derive from the coordinates
  if (weak && !independent) return done('NEEDS_CORROBORATION', 'MEDIUM', { ...pick, reason: 'coordinates are weak (city centroid) and nothing independent of them names the city' });
  if (c && c.km <= 0.03 && !subject.address && !independent) return done('NEEDS_CORROBORATION', 'MEDIUM', { ...pick, reason: 'coordinates sit on the settlement centroid with no address - possible centroid artifact' });
  if (!c && found.length < 2) return done('NEEDS_CORROBORATION', 'MEDIUM', { ...pick, reason: 'settlement has no centroid to validate against and only one signal names it' });
  signals.push(c ? `centroid_ok(${c.km}km<=${c.withinKm})` : 'two_signals_agree(no centroid)');
  return done('AUTO_FIX_HIGH', 'HIGH', pick);
}

module.exports = { proposeCity, settlementFromAddress, settlementFromReverse, validCoords };
