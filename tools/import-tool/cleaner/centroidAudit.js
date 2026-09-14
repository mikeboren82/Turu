// TuRu Cleaner - historical city-centroid detection (brief adjustment 2026-09-14): provenance first,
// then MULTIPLE signals. Identical coordinates shared by many rows are NOT a signal (a busy real venue
// does that). A location is a suspected centroid only when
//   (a) address_source = 'geocode:city_centroid' (prospective stamp by the approve path), or
//   (b) its coordinates are within ~150 m of the city's own Nominatim centroid
//       AND it has no street-level address
//       AND (it has no canonical venue OR its label is a generic city-level label).
// Flagged rows get address_source='geocode:city_centroid_suspected', address_confidence='LOW' (fill
// only when address_source is null - never over another provenance) so discover.js opens an
// `unverified_location` case and a later HIGH/MEDIUM result may replace the weak coordinates.
const { normalizeCityName } = require('../cityNaming');
const { geocodeText, ADMIN_TYPES } = require('./locationResolver');
const { haversineKm } = require('./matching');
const { isLearnableLabel } = require('../venueLearning');
const { all } = require('./discover');

const NEAR_KM = 0.15;

async function cityCentroid(city, cache) {
  if (cache.has(city)) return cache.get(city);
  const rows = await geocodeText(city);
  const hit = rows.find((r) => ADMIN_TYPES.has(r.type));
  const c = hit ? { lat: hit.lat, lng: hit.lng, type: hit.type } : null;
  cache.set(city, c);
  return c;
}

// -> { candidates, flagged, byCity, provenanceFlagged }
async function auditCityCentroids(client, { apply = false, log = console.log } = {}) {
  const locs = await all(client, 'locations', 'id, name, city, address, lat, lng, venue_id, address_source, address_confidence, activities!inner(id, status, category)', (q) => q.not('lat', 'is', null).is('address', null).eq('activities.status', 'approved').neq('activities.category', 'גן שעשועים'));
  const cache = new Map();
  const flagged = []; const byCity = {};
  let provenanceFlagged = 0;
  for (const l of locs) {
    if (l.address_source === 'geocode:city_centroid') { provenanceFlagged++; flagged.push({ id: l.id, city: l.city, name: l.name, signal: 'provenance' }); continue; }
    if (l.address_source && l.address_source !== 'geocode:city_centroid_suspected') continue; // another provenance (cleaner/monster/admin) owns it
    const city = normalizeCityName(l.city || null); if (!city) continue;
    const generic = !isLearnableLabel(l.name);
    if (l.venue_id && !generic) continue; // a linked canonical venue with a real label is a real place
    const c = await cityCentroid(city, cache); if (!c) continue;
    const km = haversineKm(c.lat, c.lng, Number(l.lat), Number(l.lng));
    (byCity[city] ||= { checked: 0, flagged: 0 }).checked++;
    if (km <= NEAR_KM) { byCity[city].flagged++; flagged.push({ id: l.id, city, name: l.name, signal: `near_centroid(${Math.round(km * 1000)}m)+no_address+${l.venue_id ? 'generic_label' : 'no_venue'}` }); }
  }
  log(`centroid audit: ${locs.length} candidates (coords, no address), ${Object.keys(byCity).length} cities checked, ${flagged.length} flagged (${provenanceFlagged} by provenance)`);
  if (apply) {
    for (const f of flagged.filter((x) => x.signal !== 'provenance')) {
      await client.from('locations').update({ address_source: 'geocode:city_centroid_suspected', address_confidence: 'LOW' }).eq('id', f.id).is('address_source', null);
    }
  }
  return { candidates: locs.length, flagged, byCity, provenanceFlagged };
}

module.exports = { auditCityCentroids, NEAR_KM };
