// TuRu - link existing non-playground activities to canonical venues by curated alias (0076).
// Conservative by design: only an exact normalized-alias match with agreeing city links; anything
// else is listed for a human. Playgrounds are skipped (a playground IS the place).
//   node backfill-venue-links.js [--apply]
require('dotenv').config();
const { getClient } = require('./supabase');
const { resolveVenue } = require('./venueNaming');
const APPLY = process.argv.includes('--apply');

(async () => {
  const { client } = await getClient();
  let all = [], from = 0;
  while (true) {
    const { data, error } = await client.from('activities')
      .select('id, name, category, venue_id, location_id, location:locations(id, name, city)')
      .neq('category', 'גן שעשועים').is('venue_id', null).neq('status', 'archived').range(from, from + 999);
    if (error) throw error;
    all = all.concat(data); if (data.length < 1000) break; from += 1000;
  }
  console.log(`non-playground activities without venue: ${all.length} (${APPLY ? 'APPLY' : 'DRY RUN'})`);
  let linked = 0; const unresolved = {};
  for (const a of all) {
    const locName = a.location?.name; const city = a.location?.city;
    const v = (await resolveVenue(client, { locationName: locName, city })) || (await resolveVenue(client, { locationName: a.name, city }));
    if (!v) { const k = `${locName || '?'} | ${city || '?'}`; unresolved[k] = (unresolved[k] || 0) + 1; continue; }
    linked++;
    if (APPLY) {
      await client.from('activities').update({ venue_id: v.id }).eq('id', a.id);
      if (a.location_id) await client.from('locations').update({ venue_id: v.id }).eq('id', a.location_id);
    } else if (linked <= 15) console.log(`  link: "${a.name}" (${locName}, ${city}) -> ${v.name_he}`);
  }
  console.log(`linked: ${linked}; unresolved location labels: ${Object.keys(unresolved).length}`);
  Object.entries(unresolved).sort((x, y) => y[1] - x[1]).slice(0, 25).forEach(([k, n]) => console.log(`  unresolved x${n}: ${k}`));
})().catch((e) => { console.error(e); process.exit(1); });
