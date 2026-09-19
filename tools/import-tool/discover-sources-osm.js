// TuRu - CONTINUOUS MONSTER: bounded, free, provenance-aware SOURCE DISCOVERY from OpenStreetMap venue records
// (ODbL). One Overpass query per (region, family), only records with a website inside the service area, deduplicated
// against sources / venues / other candidates, fetch-verified (status, Hebrew text, child/event keywords, JS-only),
// scored, written to discovery-candidates-osm-<date>.json and - with --register - inserted into `sources` as
// INACTIVE rows (disabled_reason 'discovery_candidate', trust 50) that a person activates in the admin. Never
// activates, never scans, never touches an existing source. No SerpAPI, no paid API.
//   node discover-sources-osm.js [--regions=a,b] [--families=community_center,library] [--max=20] [--register] [--dry-run]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { all } = require('./cleaner/discover');
const { loadSettlementIndex } = require('./lib/canonicalSettlement');
const { classifyServiceArea } = require('./lib/serviceArea');
const { TAG_QUERIES, overpassQuery, candidateFromElement, dedupeCandidates, regionBbox, registryRow, hostOf } = require('./lib/sourceDiscovery');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const MAX = Number(args.max || 20); const REGISTER = !!args.register && !args['dry-run'];
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.openstreetmap.fr/api/interpreter'];
const UA = 'TuruBot/1.0 (children activities catalogue; contact via turu app)';
const CHILD_KW = ['ילדים', 'משפחה', 'משפחות', 'הורים', 'פעוטות', 'גיל הרך', 'סדנ', 'הצג', 'אירוע', 'פעילויות', 'חוגים', 'שעת סיפור', 'קייטנ'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(q) {
  for (const ep of ENDPOINTS) {
    try { const r = await fetch(ep, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q), signal: AbortSignal.timeout(90000) }); if (r.ok) return (await r.json()).elements || []; }
    catch { /* next endpoint */ }
    await sleep(2000);
  }
  return null;
}
async function verify(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'he-IL,he;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    const html = await r.text(); const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const hebrew = (text.match(/[֐-׿]/g) || []).length; const hits = CHILD_KW.filter((k) => text.includes(k)).length;
    const jsOnly = text.length < 400 && /<script/i.test(html);
    const verdict = !r.ok ? 'blocked' : jsOnly ? 'js_only' : hebrew < 200 ? 'not_hebrew' : hits >= 2 ? 'scrapable' : 'weak_signal';
    return { status: r.status, finalUrl: r.url, textChars: text.length, hebrewChars: hebrew, keywordHits: hits, verdict, summary: `HTTP ${r.status}, ${hebrew} Hebrew chars, ${hits} child/event keywords -> ${verdict}` };
  } catch (e) { return { status: null, verdict: 'unreachable', summary: 'fetch failed: ' + (e.message || e).slice(0, 80) }; }
}

(async () => {
  const { client } = await getClient();
  const index = await loadSettlementIndex(client);
  const settlements = [...index.byId.values()];
  const regions = args.regions ? String(args.regions).split(',') : [...new Set(settlements.map((s) => s.region).filter(Boolean))];
  const specs = args.families ? TAG_QUERIES.filter((t) => String(args.families).split(',').includes(t.family)) : TAG_QUERIES;
  const [sources, venues] = await Promise.all([all(client, 'sources', 'id, seed_url, is_active'), all(client, 'venues', 'id, website_url, events_url')]);
  const known = new Set([...sources.map((s) => hostOf(s.seed_url)), ...venues.flatMap((v) => [hostOf(v.website_url), hostOf(v.events_url)])].filter(Boolean));
  console.log(`regions ${regions.length} | families ${specs.map((s) => s.family).join(',')} | known hosts ${known.size} | max ${MAX} | ${REGISTER ? 'REGISTER inactive rows' : 'dry run'}`);
  let raw = []; const stats = { queries: 0, elements: 0, outside_service_area: 0, ambiguous: 0, known_host: 0, no_website: 0, verified: {}, registered: 0 };
  for (const region of regions) {
    const bbox = regionBbox(settlements, region); if (!bbox) continue;
    for (const spec of specs) {
      stats.queries++;
      const els = await overpass(overpassQuery(spec.overpass, bbox)); if (!els) continue; stats.elements += els.length;
      for (const el of els) { const c = candidateFromElement(el, spec); if (!c) { stats.no_website++; continue; } c.region = region; raw.push(c); }
      await sleep(1500);
    }
  }
  // service area: candidates inside PA-administered territory are dropped here (counted, never registered)
  const inScope = [];
  for (const c of raw) {
    const v = classifyServiceArea({ lat: c.lat, lng: c.lng }, { index });
    if (v.klass === 'OUTSIDE_SERVICE_AREA') { stats.outside_service_area++; continue; }
    if (v.klass === 'AMBIGUOUS') { stats.ambiguous++; c.service_area = 'AMBIGUOUS'; c.service_area_reason = v.reason; }
    // the region is the nearest CBS settlement's region, not the query bbox (a padded region bbox overlaps neighbours)
    const near = v.evidence && v.evidence.nearest_cbs; const st = near ? settlements.find((x) => x.city === near.city || x.name_he === near.city) : null;
    c.query_region = c.region; c.settlement = near ? near.city : null; c.settlement_km = near ? Math.round(near.km * 10) / 10 : null; if (st && st.region) c.region = st.region;
    inScope.push(c);
  }
  const deduped = dedupeCandidates(inScope, known); stats.known_host = deduped.filter((c) => c.verdict === 'known_host').length;
  const fresh = deduped.filter((c) => !c.verdict).slice(0, MAX * 3);
  const out = [];
  for (const c of fresh) { c.verify = await verify(c.website); stats.verified[c.verify.verdict] = (stats.verified[c.verify.verdict] || 0) + 1; c.score = c.verify.verdict === 'scrapable' ? 80 + Math.min(15, c.verify.keywordHits) : c.verify.verdict === 'weak_signal' ? 50 : 10; out.push(c); await sleep(500); }
  out.sort((a, b) => b.score - a.score);
  const batch = `osm-${new Date().toISOString().slice(0, 10)}`;
  const toRegister = out.filter((c) => c.verify.verdict === 'scrapable').slice(0, MAX);
  if (REGISTER) {
    for (const c of toRegister) { const { error } = await client.from('sources').insert(registryRow(c, batch)); if (error) { c.register_error = error.message; continue; } stats.registered++; }
  }
  const report = { generatedAt: new Date().toISOString(), batch, dryRun: !REGISTER, regions, families: specs.map((s) => s.family), stats, wouldRegister: toRegister.map((c) => ({ name: c.name, website: c.website, region: c.region, family: c.family, score: c.score, osm: c.osm, service_area: c.service_area || 'IN_SCOPE' })), candidates: out, knownHosts: deduped.filter((c) => c.verdict === 'known_host').map((c) => ({ name: c.name, host: c.host })) };
  const file = path.join(__dirname, `discovery-candidates-osm-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(stats), '| would register', toRegister.length, '->', path.basename(file));
  for (const c of toRegister.slice(0, 25)) console.log(`  ${c.family.padEnd(16)} ${String(c.name).slice(0, 34).padEnd(34)} ${c.region} | ${c.website} | ${c.verify.summary}`);
})().catch((e) => { console.error(e); process.exit(1); });
