const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const { discoverListingLinks, canonicalPageKey } = require('../lib/discovery');

const HOLON = 'https://www.holon.muni.il/Havingfun/pages/allevents.aspx';
const discover = (seed, anchors, max = 7) => discoverListingLinks(cheerio.load(`<body>${anchors.map(([h, t]) => `<a href="${h}">${t}</a>`).join('')}</body>`), seed, max);

test('SharePoint /Pages/ navigation is not admitted merely because the URL contains "page"', () => {
  const found = discover(HOLON, [
    ['/Residents/Emergency/Pages/default.aspx', 'חירום וביטחון'],
    ['/CityHall/Pages/ClickService.aspx', 'חולון בקליק'],
    ['/Residents/TaxesWater/Pages/default.aspx', 'ארנונה'],
    ['/Residents/Pages/Payments.aspx', 'תשלומים'],
    ['/Residents/enforce/Pages/ParkingReports.aspx', 'דו"חות חנייה'],
    ['/_catalogs/masterpage/', ''],
    ['/Pages/Home.aspx', 'עמוד הבית'],
  ]);
  assert.deepEqual(found, []);
});

test('seed self-link differing only by case is one logical page (Holon calendar not sent twice)', () => {
  const found = discover(HOLON, [['/Havingfun/Pages/AllEvents.aspx', 'אירועים בעיר'], ['https://holon.muni.il/HAVINGFUN/pages/allevents.aspx/', 'לוח אירועים']]);
  assert.deepEqual(found, []);
});

test('legitimate event / pagination links are retained', () => {
  const found = discover('https://city.example/events', [
    ['/events/summer', 'אירועי קיץ'],
    ['/calendar?month=10', 'לוח שנה'],
    ['/events?page=2', '2'],
    ['/list/p2', 'עמוד 2'],
    ['/Pages/KidsActivities.aspx', 'פעילויות לילדים'],
  ]);
  assert.deepEqual(found, ['https://city.example/events/summer', 'https://city.example/calendar?month=10', 'https://city.example/events?page=2', 'https://city.example/list/p2', 'https://city.example/Pages/KidsActivities.aspx']);
});

test('kids/show listings kept without "page": show keywords and whole-anchor kids labels, but not welfare / kindergarten pages', () => {
  const found = discover('https://matnaskg.smarticket.co.il/', [
    ['/ילדים_page_17', 'ילדים'],
    ['/הצגות_ילדים_page_44', 'הצגות ילדים'],
    ['/show-pages', 'הופעות לפי תאריך'],
    ['/סטנדאפ_page_26', 'סטנדאפ'],
    ['/גני-ילדים', 'רישום לגני ילדים'],
    ['/פרט-ומשפחה', 'פרט ומשפחה'],
    ['/צור_קשר_page_56', 'צור קשר'],
  ]);
  assert.deepEqual(found.map((u) => decodeURIComponent(new URL(u).pathname)), ['/ילדים_page_17', '/הצגות_ילדים_page_44', '/show-pages']);
});

test('distinct query strings stay distinct; tracking params, fragments, trailing slash and www do not', () => {
  const found = discover('https://city.example/', [
    ['/event?id=1', 'אירוע'], ['/event?id=2', 'אירוע'], ['/event?id=1&utm_source=fb', 'אירוע'],
    ['/events/', 'אירועים'], ['https://www.city.example/events#top', 'אירועים'],
  ]);
  assert.deepEqual(found, ['https://city.example/event?id=1', 'https://city.example/event?id=2', 'https://city.example/events/']);
});

test('canonicalPageKey', () => {
  assert.equal(canonicalPageKey('https://www.Holon.muni.il/Havingfun/Pages/AllEvents.aspx#x'), 'holon.muni.il/havingfun/pages/allevents.aspx');
  assert.equal(canonicalPageKey('http://holon.muni.il/havingfun/pages/allevents.aspx/'), 'holon.muni.il/havingfun/pages/allevents.aspx');
  assert.equal(canonicalPageKey('https://a.b/x?ID=AbC&gclid=1'), 'a.b/x?ID=AbC');
  assert.notEqual(canonicalPageKey('https://a.b/x?id=1'), canonicalPageKey('https://a.b/x?id=2'));
  assert.equal(canonicalPageKey('https://a.b/'), 'a.b/');
});
