// TuRu - shared page-evidence extraction for THE MONSTER (relay-scan.js) and THE CLEANER
// (cleaner/*). Pure functions over fetched HTML - no network, no DB - so both systems parse pages
// the same way: JSON-LD (Event / Place / Organization / LocalBusiness with PostalAddress +
// GeoCoordinates), OpenGraph / Twitter images, embedded Google-Maps / Waze links, Hebrew street
// address text, the page's own images, the listing card that names one event (+ its detail link),
// and bounded detail-link discovery ("פרטים נוספים" / title links / booking links).
// The Deno twin of the JSON-LD subset is supabase/functions/_shared/jsonld.ts - keep in lockstep.
const cheerio = require('cheerio');

function safeJson(text) { try { return JSON.parse(text); } catch { return null; } }

function flattenJsonLd(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) { node.forEach((n) => flattenJsonLd(n, out)); return out; }
  if (typeof node !== 'object') return out;
  out.push(node);
  if (node['@graph']) flattenJsonLd(node['@graph'], out);
  return out;
}

const typeOf = (n) => (Array.isArray(n?.['@type']) ? n['@type'] : [n?.['@type']]).filter(Boolean).map(String);
const str = (v) => (typeof v === 'string' ? v.trim() : (v && typeof v === 'object' && typeof v.name === 'string') ? v.name.trim() : null);

function addressOf(node) {
  const a = node?.address;
  if (!a) return null;
  if (typeof a === 'string') return { text: a.trim(), street: null, city: null };
  const street = str(a.streetAddress), city = str(a.addressLocality);
  const text = [street, city].filter(Boolean).join(', ') || str(a) || null;
  return text ? { text, street, city } : null;
}
function geoOf(node) {
  const g = node?.geo; if (!g) return null;
  const lat = Number(g.latitude), lng = Number(g.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}
function imageOf(node) {
  const im = node?.image; if (!im) return [];
  const list = Array.isArray(im) ? im : [im];
  return list.map((x) => (typeof x === 'string' ? x : x?.url || x?.contentUrl)).filter((u) => typeof u === 'string');
}

// -> { events: [{name, startDate, endDate, location:{name,address,geo}, images, url}], places: [{name,address,geo,type}], images: [] }
function extractJsonLd(html) {
  const $ = cheerio.load(html);
  const nodes = [];
  $('script[type="application/ld+json"]').each((_, el) => { const j = safeJson($(el).text()); if (j) flattenJsonLd(j, nodes); });
  const events = [], places = [];
  for (const n of nodes) {
    const types = typeOf(n);
    if (types.some((t) => /Event$/.test(t))) {
      const loc = n.location && typeof n.location === 'object' ? (Array.isArray(n.location) ? n.location[0] : n.location) : null;
      events.push({ name: str(n.name), types, startDate: n.startDate || null, endDate: n.endDate || null, images: imageOf(n), url: n.url || null,
        location: loc ? { name: str(loc.name), address: addressOf(loc), geo: geoOf(loc) } : null });
    }
    if (types.some((t) => /Place|LocalBusiness|Organization|Museum|Library|Park|Store|ShoppingCenter|TouristAttraction|CivicStructure|Theater|MovieTheater|EventVenue/.test(t))) {
      const addr = addressOf(n), geo = geoOf(n);
      if (addr || geo) places.push({ name: str(n.name), address: addr, geo, type: types[0] });
    }
  }
  return { events, places, images: [...new Set(nodes.flatMap(imageOf))] };
}

function extractMetaImages(html) {
  const $ = cheerio.load(html);
  const pick = (sel) => $(sel).map((_, el) => $(el).attr('content')).get().filter(Boolean);
  return [...new Set([...pick('meta[property="og:image"]'), ...pick('meta[property="og:image:secure_url"]'), ...pick('meta[name="twitter:image"]'), ...pick('meta[name="twitter:image:src"]')])];
}

// Google Maps links: /@lat,lng or ?q=lat,lng or ?q=<place text> or /place/<text>/@lat,lng ; also waze
function extractMapLinks(html) {
  const out = [];
  const re = /https?:\/\/(?:www\.)?(?:google\.[a-z.]+\/maps[^"'\s<)]*|maps\.google\.[a-z.]+[^"'\s<)]*|goo\.gl\/maps\/[^"'\s<)]*|maps\.app\.goo\.gl\/[^"'\s<)]*|waze\.com\/[^"'\s<)]*|ul\.waze\.com\/[^"'\s<)]*)/gi;
  for (const m of html.matchAll(re)) {
    const url = m[0].replace(/&amp;/g, '&');
    const at = /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/.exec(url);
    const q = /[?&](?:q|query|ll|destination)=(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/.exec(url);
    const coords = at ? { lat: Number(at[1]), lng: Number(at[2]) } : q ? { lat: Number(q[1]), lng: Number(q[2]) } : null;
    let query = null;
    const qt = /[?&](?:q|query|destination)=([^&]+)/.exec(url); if (qt && !q) { try { query = decodeURIComponent(qt[1].replace(/\+/g, ' ')); } catch { query = qt[1]; } }
    const pl = /\/place\/([^/@?]+)/.exec(url); if (pl && !query) { try { query = decodeURIComponent(pl[1].replace(/\+/g, ' ')); } catch { query = pl[1]; } }
    if (coords && !inIsrael(coords)) continue;
    out.push({ url, coords, query });
  }
  return dedupeBy(out, (x) => x.url);
}

function inIsrael({ lat, lng }) { return lat >= 29.3 && lat <= 33.4 && lng >= 34.2 && lng <= 35.95; }

// Hebrew street address patterns: "רחוב X 12, עיר" / "X 12 עיר" / "שד' X 5" / "כיכר X" ; returns candidates with the text
const STREET_WORDS = '(?:רחוב|רח\'|רח׳|שדרות|שד\'|שד׳|דרך|כיכר|סמטת|שביל|מתחם|בית)';
function extractAddressTexts(text, { city } = {}) {
  const out = [];
  const t = (text || '').replace(/\s+/g, ' ');
  const re = new RegExp(`${STREET_WORDS}\\s+([\\u0590-\\u05FF"'׳״\\-\\s]{2,40}?)\\s+(\\d{1,4})(?:\\s*[,\\-–]\\s*|\\s+)([\\u0590-\\u05FF\\s\\-]{2,30}?)(?=[.,;)\\n]|\\s{2,}|$|\\s(?:טל|טלפון|מיקוד|ישראל|קומה|בניין|כניסה))`, 'g');
  for (const m of t.matchAll(re)) {
    const street = m[1].trim(), number = m[2], tail = m[3].trim();
    const cityGuess = tail.split(' ').slice(0, 3).join(' ');
    out.push({ text: `${m[0].split(/\s+/)[0]} ${street} ${number}, ${cityGuess}`.trim(), street, number, city: cityGuess });
  }
  // also bare "<street> <number>, <known city>" when the city is known
  if (city) {
    const re2 = new RegExp(`([\\u0590-\\u05FF"'׳״\\-]{2,25}(?:\\s[\\u0590-\\u05FF"'׳״\\-]{2,25}){0,3})\\s+(\\d{1,4})\\s*,\\s*(${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'g');
    for (const m of t.matchAll(re2)) out.push({ text: `${m[1].trim()} ${m[2]}, ${m[3]}`, street: m[1].trim(), number: m[2], city: m[3] });
  }
  return dedupeBy(out, (x) => x.text).slice(0, 10);
}

function pageText(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, input, select, textarea, button').remove();
  return $('body').text().replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

function extractPageImages(html, baseUrl) {
  const $ = cheerio.load(html);
  const out = [];
  $('img[src], img[data-src], source[srcset]').each((_, el) => {
    const $el = $(el);
    const raw = $el.attr('src') || $el.attr('data-src') || ($el.attr('srcset') || '').split(',')[0].trim().split(' ')[0];
    if (!raw || raw.startsWith('data:')) return;
    let abs; try { abs = new URL(raw, baseUrl).toString(); } catch { return; }
    if (/logo|sprite|icon|favicon|placeholder|pixel\.gif|\.svg|banner-ad|advert/i.test(abs)) return;
    const w = Number($el.attr('width') || 0), h = Number($el.attr('height') || 0);
    if ((w && w < 120) || (h && h < 120)) return;
    out.push({ url: abs, alt: ($el.attr('alt') || '').trim(), context: ($el.closest('article, figure, li, div, section').text() || '').replace(/\s+/g, ' ').trim().slice(0, 200) });
  });
  return dedupeBy(out, (x) => x.url).slice(0, 40);
}

// fraction of the event name's words that appear in a text (a long card text must not dilute it)
function containsScore(text, name) {
  const norm = (s) => (s || '').toLowerCase().replace(/[^֐-׿a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const wn = [...new Set(norm(name).split(' ').filter((w) => w.length > 1))];
  if (!wn.length) return 0;
  const wt = new Set(norm(text).split(' ').filter((w) => w.length > 1));
  return wn.filter((w) => wt.has(w)).length / wn.length;
}

function resolveBaseHref($, baseUrl) {
  const baseHref = $('base[href]').first().attr('href');
  if (baseHref) { try { return new URL(baseHref, baseUrl).toString(); } catch { /* keep */ } }
  return baseUrl;
}
function abs(u, base) { try { return new URL(u, base).toString(); } catch { return null; } }

// The card on a listing page that names THIS event: its images + the link to its detail page
// (any host - municipal calendars link to matnas / ticketing sites). Also reports how many other
// cards on the page reuse the same image (a shared image is a site/organizer image, not the event's).
function findEventCard(html, baseUrl, name) {
  const $ = cheerio.load(html);
  baseUrl = resolveBaseHref($, baseUrl);
  let best = null, bestScore = 0;
  $('a[href], h1, h2, h3, h4, .title, .name').each((_, el) => {
    const own = ($(el).text() || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const s = containsScore(own, name);
    if (s > bestScore && s >= 0.8) { bestScore = s; best = $(el); }
  });
  if (!best) return { detailUrl: null, images: [], score: 0, sharedImages: [] };
  // the card = the smallest ancestor that also holds an image or a link (up to 4 levels)
  let card = best; for (let i = 0; i < 4; i++) { if (card.find('img').length) break; if (!card.parent().length || card.parent().is('body, html')) break; card = card.parent(); }
  const images = []; const push = (u) => { const a = abs(u, baseUrl); if (a && !/logo|icon|sprite|placeholder|\.svg/i.test(a) && !images.includes(a)) images.push(a); };
  card.find('img[src], img[data-src]').each((_, im) => push($(im).attr('src') || $(im).attr('data-src')));
  if (card.is('a')) { const bg = /url\(["']?([^"')]+)/.exec(card.attr('style') || ''); if (bg) push(bg[1]); }
  let detailUrl = null;
  const links = (best.is('a') ? [best] : []).concat(card.is('a') ? [card] : [], card.find('a[href]').toArray().map((a) => $(a)));
  for (const a of links) { const href = a.attr('href'); if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue; const u = abs(href, baseUrl); if (u && u.split('#')[0] !== baseUrl.split('#')[0]) { detailUrl = u; break; } }
  // image reuse across the page: count <img> occurrences of each card image outside the card
  const sharedImages = [];
  for (const u of images) {
    let n = 0;
    $('img[src], img[data-src]').each((_, im) => { const a = abs($(im).attr('src') || $(im).attr('data-src'), baseUrl); if (a === u) n++; });
    if (n > 1) sharedImages.push(u);
  }
  return { detailUrl, images: images.slice(0, 3), score: bestScore, sharedImages };
}

// Bounded detail-link discovery for a listing page: links whose text/href say "more details",
// event title links, booking links, and card links. Same host by default; `allowHosts` extends it
// (ticketing hosts a municipality links to). Returns at most `max` absolute URLs, listing order.
const DETAIL_TEXT = /פרטים נוספים|מידע נוסף|לפרטים|קרא עוד|קראו עוד|להזמנת כרטיסים|לרכישת כרטיסים|לפרטים והרשמה|read more|more info/i;
const DETAIL_HREF = /\/event(s)?\/(?!calendar|category|page|\?|#)[^/?#]+|\/activity\/|\/show\/|\/item\/|[?&](?:event|item|eventid|activityid)=\d+/i;
// an event card carries a date/time; site navigation ("מכרזים", "צור קשר", "דבר ראש העיר") does not
const EVENT_CONTEXT = /\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b|\b\d{1,2}:\d{2}\b|בשעה|יום (?:ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)|בתאריך|ב(?:ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)/;
const NAV_TEXT = /מכרז|הליך איתור|צור קשר|צרו קשר|אודות|דבר ראש|הנהלה|תנאי שימוש|תקנון|נגישות|הצהרת נגישות|מפת האתר|כניסה|התחברות|הרשמה לאתר|חיפוש|עמוד הבית|דף הבית|הצטרפו|ניוזלטר|תשלומים|טפסים|מדיניות פרטיות|שוברים|סל הקניות|עגלה/;
// alternate-language / mirrored sections of a site ("/ru/events/...", "/en/...") are the same events
// again - never traverse into them from a Hebrew listing
const LANG_SECTION = /^\/(ru|en|ar|fr|es|de|uk)(\/|$)/i;
const { isListingShapedUrl } = require('./eventIdentity');
// the anchor's aria-label / title attributes are part of its text (whole-card anchors with an image and
// no visible text still name the event that way); listing-shaped URLs (category / paginated / search /
// host root) are never an event's page. Mirror of _shared/detailLinks.ts findEventDetailLinks.
function findEventDetailLinks(html, baseUrl, { max = 20, allowHosts = [], sameSection = true, linkSelector = null, urlPattern = null, listingUrls = [] } = {}) {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const resolveBase = resolveBaseHref($, baseUrl);
  const norm = (h) => h.replace(/^www\./, '');
  const allowed = new Set([norm(base.hostname), ...allowHosts.map(norm)]);
  const baseLang = LANG_SECTION.test(base.pathname);
  let pattern = null; if (urlPattern) { try { pattern = new RegExp(urlPattern, 'i'); } catch { pattern = null; } }
  const seen = new Set([baseUrl.split('#')[0]]); const out = [];
  $('a[href]').each((_, el) => {
    if (out.length >= max) return false;
    const $el = $(el);
    const href = $el.attr('href'); if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;
    let u; try { u = new URL(href, resolveBase); } catch { return; }
    if (!['http:', 'https:'].includes(u.protocol) || !allowed.has(norm(u.hostname))) return;
    if (sameSection && !baseLang && LANG_SECTION.test(u.pathname)) return;
    u.hash = ''; const key = u.toString(); if (seen.has(key)) return;
    if (isListingShapedUrl(key, { seedUrl: baseUrl, listingUrls })) return;
    const text = [$el.text() || '', $el.attr('aria-label') || '', $el.attr('title') || ''].join(' ').replace(/\s+/g, ' ').trim();
    if (NAV_TEXT.test(text) || $el.closest('nav, header, footer, .menu, .nav, .breadcrumb, .footer, .header').length) return;
    const card = $el.closest('article, li, .event, .card, .item, .post, .show, [class*="event"], [class*="card"], [class*="show"]');
    const cardText = card.length ? (card.text() || '').replace(/\s+/g, ' ').trim().slice(0, 600) : '';
    const eventContext = EVENT_CONTEXT.test(cardText) || EVENT_CONTEXT.test(text);
    let method = null;
    if (linkSelector && (() => { try { return $el.is(linkSelector); } catch { return false; } })()) method = 'adapter_rule';
    else if (pattern && pattern.test(u.pathname + u.search)) method = 'adapter_rule';
    else if (DETAIL_TEXT.test(text)) method = 'detail_text';
    else if (DETAIL_HREF.test(u.pathname + u.search) && (eventContext || text.length >= 6)) method = 'href_shape';
    else if (eventContext && text.length >= 6 && text.length <= 400) method = 'event_context';
    if (!method) return;
    seen.add(key); out.push({ url: key, text: text.slice(0, 160), method });
  });
  return out;
}

function dedupeBy(arr, key) { const seen = new Set(); return arr.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); }

// ---- Node twins of supabase/functions/_shared/detailEvidence.ts (keep in lockstep; tests/pageExtract.test.js) ----
// OCCURRENCES: only the specific Hebrew textual form (month name + 4-digit year, optional weekday) may
// produce dated performances; loose dd.mm never does. Each occurrence keeps its own time and, when the
// anchor that carries it has a booking shape (?id=NNN / booking verb), its purchase link + provider id.
const HEBREW_MONTHS = { 'ינואר': 1, 'פברואר': 2, 'מרץ': 3, 'מרס': 3, 'אפריל': 4, 'מאי': 5, 'יוני': 6, 'יולי': 7, 'אוגוסט': 8, 'ספטמבר': 9, 'אוקטובר': 10, 'נובמבר': 11, 'דצמבר': 12 };
const WEEKDAYS = 'ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת';
const TEXTUAL_DATE_RE = new RegExp(`(?:ב?יום\\s+(?:${WEEKDAYS})\\s*,?\\s*)?(\\d{1,2})\\s+ב?(${Object.keys(HEBREW_MONTHS).join('|')})\\s+(\\d{4})`, 'g');
const AT_TIME_RE = /(?:בשעה|בשעות|שעה)\s*(\d{1,2}:\d{2})(?:\s*(?:[-–]|עד)\s*(\d{1,2}:\d{2}))?/;
const BOOKING_HREF = /[?&](?:id|eventid|event_id|showid|show_id|performance|perf|occurrence|ticket)=([\w-]+)/i;
const BOOKING_TEXT = /רכישה|לרכישה|לרכישת כרטיסים|להזמנה|הזמנה|הזמנת כרטיסים|הרשמה|להרשמה|כרטיסים|קנה כרטיס|קנו כרטיסים|\b(?:buy|tickets?|register|book now)\b/i;
const MAX_OCCURRENCES = 40, MAX_DAYS_AHEAD = 365;
const plainText = (html) => (html || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const padTime = (t) => { const [h, m] = t.split(':'); return `${h.padStart(2, '0')}:${m}`; };
function withinAhead(iso, today) { const d = new Date(iso + 'T00:00:00Z').getTime(), t = new Date(today + 'T00:00:00Z').getTime(); return !Number.isNaN(d) && d >= t && d - t <= MAX_DAYS_AHEAD * 86400000; }

function textualOccurrences(text, today) {
  const out = [];
  for (const m of (text || '').matchAll(TEXTUAL_DATE_RE)) {
    const d = Number(m[1]), mo = HEBREW_MONTHS[m[2]], y = Number(m[3]);
    if (!mo || d < 1 || d > 31) continue;
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!withinAhead(iso, today)) continue;
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
    const t = AT_TIME_RE.exec(after);
    out.push({ date: iso, start_time: t ? padTime(t[1]) : null, end_time: t && t[2] ? padTime(t[2]) : null, evidence: (m[0] + (t ? ' ' + t[0] : '')).trim() });
    if (out.length >= MAX_OCCURRENCES * 3) break;
  }
  return out;
}
function anchorOccurrences(html, today, baseUrl) {
  const out = [];
  for (const m of (html || '').matchAll(/<a\b([^>]*)>([\s\S]{0,1500}?)<\/a>/gi)) {
    const attrs = m[1]; const inner = plainText(m[2]);
    const href = (/\shref=["']([^"']+)["']/i.exec(attrs) || [])[1] || '';
    const aria = (/\saria-label=["']([^"']+)["']/i.exec(attrs) || [])[1] || '';
    const title = (/\stitle=["']([^"']+)["']/i.exec(attrs) || [])[1] || '';
    const occ = textualOccurrences([aria, title, inner].filter(Boolean).join(' '), today);
    if (!occ.length) continue;
    let absUrl = null; if (href && !/^(#|mailto:|tel:|javascript:)/i.test(href)) { try { absUrl = new URL(href, baseUrl || undefined).toString(); } catch { absUrl = null; } }
    const bm = absUrl ? BOOKING_HREF.exec(absUrl) : null;
    const isBooking = !!absUrl && (!!bm || BOOKING_TEXT.test(inner) || BOOKING_TEXT.test(aria));
    for (const o of occ.slice(0, 3)) out.push({ ...o, external_id: bm ? bm[1] : null, booking_url: isBooking ? absUrl : null, evidence: (aria || o.evidence).slice(0, 120) });
    if (out.length >= MAX_OCCURRENCES * 3) break;
  }
  return out;
}
function extractOccurrences(html, today, baseUrl = null) {
  const text = plainText(html).slice(0, 12000);
  const byKey = new Map();
  const put = (o) => { const k = `${o.date}|${o.start_time || ''}`; const prev = byKey.get(k); if (!prev) { byKey.set(k, o); return; } if (!prev.booking_url && o.booking_url) prev.booking_url = o.booking_url; if (!prev.external_id && o.external_id) prev.external_id = o.external_id; if (!prev.end_time && o.end_time) prev.end_time = o.end_time; };
  for (const o of anchorOccurrences(html, today, baseUrl)) put(o);
  for (const o of textualOccurrences(text, today)) {
    if (o.start_time == null && [...byKey.keys()].some((k) => k.startsWith(o.date + '|') && !k.endsWith('|'))) continue;
    put({ ...o, external_id: null, booking_url: null });
  }
  return [...byKey.values()].sort((a, b) => (a.date + (a.start_time || '')).localeCompare(b.date + (b.start_time || ''))).slice(0, MAX_OCCURRENCES);
}

// PRICE with tiers: "free" only when no positive amount exists and the free phrase is not the adult tier
const AMOUNT_RE = /(?:(ילד(?:ים)?|לילד(?:ים)?|מבוגר(?:ים)?|למבוגר(?:ים)?|מלווה|למלווה|תושב(?:ים)?|לתושב(?:ים)?|מנוי(?:ים)?|למנויים|כרטיס|מחיר|החל מ[־-]?|עלות)\s*:?\s*)?(?:₪\s*(\d{1,4})|(\d{1,4})\s*(?:₪|ש"ח|ש״ח|שח\b|שקל(?:ים)?))/g;
const FREE_RE = /חינם|בחינם|כניסה חופשית|ללא תשלום|ללא עלות/g;
const ADULT_WORDS = /(מבוגר|למבוגר|מבוגרים|מלווה|למלווה|מלווים|הורה|להורה)/;
const TIER_LABELS = { 'ילד': 'ילד', 'ילדים': 'ילד', 'לילד': 'ילד', 'לילדים': 'ילד', 'מבוגר': 'מבוגר', 'מבוגרים': 'מבוגר', 'למבוגר': 'מבוגר', 'למבוגרים': 'מבוגר', 'מלווה': 'מבוגר', 'למלווה': 'מבוגר', 'תושב': 'תושב', 'תושבים': 'תושב', 'לתושב': 'תושב', 'לתושבים': 'תושב', 'מנוי': 'מנוי', 'מנויים': 'מנוי', 'למנויים': 'מנוי' };
function extractPriceTiers(text) {
  const window = (text || '').slice(0, 6000);
  const tiers = []; const evid = [];
  for (const m of window.matchAll(AMOUNT_RE)) {
    const amount = Number(m[2] || m[3]); if (!(amount > 0) || amount > 2000) continue;
    const rawLabel = (m[1] || '').replace(/[:\s]+$/, '').trim();
    const label = TIER_LABELS[rawLabel] || (rawLabel && /החל/.test(rawLabel) ? 'החל מ' : rawLabel || 'כרטיס');
    if (!tiers.some((t) => t.label === label && t.amount === amount)) { tiers.push({ label, amount }); evid.push(m[0].trim()); }
    if (tiers.length >= 8) break;
  }
  for (const m of window.matchAll(FREE_RE)) {
    const before = window.slice(Math.max(0, m.index - 14), m.index);
    if (ADULT_WORDS.test(before)) { if (!tiers.some((t) => t.label === 'מבוגר')) { tiers.push({ label: 'מבוגר', amount: 0 }); evid.push((before + m[0]).trim()); } }
    else if (!tiers.some((t) => t.label === 'חינם')) { tiers.push({ label: 'חינם', amount: 0 }); evid.push(m[0]); }
  }
  const positive = tiers.filter((t) => t.amount > 0);
  if (!positive.length) return tiers.some((t) => t.label === 'חינם') ? { price_type: 'free', price_amount: 0, tiers, evidence: evid.join(' | ') } : null;
  const child = positive.find((t) => t.label === 'ילד') || positive.find((t) => t.label === 'החל מ') || positive.reduce((a, b) => (b.amount < a.amount ? b : a));
  return { price_type: 'fixed', price_amount: child.amount, tiers, evidence: evid.join(' | ') };
}

// ADDRESS candidates: "רחוב X 12", or "<street words> 12[ א]" right before the known city
const isSinglePlace = (s) => !!s && s.trim().length <= 60 && (s.match(/,/g) || []).length <= 1;
function extractAddressCandidates(text, city) {
  const out = []; const t = (text || '').replace(/\s+/g, ' ');
  const a = new RegExp(`${STREET_WORDS}\\s+([\\u0590-\\u05FF"'׳״\\-\\s]{2,40}?)\\s+(\\d{1,4})(?:\\s?([א-ת])(?![\\u0590-\\u05FF]))?`, 'u').exec(t);
  if (a) out.push(`${a[1].trim()} ${a[2]}${a[3] ? ' ' + a[3] : ''}`);
  if (city) {
    const c = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s-]+');
    const re = new RegExp(`([\\u0590-\\u05FF"'׳״\\-]{2,25}(?:\\s[\\u0590-\\u05FF"'׳״\\-]{2,25}){0,2})\\s+(\\d{1,4})(?:\\s?([א-ת])(?![\\u0590-\\u05FF]))?(?:\\s*,\\s*|\\s+)${c}(?![\\u0590-\\u05FF])`, 'gu');
    for (const m of t.matchAll(re)) { const cand = `${m[1].trim()} ${m[2]}${m[3] ? ' ' + m[3] : ''}`; if (!out.includes(cand)) out.push(cand); if (out.length >= 5) break; }
  }
  return out.filter(isSinglePlace);
}

// links claimed by more than one differently-named candidate are shared pages, not detail pages
function sharedLinkUrls(claims) {
  const names = new Map();
  for (const c of claims) { const key = (c.name || '').toLowerCase().replace(/\s+/g, ' ').trim(); if (!names.has(c.url)) names.set(c.url, new Set()); names.get(c.url).add(key); }
  return new Set([...names.entries()].filter(([, s]) => s.size > 1).map(([u]) => u));
}

module.exports = { extractJsonLd, extractMetaImages, extractMapLinks, extractAddressTexts, extractPageImages, pageText, inIsrael, findEventCard, containsScore, findEventDetailLinks, resolveBaseHref, extractOccurrences, textualOccurrences, extractPriceTiers, extractAddressCandidates, sharedLinkUrls };
