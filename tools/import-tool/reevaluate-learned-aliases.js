// TuRu - re-evaluate the settlement_aliases rows THE CLEANER learned today against the current (tightened)
// learnSettlementAlias rule; rows that no longer qualify are removed (they were created by this program a few
// minutes earlier - never touches curated / older aliases). Dry run by default:  node reevaluate-learned-aliases.js [--apply]
require('dotenv').config();
const { getClient } = require('./supabase');
const { loadSettlementIndex, learnSettlementAlias, resolveSettlement } = require('./lib/canonicalSettlement');
const APPLY = process.argv.includes('--apply');
(async () => {
  const { client } = await getClient();
  const { data: rows, error } = await client.from('settlement_aliases').select('alias_name, settlement_id, notes').like('notes', 'cleaner:city_not_canonical%');
  if (error) throw error;
  const index = await loadSettlementIndex(client, { fresh: true });
  // evaluate each alias as if it were not yet known: build an index WITHOUT today's learned aliases
  const { data: allAliases } = await client.from('settlement_aliases').select('alias_name, settlement_id, notes');
  const { buildSettlementIndex } = require('./lib/canonicalSettlement');
  const base = buildSettlementIndex([...index.byId.values()].map((s) => ({ settlement_id: s.settlement_id, name_he: s.name_he, name_en: s.name_en, council: s.council, region: null, population: s.population, lat: s.lat, lng: s.lng })), (allAliases || []).filter((a) => !/^cleaner:city_not_canonical/.test(a.notes || '')));
  const keep = [], drop = [];
  for (const r of rows || []) {
    const S = base.byId.get(String(r.settlement_id));
    const v = await learnSettlementAlias({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) }) }), upsert: async () => ({ error: null }) }) }, base, r.alias_name, r.settlement_id, {});
    (v.learned ? keep : drop).push({ alias: r.alias_name, city: S?.city, why: v.why || 'ok' });
  }
  console.log(`learned today ${rows.length} | keep ${keep.length} | drop ${drop.length}`);
  for (const d of drop) console.log('  DROP', d.alias, '->', d.city, '|', d.why);
  if (APPLY && drop.length) { const { error: e } = await client.from('settlement_aliases').delete().in('alias_name', drop.map((d) => d.alias)).like('notes', 'cleaner:city_not_canonical%'); if (e) throw e; console.log('deleted', drop.length); }
})().catch((e) => { console.error(e); process.exit(1); });
