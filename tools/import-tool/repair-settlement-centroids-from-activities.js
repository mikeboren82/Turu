// TuRu - reference-data repair, detector 2: settlement centroids contradicted by TuRu's OWN canonical data.
// (Detector 1, repair-settlement-centroids.js, compares a centroid with its council / office median and
//  MISSES the towns that matter most - אריאל, אפרת, בית אל - because those medians are wide and themselves
//  contaminated.)
// Ground truth here = the published activities of the settlement: their coordinates come from OSM / Google
// Places / venue pages, independently of the settlements table. When >= 3 of them form a TIGHT cluster
// (every point <= 6 km from their median) and the stored centroid is > 10 km from that cluster, the
// centroid is wrong (it was geocoded to a same-named street elsewhere).
// A write needs a SECOND, independent signal: Nominatim knows a real PLACE (city/town/village/hamlet or
// its administrative boundary) of that name within 6 km of the cluster. The written value is that place's
// position (not the activity median). No second signal -> reported, never written. Nothing is nulled.
//   node repair-settlement-centroids-from-activities.js [--apply]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { all } = require('./cleaner/discover');
const { nominatim } = require('./cleaner/nominatimClient');
const { loadSettlementIndex, resolveSettlement, haversineKm } = require('./lib/canonicalSettlement');

const APPLY = process.argv.includes('--apply');
const MIN_POINTS = 3, CLUSTER_KM = 6, WRONG_KM = 5, CONFIRM_KM = 4, OUTLIER_KM = 15;
const PLACE_OK = new Set(['place/city', 'place/town', 'place/village', 'place/hamlet', 'boundary/administrative']);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

(async () => {
  const { client } = await getClient();
  const index = await loadSettlementIndex(client, { fresh: true });
  const acts = await all(client, 'activities', 'id, locations!inner(city, lat, lng, address_source)', (q) => q.eq('status', 'approved').not('locations.lat', 'is', null));
  const bySettlement = new Map();
  for (const a of acts) {
    const L = a.locations; if (!L || L.lat == null) continue;
    if (['geocode:city_centroid', 'geocode:city_centroid_suspected'].includes(L.address_source)) continue; // a centroid-derived point proves nothing about the centroid
    const s = resolveSettlement(index, L.city); if (!s || s.lat == null) continue;
    if (!bySettlement.has(s.settlement_id)) bySettlement.set(s.settlement_id, { s, pts: [] });
    bySettlement.get(s.settlement_id).pts.push({ lat: Number(L.lat), lng: Number(L.lng), id: a.id });
  }
  const plan = []; const outliers = [];
  for (const { s, pts } of bySettlement.values()) {
    // distinct points only: twenty activities on one shared location row are one observation
    const uniq = [...new Map(pts.map((p) => [`${p.lat.toFixed(4)},${p.lng.toFixed(4)}`, p])).values()];
    if (uniq.length < MIN_POINTS) continue;
    const m = { lat: median(uniq.map((p) => p.lat)), lng: median(uniq.map((p) => p.lng)) };
    // ROBUST spread (80th percentile): one mislocated activity (city says אריאל, coordinates near Jerusalem)
    // must not hide a wrong centroid - and is itself a finding (coordinates contradict the city)
    const dists = uniq.map((p) => haversineKm(p.lat, p.lng, m.lat, m.lng)).sort((a, b) => a - b);
    const spread = dists[Math.min(dists.length - 1, Math.floor(dists.length * 0.8))];
    if (spread <= CLUSTER_KM) for (const p of uniq) { const d = haversineKm(p.lat, p.lng, m.lat, m.lng); if (d > OUTLIER_KM) outliers.push({ activity_id: p.id, city: s.name_he, km_from_city_cluster: Math.round(d * 10) / 10, lat: p.lat, lng: p.lng }); }
    const off = haversineKm(s.lat, s.lng, m.lat, m.lng);
    if (spread > CLUSTER_KM || off <= WRONG_KM) continue;
    plan.push({ settlement_id: s.settlement_id, name_he: s.name_he, points: uniq.length, spread_km: Math.round(spread * 10) / 10, old: { lat: s.lat, lng: s.lng }, km_off: Math.round(off * 10) / 10, cluster: m });
  }
  plan.sort((a, b) => b.points - a.points);
  console.log(`settlements with >=${MIN_POINTS} independent activity points: ${[...bySettlement.values()].filter((x) => x.pts.length >= MIN_POINTS).length} | centroid contradicted by a tight cluster: ${plan.length}`);
  for (const p of plan) {
    const res = await nominatim(`/search?format=jsonv2&q=${encodeURIComponent(p.name_he)}&countrycodes=il,ps&limit=12&addressdetails=0`);
    const cands = (res || []).map((x) => ({ lat: Number(x.lat), lng: Number(x.lon), type: `${x.category || x.class}/${x.type}`, display: x.display_name, km: haversineKm(Number(x.lat), Number(x.lon), p.cluster.lat, p.cluster.lng) })).filter((c) => PLACE_OK.has(c.type)).sort((a, b) => a.km - b.km);
    const best = cands[0];
    p.geocoder = res == null ? 'unavailable' : 'ok';
    if (best && best.km <= CONFIRM_KM) { p.action = 'REPLACE'; p.new = { lat: best.lat, lng: best.lng, type: best.type, km_from_cluster: Math.round(best.km * 10) / 10, display: best.display.slice(0, 80) }; }
    else { p.action = 'REPORT_ONLY'; p.why = res == null ? 'geocoder unavailable' : best ? `nearest real place of this name is ${Math.round(best.km)} km from the activity cluster` : 'no place-class result for this name'; }
    console.log(`  ${p.name_he.padEnd(20)} ${String(p.points).padStart(3)} pts, spread ${String(p.spread_km).padStart(4)} km, stored centroid ${String(p.km_off).padStart(6)} km away -> ${p.action}${p.new ? ' ' + p.new.type + ' @' + p.new.km_from_cluster + ' km' : ' (' + p.why + ')'}`);
  }
  if (APPLY) for (const p of plan.filter((x) => x.action === 'REPLACE')) {
    const { error } = await client.from('settlements').update({ lat: p.new.lat, lng: p.new.lng, geocode_source: 'nominatim:place_verified+activity_cluster', updated_at: new Date().toISOString() }).eq('settlement_id', p.settlement_id).eq('lat', p.old.lat).eq('lng', p.old.lng);
    if (error) console.log('   write failed', p.name_he, error.message);
  }
  const counts = { activities_whose_coords_contradict_their_city: outliers.length, contradicted: plan.length, replace: plan.filter((p) => p.action === 'REPLACE').length, report_only: plan.filter((p) => p.action === 'REPORT_ONLY').length };
  const file = path.join(__dirname, `settlement-centroid-from-activities-${new Date().toISOString().slice(0, 10)}${APPLY ? '-applied' : '-dryrun'}.json`);
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), applied: APPLY, counts, plan, outliers }, null, 2));
  console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'}`, JSON.stringify(counts), '->', path.basename(file));
})().catch((e) => { console.error(e); process.exit(1); });
