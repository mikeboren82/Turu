// TuRu - one-off audit of the images THE CLEANER attached (brief §12): is `event_specific` earned?
// Evidence checked per image: (1) site-default og:image of the page host, (2) the same URL attached
// to other activities (same title => event_series, different => organizer_specific), (3) shared by
// several cards on the listing page. Reclassifies image_kind in place (never deletes an image).
//   node audit-cleaner-images.js            report only
//   node audit-cleaner-images.js --apply    write the reclassifications
require('dotenv').config();
const { getClient } = require('./supabase');
const { fetchHtml } = require('./lib/fetchPage');
const { findEventCard } = require('./lib/pageExtract');
const { siteDefaultImages } = require('./cleaner/imageResolver');
const { wordOverlapScore } = require('./cleaner/matching');

const APPLY = process.argv.includes('--apply');
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

(async () => {
  const { client } = await getClient();
  const { data: imgs } = await client.from('activity_images').select('id, url, image_kind, image_page_url, activity_id, activities!inner(name)').not('retrieved_at', 'is', null).order('retrieved_at');
  const cache = new Map(); const pageCache = new Map();
  const rows = [];
  for (const im of imgs || []) {
    const name = im.activities.name; const verdicts = [];
    const host = im.image_page_url ? hostOf(im.image_page_url) : null;
    const norm = (u) => (u || '').split('?')[0];
    if (host && (await siteDefaultImages(host, cache)).has(norm(im.url))) verdicts.push({ to: 'generic_fallback', why: 'site_default_og_image' });
    const { data: others } = await client.from('activity_images').select('activity_id, activities!inner(name)').eq('url', im.url).neq('activity_id', im.activity_id);
    if (others && others.length) { const same = others.every((o) => wordOverlapScore(o.activities.name, name) >= 0.7); verdicts.push({ to: same ? 'event_series' : 'organizer_specific', why: `reused by ${others.length} other activit${others.length > 1 ? 'ies' : 'y'} (${others.map((o) => o.activities.name).join(' | ').slice(0, 80)})` }); }
    if (im.image_page_url && !verdicts.length) {
      if (!pageCache.has(im.image_page_url)) pageCache.set(im.image_page_url, await fetchHtml(im.image_page_url));
      const r = pageCache.get(im.image_page_url);
      if (r.ok && r.html) { const card = findEventCard(r.html, im.image_page_url, name); if (card.sharedImages.includes(im.url)) verdicts.push({ to: 'organizer_specific', why: 'shared by other cards on the listing page' }); else if (card.score >= 0.8 && card.images.includes(im.url)) verdicts.push({ keep: true, why: `card match ${card.score.toFixed(2)}, image unique on page` }); else verdicts.push({ keep: true, why: 'page image confirmed by title/og context' }); }
    }
    const order = { generic_fallback: 0, organizer_specific: 1, venue_specific: 2, event_series: 3, event_specific: 4 };
    const down = verdicts.filter((v) => v.to).sort((a, b) => order[a.to] - order[b.to])[0];
    const to = down ? down.to : im.image_kind;
    rows.push({ id: im.id, name, url: im.url, from: im.image_kind, to, why: (down || verdicts[0] || { why: 'no evidence checked' }).why });
    if (APPLY && to !== im.image_kind) await client.from('activity_images').update({ image_kind: to }).eq('id', im.id);
  }
  console.log(`${APPLY ? 'APPLY' : 'REPORT'}: ${rows.length} Cleaner-attached images`);
  for (const r of rows) console.log(`  ${r.from} -> ${r.to}${r.from !== r.to ? '  *' : '   '} | ${r.name.slice(0, 40)} | ${r.why} | ${r.url.slice(0, 70)}`);
  console.log('summary', JSON.stringify(rows.reduce((m, r) => { m[`${r.from}->${r.to}`] = (m[`${r.from}->${r.to}`] || 0) + 1; return m; }, {})));
})().catch((e) => { console.error(e); process.exit(1); });
