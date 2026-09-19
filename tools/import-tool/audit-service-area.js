// TuRu - SERVICE-AREA dry run (read-only): classifies the deferred Palestinian-locality Cleaner cohort (the
// `requires_human_judgment` city_not_canonical cases noted PALESTINIAN_LOCALITY) and, with --all, every published
// activity with coordinates, using lib/serviceArea.js (offline PA-locality reference + CBS centroids) refined by the
// CACHED reverse geocode where one exists (logs/reverse-cache.json - no new geocoder calls unless --reverse).
//   A. CONFIRMED_OUTSIDE_SERVICE_AREA   B. IN_SCOPE_ISRAEL   C. AMBIGUOUS_LOCATION   D. DATA_ERROR
// Writes service-area-audit-<date>.json with ids, evidence and the proposed mutation. NEVER mutates.
//   node audit-service-area.js [--all] [--reverse]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { all } = require('./cleaner/discover');
const { loadSettlementIndex } = require('./lib/canonicalSettlement');
const { classifyServiceArea } = require('./lib/serviceArea');
const { reverseAddress } = require('./cleaner/reverse');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const CACHE_FILE = path.join(__dirname, 'logs', 'reverse-cache.json');
const KLASS = { OUTSIDE_SERVICE_AREA: 'A_CONFIRMED_OUTSIDE_SERVICE_AREA', OUTSIDE_FOREIGN: 'A_CONFIRMED_OUTSIDE_SERVICE_AREA', IN_SCOPE: 'B_IN_SCOPE_ISRAEL', AMBIGUOUS: 'C_AMBIGUOUS_LOCATION', DATA_ERROR: 'D_DATA_ERROR' };

function cachedReverse(lat, lng) {
  try { const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); const k = `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`; const r = c[k]?.r; if (!r?.address) return null; const a = r.address; const F = ['city', 'town', 'village', 'hamlet', 'municipality', 'suburb', 'city_district', 'neighbourhood', 'region', 'county']; return { localities: F.filter((f) => a[f]).map((f) => ({ field: f, value: a[f] })), countryCode: a.country_code || null, state: a.state || null, raw: r.display_name }; } catch { return null; }
}

(async () => {
  const { client } = await getClient();
  const index = await loadSettlementIndex(client);
  const { data: cases } = await client.from('cleaner_cases').select('id, subject_id, status, archive_reason, resolution').eq('issue', 'city_not_canonical').like('resolution->>note', 'PALESTINIAN%');
  const cohortIds = new Set((cases || []).map((c) => c.subject_id));
  let acts = await all(client, 'activities', 'id, name, category, status, source_id, google_place_id, source_url, locations(id, city, address, lat, lng, region)', (q) => q.eq('status', 'approved'));
  if (!args.all) acts = acts.filter((a) => cohortIds.has(a.id));
  const rows = []; const dist = {}; let reverseCalls = 0;
  for (const a of acts) {
    const L = a.locations || {};
    let rev = cachedReverse(L.lat, L.lng);
    let v = classifyServiceArea({ lat: L.lat, lng: L.lng }, { index, reverse: rev, cityHint: L.city || null });
    if (!rev && args.reverse && ['AMBIGUOUS', 'OUTSIDE_SERVICE_AREA'].includes(v.klass)) { try { rev = await reverseAddress(L.lat, L.lng); reverseCalls++; v = classifyServiceArea({ lat: L.lat, lng: L.lng }, { index, reverse: rev, cityHint: L.city || null }); } catch { /* keep offline verdict */ } }
    const k = KLASS[v.klass];
    if (!args.all || k !== 'B_IN_SCOPE_ISRAEL') rows.push({ activity_id: a.id, in_cohort_37: cohortIds.has(a.id), name: a.name, category: a.category, origin: a.source_id ? 'monster_source' : a.google_place_id ? 'google_scanner' : /openstreetmap/.test(a.source_url || '') ? 'osm_import' : 'manual', stored_city: L.city, lat: L.lat, lng: L.lng, klass: k, confidence: v.confidence, reason: v.reason, evidence: v.evidence, proposed: k.startsWith('A_') ? 'archive activity outside_service_area (status guard), archive its Cleaner case outside_service_area' : k.startsWith('C_') ? 'keep requires_human_judgment' : k.startsWith('D_') ? 'normal data repair (missing/invalid coordinates)' : 'keep published' });
    dist[k] = (dist[k] || 0) + 1;
  }
  const cohortRows = rows.filter((r) => r.in_cohort_37);
  const cohortDist = {}; for (const r of cohortRows) cohortDist[r.klass] = (cohortDist[r.klass] || 0) + 1;
  const report = { generatedAt: new Date().toISOString(), scope: args.all ? 'all published with coordinates' : 'deferred cohort', cohortCases: (cases || []).length, cohortActivities: cohortRows.length, cohortDistribution: cohortDist, distribution: dist, reverseCalls, rollback: 'update activities set status=approved, archive_reason=null, archived_at=null where id in (<ids>) and archive_reason=outside_service_area; reopen the cleaner cases by id', rows };
  const file = path.join(__dirname, `service-area-audit-${new Date().toISOString().slice(0, 10)}${args.all ? '-all' : ''}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log('cohort', report.cohortActivities, JSON.stringify(cohortDist), '| scope distribution', JSON.stringify(dist), '| reverse calls', reverseCalls);
  for (const r of cohortRows) console.log(`  ${r.klass.padEnd(34)} ${String(r.stored_city).padEnd(26)} ${String(r.name).slice(0, 38).padEnd(38)} ${r.lat},${r.lng} | ${r.reason.slice(0, 90)}`);
  console.log('->', path.basename(file));
})().catch((e) => { console.error(e); process.exit(1); });
