// TuRu - THE CLEANER: repair of CITY-CENTROID PILE-UPS and what was laundered from them (2026-09-17).
// Chain that produced the debt: the approve path's city-only geocode fallback put every event whose place it
// could not find on ONE point per city (37 Tel Aviv venues on a single coordinate) -> the Cleaner
// reverse-geocoded that point and wrote the city-centre street as each event's "address" (MEDIUM) -> that
// address hid the rows from the centroid audit (which only looked at rows without an address) -> the Cleaner
// derived canonical VENUE coordinates from the median of those linked locations (HIGH). Roots are fixed
// (server.js place-only fallback; centroidAudit.isSharedMultiLabelPoint guards in cleaner.js and
// locationResolver.coordsForVenue). This closes what is stored.
//
// A point is a verified fallback only on TWO independent signals:
//   (1) the exact coordinate is shared by >= 3 differently named locations of published non-playground activities
//   (2) it lies within 300 m of what the bare city NAME geocodes to (the fallback's own query)
// Then, guarded by the exact values seen:
//   locations  address written by cleaner:reverse_geocode  -> NULL (it is the city centre's street)
//              provenance -> geocode:city_centroid_suspected / LOW  (opens unverified_location; real evidence
//              may then REPLACE the coordinates - they are kept meanwhile, a rough point beats none)
//              an address from the event's own page (monster:* / cleaner:candidate) is KEPT
//   venues     coordinates equal to the point -> NULL; address -> NULL only when it is that same laundered street
// Nothing is deleted. Dry run by default:   node repair-centroid-pileups.js [--apply]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { all } = require('./cleaner/discover');
const { nominatim } = require('./cleaner/nominatimClient');
const { haversineKm } = require('./lib/canonicalSettlement');
const { SHARED_POINT_MIN_LABELS } = require('./cleaner/centroidAudit');

const APPLY = process.argv.includes('--apply');
const NEAR_CITY_GEOCODE_KM = 0.3;
const labelKey = (s) => String(s || '').replace(/["'׳״]/g, '').replace(/\s+/g, ' ').trim();
const keyOf = (lat, lng) => `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;

(async () => {
  const { client } = await getClient();
  const acts = await all(client, 'activities', 'id, name, category, venue_id, locations!inner(id, name, city, address, lat, lng, address_source, address_confidence)', (q) => q.eq('status', 'approved').neq('category', 'גן שעשועים').not('locations.lat', 'is', null));
  const points = new Map();
  for (const a of acts) { const L = a.locations; const k = keyOf(L.lat, L.lng); if (!points.has(k)) points.set(k, { lat: Number(L.lat), lng: Number(L.lng), city: L.city, labels: new Set(), locs: new Map(), acts: 0 }); const p = points.get(k); p.labels.add(labelKey(L.name)); p.locs.set(L.id, L); p.acts++; }
  const shared = [...points.values()].filter((p) => p.labels.size >= SHARED_POINT_MIN_LABELS);
  console.log(`non-playground published activities ${acts.length} | points shared by >= ${SHARED_POINT_MIN_LABELS} labels: ${shared.length}`);

  const plan = [];
  for (const p of shared) {
    // signal 2: the fallback's own query - the bare city name (first hit, exactly as the old fallback took it)
    const res = await nominatim(`/search?format=jsonv2&q=${encodeURIComponent(p.city + ', ישראל')}&countrycodes=il&limit=5`);
    const near = (res || []).map((r) => haversineKm(Number(r.lat), Number(r.lon), p.lat, p.lng)).sort((a, b) => a - b)[0];
    const verified = near != null && near <= NEAR_CITY_GEOCODE_KM;
    const locs = [...p.locs.values()];
    const laundered = locs.filter((l) => l.address_source === 'cleaner:reverse_geocode');
    const streets = {}; laundered.forEach((l) => { streets[l.address] = (streets[l.address] || 0) + 1; });
    const launderedStreets = new Set(Object.keys(streets));
    const { data: venues } = await client.from('venues').select('id, name_he, address, lat, lng').gte('lat', p.lat - 0.00002).lte('lat', p.lat + 0.00002).gte('lng', p.lng - 0.00002).lte('lng', p.lng + 0.00002);
    const entry = { city: p.city, lat: p.lat, lng: p.lng, labels: p.labels.size, activities: p.acts, locations: locs.length, km_from_city_geocode: near == null ? null : Math.round(near * 1000) / 1000, verified, geocoder: res == null ? 'unavailable' : 'ok', launderedAddresses: laundered.length, launderedStreets: [...launderedStreets], keptAddresses: locs.filter((l) => l.address && l.address_source !== 'cleaner:reverse_geocode').length, venues: (venues || []).map((v) => ({ id: v.id, name: v.name_he, address: v.address, clearAddress: !!v.address && launderedStreets.has(v.address) })) };
    plan.push(entry);
    console.log(`  ${String(p.city).padEnd(12)} ${p.labels.size} labels / ${p.acts} activities / ${locs.length} locations | ${near == null ? 'geocoder n/a' : Math.round(near * 1000) + ' m from the city-name geocode'} -> ${verified ? 'VERIFIED FALLBACK' : 'not verified (left alone)'} | laundered addresses ${laundered.length} [${[...launderedStreets].join(' / ')}] | venues on the point ${entry.venues.length}`);
    if (!APPLY || !verified) continue;
    for (const l of locs) {
      const isLaundered = l.address_source === 'cleaner:reverse_geocode';
      const ownAddress = l.address && !isLaundered; // from the event's page / a candidate: kept, its provenance kept
      if (ownAddress) continue; // its coordinates are still the fallback, but the single provenance column describes the address - reported, not restamped
      let q = client.from('locations').update({ address: isLaundered ? null : l.address, address_source: 'geocode:city_centroid_suspected', address_confidence: 'LOW', address_resolved_at: new Date().toISOString() }).eq('id', l.id).eq('lat', l.lat).eq('lng', l.lng);
      q = l.address_source ? q.eq('address_source', l.address_source) : q.is('address_source', null);
      const { error } = await q; if (error) console.log('    location write failed', l.id, error.message);
    }
    for (const v of venues || []) {
      const patch = { lat: null, lng: null, updated_at: new Date().toISOString() }; if (v.address && launderedStreets.has(v.address)) patch.address = null;
      const { error } = await client.from('venues').update(patch).eq('id', v.id).eq('lat', v.lat).eq('lng', v.lng); if (error) console.log('    venue write failed', v.id, error.message);
    }
  }
  const ver = plan.filter((p) => p.verified);
  const counts = { sharedPoints: plan.length, verifiedFallbackPoints: ver.length, activitiesOnThem: ver.reduce((n, p) => n + p.activities, 0), launderedAddressesCleared: ver.reduce((n, p) => n + p.launderedAddresses, 0), ownAddressesKept: ver.reduce((n, p) => n + p.keptAddresses, 0), venuesUnanchored: ver.reduce((n, p) => n + p.venues.length, 0), venueAddressesCleared: ver.reduce((n, p) => n + p.venues.filter((v) => v.clearAddress).length, 0) };
  const file = path.join(__dirname, `centroid-pileup-repair-${new Date().toISOString().slice(0, 10)}${APPLY ? '-applied' : '-dryrun'}.json`);
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), applied: APPLY, counts, plan }, null, 2));
  console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'}`, JSON.stringify(counts), '->', path.basename(file));
})().catch((e) => { console.error(e); process.exit(1); });
