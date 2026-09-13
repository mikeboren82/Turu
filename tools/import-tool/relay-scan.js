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
function pageTextForExtraction($) { $('script, style, noscript, nav, footer, header, svg, form').remove(); return $('body').text().replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim().slice(0, 18000); }

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
      // same basis as scan-source: hash of the extracted text (not the DOM) - see its CPU-guard note
      const hash = sha256(text);
      pages.push({ url, text, hash, images });
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
  let q = client.from('sources').select('id, name, seed_url, strategy, next_scan_at').eq('is_active', true);
  if (args.source) q = q.eq('id', String(args.source));
  else { q = q.eq('strategy', 'local_relay'); if (!args.all) q = q.lte('next_scan_at', new Date().toISOString()); }
  const { data: sources, error } = await q.order('priority', { ascending: false });
  if (error) throw error;
  console.log(`relaying ${sources.length} source(s)`);
  for (const s of sources) {
    try {
      const pages = await buildPages(s.seed_url);
      if (!pages.length) { console.log(`✗ ${s.name}: no usable pages`); continue; }
      const { error: rpcErr } = await client.rpc('relay_scan_source', { p_source_id: s.id, p_pages: pages });
      if (rpcErr) throw rpcErr;
      console.log(`✓ ${s.name}: relayed ${pages.length} pages (${pages.reduce((n, p) => n + p.text.length, 0)} chars)`);
    } catch (e) { console.log(`✗ ${s.name}: ${e.message.slice(0, 100)}`); }
  }
})().catch((e) => { console.error(e); process.exit(1); });
