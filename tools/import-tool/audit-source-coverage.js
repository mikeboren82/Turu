// TuRu - THE MONSTER: coverage of ONE publisher's entity list against the canonical catalogue (read-only).
// Discovery gap regression: cochav-hanofesh.com/parks - the listing HTML exposes 9 parks (the rest load by
// script), the publisher's own sitemap lists 54. Coverage is measured against the SITEMAP (what exists), never
// against what a listing scan happened to see.
//   source entities -> canonical match (name) -> completeness of the matched record (address / coords / city /
//   image / venue) -> missing entities (the discovery gap) -> incomplete entities (Cleaner debt)
//   node audit-source-coverage.js --sitemap=https://cochav-hanofesh.com/parks-sitemap.xml --section=parks [--out=file.json]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { all } = require('./cleaner/discover');
const { normalizeForMatch } = require('./eventFingerprint');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || true]; }));
const fold = (t) => normalizeForMatch(t).replace(/[׳״]/g, '').replace(/יי/g, 'י').replace(/וו/g, 'ו');
const words = (t) => new Set(fold(t).split(' ').filter((w) => w.length > 1));
// the entity's words must (almost) all appear in the canonical name: "גן הוורדים" is inside "גן הוורדים - ירושלים"
const contains = (entity, canon) => { const E = words(entity), C = words(canon); if (!E.size) return 0; let n = 0; E.forEach((w) => { if (C.has(w)) n++; }); return n / E.size; };

(async () => {
  // --section is a bare name ("parks"): Git Bash rewrites an argument that starts with "/" into a Windows path
  if (!args.sitemap || !args.section) { console.error('usage: --sitemap=<url> --section=parks'); process.exit(1); }
  const section = String(args.section).replace(/^\/+|\/+$/g, '');
  const res = await fetch(String(args.sitemap), { headers: { 'User-Agent': 'TuRu-KidsApp/1.0 (coverage audit)' }, signal: AbortSignal.timeout(25000) });
  const xml = await res.text();
  const re = new RegExp(`/${section}/[^/]+/?$`);
  const entities = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decodeURIComponent(m[1])).filter((u) => re.test(u)).map((u) => ({ url: u, name: u.replace(/\/$/, '').split('/').pop().replace(/-/g, ' ') }));
  const { client } = await getClient();
  const acts = await all(client, 'activities', 'id, name, category, status, venue_id, source_url, locations(city, address, lat, lng, address_confidence), activity_images(id)', (q) => q.in('status', ['approved', 'archived']));
  const live = acts.filter((a) => a.status === 'approved');
  const host = new URL(String(args.sitemap)).host.replace(/^www\./, '');
  const rows = entities.map((e) => {
    // full containment, and a generic two-word name ("גן האם") must also not be swamped: prefer the shortest canonical name
    const hits = live.filter((a) => contains(e.name, a.name) >= 1 && words(e.name).size >= 2).sort((a, b) => a.name.length - b.name.length);
    const bySource = live.find((a) => (a.source_url || '').includes(host) && decodeURIComponent(a.source_url).replace(/\/$/, '') === e.url.replace(/\/$/, ''));
    const m = bySource || hits[0] || null;
    const L = m?.locations || {};
    return { entity: e.name, url: e.url, matched: !!m, how: bySource ? 'source_url' : m ? 'name' : null, ambiguous: !bySource && hits.length > 1 ? hits.length : 0, activity: m ? { id: m.id, name: m.name, category: m.category, city: L.city || null } : null,
      complete: m ? { city: !!L.city, coords: L.lat != null && L.address_confidence !== 'LOW', address: !!L.address, image: (m.activity_images || []).length > 0, venue: !!m.venue_id } : null };
  });
  const matched = rows.filter((r) => r.matched);
  const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);
  const counts = { source_entities: rows.length, canonical_matched: matched.length, coverage_pct: pct(matched.length, rows.length), matched_by_source_url: matched.filter((r) => r.how === 'source_url').length, matched_by_name: matched.filter((r) => r.how === 'name').length, ambiguous_name_matches: matched.filter((r) => r.ambiguous).length, missing_entities: rows.length - matched.length,
    complete_city: matched.filter((r) => r.complete.city).length, complete_verified_coords: matched.filter((r) => r.complete.coords).length, complete_address: matched.filter((r) => r.complete.address).length, complete_image: matched.filter((r) => r.complete.image).length, complete_venue: matched.filter((r) => r.complete.venue).length };
  console.log(JSON.stringify(counts, null, 1));
  console.log('MISSING:', rows.filter((r) => !r.matched).map((r) => r.entity).join(' | '));
  console.log('MATCHED but no address:', matched.filter((r) => !r.complete.address).map((r) => `${r.entity} -> ${r.activity.name}`).join(' | '));
  const file = path.join(__dirname, String(args.out || `source-coverage-${host}-${new Date().toISOString().slice(0, 10)}.json`));
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), sitemap: args.sitemap, counts, rows }, null, 2));
  console.log('->', path.basename(file));
})().catch((e) => { console.error(e); process.exit(1); });
