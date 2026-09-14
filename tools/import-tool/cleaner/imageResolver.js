// TuRu Cleaner - image enrichment (THE-CLEANER.md §10-13). Source hierarchy, strongest first:
//   event_specific   : image attached to the source event (incoming extracted_data.images),
//                      JSON-LD event image / og:image on a page that is about THIS event,
//                      the listing card that names THIS event (only when the image is not shared
//                      by other cards on the page and is not the site's default image)
//   event_series     : an image Turu already holds for the same recurring event / same title, or an
//                      image already attached to another activity whose name overlaps >= 0.7
//   venue_specific   : the venue's official site og:image / JSON-LD image
//   organizer_specific : an image reused across different events of the same organizer/site
//   generic_fallback : the site's default og:image / a page image with no event context
// EVIDENCE-BASED (brief §12/§16): classification is downgraded when ambiguous, never inflated.
// Every candidate goes through imageProbe and is deduped against the activity's existing images.
// Nothing here writes.
const { fetchHtml } = require('../lib/fetchPage');
const { extractJsonLd, extractMetaImages, extractPageImages, findEventCard } = require('../lib/pageExtract');
const { probeImage } = require('./imageProbe');
const { wordOverlapScore } = require('./matching');

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } }
function provenance(url, pageUrl) {
  const same = hostOf(url) && hostOf(pageUrl) && hostOf(url) === hostOf(pageUrl);
  return { image_source_type: same ? 'ORIGINAL_SOURCE' : 'EXTERNAL_SOURCE', needs_rights_review: !same };
}
function abs(u, base) { try { return new URL(u, base).toString(); } catch { return null; } }
const norm = (u) => (u || '').split('?')[0];

// the host's homepage og:image = site default; one fetch per host per run (cache shared across cases)
async function siteDefaultImages(host, cache) {
  const key = 'sitedefault:' + host;
  if (cache.has(key)) return cache.get(key);
  let set = new Set();
  try { const r = await fetchHtml('https://' + host + '/', { timeoutMs: 20000 }); if (r.ok && r.html) set = new Set(extractMetaImages(r.html).map((u) => norm(abs(u, 'https://' + host + '/')))); } catch { /* none */ }
  cache.set(key, set);
  return set;
}

// same URL already attached to other activities? -> event_series (names overlap) or organizer_specific
async function reuseKind(client, url, name) {
  const { data } = await client.from('activity_images').select('activity_id, activities!inner(name)').eq('url', url).limit(5);
  if (!data || !data.length) return null;
  const same = data.some((r) => wordOverlapScore(r.activities?.name || '', name) >= 0.7);
  return same ? 'event_series' : 'organizer_specific';
}

// subject: { name, page_url, venue_id, existing_urls: [], incoming_images: [{url}] , series_urls: [] }
async function resolveImage(client, subject, opts = {}) {
  const budget = { pages: opts.maxPages ?? 2, probes: opts.maxProbes ?? 12 };
  const cache = opts.cache || new Map();
  const tried = []; const rejected = []; const downgrades = [];
  const existing = new Set((subject.existing_urls || []).map(String));
  const candidates = [];
  const push = (url, kind, page_url, why) => { if (url && !existing.has(url) && !candidates.some((c) => c.url === url)) candidates.push({ url, kind, page_url, why }); };

  // 1. images the scanner attached to this event
  for (const im of subject.incoming_images || []) push(typeof im === 'string' ? im : im.url, 'event_specific', subject.page_url, 'scanner_attached');

  // 2. the event's own page
  if (subject.page_url && budget.pages > 0) {
    tried.push('page');
    budget.pages--;
    const r = await fetchHtml(subject.page_url);
    if (r.ok && r.html) {
      const ld = extractJsonLd(r.html);
      const ev = ld.events.find((e) => wordOverlapScore(e.name, subject.name) >= 0.5) || (ld.events.length === 1 ? ld.events[0] : null);
      if (ev) ev.images.forEach((u) => push(abs(u, subject.page_url), 'event_specific', subject.page_url, 'jsonld_event'));
      const single = !!ev || ld.events.length <= 1;
      const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(r.html) || [])[1] || '';
      const aboutThisEvent = single && (wordOverlapScore(title, subject.name) >= 0.4 || !!ev);
      extractMetaImages(r.html).forEach((u) => push(abs(u, subject.page_url), aboutThisEvent ? 'event_specific' : 'generic_fallback', subject.page_url, aboutThisEvent ? 'og_on_event_page' : 'og_on_listing'));
      for (const im of extractPageImages(r.html, subject.page_url)) {
        const rel = Math.max(wordOverlapScore(im.alt, subject.name), wordOverlapScore(im.context, subject.name));
        if (rel >= 0.4) push(im.url, 'event_specific', subject.page_url, 'alt_context_match');
      }
      // listing page (municipal calendar, mall events): the card that names THIS event carries its
      // picture and links to a detail page whose og:image / JSON-LD image is the event's own
      if (!single || !aboutThisEvent) {
        const card = findEventCard(r.html, subject.page_url, subject.name);
        for (const u of card.images) {
          const shared = card.sharedImages.includes(u);
          push(u, shared ? 'organizer_specific' : 'event_specific', subject.page_url, shared ? 'card_image_shared_on_page' : `card_image(score ${card.score})`);
        }
        const detail = card.detailUrl;
        if (detail && budget.pages > 0) {
          tried.push('detail_page'); budget.pages--;
          const r2 = await fetchHtml(detail);
          if (r2.ok && r2.html) {
            const ld2 = extractJsonLd(r2.html);
            ld2.events.forEach((e) => e.images.forEach((u) => push(abs(u, detail), 'event_specific', detail, 'jsonld_event_detail')));
            const title2 = (/<title[^>]*>([^<]*)<\/title>/i.exec(r2.html) || [])[1] || '';
            const about = wordOverlapScore(title2, subject.name) >= 0.4 || ld2.events.some((e) => wordOverlapScore(e.name, subject.name) >= 0.5);
            extractMetaImages(r2.html).forEach((u) => push(abs(u, detail), about ? 'event_specific' : 'generic_fallback', detail, about ? 'og_on_detail_page' : 'og_on_unrelated_detail'));
            for (const im of extractPageImages(r2.html, detail)) { if (about || Math.max(wordOverlapScore(im.alt, subject.name), wordOverlapScore(im.context, subject.name)) >= 0.4) push(im.url, 'event_specific', detail, 'detail_page_image'); }
          }
        }
      }
    }
  }

  // 3. same series in Turu
  for (const u of subject.series_urls || []) push(u, 'event_series', null, 'same_title_in_turu');

  // 4. venue site
  if (subject.venue_id && budget.pages > 0) {
    const { data: venue } = await client.from('venues').select('name_he, website_url, events_url').eq('id', subject.venue_id).maybeSingle();
    const site = venue?.website_url || venue?.events_url;
    if (site) {
      tried.push('venue_site'); budget.pages--;
      const r = await fetchHtml(site);
      if (r.ok && r.html) {
        extractMetaImages(r.html).forEach((u) => push(abs(u, site), 'venue_specific', site, 'venue_og'));
        extractJsonLd(r.html).images.forEach((u) => push(abs(u, site), 'venue_specific', site, 'venue_jsonld'));
      }
    }
  }

  // evidence checks that DOWNGRADE: site default image, reuse across other activities
  for (const c of candidates) {
    if (['event_specific', 'event_series'].includes(c.kind) && c.page_url) {
      const host = hostOf(c.page_url);
      if (host && (await siteDefaultImages(host, cache)).has(norm(c.url))) { downgrades.push({ url: c.url, from: c.kind, to: 'generic_fallback', why: 'site_default_og_image' }); c.kind = 'generic_fallback'; continue; }
    }
    if (c.kind === 'event_specific') {
      const reuse = await reuseKind(client, c.url, subject.name);
      if (reuse) { downgrades.push({ url: c.url, from: c.kind, to: reuse, why: 'already_attached_elsewhere' }); c.kind = reuse; }
    }
  }

  // validate in hierarchy order: event_specific > event_series > venue_specific > organizer_specific > generic_fallback
  const order = { event_specific: 0, event_series: 1, venue_specific: 2, organizer_specific: 3, generic_fallback: 4 };
  candidates.sort((a, b) => order[a.kind] - order[b.kind]);
  for (const c of candidates) {
    if (budget.probes-- <= 0) break;
    if (c.kind === 'generic_fallback' && !opts.allowGeneric) { rejected.push({ url: c.url, reason: 'generic_only' }); continue; }
    const p = await probeImage(c.url);
    if (!p.ok) { rejected.push({ url: c.url, reason: p.reason }); continue; }
    return { found: { url: p.url, kind: c.kind, why: c.why, page_url: c.page_url, width: p.width, height: p.height, ...provenance(p.url, c.page_url || subject.page_url) }, tried, rejected, downgrades, candidates: candidates.length };
  }
  return { found: null, tried, rejected, downgrades, candidates: candidates.length };
}

module.exports = { resolveImage, findEventCard, siteDefaultImages, reuseKind };
