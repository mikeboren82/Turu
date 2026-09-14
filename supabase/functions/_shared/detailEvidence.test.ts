import { assertEquals } from 'jsr:@std/assert@1';
import { extractDetailEvidence, applyDetailEvidence } from './detailEvidence.ts';
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
