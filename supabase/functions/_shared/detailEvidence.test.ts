import { assertEquals, assert } from 'jsr:@std/assert@1';
import { extractDetailEvidence, applyDetailEvidence, detailPageNamesCandidate, extractPriceTiers } from './detailEvidence.ts';
import { detailLinkFor, findEventDetailLinksCheap } from './detailLinks.ts';

Deno.test('findEventDetailLinksCheap: regex anchors on heavy pages, same rules as the DOM version', () => {
  const page = '<html><body><nav><a href="/tenders/">מכרזים</a></nav><ul><li><a href="/events/story-hour/">שעת סיפור</a> יום שני 21.09.2026 17:00</li><li><a href="/events/?category=3">קטגוריה</a></li><li><a href="/ru/events/x/">ru</a></li><li><a href="/about/">אודות</a></li></ul></body></html>';
  const links = findEventDetailLinksCheap(page, 'https://www.city.muni.il/events/', { max: 10 });
  assertEquals(links.map((l) => l.url), ['https://www.city.muni.il/events/story-hour/']);
  assertEquals(detailLinkFor([], 'x', 'https://www.city.muni.il/events/123/', new Set(['city.muni.il']))?.url, 'https://www.city.muni.il/events/123/');
  assertEquals(detailLinkFor([], 'x', 'https://other.il/events/123/', new Set(['city.muni.il'])), null);
});

const html = `<html><head><title>שעת סיפור מומחזת - עיריית גבעתיים</title><meta property="og:image" content="/uploads/story.jpg"></head>
<body><h1>שעת סיפור מומחזת</h1><p>יום שני, 21.09.2026 בשעה 17:00 · לגילאי 3-6 · מרכז קהילתי שז״ר, רחוב יבניאלי 30, גבעתיים · כניסה חופשית · לילדים ולכל המשפחה</p></body></html>`;

Deno.test('extractDetailEvidence: date/time, ages, address text, og:image, price, markers', () => {
  const ev = extractDetailEvidence(html, '2026-09-14');
  assertEquals(ev.date, '2026-09-21'); assertEquals(ev.time, '17:00');
  assertEquals(ev.ages?.min_age, 3); assertEquals(ev.ages?.max_age, 6);
  assertEquals(ev.addressText, 'יבניאלי 30'); assertEquals(ev.ogImage, '/uploads/story.jpg');
  assertEquals(ev.price?.price_type, 'free'); assertEquals(ev.childMarkers >= 2, true); assertEquals(ev.adultMarkers, 0);
});

Deno.test('applyDetailEvidence: fill-null only, provenance fields, image host rule', () => {
  const ev = extractDetailEvidence(html, '2026-09-14');
  const c: Record<string, unknown> = { name: 'שעת סיפור מומחזת', schedule_type: 'one_time', one_time_date: null, start_time: null, address: null, min_age: null, max_age: null, audience: 'unknown', price_type: null, price_amount: null, image_urls: [] };
  const filled = applyDetailEvidence(c, ev, 'https://www.givatayim.muni.il/events/10281/', 'givatayim.muni.il');
  assertEquals(filled, ['address', 'one_time_date', 'start_time', 'ages', 'audience', 'price', 'image']);
  assertEquals(c.address, 'יבניאלי 30'); assertEquals(c.one_time_date, '2026-09-21'); assertEquals(c.audience, 'children'); assertEquals(c.price_amount, 0);
  assertEquals((c.images as { needs_rights_review: boolean }[])[0].needs_rights_review, false);
  assertEquals(c.detail_url, 'https://www.givatayim.muni.il/events/10281/');
  const keep: Record<string, unknown> = { name: 'x', schedule_type: 'one_time', one_time_date: '2026-10-01', start_time: '10:00', address: 'אחר 1', min_age: 8, audience: 'family', price_type: 'fixed', price_amount: 30, image_urls: ['https://a/b.jpg'] };
  assertEquals(applyDetailEvidence(keep, ev, 'https://x/y', 'x'), []);
  assertEquals(keep.one_time_date, '2026-10-01');
});

Deno.test('detailLinkFor: the link whose text names the candidate', () => {
  const links = [{ url: 'https://s/events/1/', text: 'הרצאה: לסלוח לעצמי יום שני 14.09.2026' }, { url: 'https://s/events/2/', text: 'שעת סיפור מומחזת "ליאור בכה כשאמא הלכה" יום שני 14.09' }];
  assertEquals(detailLinkFor(links, 'שעת סיפור מומחזת ליאור בכה כשאמא הלכה')?.url, 'https://s/events/2/');
  assertEquals(detailLinkFor(links, 'סדנת יצירה'), null);
  const imageAnchor = [{ url: 'https://visit.ashdod.muni.il/events/%d7%9e%d7%95%d7%a4%d7%a2-%d7%a1%d7%9c%d7%95%d7%a0%d7%99%d7%9d-%d7%91%d7%a4%d7%90%d7%a8%d7%a7/', text: '' }];
  assertEquals(detailLinkFor(imageAnchor, 'מופע סלונים בפארק')?.url, imageAnchor[0].url);
});

// ---- Ra'anana regression (fixtures trimmed from the live pages, 2026-09-14) ----
const FIX = (f: string) => Deno.readTextFileSync(new URL('./fixtures/' + f, import.meta.url));
const GULI_URL = 'https://tickets.raanana.muni.il/גולי_והגיטרה_ששרה_לגיל_2-4';

Deno.test('Ra\'anana detail page: every performance with its own time and purchase link, child price 45 (adult free kept as a tier), street address, no fake registration_url', () => {
  const ev = extractDetailEvidence(FIX('raanana-detail-guli.html'), '2026-09-14', { baseUrl: GULI_URL, city: 'רעננה' });
  assertEquals(ev.occurrences.length, 8);
  assertEquals(ev.occurrences.map((o) => o.date + ' ' + o.start_time).slice(0, 4), ['2026-10-12 16:30', '2026-10-12 17:30', '2026-12-21 16:30', '2026-12-21 17:30']);
  assertEquals(new Set(ev.occurrences.map((o) => o.start_time)), new Set(['16:30', '17:30']));
  assertEquals(ev.occurrences[0].external_id, '31436');
  assertEquals(ev.occurrences[1].external_id, '31435');
  assert(ev.occurrences.every((o) => o.booking_url && o.booking_url.includes('?id=' + o.external_id)));
  assertEquals(ev.date, null); // several performances: no single "the date"
  assertEquals(ev.price?.price_type, 'fixed'); assertEquals(ev.price?.price_amount, 45);
  assert(ev.price!.tiers.some((t) => t.label === 'מבוגר' && t.amount === 0));
  assertEquals(ev.addressText, 'הפלמ"ח 2 א');
  assertEquals(ev.registrationUrl, null); // per-performance purchase links are occurrence booking_url, not an event registration_url
  assertEquals(detailPageNamesCandidate(ev, 'גולי והגיטרה ששרה לגיל 2-4'), true);
  assertEquals(detailPageNamesCandidate(ev, 'הקופיף והפרפר המבולבל'), false);
});

Deno.test('Ra\'anana merge: a listing-side recurring misread becomes dated occurrences; listing data never overwritten; the detail URL is provenance only', () => {
  const ev = extractDetailEvidence(FIX('raanana-detail-guli.html'), '2026-09-14', { baseUrl: GULI_URL, city: 'רעננה' });
  const c: Record<string, unknown> = { name: 'גולי והגיטרה ששרה לגיל 2-4', schedule_type: 'recurring', recurring_days: ['שני'], start_time: '16:30', one_time_date: null, city: 'רעננה', address: null, price_type: 'fixed', price_amount: null, min_age: 2, max_age: 4, audience: 'children', image_urls: ['https://tickets.raanana.muni.il/uploads/x.jpg'], registration_url: null };
  const filled = applyDetailEvidence(c, ev, GULI_URL, 'tickets.raanana.muni.il');
  assertEquals(c.schedule_type, 'one_time'); assertEquals(c.one_time_date, '2026-10-12'); assertEquals(c.start_time, '16:30');
  assertEquals((c.occurrences as unknown[]).length, 8);
  assertEquals(c.price_amount, 45); assertEquals(c.price_type, 'fixed');
  assertEquals((c.price_evidence as { tiers: unknown[] }).tiers.length, 3);
  assertEquals(c.address, 'הפלמ"ח 2 א'); assertEquals(c.address_source, 'monster:detail');
  assertEquals(c.registration_url, null);
  assertEquals(c.detail_url, GULI_URL);
  assertEquals(c.image_urls, ['https://tickets.raanana.muni.il/uploads/x.jpg']); // listing image kept
  for (const f of ['schedule_type', 'occurrences', 'one_time_date', 'price', 'address']) assert(filled.includes(f), f);
  // a listing-side 'פעילות' (class) label is corrected to an event by the page's dated performances
  const cls: Record<string, unknown> = { name: 'גולי והגיטרה ששרה לגיל 2-4', entity_type: 'פעילות', schedule_type: 'recurring', recurring_days: ['שני'], start_time: '16:30', image_urls: [] };
  const f2 = applyDetailEvidence(cls, ev, GULI_URL, 'tickets.raanana.muni.il');
  assertEquals(cls.entity_type, 'אירוע'); assert(f2.includes('entity_type'));
  // an explicit listing date is kept and joined with the page's performances
  const d: Record<string, unknown> = { name: 'גולי והגיטרה ששרה לגיל 2-4', schedule_type: 'one_time', one_time_date: '2026-10-12', start_time: '16:30', image_urls: [] };
  applyDetailEvidence(d, ev, GULI_URL, 'tickets.raanana.muni.il');
  assertEquals(d.one_time_date, '2026-10-12'); assertEquals((d.occurrences as unknown[]).length, 8);
});

Deno.test('Ra\'anana listing: whole-card anchors are detail links; navigation / tender / category / ticketing-homepage links are not', () => {
  const links = findEventDetailLinksCheap(FIX('raanana-listing.html'), 'https://tickets.raanana.muni.il/ילדים_ומשפחה', { max: 40 });
  const urls = links.map((l) => decodeURIComponent(l.url));
  assertEquals(urls.length, 4);
  assert(urls.includes(GULI_URL));
  for (const bad of ['מנויים_page_67', 'אזרחים_ותיקים_page_83', 'צור_קשר', 'smarticket', 'מכרזים', 'ילדים_ומשפחה']) assert(!urls.some((u) => u.includes(bad)), bad);
  const m = detailLinkFor(links, 'גולי והגיטרה ששרה לגיל 2-4');
  assertEquals(decodeURIComponent(m!.url), GULI_URL); assertEquals(m!.method, 'card_text'); assert(m!.score >= 0.7);
  assertEquals(detailLinkFor(links, 'הצגה שלא קיימת בדף'), null);
});

Deno.test('occurrences: only the specific Hebrew textual form counts - footer dd.mm dates never become performances', () => {
  const html = '<html><body><h1>שעת סיפור</h1><p>יום שני, 21.09.2026 בשעה 17:00</p><footer>עודכן 03.09.2026 · 14.10.2026</footer></body></html>';
  const ev = extractDetailEvidence(html, '2026-09-14');
  assertEquals(ev.occurrences, []);
  assertEquals(ev.date, null); // two future numeric dates = ambiguous: the loose rule fills nothing
  assertEquals(extractDetailEvidence('<p>יום שני, 21.09.2026 בשעה 17:00</p><footer>עודכן 03.09.2026</footer>', '2026-09-14').date, '2026-09-21'); // one future numeric date still fills
  const two = extractDetailEvidence('<p>ביום שני, 12 באוקטובר 2026 בשעה 16:30</p><p>21 בדצמבר 2026 בשעה 17:00 - 18:00</p><p>עודכן 03.09.2026</p>', '2026-09-14');
  assertEquals(two.occurrences.map((o) => `${o.date} ${o.start_time} ${o.end_time}`), ['2026-10-12 16:30 null', '2026-12-21 17:00 18:00']);
});

Deno.test('price tiers: "מבוגר ללא תשלום" next to a child price is not a free event; a plain free phrase is', () => {
  assertEquals(extractPriceTiers('מחיר לילד: 45 ש"ח, מבוגר ללא תשלום')?.price_amount, 45);
  assertEquals(extractPriceTiers('כניסה חופשית לכל המשפחה')?.price_type, 'free');
  assertEquals(extractPriceTiers('החל מ־60 ₪ · מנויים 40 ₪')?.price_amount, 60);
  assertEquals(extractPriceTiers('אין מידע על מחיר'), null);
});

Deno.test('ages: a reversed RTL range ("לגילאי 4 -2") is normalized to min 2 / max 4', () => {
  const ev = extractDetailEvidence('<p>תיאטרון סיפור לגילאי 4 -2 ביום שני</p>', '2026-09-14');
  assertEquals(ev.ages?.min_age, 2); assertEquals(ev.ages?.max_age, 4);
});
