// TuRu - THE CLEANER: CITY_NOT_CANONICAL dry run / audit (read-only unless --apply).
// Every PUBLISHED activity whose stored city is not the canonical settlement value (a regional council,
// a spelling variant, an Arabic-script / Latin / unknown locality string) is run through the SAME
// resolver the missing_city case uses (cleaner/cityResolver.js proposeCity with replace_city) and
// classified:
//   AUTO_FIX_HIGH (by method: spelling_normalization | venue | address | reverse | nearest_settlement+council ...)
//   NEEDS_CORROBORATION | CONFLICT | UNRESOLVED | INVALID_COORDINATES | RETRY
//   OTHER/outside_israel (foreign territory)  |  OTHER/palestinian_locality (service-area DECISION)
// Part G classes (brief §17) are derived from the evidence used: B venue city, C address locality,
// A coordinate->settlement (reverse / nearest+council), E council-only evidence, F conflicting, G rural.
// --apply writes ONLY AUTO_FIX_HIGH proposals through cleaner/apply.js applyCityToActivity (value-guarded,
// verified, write_denied surfaced) and learns aliases through the shared resolver; bounded by --max.
//   node audit-city-not-canonical.js [--kind=administrative_area|variant|unresolved] [--max=N] [--apply] [--learn-aliases]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { all } = require('./cleaner/discover');
const { loadSettlementIndex, classifyCityValue, learnSettlementAlias, isMissingCity } = require('./lib/canonicalSettlement');
const { proposeCity } = require('./cleaner/cityResolver');
const { reverseAddress } = require('./cleaner/reverse');
const { applyCityToActivity } = require('./cleaner/apply');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const APPLY = !!args.apply; const MAX = Number(args.max || Infinity); const KIND = args.kind ? String(args.kind) : null;

function partGClass(p, stored) {
  if (p.klass === 'AUTO_FIX_HIGH') {
    if (p.method === 'spelling_normalization') return 'H_variant_normalized';
    if (/venue/.test(p.method)) return 'B_canonical_venue_locality';
    if (/address/.test(p.method)) return 'C_address_locality';
    return 'A_coordinates_resolve_to_locality';
  }
  if (p.klass === 'CONFLICT') return 'F_conflicting_evidence';
  if (p.klass === 'OTHER') return p.reason === 'outside_israel' ? 'X_outside_service_area' : 'P_palestinian_locality_decision';
  if (p.klass === 'UNRESOLVED') return stored?.kind === 'administrative_area' ? 'E_council_only_evidence' : 'G_unresolved_no_named_settlement';
  if (p.klass === 'NEEDS_CORROBORATION') return 'E_single_signal_needs_corroboration';
  return p.klass;
}

(async () => {
  const { client } = await getClient();
  let index = await loadSettlementIndex(client);
  const acts = await all(client, 'activities', 'id, name, category, venue_id, source_id, google_place_id, source_url, locations(id, name, address, city, lat, lng, region, address_source, address_confidence)', (q) => q.eq('status', 'approved'));
  const subjects = [];
  for (const a of acts) {
    const L = a.locations; if (!L || L.lat == null || isMissingCity(L.city)) continue;
    const nc = classifyCityValue(index, L.city); if (!nc) continue;
    if (KIND && nc.kind !== KIND) continue;
    subjects.push({ a, L, nc });
  }
  console.log(`published ${acts.length} | non-canonical city ${subjects.length}${KIND ? ' (kind ' + KIND + ')' : ''} | ${APPLY ? 'APPLY' : 'DRY RUN'} max ${MAX}`);
  const venueCity = new Map();
  const rows = []; const dist = {}; const byG = {}; const byValue = {}; const stats = {};
  let applied = 0, denied = 0, learned = 0, n = 0;
  for (const { a, L, nc } of subjects) {
    if (n++ >= MAX) break;
    let vc = null;
    if (a.venue_id) { if (!venueCity.has(a.venue_id)) { const { data: v } = await client.from('venues').select('city').eq('id', a.venue_id).maybeSingle(); venueCity.set(a.venue_id, v?.city || null); } vc = venueCity.get(a.venue_id); }
    const rstats = {};
    let p;
    try { p = await proposeCity({ lat: L.lat, lng: L.lng, city: L.city, address: L.address, region: L.region, address_source: L.address_source, address_confidence: L.address_confidence, venue_city: vc, replace_city: true }, { index, reverse: (lat, lng) => reverseAddress(lat, lng, rstats), stats }); }
    catch (e) { p = { klass: 'ERROR', reason: e.message || String(e), signals: [], evidence: {} }; }
    const g = partGClass(p, nc);
    dist[p.klass + (p.reason && p.klass === 'OTHER' ? '/' + p.reason : '')] = (dist[p.klass + (p.reason && p.klass === 'OTHER' ? '/' + p.reason : '')] || 0) + 1;
    byG[g] = (byG[g] || 0) + 1;
    const bv = (byValue[L.city] ||= { kind: nc.kind, n: 0, klass: {}, cities: {} }); bv.n++; bv.klass[p.klass] = (bv.klass[p.klass] || 0) + 1; if (p.city) bv.cities[p.city] = (bv.cities[p.city] || 0) + 1;
    const row = { activity_id: a.id, name: a.name, category: a.category, origin: a.source_id ? 'monster_source' : a.google_place_id ? 'google_scanner' : /openstreetmap/.test(a.source_url || '') ? 'osm_import' : 'manual_or_legacy', stored_city: L.city, stored_kind: nc.kind, stored_script: nc.script || null, lat: L.lat, lng: L.lng, address: L.address, region: L.region, klass: p.klass, part_g: g, proposed_city: p.city, settlement_id: p.settlement_id, method: p.method, confidence: p.confidence, reason: p.reason || null, signals: p.signals, evidence: p.evidence, reverse_requests: rstats.requests || 0, reverse_cache_hits: rstats.cacheHits || 0 };
    if (APPLY && p.klass === 'AUTO_FIX_HIGH') {
      const w = await applyCityToActivity(client, { id: a.id, location_id: L.id }, p);
      row.applied = w;
      if (w.why === 'write_denied') denied++; else if (w.wrote && w.wrote.length) applied++;
      if (args['learn-aliases'] && w.wrote && w.wrote.length && p.method !== 'spelling_normalization') {
        try { const al = await learnSettlementAlias(client, index, L.city, p.settlement_id, { notes: `cleaner:city_not_canonical ${new Date().toISOString().slice(0, 10)} (${p.method})` }); row.alias = al; if (al.learned) { learned++; index = await loadSettlementIndex(client, { fresh: true }); } } catch (e) { row.alias = { learned: false, why: e.message }; }
      }
    }
    rows.push(row);
    if (n % 50 === 0) console.log(`  ${n}/${Math.min(MAX, subjects.length)} ...`, JSON.stringify(dist));
  }
  const report = { generatedAt: new Date().toISOString(), applied: APPLY, published: acts.length, subjects: subjects.length, processed: rows.length, distribution: dist, partG: byG, byStoredValue: byValue, resolverStats: stats, writes: { applied, denied, aliasesLearned: learned }, rows };
  const file = path.join(__dirname, `city-not-canonical-${new Date().toISOString().slice(0, 10)}${KIND ? '-' + KIND : ''}${APPLY ? '-applied' : '-dryrun'}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log('distribution', JSON.stringify(dist)); console.log('part G', JSON.stringify(byG)); console.log('writes', JSON.stringify(report.writes)); console.log('->', path.basename(file));
})().catch((e) => { console.error(e); process.exit(1); });
