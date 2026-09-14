// TuRu - bounded detail-link discovery for THE MONSTER (scan-source). Deno twin of
// tools/import-tool/lib/pageExtract.js findEventDetailLinks - keep in lockstep. A listing page often
// carries only a title/date; the address, JSON-LD, image, price and ages live on the event's own page.
// Selective by design: a link counts only with explicit "details" text, an event-detail URL shape, or
// event context (a date/time in its card); navigation and alternate-language sections never count.

const DETAIL_TEXT = /פרטים נוספים|מידע נוסף|לפרטים|קרא עוד|קראו עוד|להזמנת כרטיסים|לרכישת כרטיסים|לפרטים והרשמה|read more|more info/i;
const DETAIL_HREF = /\/event(s)?\/(?!calendar|category|page|\?|#)[^/?#]+|\/activity\/|\/show\/|\/item\/|[?&](?:event|item|eventid|activityid)=\d+/i;
const EVENT_CONTEXT = /\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b|\b\d{1,2}:\d{2}\b|בשעה|יום (?:ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)|בתאריך/;
const NAV_TEXT = /מכרז|צור קשר|אודות|דבר ראש|הנהלה|תנאי שימוש|נגישות|מפת האתר|כניסה|התחברות|חיפוש|עמוד הבית|דף הבית|הצטרפו|ניוזלטר|תשלומים|טפסים/;
const LANG_SECTION = /^\/(ru|en|ar|fr|es|de|uk)(\/|$)/i;

export interface DetailTraversalConfig { max_pages?: number; allow_hosts?: string[] }
export interface DetailLink { url: string; text: string }

// deno-lint-ignore no-explicit-any
export function findEventDetailLinks($: any, baseUrl: string, opts: { max?: number; allowHosts?: string[] } = {}): DetailLink[] {
  const max = opts.max ?? 20;
  const base = new URL(baseUrl);
  const norm = (h: string) => h.replace(/^www\./, '');
  const allowed = new Set([norm(base.hostname), ...(opts.allowHosts || []).map(norm)]);
  let resolveBase = base;
  const baseHref = $('base[href]').first().attr('href');
  if (baseHref) { try { resolveBase = new URL(baseHref, base); } catch { /* keep */ } }
  const baseLang = LANG_SECTION.test(base.pathname);
  const seen = new Set<string>([baseUrl.split('#')[0]]); const out: DetailLink[] = [];
  $('a[href]').each((_: number, el: unknown) => {
    if (out.length >= max) return false;
    const $el = $(el);
    const href = $el.attr('href'); if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;
    let u: URL; try { u = new URL(href, resolveBase); } catch { return; }
    if (!['http:', 'https:'].includes(u.protocol) || !allowed.has(norm(u.hostname))) return;
    if (!baseLang && LANG_SECTION.test(u.pathname)) return;
    u.hash = ''; const key = u.toString(); if (seen.has(key)) return;
    const text = ($el.text() || '').replace(/\s+/g, ' ').trim();
    if (NAV_TEXT.test(text) || $el.closest('nav, header, footer, .menu, .nav, .breadcrumb, .footer, .header').length) return;
    const card = $el.closest('article, li, .event, .card, .item, .post, [class*="event"], [class*="card"]');
    const cardText = card.length ? (card.text() || '').replace(/\s+/g, ' ').trim().slice(0, 600) : '';
    const eventContext = EVENT_CONTEXT.test(cardText) || EVENT_CONTEXT.test(text);
    const ok = DETAIL_TEXT.test(text) || (DETAIL_HREF.test(u.pathname + u.search) && (eventContext || text.length >= 6)) || (eventContext && text.length >= 6 && text.length <= 120);
    if (!ok) return;
    seen.add(key); out.push({ url: key, text: text.slice(0, 120) });
  });
  return out;
}

// DOM-free variant for heavy pages (the scanner skips cheerio above HEAVY_HTML_BYTES): anchors by regex,
// the same text/href/context rules, context = the 600 chars around the anchor.
export function findEventDetailLinksCheap(html: string, baseUrl: string, opts: { max?: number; allowHosts?: string[]; maxAnchors?: number } = {}): DetailLink[] {
  const max = opts.max ?? 20;
  const base = new URL(baseUrl);
  const norm = (h: string) => h.replace(/^www\./, '');
  const allowed = new Set([norm(base.hostname), ...(opts.allowHosts || []).map(norm)]);
  const baseHrefM = /<base[^>]+href=["']([^"']+)["']/i.exec(html);
  let resolveBase = base; if (baseHrefM) { try { resolveBase = new URL(baseHrefM[1], base); } catch { /* keep */ } }
  const baseLang = LANG_SECTION.test(base.pathname);
  const seen = new Set<string>([baseUrl.split('#')[0]]); const out: DetailLink[] = [];
  const strip = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  let n = 0;
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi)) {
    if (++n > (opts.maxAnchors ?? 600) || out.length >= max) break;
    const href = m[1]; if (/^(mailto|tel|javascript):/i.test(href)) continue;
    let u: URL; try { u = new URL(href, resolveBase); } catch { continue; }
    if (!['http:', 'https:'].includes(u.protocol) || !allowed.has(norm(u.hostname))) continue;
    if (!baseLang && LANG_SECTION.test(u.pathname)) continue;
    u.hash = ''; const key = u.toString(); if (seen.has(key)) continue;
    if (u.pathname.replace(/\/$/, '') === base.pathname.replace(/\/$/, '')) continue; // the listing itself with a query (filters, pages)
    const text = strip(m[2]);
    if (NAV_TEXT.test(text)) continue;
    // without a DOM there is no "card": only the anchor's own text/href carry evidence (a window of
    // surrounding text bleeds the neighbouring card's date onto filter links)
    const ok = DETAIL_TEXT.test(text) || (DETAIL_HREF.test(u.pathname + u.search) && text.length >= 6) || (EVENT_CONTEXT.test(text) && text.length >= 6 && text.length <= 120);
    if (!ok) continue;
    seen.add(key); out.push({ url: key, text: text.slice(0, 120) });
  }
  return out;
}

// fraction of the candidate name's words present in a link text / card text
export function containsScore(text: string | null, name: string | null): number {
  const norm = (s: string | null) => (s || '').toLowerCase().replace(/[^֐-׿a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const wn = [...new Set(norm(name).split(' ').filter((w) => w.length > 1))];
  if (!wn.length) return 0;
  const wt = new Set(norm(text).split(' ').filter((w) => w.length > 1));
  return wn.filter((w) => wt.has(w)).length / wn.length;
}

// the detail link that belongs to this candidate: the extractor's own registration/detail URL when it
// is a same-host detail page, else the discovered link whose text names the event (>= 0.7 of its words)
export function detailLinkFor(links: DetailLink[], name: string | null, registrationUrl?: string | null, allowedHosts?: Set<string>): DetailLink | null {
  if (registrationUrl) {
    try { const u = new URL(registrationUrl); const host = u.hostname.replace(/^www\./, ''); if ((!allowedHosts || allowedHosts.has(host)) && DETAIL_HREF.test(u.pathname + u.search)) return { url: registrationUrl.split('#')[0], text: 'registration_url' }; } catch { /* not a url */ }
  }
  // link text, else the decoded URL slug ("/events/מופע-סלונים-.../" - image-only card anchors have no text)
  let best: DetailLink | null = null, bestScore = 0;
  for (const l of links) {
    let slug = ''; try { const u = new URL(l.url); slug = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '').replace(/[-_+]/g, ' '); } catch { /* none */ }
    const s = Math.max(containsScore(l.text, name), containsScore(slug, name));
    if (s > bestScore && s >= 0.7) { best = l; bestScore = s; }
  }
  return best;
}
