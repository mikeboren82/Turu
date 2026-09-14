// EVENT identity (lib/eventIdentity.js, Node twin of _shared/eventIdentity.ts): the key hierarchy, listing
// shapes that never count, generic titles that never get a title-based key.
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeEventKey, isListingShapedUrl, isGenericTitle, normalizeDetailUrl, eventKeyRank } = require('../lib/eventIdentity');

const S = 'src-1';

test('hierarchy: provider id > verified detail URL > provider key > exact title+venue+source; nothing weaker', () => {
  assert.deepEqual(computeEventKey({ sourceId: S, title: 'גולי והגיטרה ששרה לגיל 2-4', venueId: 'v1', externalEventId: '31436', detailUrl: 'https://x.il/e/1', detailVerified: true }), { key: 'ext:src-1:31436', kind: 'external_id' });
  assert.deepEqual(computeEventKey({ sourceId: S, title: 'גולי והגיטרה ששרה לגיל 2-4', venueId: 'v1', detailUrl: 'https://tickets.raanana.muni.il/גולי_והגיטרה_ששרה_לגיל_2-4?utm_source=x#top', detailVerified: true }), { key: 'url:https://tickets.raanana.muni.il/גולי_והגיטרה_ששרה_לגיל_2-4', kind: 'detail_url' });
  // an UNVERIFIED detail URL never becomes identity
  assert.deepEqual(computeEventKey({ sourceId: S, title: 'גולי והגיטרה ששרה לגיל 2-4', venueId: 'v1', detailUrl: 'https://x.il/e/1', detailVerified: false }), { key: 'tvs:גולי והגיטרה ששרה לגיל 24|v:v1|s:src-1', kind: 'title_venue_source' });
  assert.deepEqual(computeEventKey({ sourceId: S, title: 'x', venueId: null, providerKey: 'abc' }), { key: 'pk:src-1:abc', kind: 'provider_key' });
  // the fallback needs a canonical venue and a non-generic title
  assert.equal(computeEventKey({ sourceId: S, title: 'גולי והגיטרה ששרה לגיל 2-4', venueId: null }), null);
  assert.equal(computeEventKey({ sourceId: S, title: 'שעת סיפור', venueId: 'v1' }), null);
  assert.equal(computeEventKey({ sourceId: S, title: 'הצגה לגיל הרך', venueId: 'v1' }), null);
  assert.ok(eventKeyRank('external_id') > eventKeyRank('detail_url') && eventKeyRank('detail_url') > eventKeyRank('title_venue_source'));
});

test('same title, different ages => different exact titles => different keys (never overlap-based)', () => {
  const a = computeEventKey({ sourceId: S, title: 'גולי והגיטרה ששרה לגיל 2-4', venueId: 'v1' });
  const b = computeEventKey({ sourceId: S, title: 'גולי והגיטרה ששרה לגיל 5-8', venueId: 'v1' });
  assert.notEqual(a.key, b.key);
});

test('listing-shaped URLs are never event pages: category, paginated, search, host root, seed / known listing pages', () => {
  for (const u of ['https://tickets.raanana.muni.il/אזרחים_ותיקים_page_83', 'https://city.il/events/', 'https://city.il/events/?category=3', 'https://city.il/', 'https://city.il/search?q=x', 'https://city.il/page/2', 'https://x.il/סדרה_season_2047']) assert.equal(isListingShapedUrl(u), true, u);
  for (const u of ['https://tickets.raanana.muni.il/גולי_והגיטרה_ששרה_לגיל_2-4', 'https://city.il/events/story-hour/', 'https://city.il/events/123/']) assert.equal(isListingShapedUrl(u), false, u);
  // a category page with no shape marker is excluded through the scan's own knowledge: the seed / discovered listing pages
  assert.equal(isListingShapedUrl('https://tickets.raanana.muni.il/ילדים_ומשפחה', { seedUrl: 'https://tickets.raanana.muni.il/ילדים_ומשפחה' }), true);
  assert.equal(isListingShapedUrl('https://city.il/events/story-hour/', { listingUrls: ['https://city.il/events/story-hour'] }), true);
});

test('normalizeDetailUrl strips tracking params, hash, trailing slash, www', () => {
  assert.equal(normalizeDetailUrl('https://www.City.il/events/1/?utm_campaign=a&id=5#x'), 'https://city.il/events/1?id=5');
  assert.equal(normalizeDetailUrl('mailto:x@y'), null);
  assert.equal(isGenericTitle('הקופיף והפרפר המבולבל - תיאטרון סיפור לגילאי 2-4'), false);
});
