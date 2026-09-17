// TuRu - generates supabase/0098_split_regions_on_venues_and_sources.sql (one-off, deterministic).
// 0084 split locations.region into 9 regions; venues (CHECK still lists the old 7) and sources kept the two
// combined names ("השפלה והדרום", "הצפון והעמק"), so report-coverage showed 0 sources / venues for the four
// new regions. Each row's new region comes from CANONICAL knowledge only, never from a guess:
//   venue   city -> canonical settlement (lib/canonicalSettlement.js) -> TuRu region
//   source  its venue's new region  >  the dominant locations.region of the activities it produced (>= 3, >= 70%)
//   anything that cannot be decided keeps NULL and is listed in the file's header for a person.
// Rows on the other five region names are untouched (they did not change in 0084).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { all } = require('./cleaner/discover');
const { loadSettlementIndex, resolveSettlement } = require('./lib/canonicalSettlement');

const COMBINED = { 'השפלה והדרום': ['השפלה', 'הדרום והנגב'], 'הצפון והעמק': ['הצפון והגליל', 'עמק יזרעאל והעמקים'] };
const NINE = ['גוש דן והמרכז', 'השרון', 'ירושלים והסביבה', 'חיפה והקריות', 'הצפון והגליל', 'עמק יזרעאל והעמקים', 'השפלה', 'הדרום והנגב', 'יו"ש והבנימין'];
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

(async () => {
  const { client } = await getClient();
  const index = await loadSettlementIndex(client, { fresh: true });
  const venues = await all(client, 'venues', 'id, name_he, city, region');
  const sources = await all(client, 'sources', 'id, name, region, venue_id');
  const acts = await all(client, 'activities', 'source_id, locations(region)', (x) => x.eq('status', 'approved').not('source_id', 'is', null));
  const venueRegion = new Map(); const vUpd = []; const vUnknown = [];
  for (const v of venues) {
    if (!COMBINED[v.region]) { venueRegion.set(v.id, v.region); continue; }
    const s = resolveSettlement(index, v.city);
    const r = s && s.region && COMBINED[v.region].includes(s.region) ? s.region : null;
    if (r) { vUpd.push({ id: v.id, name: v.name_he, city: v.city, from: v.region, to: r }); venueRegion.set(v.id, r); } else { vUnknown.push(`${v.name_he} (${v.city || 'no city'}; settlement region ${s?.region || 'unresolved'})`); venueRegion.set(v.id, null); }
  }
  const bySource = {}; for (const a of acts) { const r = a.locations?.region; if (!r) continue; (bySource[a.source_id] ||= {})[r] = ((bySource[a.source_id] || {})[r] || 0) + 1; }
  const sUpd = []; const sUnknown = [];
  for (const s of sources) {
    if (!COMBINED[s.region]) continue;
    let r = s.venue_id ? venueRegion.get(s.venue_id) : null; let how = 'venue';
    if (!r) { const t = Object.entries(bySource[s.id] || {}).sort((a, b) => b[1] - a[1]); const total = t.reduce((n, x) => n + x[1], 0); if (t[0] && total >= 3 && t[0][1] / total >= 0.7 && COMBINED[s.region].includes(t[0][0])) { r = t[0][0]; how = `activities ${t[0][1]}/${total}`; } }
    // third signal: a canonical settlement named inside the source's own name ("עיריית נהריה", "מתנ"ס גן יבנה") -
    // the longest such name, and only when every matching settlement agrees on the region
    if (!r) {
      const hay = ` ${s.name} `; const hits = [];
      for (const st of index.byId.values()) { if (!st.city || st.city.length < 3 || !st.region) continue; if (new RegExp(`(^|[\\s\\-–(])${st.city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s\\-–),])`).test(hay)) hits.push(st); }
      const longest = hits.sort((a, b) => b.city.length - a.city.length)[0];
      const top = longest ? hits.filter((h) => h.city.length === longest.city.length) : [];
      if (top.length && new Set(top.map((h) => h.region)).size === 1 && COMBINED[s.region].includes(top[0].region)) { r = top[0].region; how = `settlement in the name: ${top[0].city}`; }
    }
    if (r && COMBINED[s.region].includes(r)) sUpd.push({ id: s.id, name: s.name, from: s.region, to: r, how }); else sUnknown.push(s.name);
  }
  const lines = [
    '-- 0098 - the 9-region split (0084) reaches VENUES and SOURCES (2026-09-17).',
    '-- 0084 split locations.region; venues (whose CHECK still enforced the old 7 names) and sources kept the two',
    '-- combined names, so coverage by region showed 0 sources / venues for the North, the Valleys, the Shfela and',
    '-- the South. Every new value below was derived from canonical knowledge (generate-region-split-migration.js):',
    '-- venue city -> canonical settlement -> region; source -> its venue, else the dominant region of its own activities.',
    `-- venues re-mapped: ${vUpd.length} | sources re-mapped: ${sUpd.length}`,
    `-- NOT decidable, set to NULL for a person to assign - venues (${vUnknown.length}): ${vUnknown.join(' ; ') || '-'}`,
    `-- NOT decidable, set to NULL - sources (${sUnknown.length}): ${sUnknown.join(' ; ') || '-'}`,
    '-- Order matters (incident 2026-09-13): drop the CHECK, update, re-add it - in ONE transaction.',
    'begin;',
    'alter table public.venues drop constraint if exists venues_region_check;',
    ...vUpd.map((u) => `update public.venues set region = ${q(u.to)} where id = ${q(u.id)} and region = ${q(u.from)}; -- ${u.name} (${u.city})`),
    `update public.venues set region = null where region in (${Object.keys(COMBINED).map(q).join(', ')});`,
    `alter table public.venues add constraint venues_region_check check (region is null or region in (${NINE.map(q).join(', ')}));`,
    ...sUpd.map((u) => `update public.sources set region = ${q(u.to)} where id = ${q(u.id)} and region = ${q(u.from)}; -- ${u.name} [${u.how}]`),
    `update public.sources set region = null where region in (${Object.keys(COMBINED).map(q).join(', ')});`,
    'commit;', '',
  ];
  const file = path.join(__dirname, '..', '..', 'supabase', '0098_split_regions_on_venues_and_sources.sql');
  fs.writeFileSync(file, lines.join('\n'));
  console.log(`venues: ${vUpd.length} re-mapped, ${vUnknown.length} undecidable | sources: ${sUpd.length} re-mapped, ${sUnknown.length} undecidable -> ${path.basename(file)}`);
  console.log('venue split:', JSON.stringify(vUpd.reduce((m, u) => { m[u.to] = (m[u.to] || 0) + 1; return m; }, {})), '| source split:', JSON.stringify(sUpd.reduce((m, u) => { m[u.to] = (m[u.to] || 0) + 1; return m; }, {})));
  if (vUnknown.length) console.log('undecidable venues:', vUnknown.join(' ; ')); if (sUnknown.length) console.log('undecidable sources:', sUnknown.slice(0, 30).join(' ; '));
})().catch((e) => { console.error(e); process.exit(1); });
