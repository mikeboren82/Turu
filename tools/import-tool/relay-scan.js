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
require('dotenv').config();
const crypto = require('crypto');
const cheerio = require('cheerio');
const { getClient } = require('./supabase');
const { fetchJsonApiText } = require('./jsonApiAdapter');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_PAGES = 8;

// --- mirrors of supabase/functions/_shared (discovery.ts / hashing.ts / extraction.ts) ---
const DISCOVERY_KEYWORDS = ['אירוע', 'אירועים', 'לוח אירועים', 'פעילויות', 'פעילות', 'חוגים', 'קייטנה', 'event', 'events', 'calendar', 'activities', 'activity', 'קטגוריה', 'category', 'עמוד', 'page'];
const PAGINATION_PATTERNS = [/[?&]page=\d+/i, /\/page\/\d+/i, /[?&]p=\d+/i];
function discoverListingLinks($, baseUrl, maxExtra) {
  const base = new URL(baseUrl); const norm = (h) => h.replace(/^www\./, '');
  let resolveBase = base; const baseHref = $('base[href]').first().attr('href'); if (baseHref) { try { resolveBase = new URL(baseHref, base); } catch { /* keep */ } }
  const found = []; const seen = new Set([base.toString()]); let scanned = 0;
  $('a[href]').each((_, el) => {
    if (scanned >= 200 || found.length >= maxExtra) return false; scanned++;
    const href = $(el).attr('href'); if (!href) return;
    let abs; try { abs = new URL(href, resolveBase); } catch { return; }
    if (!['http:', 'https:'].includes(abs.protocol) || norm(abs.hostname) !== norm(base.hostname)) return;
    abs.hash = ''; const key = abs.toString(); if (seen.has(key)) return;
    const text = ($(el).text() || '').toLowerCase(); const lh = href.toLowerCase();
    const ok = PAGINATION_PATTERNS.some((p) => p.test(lh)) || DISCOVERY_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()) || lh.includes(kw.toLowerCase()));
    if (!ok) return; seen.add(key); found.push(key);
  });
  return found.slice(0, maxExtra);
}
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
// 18000 chars × 4 windows - scan-source now extracts long listing pages in up to 4 chunks (see
// _shared/extraction.ts splitTextForExtraction), so the relay must send that much text.
// <form> itself is kept (SharePoint/WebForms sites wrap the whole body in one) - only controls go.
function pageTextForExtraction($) { $('script, style, noscript, nav, footer, header, svg, input, select, textarea, button').remove(); return $('body').text().replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim().slice(0, 18000 * 4); }

const { execFileSync } = require('child_process');

function decodeBuf(buf, contentType) {
  const head = buf.slice(0, 4096).toString('latin1');
  const charset = ((/charset=([\w-]+)/i.exec(contentType || '') || /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1] || 'utf-8').toLowerCase();
  try { return new TextDecoder(charset === 'iso-8859-8-i' ? 'iso-8859-8' : charset).decode(buf); } catch { return buf.toString('utf8'); }
}

// Node's fetch (undici) fails the TLS handshake against a few Israeli hosts that curl negotiates
// fine (observed: azrielimalls.co.il -> "fetch failed"). curl is the fallback, not the default.
function curlFetch(url) {
  // the plain bot UA is what worked against these hosts in the manual probes; -f is NOT used so a
  // non-2xx still returns the body and the status marker
  const out = execFileSync('curl', ['-sL', '-A', 'Mozilla/5.0 (compatible; TuruBot/1.0)', '--max-time', '90', '-H', 'Accept-Language: he-IL,he;q=0.9', '-w', '\n__STATUS__%{http_code}', url], { maxBuffer: 30 * 1024 * 1024 });
  const s = out.toString('latin1');
  const m = /__STATUS__(\d+)\s*$/.exec(s);
  const status = m ? Number(m[1]) : 0;
  const body = out.slice(0, out.length - (m ? m[0].length + 1 : 0));
  return { ok: status >= 200 && status < 400, status, html: decodeBuf(body, null) };
}

async function fetchHtml(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'he-IL,he;q=0.9,en;q=0.5' }, signal: AbortSignal.timeout(45000), redirect: 'follow' });
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: res.ok, status: res.status, html: decodeBuf(buf, res.headers.get('content-type')) };
  } catch (e) {
    if (!/fetch failed|ECONNRESET|certificate|TLS|socket/i.test(e.message || '')) throw e;
    return curlFetch(url);
  }
}

// Poll for the scan log the relay RPC just created (started after `since`) to leave 'running'.
async function waitForScan(client, sourceId, since, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5000));
    const { data } = await client.from('source_scan_logs').select('status, activities_found, new_count, duplicate_count, rejected_count')
      .eq('source_id', sourceId).gte('started_at', since).order('started_at', { ascending: false }).limit(1);
    if (data && data[0] && data[0].status !== 'running') return data[0];
  }
  return null;
}

// mirror of _shared/extraction.ts splitTextForExtraction (no chunk cap here - parts are pages)
function splitText(text, limit) {
  const parts = []; let rest = text;
  while (rest.length > 0) {
    if (rest.length <= limit) { parts.push(rest); break; }
    let cut = rest.lastIndexOf('\n', limit); if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut)); rest = rest.slice(cut).trimStart();
  }
  return parts;
}

async function buildPages(seedUrl) {
  const seed = await fetchHtml(seedUrl);
  if (!seed.ok) throw new Error(`seed HTTP ${seed.status}`);
  const $seed = cheerio.load(seed.html);
  const urls = [seedUrl, ...discoverListingLinks($seed, seedUrl, MAX_PAGES - 1)];
  const pages = [];
  for (const url of urls) {
    try {
      const res = url === seedUrl ? seed : await fetchHtml(url);
      if (!res.ok) continue;
      const $ = cheerio.load(res.html.length > 1_500_000 ? res.html.slice(0, 1_500_000) : res.html);
      const images = extractCandidateImages($, url);
      const text = pageTextForExtraction($);
      if (text.length < 200) continue;
      // same basis as scan-source: hash of the extracted text (not the DOM) - see its CPU-guard note.
      // Long listing pages are relayed as parts of <=18k chars (one extraction window each, split on
      // line boundaries): every part has its own snapshot, so the scanner's time budget can defer
      // the tail to the next relay run instead of the invocation dying mid-page (Holon: ~73k chars).
      for (const [i, part] of splitText(text, 18000).entries()) {
        const partUrl = i === 0 ? url : `${url}#part=${i + 1}`;
        pages.push({ url: partUrl, text: part, hash: sha256(part), images: i === 0 ? images : [] });
      }
    } catch (e) { console.log('   page failed:', url, e.message.slice(0, 60)); }
  }
  return pages;
}

(async () => {
  const { client } = await getClient();
  if (args['mark-blocked']) {
    const { data, error } = await client.from('sources').update({ strategy: 'local_relay' })
      .eq('is_active', true).in('last_failure_kind', ['access_403_waf', 'timeout_network', 'unknown']).neq('strategy', 'local_relay').select('name');
    if (error) throw error;
    console.log(`marked ${data.length} sources as local_relay:`, data.map((d) => d.name).join(' | '));
  }
  let q = client.from('sources').select('id, name, seed_url, strategy, next_scan_at, adapter_config').eq('is_active', true);
  if (args.source) q = q.eq('id', String(args.source));
  else { q = q.eq('strategy', 'local_relay'); if (!args.all) q = q.lte('next_scan_at', new Date().toISOString()); }
  const { data: sources, error } = await q.order('priority', { ascending: false });
  if (error) throw error;
  console.log(`relaying ${sources.length} source(s)`);
  for (const s of sources) {
    try {
      // A JSON-service source (adapter_config, see migration 0082) whose service blocks cloud IPs is
      // relayed too: the request runs here, the rendered text goes through the same RPC.
      const pages = s.adapter_config && (s.adapter_config.url || s.adapter_config.method)
        ? await (async () => {
          const api = await fetchJsonApiText(s.adapter_config, s.seed_url);
          if (!api.ok) throw new Error(`json_api ${api.error}`);
          // one relay "page" per 18k window (split on item boundaries): each part gets its own
          // snapshot hash, so unchanged parts are skipped next time and the scanner's time budget
          // defers the rest to the next relay run instead of losing it (Tel Aviv: 153 items ≈ 61k chars)
          const parts = []; let cur = '';
          for (const block of api.text.split('\n---\n')) {
            if (cur && cur.length + block.length + 5 > 18000) { parts.push(cur); cur = ''; }
            cur = cur ? cur + '\n---\n' + block : block;
          }
          if (cur) parts.push(cur);
          console.log(`   json_api: ${api.count} items -> ${api.text.length} chars in ${parts.length} part(s)`);
          return parts.map((text, i) => ({ url: `${s.seed_url}#part=${i + 1}`, text, hash: sha256(text), images: [] }));
        })()
        : await buildPages(s.seed_url);
      if (!pages.length) { console.log(`✗ ${s.name}: no usable pages`); continue; }
      // One edge invocation extracts ~2-3 dense windows before its time budget (SCAN_TIME_BUDGET_MS)
      // defers the rest, so the pages go in batches: post a batch, wait for that scan to finish
      // (poll source_scan_logs), post the next. Unchanged parts are hash-skipped, so re-runs are cheap.
      const BATCH = Number(args.batch || 3);
      let sent = 0, total = 0;
      for (let i = 0; i < pages.length; i += BATCH) {
        const batch = pages.slice(i, i + BATCH);
        const startedAfter = new Date().toISOString();
        const { error: rpcErr } = await client.rpc('relay_scan_source', { p_source_id: s.id, p_pages: batch });
        if (rpcErr) throw rpcErr;
        sent += batch.length; total += batch.reduce((n, p) => n + p.text.length, 0);
        if (i + BATCH < pages.length) {
          const done = await waitForScan(client, s.id, startedAfter, 240_000);
          if (!done) { console.log(`   batch ${Math.floor(i / BATCH) + 1}: scan did not finish in time - remaining ${pages.length - sent} pages left for the next run`); break; }
          console.log(`   batch ${Math.floor(i / BATCH) + 1}: ${done.status} found ${done.activities_found} new ${done.new_count} dup ${done.duplicate_count} rej ${done.rejected_count}`);
        }
      }
      console.log(`✓ ${s.name}: relayed ${sent}/${pages.length} pages (${total} chars)`);
    } catch (e) { console.log(`✗ ${s.name}: ${e.message.slice(0, 100)}`); }
  }
})().catch((e) => { console.error(e); process.exit(1); });
