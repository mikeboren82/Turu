const test = require('node:test');
const assert = require('node:assert/strict');
const { computeConfidence, wordOverlapScore, getConfidenceThresholds } = require('../cleaner/matching');
const { extractJsonLd, extractMapLinks, extractAddressTexts, extractMetaImages } = require('../cleaner/pageEvidence');
const { readDimensions } = require('../cleaner/imageProbe');
const { nextAttemptAt, settingsFrom, ARCHIVE_REASON_BY_ISSUE } = require('../cleaner/lifecycle');

const thresholds = getConfidenceThresholds({});
const existing = { id: 'e1', name: 'הצגת ילדים: הקוסם מארץ עוץ', source_url: 'https://venue.example/events', location_name: 'קניון רננים', city: 'רעננה', lat: 32.18, lng: 34.87, venue_id: 'venue-renanim', event_fingerprint: null, schedule_type: 'one_time', one_time_date: '2026-09-27', start_time: '17:00', recurring_days: [], has_image: false };

test('matching mirror: same listing url + different event stays below review; same venue+date is a duplicate', () => {
  const other = { name: 'סדנת גיבורי על - איור לילדים', city: 'רעננה', venue_id: null, pageUrl: 'https://venue.example/events', one_time_date: '2026-10-05', recurring_days: [] };
  const c1 = computeConfidence(other, { ...existing, venue_id: null }, thresholds);
  assert.equal(c1.breakdown.exact_url_match, 1); assert.ok(c1.score < thresholds.needsReview, String(c1.score));
  const same = { name: 'הקוסם מארץ עוץ - מופע לכל המשפחה', city: 'רעננה', venue_id: 'venue-renanim', pageUrl: 'https://city.example/calendar', one_time_date: '2026-09-27', recurring_days: [] };
  assert.ok(computeConfidence(same, existing, thresholds).score >= thresholds.duplicate);
  assert.equal(wordOverlapScore('שעת סיפור בספרייה', 'שעת סיפור'), 2 / 3);
});

test('JSON-LD Event with PostalAddress + geo and og:image are extracted', () => {
  const html = `<html><head><meta property="og:image" content="/img/ev.jpg"><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Event', name: 'שעת סיפור', startDate: '2026-09-20T17:00', image: ['https://x.il/a.jpg'], location: { '@type': 'Place', name: 'ספריית בן יהודה', address: { '@type': 'PostalAddress', streetAddress: 'בן יהודה 12', addressLocality: 'חולון' }, geo: { '@type': 'GeoCoordinates', latitude: 32.01, longitude: 34.77 } } })}</script></head><body></body></html>`;
  const ld = extractJsonLd(html);
  assert.equal(ld.events.length, 1);
  assert.equal(ld.events[0].location.address.text, 'בן יהודה 12, חולון');
  assert.deepEqual(ld.events[0].location.geo, { lat: 32.01, lng: 34.77 });
  assert.deepEqual(ld.events[0].images, ['https://x.il/a.jpg']);
  assert.deepEqual(extractMetaImages(html), ['/img/ev.jpg']);
});

test('Google Maps links: coordinates and place queries; out-of-Israel coordinates dropped', () => {
  const html = '<a href="https://www.google.com/maps/place/%D7%9E%D7%93%D7%99%D7%98%D7%A7/@32.0157,34.7745,17z">map</a> <a href="https://maps.google.com/?q=48.85,2.35">paris</a> <a href="https://www.google.com/maps?q=%D7%A8%D7%97%D7%95%D7%91+%D7%94%D7%A8%D7%A6%D7%9C+5+%D7%97%D7%95%D7%9C%D7%95%D7%9F">q</a>';
  const links = extractMapLinks(html);
  assert.equal(links.length, 2);
  assert.deepEqual(links[0].coords, { lat: 32.0157, lng: 34.7745 }); assert.equal(links[0].query, 'מדיטק');
  assert.equal(links[1].coords, null); assert.equal(links[1].query, 'רחוב הרצל 5 חולון');
});

test('Hebrew street address text is found with street/number/city', () => {
  const t = 'המופע יתקיים במדיטק, רחוב גולדה מאיר 6, חולון. טלפון 03-5021552. ';
  const a = extractAddressTexts(t, { city: 'חולון' });
  assert.ok(a.length >= 1, JSON.stringify(a));
  assert.equal(a[0].number, '6'); assert.ok(a[0].street.includes('גולדה מאיר')); assert.ok(a[0].city.startsWith('חולון'));
});

test('image header dimensions: PNG, JPEG SOF, GIF', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 3, 0x20, 0, 0, 2, 0x58]), Buffer.alloc(8)]);
  assert.deepEqual(readDimensions(png), { type: 'png', width: 800, height: 600 });
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.alloc(14), Buffer.from([0xff, 0xc0, 0, 17, 8, 0x01, 0x90, 0x02, 0x80]), Buffer.alloc(20)]);
  assert.deepEqual(readDimensions(jpeg), { type: 'jpeg', width: 640, height: 400 });
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x2c, 0x01, 0xf4, 0x01]), Buffer.alloc(20)]);
  assert.deepEqual(readDimensions(gif), { type: 'gif', width: 300, height: 500 });
});

test('lifecycle: backoff schedule and settings defaults', () => {
  const s = settingsFrom([{ key: 'cleaner_backoff_hours', value: [6, 24, 72] }, { key: 'cleaner_max_attempts', value: 3 }]);
  assert.equal(s.maxAttempts, 3);
  const now = new Date('2026-09-13T10:00:00Z');
  assert.equal(nextAttemptAt(1, s.backoffHours, now), '2026-09-13T16:00:00.000Z');
  assert.equal(nextAttemptAt(2, s.backoffHours, now), '2026-09-14T10:00:00.000Z');
  assert.equal(nextAttemptAt(9, s.backoffHours, now), '2026-09-16T10:00:00.000Z');
  assert.equal(ARCHIVE_REASON_BY_ISSUE.missing_location, 'missing_address_unresolved');
  assert.equal(ARCHIVE_REASON_BY_ISSUE.missing_image, 'image_unavailable_only');
});

test('listing-card image discovery: card image + detail link (Givatayim markup), cross-host detail link (Herzliya markup)', () => {
  const { findEventCard, containsScore } = require('../cleaner/imageResolver');
  const giv = '<base href="/"><div class="col"><a href="./events/10215/" class="event-promo"><div class="pic"><img src="https://org-images.coing.co/437/resources/d8d4.jpeg" alt="" loading="lazy"></div><div class="details"><h2 class="name mb-2"> סדנת רכיבה על אופניים </h2><div class="date">15/09/2026 17:00 גבעתיים פארק</div></div></a></div><a href="./events/1/">טורניר סטריטבול 3 על 3</a>';
  const c1 = findEventCard(giv, 'https://www.givatayim.muni.il/events/', 'סדנת רכיבה על אופניים');
  assert.equal(c1.detailUrl, 'https://www.givatayim.muni.il/events/10215/');
  assert.deepEqual(c1.images, ['https://org-images.coing.co/437/resources/d8d4.jpeg']);
  const her = '<div class="event"><a href="https://www.herzliya-matnasim.org.il/events/8464/"><img src="https://www.herzliya-matnasim.org.il/uploads/c-480/1788851804.png" class="img-fluid" alt=""></a><div class="h"><h2><a href="https://www.herzliya-matnasim.org.il/events/8464/" target="_blank"> סדנאת הכנת עוגיות לראש השנה </a></h2></div></div>';
  const c2 = findEventCard(her, 'https://www.herzliya.muni.il/events/', 'סדנאת הכנת עוגיות לראש השנה');
  assert.equal(c2.detailUrl, 'https://www.herzliya-matnasim.org.il/events/8464/');
  assert.equal(c2.images.length, 1);
  assert.equal(containsScore('סדנת רכיבה על אופניים 15/09/2026 17:00 גבעתיים', 'סדנת רכיבה על אופניים'), 1);
  assert.equal(findEventCard(giv, 'https://x', 'הצגה שלא קיימת').detailUrl, null);
});
