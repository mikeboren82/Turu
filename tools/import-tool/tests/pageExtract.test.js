// Shared page extraction (lib/pageExtract.js): detail-link discovery for THE MONSTER's relay and
// the Cleaner's detail_page stage; shared-image detection on listing cards.
const test = require('node:test');
const assert = require('node:assert/strict');
const { findEventDetailLinks, findEventCard } = require('../lib/pageExtract');

test('detail links: "פרטים נוספים", event title links, /events/<id>/ paths; same host unless allowed; bounded', () => {
  const html = '<base href="https://www.city.muni.il/"><ul>'
    + '<li><h3><a href="./events/101/">הצגת ילדים: הקוסם</a></h3><a href="./events/101/">פרטים נוספים</a></li>'
    + '<li><h3><a href="./events/102/">סדנת יצירה לגיל הרך</a></h3></li>'
    + '<li><a href="https://tickets.example.il/show/55">לרכישת כרטיסים</a></li>'
    + '<li><a href="https://other.example.il/show/56">לרכישת כרטיסים</a></li>'
    + '<li><a href="./about/">אודות</a></li><li><a href="mailto:x@y">מייל</a></li></ul>';
  const links = findEventDetailLinks(html, 'https://www.city.muni.il/events/', { max: 10, allowHosts: ['tickets.example.il'] });
  assert.deepEqual(links.map((l) => l.url), ['https://www.city.muni.il/events/101/', 'https://www.city.muni.il/events/102/', 'https://tickets.example.il/show/55']);
  assert.equal(findEventDetailLinks(html, 'https://www.city.muni.il/events/', { max: 1 }).length, 1);
});

test('event card: an image reused by other cards on the page is reported as shared', () => {
  const html = '<div class="card"><a href="/e/1"><img src="/img/default.jpg"><h2>שעת סיפור בספרייה</h2></a></div><div class="card"><a href="/e/2"><img src="/img/default.jpg"><h2>סדנת שוקולד</h2></a></div><div class="card"><a href="/e/3"><img src="/img/own.jpg"><h2>הצגה: הנעל הכתומה</h2></a></div>';
  const c1 = findEventCard(html, 'https://x.il/events', 'שעת סיפור בספרייה');
  assert.equal(c1.detailUrl, 'https://x.il/e/1'); assert.deepEqual(c1.sharedImages, ['https://x.il/img/default.jpg']);
  const c3 = findEventCard(html, 'https://x.il/events', 'הצגה: הנעל הכתומה');
  assert.deepEqual(c3.images, ['https://x.il/img/own.jpg']); assert.deepEqual(c3.sharedImages, []);
});

// ---- Node twins of the detail-evidence parsers (lockstep with _shared/detailEvidence.ts; Ra'anana fixtures) ----
const fs = require('node:fs');
const path = require('node:path');
const { extractOccurrences, extractPriceTiers, extractAddressCandidates, pageText, sharedLinkUrls } = require('../lib/pageExtract');
const FIX = (f) => fs.readFileSync(path.join(__dirname, '../../../supabase/functions/_shared/fixtures', f), 'utf8');
const GULI_URL = 'https://tickets.raanana.muni.il/גולי_והגיטרה_ששרה_לגיל_2-4';

test('Ra\'anana detail (Node twin): 8 performances with own times + purchase links, price 45 (adult free tier), address', () => {
  const html = FIX('raanana-detail-guli.html');
  const occ = extractOccurrences(html, '2026-09-14', GULI_URL);
  assert.equal(occ.length, 8);
  assert.deepEqual([...new Set(occ.map((o) => o.start_time))].sort(), ['16:30', '17:30']);
  assert.equal(occ[0].external_id, '31436'); assert.ok(occ[0].booking_url.includes('?id=31436'));
  const price = extractPriceTiers(pageText(html));
  assert.equal(price.price_type, 'fixed'); assert.equal(price.price_amount, 45); assert.ok(price.tiers.some((t) => t.label === 'מבוגר' && t.amount === 0));
  assert.deepEqual(extractAddressCandidates(pageText(html), 'רעננה'), ['הפלמ"ח 2 א']);
  assert.deepEqual(extractOccurrences('<p>עודכן 03.09.2026</p>', '2026-09-14', null), []);
});

test('Ra\'anana listing (Node twin): aria-label / whole-card anchors are detail links; nav, tender, category and ticketing homepage are not', () => {
  const links = findEventDetailLinks(FIX('raanana-listing.html'), 'https://tickets.raanana.muni.il/ילדים_ומשפחה', { max: 40 });
  const urls = links.map((l) => decodeURIComponent(l.url));
  assert.equal(urls.length, 4); assert.ok(urls.includes(GULI_URL));
  for (const bad of ['page_67', 'page_83', 'צור_קשר', 'smarticket', 'מכרזים', 'ילדים_ומשפחה']) assert.ok(!urls.some((u) => u.includes(bad)), bad);
  const aria = findEventDetailLinks('<div class="show"><a href="/e/77" aria-label="מופע הקסמים ביום שני, 12 באוקטובר 2026"><img src="/i.jpg"></a></div>', 'https://x.il/events/', {});
  assert.deepEqual(aria.map((l) => l.url), ['https://x.il/e/77']);
  assert.deepEqual([...sharedLinkUrls([{ url: 'u1', name: 'א' }, { url: 'u1', name: 'ב' }, { url: 'u2', name: 'א' }, { url: 'u2', name: 'א' }])], ['u1']);
});
