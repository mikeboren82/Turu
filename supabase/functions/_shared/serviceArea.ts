// TuRu - SERVICE AREA (Deno twin of tools/import-tool/lib/serviceArea.js - keep in lockstep).
// Product decision 2026-09-19: locations inside Palestinian-Authority-administered territory (West Bank
// Areas A/B, Gaza Strip) are OUT OF SCOPE. GEOGRAPHIC rule on coordinates only - never language, script,
// name, audience or population. Israeli Arab localities are CBS settlements and are always IN SCOPE.
//   PA locality match AND no CBS settlement <= 2 km -> OUTSIDE_SERVICE_AREA; CBS <= 2 km -> IN_SCOPE;
//   PA match with CBS 2-4 km -> AMBIGUOUS (never excluded); no PA match -> IN_SCOPE (default).
import paRef from './paLocalities.json' with { type: 'json' };

export type ServiceAreaClass = 'IN_SCOPE' | 'OUTSIDE_SERVICE_AREA' | 'AMBIGUOUS' | 'DATA_ERROR';
export interface Settlement { city: string; lat: number; lng: number }
export interface ServiceAreaVerdict { klass: ServiceAreaClass; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; reason: string; evidence: Record<string, unknown> }
const CBS_IN_SCOPE_KM = 2.0, AMBIGUOUS_CBS_KM = 4.0;

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
export function validCoords(lat: unknown, lng: unknown): boolean { const a = Number(lat), b = Number(lng); return lat != null && lng != null && Number.isFinite(a) && Number.isFinite(b) && !(a === 0 && b === 0) && a > 29 && a < 34 && b > 34 && b < 36.5; }

const radius = (paRef as { source: { radius_km: Record<string, number> } }).source.radius_km;
const localities = (paRef as { localities: { name: string; kind: string; lat: number; lng: number }[] }).localities;

export function nearestPaLocality(lat: number, lng: number) {
  let best: { name: string; kind: string; km: number } | null = null;
  for (const l of localities) { const km = haversineKm(lat, lng, l.lat, l.lng); if (!best || km < best.km) best = { name: l.name, kind: l.kind, km }; }
  if (!best) return null;
  const r = radius[best.kind] ?? 1.5;
  return { ...best, radius_km: r, within: best.km <= r };
}

// settlements: CBS centroids (city, lat, lng) loaded once per scan; nearest one decides "an Israeli locality is here"
const CITY_HINT_KM = 8; // a record that names a CBS settlement this close is never auto-excluded (big-city neighbourhoods)
const normCity = (v: unknown) => String(v ?? '').replace(/["'׳״’]/g, '').replace(/s+/g, ' ').trim();
// cityHint: the city the record itself names (extracted / resolved) - only used to keep a verdict AMBIGUOUS, never to exclude
export function classifyServiceArea(lat: unknown, lng: unknown, settlements: Settlement[], cityHint: unknown = null): ServiceAreaVerdict {
  if (!validCoords(lat, lng)) return { klass: 'DATA_ERROR', confidence: 'HIGH', reason: 'coordinates missing or outside the region frame', evidence: {} };
  const p = { lat: Number(lat), lng: Number(lng) };
  let near: { city: string; km: number } | null = null;
  for (const s of settlements) { if (s.lat == null || s.lng == null) continue; const km = haversineKm(p.lat, p.lng, Number(s.lat), Number(s.lng)); if (!near || km < near.km) near = { city: s.city, km }; }
  if (near) near.km = Math.round(near.km * 100) / 100;
  const pa = nearestPaLocality(p.lat, p.lng);
  const evidence = { nearest_cbs: near, nearest_pa: pa ? { name: pa.name, kind: pa.kind, km: Math.round(pa.km * 100) / 100, within: pa.within } : null };
  // inside an Israeli locality's own centre (<= 1 km of its CBS point) -> in scope even next to a PA village (Ariel / Marda)
  if (near && near.km <= 1.0) return { klass: 'IN_SCOPE', confidence: 'HIGH', reason: `inside CBS settlement ${near.city} (${near.km} km from its centre)`, evidence };
  // PA evidence next: two claims on one point (Hebron / Kiryat Arba, 1-4 km) are never resolved by proximity alone
  if (pa && pa.within) {
    if (near && near.km <= AMBIGUOUS_CBS_KM) return { klass: 'AMBIGUOUS', confidence: 'LOW', reason: `PA locality ${pa.name} and CBS settlement ${near.city} ${near.km} km away - two claims on one point`, evidence };
    // SAFETY: Jerusalem's neighbourhoods next to Anata / Abu Dis are 5-8 km from the city's single CBS point - when the
    // record names a CBS settlement within CITY_HINT_KM the two claims go to a person, never to an exclusion
    const hint = normCity(cityHint);
    if (hint) { const h = settlements.find((s) => normCity(s.city) === hint); if (h && h.lat != null) { const hk = haversineKm(p.lat, p.lng, Number(h.lat), Number(h.lng)); if (hk <= CITY_HINT_KM) return { klass: 'AMBIGUOUS', confidence: 'LOW', reason: `PA locality ${pa.name} but the record names CBS settlement ${h.city} ${hk.toFixed(1)} km away - two claims on one point`, evidence: { ...evidence, city_hint: { city: h.city, km: Math.round(hk * 100) / 100 } } }; } }
    return { klass: 'OUTSIDE_SERVICE_AREA', confidence: 'HIGH', reason: `inside ${pa.name} (${pa.kind}, ${pa.km.toFixed(2)} km from its centre), no CBS settlement within ${AMBIGUOUS_CBS_KM} km`, evidence };
  }
  if (near && near.km <= CBS_IN_SCOPE_KM) return { klass: 'IN_SCOPE', confidence: 'HIGH', reason: `CBS settlement ${near.city} ${near.km} km away`, evidence };
  return { klass: 'IN_SCOPE', confidence: pa ? 'MEDIUM' : 'HIGH', reason: 'no Palestinian-administered locality matches these coordinates', evidence };
}
