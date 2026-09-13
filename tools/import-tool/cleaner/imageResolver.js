// TuRu Cleaner - image enrichment (THE-CLEANER.md §10-13). Source hierarchy, strongest first:
//   event_specific   : image attached to the source event (incoming extracted_data.images),
//                      JSON-LD event image / og:image on a page that is about THIS event,
//                      page images whose alt/context names the event
//   event_series     : an image Turu already holds for the same recurring event / same title
//   venue_specific   : the venue's official site og:image / JSON-LD image
// Every candidate goes through imageProbe (reachable, real image, >= 300x200, not logo/icon) and
// is deduped against the activity's existing images. Provenance (source url, page url, kind,
// retrieved_at, needs_rights_review by host rule) is returned for the caller to store through the
// existing activity_images table. Nothing here writes.
const { fetchHtml } = require('../lib/fetchPage');
const { extractJsonLd, extractMetaImages, extractPageImages } = require('./pageEvidence');
const { probeImage } = require('./imageProbe');
const { wordOverlapScore } = require('./matching');

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } }
function provenance(url, pageUrl) {
  const same = hostOf(url) && hostOf(pageUrl) && hostOf(url) === hostOf(pageUrl);
  return { image_source_type: same ? 'ORIGINAL_SOURCE' : 'EXTERNAL_SOURCE', needs_rights_review: !same };
}

// subject: { name, page_url, venue_id, existing_urls: [], incoming_images: [{url}] , series_urls: [] }
async function resolveImage(client, subject, opts = {}) {
  const budget = { pages: opts.maxPages ?? 2, probes: opts.maxProbes ?? 12 };
  const tried = []; const rejected = [];
  const existing = new Set((subject.existing_urls || []).map(String));
  const candidates = [];
  const push = (url, kind, page_url) => { if (url && !existing.has(url) && !candidates.some((c) => c.url === url)) candidates.push({ url, kind, page_url }); };

  // 1. images the scanner attached to this event
  for (const im of subject.incoming_images || []) push(typeof im === 'string' ? im : im.url, 'event_specific', subject.page_url);

  // 2. the event's own page
  if (subject.page_url && budget.pages > 0) {
    tried.push('page');
    budget.pages--;
    const r = await fetchHtml(subject.page_url);
    if (r.ok && r.html) {
      const ld = extractJsonLd(r.html);
      const ev = ld.events.find((e) => wordOverlapScore(e.name, subject.name) >= 0.5) || (ld.events.length === 1 ? ld.events[0] : null);
      if (ev) ev.images.forEach((u) => push(abs(u, subject.page_url), 'event_specific', subject.page_url));
      const single = !!ev || ld.events.length <= 1;
      const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(r.html) || [])[1] || '';
      const aboutThisEvent = single && (wordOverlapScore(title, subject.name) >= 0.4 || !!ev);
      extractMetaImages(r.html).forEach((u) => push(abs(u, subject.page_url), aboutThisEvent ? 'event_specific' : 'generic_fallback', subject.page_url));
      for (const im of extractPageImages(r.html, subject.page_url)) {
        const rel = Math.max(wordOverlapScore(im.alt, subject.name), wordOverlapScore(im.context, subject.name));
        if (rel >= 0.4) push(im.url, 'event_specific', subject.page_url);
      }
      // listing page (municipal calendar, mall events): the card that names THIS event carries its
      // picture and links to a detail page whose og:image / JSON-LD image is the event's own
      if (!single || !aboutThisEvent) {
        const card = findEventCard(r.html, subject.page_url, subject.name);
        for (const u of card.images) push(u, 'event_specific', subject.page_url);
        const detail = card.detailUrl;
        if (detail && budget.pages > 0) {
          tried.push('detail_page'); budget.pages--;
          const r2 = await fetchHtml(detail);
          if (r2.ok && r2.html) {
            const ld2 = extractJsonLd(r2.html);
            ld2.events.forEach((e) => e.images.forEach((u) => push(abs(u, detail), 'event_specific', detail)));
            const title2 = (/<title[^>]*>([^<]*)<\/title>/i.exec(r2.html) || [])[1] || '';
            const about = wordOverlapScore(title2, subject.name) >= 0.4 || ld2.events.some((e) => wordOverlapScore(e.name, subject.name) >= 0.5);
            extractMetaImages(r2.html).forEach((u) => push(abs(u, detail), about ? 'event_specific' : 'generic_fallback', detail));
            for (const im of extractPageImages(r2.html, detail)) { if (about || Math.max(wordOverlapScore(im.alt, subject.name), wordOverlapScore(im.context, subject.name)) >= 0.4) push(im.url, 'event_specific', detail); }
          }
        }
      }
    }
  }

  // 3. same series in Turu
  for (const u of subject.series_urls || []) push(u, 'event_series', null);

  // 4. venue site
  if (subject.venue_id && budget.pages > 0) {
    const { data: venue } = await client.from('venues').select('name_he, website_url, events_url').eq('id', subject.venue_id).maybeSingle();
    const site = venue?.website_url || venue?.events_url;
    if (site) {
      tried.push('venue_site'); budget.pages--;
      const r = await fetchHtml(site);
      if (r.ok && r.html) {
        extractMetaImages(r.html).forEach((u) => push(abs(u, site), 'venue_specific', site));
        extractJsonLd(r.html).images.forEach((u) => push(abs(u, site), 'venue_specific', site));
      }
    }
  }

  // validate in hierarchy order: event_specific > event_series > venue_specific > generic_fallback
  const order = { event_specific: 0, event_series: 1, venue_specific: 2, organizer_specific: 3, generic_fallback: 4 };
  candidates.sort((a, b) => order[a.kind] - order[b.kind]);
  for (const c of candidates) {
    if (budget.probes-- <= 0) break;
    if (c.kind === 'generic_fallback' && !opts.allowGeneric) { rejected.push({ url: c.url, reason: 'generic_only' }); continue; }
    const p = await probeImage(c.url);
    if (!p.ok) { rejected.push({ url: c.url, reason: p.reason }); continue; }
    return { found: { url: p.url, kind: c.kind, page_url: c.page_url, width: p.width, height: p.height, ...provenance(p.url, c.page_url || subject.page_url) }, tried, rejected, candidates: candidates.length };
  }
  return { found: null, tried, rejected, candidates: candidates.length };
}
function abs(u, base) { try { return new URL(u, base).toString(); } catch { return null; } }

// fraction of the event name's words that appear in a text (a long card text must not dilute it)
function containsScore(text, name) {
  const norm = (s) => (s || '').toLowerCase().replace(/[^֐-׿a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const wn = [...new Set(norm(name).split(' ').filter((w) => w.length > 1))];
  if (!wn.length) return 0;
  const wt = new Set(norm(text).split(' ').filter((w) => w.length > 1));
  return wn.filter((w) => wt.has(w)).length / wn.length;
}

// The card on a listing page that names THIS event: its images + the link to its detail page
// (any host - municipal calendars link to matnas / ticketing sites).
function findEventCard(html, baseUrl, name) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  // <base href> (municipal sites use relative './events/123/' links against it) - same rule as relay-scan's discovery
  const baseHref = $('base[href]').first().attr('href'); if (baseHref) { try { baseUrl = new URL(baseHref, baseUrl).toString(); } catch { /* keep */ } }
  let best = null, bestScore = 0;
  $('a[href], h1, h2, h3, h4, .title, .name').each((_, el) => {
    const own = ($(el).text() || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const s = containsScore(own, name);
    if (s > bestScore && s >= 0.8) { bestScore = s; best = $(el); }
  });
  if (!best) return { detailUrl: null, images: [] };
  // the card = the smallest ancestor that also holds an image or a link (up to 4 levels)
  let card = best; for (let i = 0; i < 4; i++) { if (card.find('img').length) break; if (!card.parent().length || card.parent().is('body, html')) break; card = card.parent(); }
  const images = []; const push = (u) => { const a = abs(u, baseUrl); if (a && !/logo|icon|sprite|placeholder|\.svg/i.test(a) && !images.includes(a)) images.push(a); };
  card.find('img[src], img[data-src]').each((_, im) => push($(im).attr('src') || $(im).attr('data-src')));
  if (card.is('a')) { const bg = /url\(["']?([^"')]+)/.exec(card.attr('style') || ''); if (bg) push(bg[1]); }
  let detailUrl = null;
  const links = (best.is('a') ? [best] : []).concat(card.is('a') ? [card] : [], card.find('a[href]').toArray().map((a) => $(a)));
  for (const a of links) { const href = a.attr('href'); if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue; const u = abs(href, baseUrl); if (u && u.split('#')[0] !== baseUrl.split('#')[0]) { detailUrl = u; break; } }
  return { detailUrl, images: images.slice(0, 3) };
}

module.exports = { resolveImage, findEventCard, containsScore };
