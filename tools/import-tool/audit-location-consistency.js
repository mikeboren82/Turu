// TuRu - THE CLEANER: DB-wide location consistency audit (read-only; writes a JSON report, never the DB).
// Multi-signal contradictions on PUBLISHED activities, all through lib/canonicalSettlement.js:
//   city_far_from_coords     the stored city is a canonical settlement whose CBS centroid is implausibly
//                            far from the coordinates (regression: a "תבור" event 8.8 km from Tzova)
//   address_city_conflict    the address names a different canonical settlement than locations.city
//                            (regression: חוות ארץ האיילים - "367, ביתר עילית" with city כפר עציון)
//   road_number_as_street    the address is / starts with a bare road number ("367", "4311, ...")
//   admin_area_as_city       "מועצה אזורית X" stored as the city
//   non_canonical_city       the city resolves to no settlement (Arabic-script towns, neighbourhoods, typos)
//   outside_frame            coordinates outside Israel's frame
//   split_city_variant       a non-canonical spelling of a canonical city ("תל אביב" vs "תל אביב יפו")
// Usage: node audit-location-consistency.js [--out=file.json]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { all } = require('./cleaner/discover');
const { loadSettlementIndex, resolveSettlement, isAdministrativeArea, isMissingCity, centroidCheck, heKey } = require('./lib/canonicalSettlement');
const { validCoords } = require('./cleaner/cityResolver');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const ADDRESS_NOISE = /^(ישראל|israel|\d{5,7}|[A-Z0-9]{4}\+[A-Z0-9]{2,3}.*)$/i;

function classify(index, a) {
  const L = a.locations || {}; const flags = [];
  const lat = L.lat, lng = L.lng;
  if (lat != null && !validCoords(lat, lng)) flags.push({ flag: 'outside_frame', detail: `${lat},${lng}` });
  const city = L.city;
  let S = null;
  if (!isMissingCity(city)) {
    if (isAdministrativeArea(city)) flags.push({ flag: 'admin_area_as_city', detail: city });
    else {
      S = resolveSettlement(index, city);
      if (!S) flags.push({ flag: 'non_canonical_city', detail: city });
      else {
        if (S.city !== city) flags.push({ flag: 'split_city_variant', detail: `${city} -> ${S.city}` });
        // a stored city says nothing about its kind; 15 km is the widest (city) radius, so this only
        // fires on gross contradictions - never on a suburb of a large city
        const c = centroidCheck(S, lat, lng, 'city');
        if (c && !c.plausible) flags.push({ flag: 'city_far_from_coords', detail: `${S.city} is ${c.km} km from the coordinates`, km: c.km });
      }
    }
  }
  const tokens = String(L.address || '').split(',').map((t) => t.trim()).filter((t) => t && !ADDRESS_NOISE.test(t));
  if (tokens.length && /^\d{2,4}$/.test(tokens[0])) flags.push({ flag: 'road_number_as_street', detail: L.address });
  if (S && tokens.length > 1) {
    const T = resolveSettlement(index, tokens[tokens.length - 1]);
    if (T && T.settlement_id !== S.settlement_id && heKey(T.city) !== heKey(S.city)) flags.push({ flag: 'address_city_conflict', detail: `address says ${T.city}, city says ${S.city}` });
  }
  return flags;
}

(async () => {
  const { client } = await getClient();
  const index = await loadSettlementIndex(client);
  const acts = await all(client, 'activities', 'id, name, category, source_id, venue_id, google_place_id, source_url, locations(id, name, address, city, region, lat, lng, address_source, address_confidence)', (q) => q.eq('status', 'approved'));
  const counts = {}; const rows = [];
  for (const a of acts) {
    const flags = classify(index, a); if (!flags.length) continue;
    for (const f of flags) counts[f.flag] = (counts[f.flag] || 0) + 1;
    rows.push({ id: a.id, name: a.name, category: a.category, source_id: a.source_id, has_venue: !!a.venue_id, origin: a.source_id ? 'monster_source' : a.google_place_id ? 'google_scanner' : /openstreetmap/.test(a.source_url || '') ? 'osm_import' : 'manual_or_legacy', city: a.locations?.city, address: a.locations?.address, lat: a.locations?.lat, lng: a.locations?.lng, flags });
  }
  const byOrigin = {}; for (const r of rows) for (const f of r.flags) { const k = `${f.flag}|${r.origin}`; byOrigin[k] = (byOrigin[k] || 0) + 1; }
  const report = { generatedAt: new Date().toISOString(), published: acts.length, flaggedActivities: rows.length, counts, byFlagAndOrigin: byOrigin, rows };
  const file = path.join(__dirname, args.out || `location-consistency-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`published ${acts.length} | flagged ${rows.length}`); console.log(JSON.stringify(counts, null, 1)); console.log(JSON.stringify(byOrigin, null, 1));
  console.log('->', path.basename(file));
})().catch((e) => { console.error(e); process.exit(1); });
