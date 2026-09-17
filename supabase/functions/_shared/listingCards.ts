// TuRu - THE MONSTER: deterministic CARD ENUMERATION for dense listing pages (wave 2, recall).
// A listing that renders N repeated cards is enumerated from the DOM - no AI involved - so the scanner
// knows how many credible cards exist BEFORE extraction (recall becomes measurable: cards detected ->
// submitted -> extracted -> unaccounted) and can hand the extractor whole cards in small windows
// instead of one flattened page text (a 32-card page returned 15-25 events per call, 2026-09-14/17).
// Generic: repeated sibling-like elements with the same tag+class signature, each carrying a link and
// real text. No per-site selectors; a page without a repeated structure returns [] and the scanner
// keeps its text-window path unchanged.
export interface ListingCard { title: string; text: string; url: string | null; image: string | null; signature: string }

const MIN_GROUP = 5; // fewer repeats than this is not a "dense listing"
const MIN_TEXT = 12, MAX_TEXT = 1500;

const clean = (s: string) => (s || '').replace(/[ \t\r\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();
function absolute(href: string | undefined, baseUrl: string): string | null {
  if (!href || /^(javascript:|mailto:|tel:|#)/i.test(href.trim())) return null;
  try { return new URL(href, baseUrl).toString().split('#')[0]; } catch { return null; }
}

// deno-lint-ignore no-explicit-any
function signatureOf($: any, el: any): string {
  const cls = String($(el).attr('class') || '').split(/\s+/).filter(Boolean).map((c: string) => c.replace(/\d+/g, '#')).filter((c: string) => !/^(wow|animated|active|first|last|odd|even|pulse|fade\w*|slick-\w+|swiper-slide-\w+)$/.test(c)).slice(0, 4).sort().join('.');
  return `${el.tagName}|${cls}`;
}

// block-aware text of one card: children on separate lines so "date / title / venue" stay distinct
// deno-lint-ignore no-explicit-any
function cardText($: any, el: any): string {
  const clone = $(el).clone();
  clone.find('script, style, noscript, svg, button, input, select').remove();
  clone.find('br').replaceWith('\n');
  // inline siblings (<span>title</span><span>subtitle</span>) must not glue into one word
  clone.find('span, a, b, strong, em, i, small, label').each((_: number, n: unknown) => { $(n).append(' '); });
  clone.find('div, p, li, h1, h2, h3, h4, h5, h6, span.date, time, tr').each((_: number, n: unknown) => { $(n).append('\n'); });
  return clean(clone.text());
}

// deno-lint-ignore no-explicit-any
export function enumerateListingCards($: any, baseUrl: string, opts: { minGroup?: number } = {}): ListingCard[] {
  const minGroup = opts.minGroup ?? MIN_GROUP;
  // deno-lint-ignore no-explicit-any
  const groups = new Map<string, any[]>();
  // CPU guard (edge runtime): candidates are collected bottom-up from the page's anchors (<= 600) and
  // at most 4 ancestors each - never a walk over every <div> of a heavy page; an element holding many
  // links is a container, not a card, and its text is never computed.
  const ALLOWED = new Set(['a', 'article', 'li', 'div', 'section', 'tr']);
  // deno-lint-ignore no-explicit-any
  const cand = new Set<any>();
  $('body a[href]').slice(0, 600).each((_: number, el: unknown) => {
    // deno-lint-ignore no-explicit-any
    let n = el as any;
    for (let up = 0; up < 5 && n && n.tagName && n.tagName !== 'body'; up++) { if (ALLOWED.has(n.tagName)) cand.add(n); n = n.parent; }
  });
  for (const node of cand) {
    const $el = $(node);
    if (node.tagName !== 'a' && $el.find('a[href]').length > 8) continue; // container
    if (node.tagName === 'a' && !$el.attr('href')) continue;
    if ($el.closest('nav, header, footer, [role="navigation"], [class*="menu"], [class*="breadcrumb"]').length) continue;
    const cls = String($el.attr('class') || ''); if (!cls && node.tagName !== 'article' && node.tagName !== 'li') continue; // an unclassed div/a is layout, not a card
    const len = clean($el.text()).length; if (len < MIN_TEXT || len > MAX_TEXT) continue;
    const sig = signatureOf($, node);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig)!.push(node);
  }
  // deno-lint-ignore no-explicit-any
  let best: { sig: string; nodes: any[]; score: number } | null = null;
  for (const [sig, nodes] of groups) {
    if (nodes.length < minGroup) continue;
    // members must not contain each other (that is nesting, not repetition)
    // deno-lint-ignore no-explicit-any
    const flat = nodes.filter((n: any) => !nodes.some((m: any) => m !== n && $(m).find(n).length));
    if (flat.length < minGroup) continue;
    // deno-lint-ignore no-explicit-any
    const texts = flat.map((n: any) => clean($(n).text()));
    const distinct = new Set(texts).size; if (distinct < flat.length * 0.7) continue; // repeated boilerplate (share buttons, "read more")
    const avg = texts.reduce((s: number, t: string) => s + t.length, 0) / texts.length; if (avg < 25) continue;
    // deno-lint-ignore no-explicit-any
    const withOwnLink = flat.filter((n: any) => absolute(n.tagName === 'a' ? $(n).attr('href') : $(n).find('a[href]').first().attr('href'), baseUrl)).length;
    if (withOwnLink < flat.length * 0.7) continue;
    // prefer the OUTERMOST repeated structure with the richest text: count x min(avg,400)
    const score = flat.length * Math.min(avg, 400);
    if (!best || score > best.score) best = { sig, nodes: flat, score };
  }
  if (!best) return [];
  const seen = new Set<string>(); const cards: ListingCard[] = [];
  for (const node of best.nodes) {
    const $el = $(node);
    const text = cardText($, node);
    // title: the card's own heading (block-aware, first line) > aria-label > the longest real anchor text >
    // first text line. Class-name guesses ("name"/"title") are NOT used: on venue sites they hold the venue.
    const headingEl = $el.find('h1, h2, h3, h4, h5, h6').first();
    const heading = headingEl.length ? cardText($, headingEl.get(0)).split('\n')[0] : '';
    const aria = clean($el.attr('aria-label') || $el.attr('title') || $el.find('a[aria-label]').first().attr('aria-label') || '');
    // deno-lint-ignore no-explicit-any
    const anchorText = $el.find('a').toArray().map((a: any) => cardText($, a).split('\n')[0]).filter((t: string) => t.length >= 4 && !/^(לפרטים|פרטים נוספים|להרשמה|לרכישה|כרטיסים|קרא עוד|read more|more)$/i.test(t)).sort((a: string, b: string) => b.length - a.length)[0] || '';
    const notDate = (l: string) => l.length >= 4 && !/^\d{1,2}(\s|[./-])/.test(l) && !/^\d/.test(l.replace(/\s/g, '').slice(0, 2));
    const title = ([heading, aria, anchorText].find((t) => t && notDate(t)) || text.split('\n').find(notDate) || heading || aria || anchorText || '').slice(0, 160);
    if (!title) continue;
    const url = absolute(node.tagName === 'a' ? $el.attr('href') : $el.find('a[href]').first().attr('href'), baseUrl);
    const key = `${title}|${url || ''}|${text.slice(0, 80)}`; if (seen.has(key)) continue; seen.add(key);
    const img = $el.find('img').first();
    const image = absolute(img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src'), baseUrl);
    cards.push({ title, text, url, image, signature: best.sig });
  }
  const freq = new Map<string, number>(); for (const c of cards) freq.set(c.title, (freq.get(c.title) || 0) + 1);
  for (const c of cards) { if ((freq.get(c.title) || 0) > Math.max(2, cards.length * 0.3)) { const alt = c.text.split('\n').find((l) => l.length >= 4 && (freq.get(l) || 0) <= 1 && l !== c.title && !/^\d/.test(l)); if (alt) c.title = alt.slice(0, 160); } }
  return cards;
}

// Recovery is only worth an AI call on EVENT-like cards (a date or a time on most of them); a repeated
// block of municipal service tiles is measured but never re-extracted.
const DATEISH = /\d{1,2}[./]\d{1,2}|\d{1,2}:\d{2}|ינואר|פברואר|מרץ|מרס|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר/;
export function cardsLookLikeEvents(cards: ListingCard[]): boolean {
  if (cards.length < 5) return false;
  return cards.filter((c) => DATEISH.test(c.text)).length >= cards.length * 0.5;
}

// Whole cards packed into extraction windows: a card is never split, every card is delimited and
// numbered, and a window holds at most `perWindow` cards - the model answers for a short explicit list.
export function cardWindows(cards: ListingCard[], charLimit: number, perWindow = 12): string[] {
  const windows: string[] = []; let cur: string[] = []; let len = 0;
  const flush = () => { if (cur.length) { windows.push(`בקטע זה ${cur.length} כרטיסי אירוע/פעילות נפרדים מתוך דף רשימה. החזר פריט נפרד עבור כל כרטיס שהוא פעילות או אירוע (אל תדלג על כרטיסים ואל תאחד כרטיסים שונים).\n\n${cur.join('\n\n')}`); cur = []; len = 0; } };
  cards.forEach((c, i) => {
    const block = `### כרטיס ${i + 1}\n${c.text}${c.url ? `\nקישור: ${c.url}` : ''}`;
    if (cur.length >= perWindow || (len + block.length > charLimit - 300 && cur.length)) flush();
    cur.push(block); len += block.length + 2;
  });
  flush();
  return windows;
}

// funnel accounting: which cards did the extractor account for (name overlap with the card title/text)
const norm = (s: string) => (s || '').toLowerCase().replace(/[^֐-׿a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
export function cardAccounting(cards: ListingCard[], extractedNames: string[]): { matched: number; unaccounted: string[]; unaccountedCards: ListingCard[] } {
  const unaccounted: string[] = []; const unaccountedCards: ListingCard[] = []; let matched = 0;
  for (const c of cards) {
    const T = new Set(norm(c.title).split(' ').filter((w) => w.length > 1));
    const hit = extractedNames.some((n) => { const N = new Set(norm(n).split(' ').filter((w) => w.length > 1)); if (!N.size || !T.size) return false; let k = 0; N.forEach((w) => { if (T.has(w)) k++; }); return k / Math.min(N.size, T.size) >= 0.6; });
    if (hit) matched++; else { unaccounted.push(c.title.slice(0, 80)); unaccountedCards.push(c); }
  }
  return { matched, unaccounted, unaccountedCards };
}
