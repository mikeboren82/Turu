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
