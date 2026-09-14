// TuRu - Node mirror of supabase/functions/_shared/eventIdentity.ts (EVENT identity for THE MONSTER).
// Keep in lockstep; tests/eventIdentity.test.js pins the shared cases.
//
// event_key         = EVENT identity (stable across occurrences).
// event_fingerprint = LEGACY first-occurrence fingerprint (eventFingerprint.js) - never the canonical
//                     multi-occurrence event identity.
// Kinds, strongest first: ext:<source>:<id> > url:<verified detail URL> > pk:<source>:<key> >
// tvs:<exact normalized title>|v:<venue>|s:<source> (conservative fallback, never outranks the others).
const { normalizeForMatch } = require('../eventFingerprint');

const GENERIC_TITLE_STOPWORDS = new Set([
  'שעת', 'סיפור', 'הצגה', 'הצגת', 'ילדים', 'לילדים', 'מופע', 'סדנה', 'סדנת', 'פעילות', 'לגיל', 'לגילאי', 'גילאי', 'גיל', 'בני',
  'הרך', 'לכל', 'המשפחה', 'משפחתי', 'משפחה', 'לפעוטות', 'פעוטות', 'קטנטנים', 'יצירה', 'ספרייה', 'בספרייה', 'ההצגה', 'המופע',
]);

function contentWords(title) {
  return normalizeForMatch(title).split(' ').filter((w) => w.length > 1 && !/^\d+$/.test(w) && !GENERIC_TITLE_STOPWORDS.has(w));
}
function isGenericTitle(title) { return contentWords(title).length < 3; }

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|_ga$)/i;
function normalizeDetailUrl(url) {
  if (!url) return null;
  let u; try { u = new URL(url); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  u.hash = '';
  for (const k of Array.from(u.searchParams.keys())) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  let path = u.pathname; try { path = decodeURIComponent(path); } catch { /* keep */ }
  path = path.replace(/\/+$/, '') || '/';
  const q = u.searchParams.toString();
  return `${u.protocol}//${u.hostname}${path}${q ? '?' + q : ''}`;
}

const LISTING_PATH = /(^|\/)(page_\d+|page\/\d+|category|categories|search|calendar|events?|all|list|tag|tags)\/?$|_page_\d+$|(^|[/_])season_\d+/i;
const LISTING_QUERY = /(^|[?&])(page|p|pg|category|cat|q|search|date|month|year)=/i;
function isListingShapedUrl(url, opts = {}) {
  let u; try { u = new URL(url); } catch { return true; }
  const norm = normalizeDetailUrl(url);
  const known = new Set();
  if (opts.seedUrl) { const s = normalizeDetailUrl(opts.seedUrl); if (s) known.add(s); }
  for (const l of opts.listingUrls || []) { const s = normalizeDetailUrl(l); if (s) known.add(s); }
  if (norm && known.has(norm)) return true;
  let path; try { path = decodeURIComponent(u.pathname); } catch { path = u.pathname; }
  path = path.replace(/\/+$/, '');
  if (!path || path === '/') return true;
  if (LISTING_PATH.test(path)) return true;
  if (LISTING_QUERY.test(u.search)) return true;
  return false;
}

function computeEventKey(input) {
  const src = (input.sourceId || '').trim();
  const ext = (input.externalEventId || '').toString().trim();
  if (src && ext) return { key: `ext:${src}:${ext}`, kind: 'external_id' };
  if (input.detailVerified && input.detailUrl) {
    const n = normalizeDetailUrl(input.detailUrl);
    if (n && !isListingShapedUrl(n)) return { key: `url:${n}`, kind: 'detail_url' };
  }
  const pk = (input.providerKey || '').toString().trim();
  if (src && pk) return { key: `pk:${src}:${pk}`, kind: 'provider_key' };
  const title = normalizeForMatch(input.title);
  if (src && input.venueId && title && !isGenericTitle(input.title)) return { key: `tvs:${title}|v:${input.venueId}|s:${src}`, kind: 'title_venue_source' };
  return null;
}

const KIND_RANK = { external_id: 4, detail_url: 3, provider_key: 2, title_venue_source: 1 };
function eventKeyRank(kind) { return kind ? KIND_RANK[kind] || 0 : 0; }

module.exports = { GENERIC_TITLE_STOPWORDS, contentWords, isGenericTitle, normalizeDetailUrl, isListingShapedUrl, computeEventKey, eventKeyRank };
