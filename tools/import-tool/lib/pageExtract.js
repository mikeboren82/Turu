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
const DETAIL_TEXT = /פרטים נוספים|מידע נוסף|לפרטים|קרא עוד|קראו עוד|להזמנת כרטיסים|לרכישת כרטיסים|הרשמה|לפרטים והרשמה|read more|more info|details|tickets|register/i;
const DETAIL_HREF = /\/event(s)?\/[^/]+|\/activity\/|\/show\/|\/item\/|\/page\/\d+\/[^/]+|[?&](?:event|item|id|eventid|activityid)=\d+/i;
function findEventDetailLinks(html, baseUrl, { max = 20, allowHosts = [] } = {}) {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const resolveBase = resolveBaseHref($, baseUrl);
  const norm = (h) => h.replace(/^www\./, '');
  const allowed = new Set([norm(base.hostname), ...allowHosts.map(norm)]);
  const seen = new Set([baseUrl.split('#')[0]]); const out = [];
  $('a[href]').each((_, el) => {
    if (out.length >= max) return false;
    const href = $(el).attr('href'); if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;
    let u; try { u = new URL(href, resolveBase); } catch { return; }
    if (!['http:', 'https:'].includes(u.protocol) || !allowed.has(norm(u.hostname))) return;
    u.hash = ''; const key = u.toString(); if (seen.has(key)) return;
    const text = ($(el).text() || '').replace(/\s+/g, ' ').trim();
    const inHeading = $(el).closest('h1, h2, h3, h4, .title, .name, article, .event, .card, li').length > 0;
    const ok = DETAIL_TEXT.test(text) || DETAIL_HREF.test(u.pathname + u.search) || (inHeading && text.length >= 6 && text.length <= 120);
    if (!ok) return;
    seen.add(key); out.push({ url: key, text: text.slice(0, 120) });
  });
  return out;
}

function dedupeBy(arr, key) { const seen = new Set(); return arr.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); }

module.exports = { extractJsonLd, extractMetaImages, extractMapLinks, extractAddressTexts, extractPageImages, pageText, inIsrael, findEventCard, containsScore, findEventDetailLinks, resolveBaseHref };
