#!/usr/bin/env node
/*
 * TuRu - duplicate-candidate DRY RUN over the live catalogue (2026-09-21).
 *
 * ############################################################################
 * # READ-ONLY BY DEFAULT. Issues SELECTs only and writes a report file.       #
 * # Writing queue rows requires BOTH --apply AND the 0104 table to exist.    #
 * # It never touches activities, cleaner_cases or anything else.            #
 * ############################################################################
 *
 * Run: node tools/import-tool/audit-duplicate-candidates.js            (dry run, report only)
 *      node tools/import-tool/audit-duplicate-candidates.js --apply    (upsert into duplicate_candidates)
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { getClient } = require('./supabase');
const { sweep, summarize, upsertCandidates, GENERATOR_VERSION } = require('./lib/duplicateCandidates');

const APPLY = process.argv.includes('--apply');
const OUT_DIR = path.join(__dirname, 'reports');
const STAMP = new Date().toISOString().slice(0, 10);

async function loadRows(client) {
  // exactly the fields the signal needs - no description, no images
  let from = 0; const rows = [];
  while (true) {
    const { data, error } = await client.from('activities')
      .select('id, name, status, entity_type, venue_id, source_url, locations(lat, lng, address, city)')
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data) rows.push({ id: r.id, name: r.name, status: r.status, entity_type: r.entity_type, venue_id: r.venue_id, source_url: r.source_url,
      lat: r.locations?.lat ?? null, lng: r.locations?.lng ?? null, address: r.locations?.address ?? null, city: r.locations?.city ?? null });
    if (data.length < 1000) break; from += 1000;
  }
  return rows;
}

(async () => {
  const { client } = await getClient();
  const rows = await loadRows(client);
  const { candidates, stats, skippedNeighbourhoods } = sweep(rows);
  const summary = summarize(candidates);
  const report = { generatedAt: new Date().toISOString(), generatorVersion: GENERATOR_VERSION, mode: APPLY ? 'APPLY' : 'DRY RUN - no writes',
    totalRowsLoaded: rows.length, stats, summary, skippedNeighbourhoods,
    candidates: candidates.map((c) => ({ a: c.activity_id_a, b: c.activity_id_b, names: c._names, kinds: c._kinds, sources: c._sources,
      venues: c._venues, relationship: c.relationship, distance_m: c.distance_m, venue_relatedness: c.venue_relatedness, identity_evidence: c.identity_evidence })) };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `duplicate-candidates-${APPLY ? 'applied' : 'dryrun'}-${STAMP}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`mode=${report.mode}`);
  console.log(`rows loaded=${rows.length} indexed=${stats.indexed} cells=${stats.cellCount} pairComparisons=${stats.pairComparisons} candidates=${stats.candidates} rate=${(stats.candidateRate * 100).toFixed(2)}% skippedNeighbourhoods=${stats.skippedNeighbourhoods} excludedOfferingOfferingPairs=${stats.excludedOfferingOfferingPairs}`);
  console.log('byEntityKindPair=' + JSON.stringify(summary.byEntityKindPair));
  console.log('bySourceRelation=' + JSON.stringify(summary.bySourceRelation));
  console.log('byVenueRelation=' + JSON.stringify(summary.byVenueRelation));
  console.log('byIdentityKind=' + JSON.stringify(summary.byIdentityKind));
  console.log('report: ' + file);
  if (APPLY) { const w = await upsertCandidates(client, candidates, { apply: true }); console.log('write result: ' + JSON.stringify(w)); }
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
