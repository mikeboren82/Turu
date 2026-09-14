// TuRu - bounded detail-link discovery for THE MONSTER (scan-source). Deno twin of
// tools/import-tool/lib/pageExtract.js findEventDetailLinks - keep in lockstep. A listing page often
// carries only a title/date; the address, JSON-LD, image, price, ages and the performances live on the
// event's own page. Selective by design: a link counts only with explicit "details" text, an event-detail
// URL shape, event context (a date/time in its card) or an adapter rule; navigation, listing-shaped
// URLs (categories / paginated / search / host root) and alternate-language sections never count.
// The anchor's aria-label / title attributes are part of its text (whole-card anchors with an image
// and no visible text still name the event that way).

import { isListingShapedUrl } from './eventIdentity.ts';

const DETAIL_TEXT = /פרטים נוספים|מידע נוסף|לפרטים|קרא עוד|קראו עוד|להזמנת כרטיסים|לרכישת כרטיסים|לפרטים והרשמה|read more|more info/i;
const DETAIL_HREF = /\/event(s)?\/(?!calendar|category|page|\?|#)[^/?#]+|\/activity\/|\/show\/|\/item\/|[?&](?:event|item|eventid|activityid)=\d+/i;
const EVENT_CONTEXT = /\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b|\b\d{1,2}:\d{2}\b|בשעה|יום (?:ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)|בתאריך|ב(?:ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)/;
const NAV_TEXT = /מכרז|הליך איתור|צור קשר|צרו קשר|אודות|דבר ראש|הנהלה|תנאי שימוש|תקנון|נגישות|הצהרת נגישות|מפת האתר|כניסה|התחברות|הרשמה לאתר|חיפוש|עמוד הבית|דף הבית|הצטרפו|ניוזלטר|תשלומים|טפסים|מדיניות פרטיות|שוברים|סל הקניות|עגלה/;
const LANG_SECTION = /^\/(ru|en|ar|fr|es|de|uk)(\/|$)/i;

export interface DetailTraversalConfig { max_pages?: number; allow_hosts?: string[]; link_selector?: string; url_pattern?: string }
export interface DetailLink { url: string; text: string; method?: 'detail_text' | 'href_shape' | 'event_context' | 'adapter_rule' }
export interface DetailMatch { url: string; text: string; score: number; method: 'registration_url' | 'card_text' | 'slug' | 'adapter_rule' | 'detail_text' | 'href_shape' | 'event_context' }

function anchorText($el: { text: () => string; attr: (n: string) => string | undefined }): string {
  return [$el.text() || '', $el.attr('aria-label') || '', $el.attr('title') || ''].join(' ').replace(/\s+/g, ' ').trim();
}
function safePattern(p?: string): RegExp | null { if (!p) return null; try { return new RegExp(p, 'i'); } catch { return null; } }

// deno-lint-ignore no-explicit-any
export function findEventDetailLinks($: any, baseUrl: string, opts: { max?: number; allowHosts?: string[]; linkSelector?: string; urlPattern?: string; listingUrls?: Iterable<string> } = {}): DetailLink[] {
  const max = opts.max ?? 20;
  const base = new URL(baseUrl);
  const norm = (h: string) => h.replace(/^www\./, '');
  const allowed = new Set([norm(base.hostname), ...(opts.allowHosts || []).map(norm)]);
  let resolveBase = base;
  const baseHref = $('base[href]').first().attr('href');
  if (baseHref) { try { resolveBase = new URL(baseHref, base); } catch { /* keep */ } }
  const baseLang = LANG_SECTION.test(base.pathname);
  const urlPattern = safePattern(opts.urlPattern);
  const seen = new Set<string>([baseUrl.split('#')[0]]); const out: DetailLink[] = [];
  $('a[href]').each((_: number, el: unknown) => {
    if (out.length >= max) return false;
    const $el = $(el);
    const href = $el.attr('href'); if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;
    let u: URL; try { u = new URL(href, resolveBase); } catch { return; }
    if (!['http:', 'https:'].includes(u.protocol) || !allowed.has(norm(u.hostname))) return;
    if (!baseLang && LANG_SECTION.test(u.pathname)) return;
    u.hash = ''; const key = u.toString(); if (seen.has(key)) return;
    if (isListingShapedUrl(key, { seedUrl: baseUrl, listingUrls: opts.listingUrls })) return;
    const text = anchorText($el);
    if (NAV_TEXT.test(text) || $el.closest('nav, header, footer, .menu, .nav, .breadcrumb, .footer, .header').length) return;
    const card = $el.closest('article, li, .event, .card, .item, .post, .show, [class*="event"], [class*="card"], [class*="show"]');
    const cardText = card.length ? (card.text() || '').replace(/\s+/g, ' ').trim().slice(0, 600) : '';
    const eventContext = EVENT_CONTEXT.test(cardText) || EVENT_CONTEXT.test(text);
    let method: DetailLink['method'] | null = null;
    if (opts.linkSelector && (() => { try { return $el.is(opts.linkSelector); } catch { return false; } })()) method = 'adapter_rule';
    else if (urlPattern && urlPattern.test(u.pathname + u.search)) method = 'adapter_rule';
    else if (DETAIL_TEXT.test(text)) method = 'detail_text';
    else if (DETAIL_HREF.test(u.pathname + u.search) && (eventContext || text.length >= 6)) method = 'href_shape';
    else if (eventContext && text.length >= 6 && text.length <= 400) method = 'event_context';
    if (!method) return;
    seen.add(key); out.push({ url: key, text: text.slice(0, 160), method });
  });
  return out;
}

// DOM-free variant for heavy pages (the scanner skips cheerio above HEAVY_HTML_BYTES): anchors by regex,
// the same text/href/context rules; the anchor body window is wide enough for whole-card anchors
// (image + several divs) - 400 chars missed every card on ticketing listings.
export function findEventDetailLinksCheap(html: string, baseUrl: string, opts: { max?: number; allowHosts?: string[]; maxAnchors?: number; urlPattern?: string; listingUrls?: Iterable<string> } = {}): DetailLink[] {
  const max = opts.max ?? 20;
  const base = new URL(baseUrl);
  const norm = (h: string) => h.replace(/^www\./, '');
  const allowed = new Set([norm(base.hostname), ...(opts.allowHosts || []).map(norm)]);
  const baseHrefM = /<base[^>]+href=["']([^"']+)["']/i.exec(html);
  let resolveBase = base; if (baseHrefM) { try { resolveBase = new URL(baseHrefM[1], base); } catch { /* keep */ } }
  const baseLang = LANG_SECTION.test(base.pathname);
  const urlPattern = safePattern(opts.urlPattern);
  const seen = new Set<string>([baseUrl.split('#')[0]]); const out: DetailLink[] = [];
  const strip = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  let n = 0;
  for (const m of html.matchAll(/<a\b([^>]*\bhref=["']([^"'#][^"']*)["'][^>]*)>([\s\S]{0,6000}?)<\/a>/gi)) {
    if (++n > (opts.maxAnchors ?? 600) || out.length >= max) break;
    const attrs = m[1], href = m[2]; if (/^(mailto|tel|javascript):/i.test(href)) continue;
    let u: URL; try { u = new URL(href, resolveBase); } catch { continue; }
    if (!['http:', 'https:'].includes(u.protocol) || !allowed.has(norm(u.hostname))) continue;
    if (!baseLang && LANG_SECTION.test(u.pathname)) continue;
    u.hash = ''; const key = u.toString(); if (seen.has(key)) continue;
    if (u.pathname.replace(/\/$/, '') === base.pathname.replace(/\/$/, '')) continue; // the listing itself with a query (filters, pages)
    if (isListingShapedUrl(key, { seedUrl: baseUrl, listingUrls: opts.listingUrls })) continue;
    const aria = (/\saria-label=["']([^"']+)["']/i.exec(attrs) || [])[1] || '';
    const title = (/\stitle=["']([^"']+)["']/i.exec(attrs) || [])[1] || '';
    const text = [strip(m[3]), aria, title].join(' ').replace(/\s+/g, ' ').trim();
    if (NAV_TEXT.test(text)) continue;
    // without a DOM there is no "card": only the anchor's own text/href carry evidence (a window of
    // surrounding text bleeds the neighbouring card's date onto filter links)
    let method: DetailLink['method'] | null = null;
    if (urlPattern && urlPattern.test(u.pathname + u.search)) method = 'adapter_rule';
    else if (DETAIL_TEXT.test(text)) method = 'detail_text';
    else if (DETAIL_HREF.test(u.pathname + u.search) && text.length >= 6) method = 'href_shape';
    else if (EVENT_CONTEXT.test(text) && text.length >= 6 && text.length <= 400) method = 'event_context';
    if (!method) continue;
    seen.add(key); out.push({ url: key, text: text.slice(0, 160), method });
  }
  return out;
}

// fraction of the candidate name's words present in a link text / card text
export function containsScore(text: string | null, name: string | null | undefined): number {
  const norm = (s: string | null | undefined) => (s || '').toLowerCase().replace(/[^֐-׿a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const wn = [...new Set(norm(name).split(' ').filter((w) => w.length > 1))];
  if (!wn.length) return 0;
  const wt = new Set(norm(text).split(' ').filter((w) => w.length > 1));
  return wn.filter((w) => wt.has(w)).length / wn.length;
}

// the detail link that belongs to this candidate, with the evidence behind the association: the
// extractor's own registration/detail URL when it is a same-host detail-shaped page, else the discovered
// link whose text (>= 0.7 of the name's words) or decoded URL slug names the event.
export function detailLinkFor(links: DetailLink[], name: string | null, registrationUrl?: string | null, allowedHosts?: Set<string>): DetailMatch | null {
  if (registrationUrl) {
    try { const u = new URL(registrationUrl); const host = u.hostname.replace(/^www\./, ''); if ((!allowedHosts || allowedHosts.has(host)) && DETAIL_HREF.test(u.pathname + u.search) && !isListingShapedUrl(registrationUrl)) return { url: registrationUrl.split('#')[0], text: 'registration_url', method: 'registration_url', score: 1 }; } catch { /* not a url */ }
  }
  // link text, else the decoded URL slug ("/events/מופע-סלונים-.../" - image-only card anchors have no text)
  let best: DetailMatch | null = null;
  for (const l of links) {
    let slug = ''; try { const u = new URL(l.url); slug = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '').replace(/[-_+]/g, ' '); } catch { /* none */ }
    const st = containsScore(l.text, name), ss = containsScore(slug, name);
    const s = Math.max(st, ss);
    if (s >= 0.7 && (!best || s > best.score)) best = { url: l.url, text: l.text, score: s, method: l.method === 'adapter_rule' ? 'adapter_rule' : (st >= ss ? 'card_text' : 'slug') };
  }
  return best;
}

// links claimed by more than one differently-named candidate are shared pages, not detail pages
export function sharedLinkUrls(claims: { url: string; name: string }[]): Set<string> {
  const names = new Map<string, Set<string>>();
  for (const c of claims) { const key = (c.name || '').toLowerCase().replace(/\s+/g, ' ').trim(); if (!names.has(c.url)) names.set(c.url, new Set()); names.get(c.url)!.add(key); }
  return new Set([...names.entries()].filter(([, s]) => s.size > 1).map(([u]) => u));
}
