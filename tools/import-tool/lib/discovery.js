// Node twin of supabase/functions/_shared/discovery.ts - the two must stay behaviourally identical
// (tests/discovery.test.js pins the shapes). Same-host, depth-1 listing-link discovery.

// A bare 'page' / 'עמוד' is NOT evidence: every SharePoint URL has /Pages/ (115 of 573 links, 29 sources, 2026-09-24).
const DISCOVERY_KEYWORDS = [
  'אירוע', 'אירועים', 'לוח אירועים', 'פעילויות', 'פעילות', 'חוגים', 'קייטנה', 'הצגות', 'הופעות',
  'event', 'events', 'calendar', 'activities', 'activity', 'קטגוריה', 'category',
];
// Whole-anchor category labels only: a bare 'ילדים'/'משפחה' substring admits kindergarten registration and welfare pages.
const KIDS_CATEGORY_LABELS = new Set(['ילדים', 'לילדים', 'ילדים ונוער', 'ילדים ומשפחה', 'הורים וילדים']);
const PAGINATION_PATTERNS = [/[?&]page=\d+/i, /\/page\/\d+/i, /[?&]p=\d+/i];
const PAGINATION_TEXT = /(?:^|\s)(?:page|עמוד)\s*\d+(?:\s|$)/i;
const TRACKING_PARAM = /^(utm_.*|fbclid|gclid)$/i;

// Identity of a page for dedupe: host without www, case-folded path, no trailing slash / fragment / tracking params.
// Query values are kept verbatim - they often identify distinct event pages.
function canonicalPageKey(url) {
  let u;
  try { u = new URL(url); } catch { return String(url); }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let path = u.pathname.toLowerCase();
  if (path.length > 1) path = path.replace(/\/+$/, '');
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k));
  const query = params.length ? '?' + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
  return `${host}${path}${query}`;
}

function looksLikeListingLink(href, text) {
  const lowerText = (text || '').toLowerCase();
  const lowerHref = (href || '').toLowerCase();
  if (PAGINATION_PATTERNS.some((p) => p.test(lowerHref))) return true;
  if (PAGINATION_TEXT.test(lowerText.trim())) return true;
  if (KIDS_CATEGORY_LABELS.has(lowerText.replace(/\s+/g, ' ').trim())) return true;
  return DISCOVERY_KEYWORDS.some((kw) => lowerText.includes(kw.toLowerCase()) || lowerHref.includes(kw.toLowerCase()));
}

function discoverListingLinks($, baseUrl, maxExtraPages, maxLinksScanned = 200) {
  const base = new URL(baseUrl);
  const norm = (h) => h.replace(/^www\./, '').toLowerCase();
  let resolveBase = base;
  const baseHref = $('base[href]').first().attr('href');
  if (baseHref) { try { resolveBase = new URL(baseHref, base); } catch { /* keep the seed */ } }
  const found = [];
  const seen = new Set([canonicalPageKey(base.toString())]);
  let scanned = 0;
  $('a[href]').each((_, el) => {
    if (scanned >= maxLinksScanned || found.length >= maxExtraPages) return false;
    scanned++;
    const $el = $(el);
    const href = $el.attr('href');
    if (!href) return;
    let abs;
    try { abs = new URL(href, resolveBase); } catch { return; }
    if (!['http:', 'https:'].includes(abs.protocol) || norm(abs.hostname) !== norm(base.hostname)) return;
    abs.hash = '';
    const key = canonicalPageKey(abs.toString());
    if (seen.has(key)) return;
    if (!looksLikeListingLink(href, $el.text() || '')) return;
    seen.add(key);
    found.push(abs.toString());
  });
  return found.slice(0, maxExtraPages);
}

module.exports = { discoverListingLinks, canonicalPageKey, looksLikeListingLink, DISCOVERY_KEYWORDS, PAGINATION_PATTERNS };
