// TuRu - local fetch relay for sources whose websites block the Supabase edge runtime's cloud IPs
// (403/WAF/Incapsula/timeouts - see migration 0081). Runs on the admin machine: fetches the seed
// page + same-domain listing pages exactly like scan-source would (same link-discovery heuristic,
// same HTML normalization/hash, same text/image extraction), then hands the TEXT to scan-source via
// the relay_scan_source RPC. All extraction/dedupe/provenance/health logic still runs in the edge
// function - this script never writes to activities/incoming itself.
//
//   node relay-scan.js                    -> all active sources with strategy='local_relay' that are due
//   node relay-scan.js --all              -> ignore next_scan_at, relay every local_relay source
//   node relay-scan.js --source=<uuid>    -> one source (any strategy)
//   node relay-scan.js --mark-blocked     -> first flip active sources whose last failure was
//                                            access_403_waf/timeout_network/unknown to strategy='local_relay'
//   Every source run ends COMPLETE / PARTIAL / FAILED (lib/relayRun.js, one RELAY_RUN json line each); a PARTIAL
//   that made progress is retried at the relay cadence (6 h), not the source's normal frequency.
//   node relay-scan.js --detail-pages=N   -> ALSO relay up to N event detail pages per listing page
//                                            ("פרטים נוספים" / title / booking links - lib/pageExtract.js
//                                            findEventDetailLinks, shared with THE CLEANER). Default N comes
//                                            from sources.adapter_config.detail_traversal.max_pages (0 = off).
//
// DETAIL TRAVERSAL - incremental step (2026-09-14): listing pages often carry only a title/date; the
// street address, JSON-LD and the event image live on the detail page. Relaying detail pages as
// ordinary pages means scan-source extracts them with the same prompt/dedup/provenance, and the
// candidate's page_url IS the detail page (the Cleaner's source_page stage then reads it directly).
// The architectural target is adapter-controlled bounded traversal inside THE MONSTER itself
// (scan-source reading adapter_config.detail_traversal: { max_pages, allow_hosts }), not a CLI flag
// a human must remember - this flag + the adapter_config default are the first step, budgets unchanged
// when the config is absent.
require('dotenv').config();
const crypto = require('crypto');
const cheerio = require('cheerio');
const { getClient } = require('./supabase');
const { fetchJsonApiText } = require('./jsonApiAdapter');
const { UA, fetchHtml } = require('./lib/fetchPage');
const { findEventDetailLinks } = require('./lib/pageExtract');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const MAX_PAGES = 8;
const MAX_DETAIL_PAGES_HARD = 25; // per listing page, whatever the config says

// --- mirrors of supabase/functions/_shared (discovery.ts / hashing.ts / extraction.ts) ---
const { discoverListingLinks } = require('./lib/discovery');
function normalizeHtmlForHash($) {
  const $c = $.root().clone();
  $c.find('script, style, noscript, svg, iframe, link, meta').remove();
  $c.find('*').each((_, el) => { for (const name of Object.keys(el.attribs || {})) if (/^data-ga|^data-gtm|^data-track|^nonce$|^data-reactid|^data-testid/.test(name)) $c.find(el).removeAttr(name); });
  $c.find('a[href]').each((_, el) => { const $el = $(el); const href = $el.attr('href'); if (!href) return; try { const u = new URL(href, 'https://x.invalid'); let changed = false; for (const k of Array.from(u.searchParams.keys())) if (/^utm_|^fbclid$|^gclid$/.test(k)) { u.searchParams.delete(k); changed = true; } if (changed) $el.attr('href', u.pathname + (u.search || '')); } catch { /* keep */ } });
  return $c.html() ?? '';
}
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
function extractCandidateImages($, baseUrl) {
  const seen = new Set(); const out = [];
  $('img').each((_, el) => {
    const $el = $(el); const src = [$el.attr('data-src'), $el.attr('data-lazy-src'), $el.attr('data-original'), $el.attr('src')].find((s) => s && !s.startsWith('data:'));
    if (!src) return; let abs; try { abs = new URL(src, baseUrl).toString(); } catch { return; }
    if (seen.has(abs) || /logo|sprite|icon|favicon|placeholder|pixel\.gif|\.svg($|\?)/.test(abs.toLowerCase())) return;
    const w = parseInt($el.attr('width') || '0', 10), h = parseInt($el.attr('height') || '0', 10); if ((w && w < 80) || (h && h < 80)) return;
    seen.add(abs); out.push({ url: abs, alt: ($el.attr('alt') || '').trim(), context: ($el.closest('div, article, li, section').text() || '').replace(/\s+/g, ' ').trim().slice(0, 200) });
  });
  return out.slice(0, 40);
}
// The flattener lives in lib/htmlText.js (Node twin of _shared/extraction.ts): a relayed page arrives at
// scan-source as TEXT, never as a DOM, so item boundaries must be preserved HERE. The WHOLE page is flattened
// and packed into whole-item parts (lib/relayPlan.js) - no page-level character cap; the only bound is the
// explicit, reported part ceiling.
const { pageTextForExtraction } = require('./lib/htmlText');
const plan = require('./lib/relayPlan');
const { createFetchRecorder } = require('./lib/relayRpc');
const { relaySource, runSummary } = require('./lib/relayRun');

// fetch helpers live in lib/fetchPage.js (shared with the Cleaner) - see there for the curl fallback

// DETAIL PAGES ARE EVIDENCE, NOT CANDIDATES (2026-09-14): a listing page's event detail pages are relayed
// as {kind:'detail', parent_url, link_text, html} entries - scan-source primes its detail cache from the
// html and merges the evidence (occurrences / price / address / image) into the LISTING candidate of the
// same name, exactly like its own bounded traversal. They are never text-extracted as pages of their own,
// so one event has one canonical owner (the listing candidate) and no second queue row.
const DETAIL_HTML_MAX = 300_000;
function stripForRelay(html) { return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>|<noscript[\s\S]*?<\/noscript>/gi, ' ').slice(0, DETAIL_HTML_MAX); }

async function buildPages(seedUrl, detail = { maxPages: 0, allowHosts: [], linkSelector: null, urlPattern: null }, itemSelector = null, stats = []) {
  const seed = await fetchHtml(seedUrl);
  if (!seed.ok) throw new Error(`seed HTTP ${seed.status}`);
  const $seed = cheerio.load(seed.html);
  const urls = [seedUrl, ...discoverListingLinks($seed, seedUrl, MAX_PAGES - 1)];
  const pages = [];
  const seen = new Set(urls);
  let detailBudget = Math.min(Number(detail.maxPages) || 0, MAX_DETAIL_PAGES_HARD) * urls.length;
  const perPage = Math.min(Number(detail.maxPages) || 0, MAX_DETAIL_PAGES_HARD);
  for (const url of urls) {
    try {
      const res = url === seedUrl ? seed : await fetchHtml(url);
      if (!res.ok) continue;
      // bounded detail traversal (depth 1, listing pages only): fetch the event pages this listing links to
      // and relay them as EVIDENCE for this listing page
      if (detailBudget > 0) {
        const links = findEventDetailLinks(res.html, url, { max: Math.min(detailBudget, perPage), allowHosts: detail.allowHosts || [], linkSelector: detail.linkSelector || null, urlPattern: detail.urlPattern || null, listingUrls: urls });
        let got = 0;
        for (const l of links) {
          if (seen.has(l.url)) continue; seen.add(l.url); detailBudget--;
          try {
            const dr = await fetchHtml(l.url);
            if (!dr.ok || !dr.html) continue;
            pages.push({ url: l.url, kind: 'detail', parent_url: url, link_text: (l.text || '').slice(0, 160), html: stripForRelay(dr.html), text: '', hash: sha256(l.url) });
            got++;
          } catch (e) { console.log('   detail page failed:', l.url, e.message.slice(0, 60)); }
        }
        if (links.length) console.log(`   detail pages from ${url}: ${got}/${links.length} relayed as evidence`);
      }
      const $ = cheerio.load(res.html.length > 1_500_000 ? res.html.slice(0, 1_500_000) : res.html);
      const images = extractCandidateImages($, url);
      const text = pageTextForExtraction($, Infinity, { itemSelector });
      if (text.length < 200) continue;
      // same basis as scan-source: hash of the extracted text (not the DOM). Every <=18k part is one
      // extraction window with its own snapshot, so a deferred part is retried without redoing the rest.
      const packed = plan.packItemsIntoParts(text);
      stats.push({ url, chars: text.length, items: itemSelector ? packed.items : null, parts: packed.parts.length, oversizedItems: packed.oversizedItems, hardSplits: packed.hardSplits });
      for (const [i, part] of packed.parts.entries()) {
        const partUrl = i === 0 ? url : `${url}#part=${i + 1}`;
        pages.push({ url: partUrl, text: part, hash: sha256(part), images: i === 0 ? images : [] });
      }
    } catch (e) { console.log('   page failed:', url, e.message.slice(0, 60)); }
  }
  return pages;
}

async function relayPages(s) {
  const stats = [];
  // A JSON-service source (adapter_config, see migration 0082) whose service blocks cloud IPs is relayed too:
  // the request runs here, the rendered '---'-delimited item text is packed exactly like an HTML page.
  if (s.adapter_config && (s.adapter_config.url || s.adapter_config.method)) {
    const api = await fetchJsonApiText(s.adapter_config, s.seed_url);
    if (!api.ok) throw new Error(`json_api ${api.error}`);
    const packed = plan.packItemsIntoParts(api.text);
    stats.push({ url: s.seed_url, chars: api.text.length, items: packed.items, parts: packed.parts.length, oversizedItems: packed.oversizedItems, hardSplits: packed.hardSplits });
    // item images (with the item title as context) ride with the first part
    return { stats, pages: packed.parts.map((text, i) => ({ url: `${s.seed_url}#part=${i + 1}`, text, hash: sha256(text), images: i === 0 ? (api.images || []) : [] })) };
  }
  const detail = { maxPages: args['detail-pages'] != null ? Number(args['detail-pages']) : Number(s.adapter_config?.detail_traversal?.max_pages || 0), allowHosts: s.adapter_config?.detail_traversal?.allow_hosts || [], linkSelector: s.adapter_config?.detail_traversal?.link_selector || null, urlPattern: s.adapter_config?.detail_traversal?.url_pattern || null };
  const pages = await buildPages(s.seed_url, detail, s.adapter_config?.item_selector || null, stats);
  return { stats, pages };
}

(async () => {
  const recorder = createFetchRecorder();
  const { client } = await getClient({ fetch: recorder.fetch });
  if (args['mark-blocked']) {
    const { data, error } = await client.from('sources').update({ strategy: 'local_relay' })
      .eq('is_active', true).in('last_failure_kind', ['access_403_waf', 'timeout_network', 'unknown']).neq('strategy', 'local_relay').select('name');
    if (error) throw error;
    console.log(`marked ${data.length} sources as local_relay:`, data.map((d) => d.name).join(' | '));
  }
  let q = client.from('sources').select('id, name, seed_url, strategy, next_scan_at, adapter_config').eq('is_active', true);
  if (args.source) q = q.eq('id', String(args.source));
  else { q = q.eq('strategy', 'local_relay'); if (!args.all) q = q.lte('next_scan_at', new Date().toISOString()); }
  // --max=N (Continuous Monster cycle): a bounded batch, highest priority then longest overdue first
  if (args.max) q = q.order('priority', { ascending: false }).order('next_scan_at', { ascending: true }).limit(Number(args.max));
  const { data: sources, error } = await (args.max ? q : q.order('priority', { ascending: false }));
  if (error) throw error;
  console.log(`relaying ${sources.length} source(s)`);
  for (const s of sources) {
    let run;
    try {
      run = await relaySource({ client, recorder, relayPages, batchSize: Number(args.batch || 3) }, s);
    } catch (e) {
      run = { source: s.name, sourceId: s.id, outcome: 'FAILED', error: e.message.slice(0, 200) };
    }
    const mark = run.outcome === 'COMPLETE' ? '✓' : run.outcome === 'PARTIAL' ? '◐' : '✗';
    console.log(`${mark} ${s.name}: ${run.plannedParts != null ? runSummary(run) : 'relay FAILED: ' + run.error}`);
    console.log(`RELAY_RUN ${JSON.stringify(run)}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
