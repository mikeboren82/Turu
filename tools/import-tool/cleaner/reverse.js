// TuRu Cleaner - reverse geocode (coordinates -> street/house/city) through the same throttled
// Nominatim access the location resolver uses. Same semantics as enrich-playground-addresses.js:
// an Arabic-script-only road name counts as "no street" (the app is Hebrew-first).
// `city` stays the RAW geocoder locality - callers must pass it through lib/canonicalSettlement.js
// before it may reach locations.city. `localities` lists every locality-level field in evidence order.
// Disk cache (logs/reverse-cache.json, 30 days, ~1 m grid): a dry run followed by the production
// run, or a retry, never pays Nominatim twice for the same point.
const fs = require('fs');
const path = require('path');
const { nominatim } = require('./nominatimClient');

const CACHE_FILE = path.join(__dirname, '..', 'logs', 'reverse-cache.json');
const TTL_MS = 30 * 86400000;
let cache = null;
function loadCache() { if (cache) return cache; try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { cache = {}; } return cache; }
function saveCache() { try { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch { /* cache is best effort */ } }
const keyOf = (lat, lng) => `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;

// `region` / `county` carry the regional council for rural points (no village polygon in OSM)
const LOCALITY_FIELDS = ['city', 'town', 'village', 'hamlet', 'municipality', 'suburb', 'city_district', 'neighbourhood', 'region', 'county'];

async function reverseRaw(lat, lng, stats) {
  const c = loadCache(); const k = keyOf(lat, lng);
  if (c[k] && Date.now() - c[k].t < TTL_MS) { if (stats) stats.cacheHits = (stats.cacheHits || 0) + 1; return c[k].r; }
  if (stats) stats.requests = (stats.requests || 0) + 1;
  const r = await nominatim(`/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`);
  if (r && r.address) { c[k] = { t: Date.now(), r: { address: r.address, display_name: r.display_name } }; saveCache(); return c[k].r; }
  return null; // failures are never cached - a retry asks again
}

async function reverseAddress(lat, lng, stats) {
  const r = await reverseRaw(lat, lng, stats);
  const a = r?.address; if (!a) return null;
  const localities = LOCALITY_FIELDS.filter((f) => a[f]).map((f) => ({ field: f, value: a[f] }));
  const base = { city: a.city || a.town || a.village || a.municipality || null, suburb: a.suburb || null, localities, countryCode: a.country_code || null, state: a.state || null, raw: r.display_name };
  // a numeric-only `road` is a highway reference ("367"), not a street a family can navigate to
  const rawStreet = a.road || a.pedestrian || a.footway || null;
  const street = rawStreet && /^\d+$/.test(String(rawStreet).trim()) ? null : rawStreet;
  if (street && !/[֐-׿a-zA-Z]/.test(street)) return { ...base, street: null, houseNumber: null, city: a.city || a.town || a.village || null };
  return { ...base, street, houseNumber: a.house_number || null };
}

module.exports = { reverseAddress };
