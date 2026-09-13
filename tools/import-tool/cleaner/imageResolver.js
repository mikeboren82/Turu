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

module.exports = { resolveImage };
