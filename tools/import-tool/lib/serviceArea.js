// TuRu - SERVICE AREA (product decision 2026-09-19): locations inside Palestinian-Authority-administered
// territory (West Bank Areas A/B, Gaza Strip) are OUT OF SCOPE. This is a GEOGRAPHIC rule evaluated on
// coordinates only - never on language, script, name, audience, ownership or population. Israeli Arab
// localities are CBS settlements and are always IN SCOPE.
//
// Evidence (offline, deterministic - the same rule runs in the Deno twin _shared/serviceArea.ts):
//   PA   = nearest Palestinian-administered locality (reference/pa-localities.json) within its kind radius
//   CBS  = nearest CBS settlement centroid (public.settlements, via lib/canonicalSettlement index)
// Decision (PA evidence is checked first: two claims on one point are never resolved by proximity alone):
//   PA match AND CBS settlement <= 4 km              -> AMBIGUOUS           (Hebron / Kiryat Arba, Beit Jala / Har Gilo, border towns)
//   PA match AND no CBS settlement <= 4 km           -> OUTSIDE_SERVICE_AREA (HIGH)
//   no PA match AND CBS settlement <= 2 km           -> IN_SCOPE            (an Israeli locality is right here)
//   no PA match                                       -> IN_SCOPE            (default: never excluded on a proxy)
// Optional reverse-geocode evidence (Node only) refines the two grey cases: a locality that resolves to a CBS
// settlement -> IN_SCOPE; a foreign country (jo/eg/lb/sy) -> OUTSIDE_FOREIGN. Nothing else is inferred.
const fs = require('fs');
const path = require('path');
const { haversineKm, nearestSettlements, resolveSettlement } = require('./canonicalSettlement');

const CBS_IN_SCOPE_KM = 2.0;
const AMBIGUOUS_CBS_KM = 4.0;
const CITY_HINT_KM = 8; // a record that names a CBS settlement this close is never auto-excluded (big-city neighbourhoods)
const FOREIGN = new Set(['jo', 'eg', 'lb', 'sy', 'sa', 'cy']);
let ref = null;
function loadPaLocalities(file) {
  if (ref && !file) return ref;
  const p = file || path.join(__dirname, '..', 'reference', 'pa-localities.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  ref = { radius: j.source.radius_km, localities: j.localities.filter((l) => l.lat != null) };
  return ref;
}
function nearestPaLocality(lat, lng, data = loadPaLocalities()) {
  let best = null;
  for (const l of data.localities) { const km = haversineKm(lat, lng, l.lat, l.lng); if (!best || km < best.km) best = { ...l, km }; }
  if (!best) return null;
  return { ...best, radius_km: data.radius[best.kind] || 1.5, within: best.km <= (data.radius[best.kind] || 1.5) };
}
function validCoords(lat, lng) { const a = Number(lat), b = Number(lng); return lat != null && lng != null && Number.isFinite(a) && Number.isFinite(b) && !(a === 0 && b === 0) && a > 29 && a < 34 && b > 34 && b < 36.5; }

// -> { klass: 'IN_SCOPE'|'OUTSIDE_SERVICE_AREA'|'OUTSIDE_FOREIGN'|'AMBIGUOUS'|'DATA_ERROR', confidence, reason, evidence }
function classifyServiceArea({ lat, lng }, { index, reverse = null, pa = loadPaLocalities(), cityHint = null } = {}) {
  if (!validCoords(lat, lng)) return { klass: 'DATA_ERROR', confidence: 'HIGH', reason: 'coordinates missing or outside the region frame', evidence: {} };
  const p = { lat: Number(lat), lng: Number(lng) };
  const near = index ? nearestSettlements(index, p.lat, p.lng, 1)[0] || null : null;
  const paHit = nearestPaLocality(p.lat, p.lng, pa);
  const evidence = { nearest_cbs: near ? { city: near.city, km: near.km } : null, nearest_pa: paHit ? { name: paHit.name, kind: paHit.kind, km: Math.round(paHit.km * 100) / 100, within: paHit.within } : null };
  if (reverse) {
    evidence.reverse = { country: reverse.countryCode || null, state: reverse.state || null, locality: (reverse.localities || [])[0]?.value || null };
    if (reverse.countryCode && FOREIGN.has(String(reverse.countryCode).toLowerCase())) return { klass: 'OUTSIDE_FOREIGN', confidence: 'HIGH', reason: 'reverse geocode country ' + reverse.countryCode, evidence };
    if (index) { for (const l of reverse.localities || []) { const s = resolveSettlement(index, l.value); if (s && s.lat != null && haversineKm(p.lat, p.lng, s.lat, s.lng) <= AMBIGUOUS_CBS_KM) { evidence.reverse.resolved_cbs = s.city; return { klass: 'IN_SCOPE', confidence: 'HIGH', reason: 'reverse locality is the CBS settlement ' + s.city, evidence }; } } }
  }
  const cbsClose = !!near && near.km <= CBS_IN_SCOPE_KM;
  // a point inside an Israeli locality's own centre (<= 1 km of its CBS reference point) is in scope even when a
  // Palestinian village lies nearby (Ariel / Marda 1.4 km): the nearest claim wins only at this distance
  if (near && near.km <= 1.0) return { klass: 'IN_SCOPE', confidence: 'HIGH', reason: `inside CBS settlement ${near.city} (${near.km} km from its centre)`, evidence };
  if (paHit && paHit.within) {
    if (near && near.km <= AMBIGUOUS_CBS_KM) return { klass: 'AMBIGUOUS', confidence: 'LOW', reason: `PA locality ${paHit.name} (${paHit.km.toFixed(2)} km) and CBS settlement ${near.city} ${near.km} km away - two claims on one point, a person decides`, evidence };
    // SAFETY: a large Israeli city has one CBS point for a wide area (Jerusalem's neighbourhoods next to Anata / Abu Dis
    // are 5-8 km from it). When the record itself names a CBS settlement whose centre is within CITY_HINT_KM, the two
    // claims are left to a person - an Israeli locality is never auto-excluded because its centroid is far
    const hinted = cityHint && index ? resolveSettlement(index, cityHint) : null;
    if (hinted && hinted.lat != null) { const hk = haversineKm(p.lat, p.lng, hinted.lat, hinted.lng); if (hk <= CITY_HINT_KM) { evidence.city_hint = { city: hinted.city, km: Math.round(hk * 100) / 100 }; return { klass: 'AMBIGUOUS', confidence: 'LOW', reason: `PA locality ${paHit.name} (${paHit.km.toFixed(2)} km) but the record names CBS settlement ${hinted.city} ${hk.toFixed(1)} km away - two claims on one point, a person decides`, evidence }; } }
    return { klass: 'OUTSIDE_SERVICE_AREA', confidence: 'HIGH', reason: `inside ${paHit.name} (${paHit.kind}, ${paHit.km.toFixed(2)} km from its centre), no CBS settlement within ${AMBIGUOUS_CBS_KM} km`, evidence };
  }
  if (cbsClose) return { klass: 'IN_SCOPE', confidence: 'HIGH', reason: `CBS settlement ${near.city} ${near.km} km away`, evidence };
  if (reverse && String(reverse.countryCode || '').toLowerCase() === 'ps' && /רצועת עזה|غزة|gaza/i.test(reverse.state || '')) return { klass: 'OUTSIDE_SERVICE_AREA', confidence: 'HIGH', reason: 'reverse geocode state = Gaza Strip', evidence };
  if (reverse && String(reverse.countryCode || '').toLowerCase() === 'ps' && !cbsClose && (!near || near.km > AMBIGUOUS_CBS_KM)) return { klass: 'AMBIGUOUS', confidence: 'LOW', reason: 'reverse geocode says ps, no CBS settlement within 4 km, no PA locality match - unresolved', evidence };
  return { klass: 'IN_SCOPE', confidence: paHit ? 'MEDIUM' : 'HIGH', reason: 'no Palestinian-administered locality matches these coordinates', evidence };
}

module.exports = { classifyServiceArea, nearestPaLocality, loadPaLocalities, validCoords, CBS_IN_SCOPE_KM, AMBIGUOUS_CBS_KM, CITY_HINT_KM };
