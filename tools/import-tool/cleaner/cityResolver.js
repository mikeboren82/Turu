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
const { resolveSettlement, settlementFromAddress, heKey, isMissingCity, isAdministrativeArea, centroidCheck, nearestSettlements } = require('../lib/canonicalSettlement');

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

// subject: { lat, lng, city, address, region, address_source, address_confidence, venue_city }
// deps: { index, reverse(lat,lng) -> reverse.js shape | null | throws }
// -> { klass, confidence, city, settlement_id, region, raw, normalized, method, signals[], evidence, reason }
//    klass: AUTO_FIX_HIGH | NEEDS_CORROBORATION | CONFLICT | UNRESOLVED | INVALID_COORDINATES | ALREADY_FIXED | OTHER | RETRY
async function proposeCity(subject, { index, reverse, stats = {} }) {
  const signals = []; const evidence = {};
  const done = (klass, confidence, extra = {}) => ({ klass, confidence, city: null, settlement_id: null, region: null, raw: null, normalized: null, method: null, signals, evidence, ...extra });
  if (!isMissingCity(subject.city)) return done('ALREADY_FIXED', null, { reason: 'city already present: ' + subject.city });
  if (!validCoords(subject.lat, subject.lng)) return done('INVALID_COORDINATES', null, { reason: 'coordinates missing or outside the service frame' });
  const lat = Number(subject.lat), lng = Number(subject.lng);
  const weak = WEAK_SOURCES.has(subject.address_source) || subject.address_confidence === 'LOW';
  if (weak) signals.push('weak_coordinates(' + (subject.address_source || 'LOW') + ')');

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
  // N - rural points: OSM has no village polygon, the geocoder only knows the regional council. Two
  // independent signals together name the village: the council boundary (OSM) equals the CBS council of
  // the NEAREST settlement centroid, which is close (<= 1 km) and clearly dominant (next one >= 1.8x farther).
  if (!found.length && rev) {
    const council = (rev.localities || []).map((l) => /^מועצה\s+א[י]?זורית\s+(.+)$/.exec(String(l.value).trim())).find(Boolean);
    const near = nearestSettlements(index, lat, lng, 2);
    evidence.nearest = near;
    if (council && near[0] && near[0].km <= 1.0 && (!near[1] || near[1].km >= near[0].km * 1.8) && near[0].council && heKey(near[0].council) === heKey(council[1])) {
      const N = { ...index.byId.get(near[0].settlement_id), how: 'nearest_centroid+council', raw: council[0], normalized: near[0].city };
      found = [['nearest_settlement+council', N]]; Rfield = 'small';
      signals.push(`nearest=${N.city}@${near[0].km}km(next ${near[1] ? near[1].city + '@' + near[1].km + 'km' : 'none'})`, 'council_agrees=' + council[1]);
    }
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
