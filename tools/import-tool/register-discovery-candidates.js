// TuRu - CONTINUOUS MONSTER: register the candidates a discovery report already verified (no new Overpass queries),
// as INACTIVE registry rows - the same registryRow() the weekly job uses. Used once after the first pilot cycle's
// inserts failed on a non-existent column. Bounded by --max (default 20); re-checks host dedupe against `sources`.
//   node register-discovery-candidates.js --report=discovery-candidates-osm-2026-09-19.json [--max=20] [--apply]
require('dotenv').config();
const path = require('path');
const { getClient } = require('./supabase');
const { registryRow, hostOf } = require('./lib/sourceDiscovery');
const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
(async () => {
  const rep = require(path.join(__dirname, String(args.report))); const MAX = Number(args.max || 20);
  const { client } = await getClient();
  const { data: existing } = await client.from('sources').select('seed_url'); const known = new Set((existing || []).map((s) => hostOf(s.seed_url)).filter(Boolean));
  const names = new Set(rep.wouldRegister.map((w) => w.name));
  const cands = (rep.candidates || []).filter((c) => names.has(c.name) && c.verify && !known.has(c.host)).slice(0, MAX);
  console.log(`report ${rep.batch} | would register ${rep.wouldRegister.length} | still unknown hosts ${cands.length} | ${args.apply ? 'APPLY' : 'dry run'}`);
  let n = 0;
  for (const c of cands) {
    const row = registryRow(c, rep.batch);
    if (!args.apply) { console.log('  would insert', c.family, '|', c.name, '|', c.region, '|', c.service_area || 'IN_SCOPE'); continue; }
    const { error } = await client.from('sources').insert(row); if (error) { console.log('  ERROR', c.name, error.message); continue; } n++; console.log('  inserted INACTIVE', c.family, '|', c.name, '|', c.region);
  }
  console.log('inserted', n);
})().catch((e) => { console.error(e); process.exit(1); });
