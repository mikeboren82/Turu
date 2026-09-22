// HTML EXTRACTION BOUNDARY PRESERVATION (2026-09-22) - regression fixtures for the confirmed Holon
// failure. Structural fixtures only: no live activity ID and no source-specific event name is encoded
// in production logic, the shapes below merely reproduce the DOM shape the forensic captured.
//
// The proven failure: $('body').text() glued two sibling event cards with ZERO delimiter, so the card
// AFTER Gulliver ("ילדי בית העץ", 10:30) was the nearest time/price in the flattened text once the
// chunker had cut Gulliver away from its own schedule - the model attributed 10:30 and 85₪ to Gulliver.
const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const { pageTextForExtraction, splitTextForExtraction, ITEM_DELIMITER } = require('../lib/htmlText');

// --- the confirmed failure shape (Section 7) --------------------------------------------------
// CARD A: גוליבר, 10:00-11:00, dual price (regular 85 / Holon resident 55)
// CARD B: ילדי בית העץ, 10:30  - the neighbour whose fields leaked
const HOLON_FIXTURE = `<body><form><div class="listing">
  <div class="rowData"><div class="title">גוליבר</div><div class="dataRow sTime">שעת התחלה: 10:00</div><div class="dataRow eTime">שעת סיום: 11:00</div><div class="cost">מחיר כרטיס רגיל: 85 ש"ח | מחיר תושב חולון: 55 ש"ח</div><div class="txt">הצגת יחיד מוסיקלית לגילי 3 ומעלה.</div></div>
  <div class="rowData"><div class="title">ילדי בית העץ</div><div class="dataRow sTime">שעת התחלה: 10:30</div><div class="cost">מחיר כרטיס רגיל: 90 ש"ח</div><div class="txt">הצגה על פי ספרו של רן כהן אהרונוב.</div></div>
</div></form></body>`;

test('BOUNDARY REGRESSION: two adjacent event cards are never concatenated with zero delimiter', () => {
  const text = pageTextForExtraction(cheerio.load(HOLON_FIXTURE));
  assert.ok(!/גוליבר.*?11:00ילדי/s.test(text), 'the two cards must not be glued together');
  const gulliverEnd = text.indexOf('ילדי בית העץ');
  const between = text.slice(text.indexOf('הצגת יחיד מוסיקלית'), gulliverEnd);
  assert.ok(/\n/.test(between), 'a boundary must exist between the end of card A and the start of card B');
});

test('BOUNDARY REGRESSION (item selector): each card is closed with an explicit item delimiter', () => {
  const text = pageTextForExtraction(cheerio.load(HOLON_FIXTURE), 18000, { itemSelector: '.rowData' });
  const items = text.split(ITEM_DELIMITER).map((s) => s.trim()).filter(Boolean);
  assert.equal(items.length, 2, 'exactly one item per card');
  assert.ok(items[0].includes('גוליבר') && !items[0].includes('ילדי בית העץ'), 'card A holds only its own event');
  assert.ok(items[1].includes('ילדי בית העץ') && !items[1].includes('גוליבר'), 'card B holds only its own event');
});

test('BOUNDARY REGRESSION: the neighbour\'s time (10:30) never lands inside Gulliver\'s item', () => {
  const text = pageTextForExtraction(cheerio.load(HOLON_FIXTURE), 18000, { itemSelector: '.rowData' });
  const [cardA] = text.split(ITEM_DELIMITER);
  assert.ok(cardA.includes('10:00') && cardA.includes('11:00'), 'Gulliver keeps its own schedule');
  assert.ok(!cardA.includes('10:30'), 'the adjacent event\'s start time must NOT appear in Gulliver\'s item');
});

test('BOUNDARY REGRESSION: price does not bleed across the card boundary, and dual prices stay together', () => {
  const text = pageTextForExtraction(cheerio.load(HOLON_FIXTURE), 18000, { itemSelector: '.rowData' });
  const [cardA, cardB] = text.split(ITEM_DELIMITER);
  assert.ok(cardA.includes('85') && cardA.includes('55'), 'both of Gulliver\'s own price lines stay in its own item');
  assert.ok(!cardA.includes('90'), 'the neighbour\'s price must not bleed in');
  assert.ok(cardB.includes('90') && !cardB.includes('85'), 'card B keeps only its own price');
});

test('BOUNDARY REGRESSION: organizer does not bleed across the card boundary', () => {
  const fixture = `<body><div class="rowData"><h3>סדנת יצירה</h3><div>מארגן: מתנ"ס אלף</div></div><div class="rowData"><h3>שעת סיפור</h3><div>מארגן: הספרייה העירונית</div></div></body>`;
  const text = pageTextForExtraction(cheerio.load(fixture), 18000, { itemSelector: '.rowData' });
  const [a, b] = text.split(ITEM_DELIMITER);
  assert.ok(a.includes('מתנ"ס אלף') && !a.includes('הספרייה העירונית'));
  assert.ok(b.includes('הספרייה העירונית') && !b.includes('מתנ"ס אלף'));
});

// --- multi-session / multi-price integrity (Section 8) -----------------------------------------
test('NO FALSE SPLIT: one card with several legitimate sessions stays ONE item', () => {
  const fixture = `<body><div class="rowData"><h3>סדנת פסיפסים</h3>
    <div>מופע ראשון: 10:00</div><div>מופע שני: 11:00</div><div>מופע שלישי: 12:00</div><div>מחיר: 50 ש"ח</div>
  </div><div class="rowData"><h3>חוג בישול</h3><div>שעה: 16:00</div></div></body>`;
  const text = pageTextForExtraction(cheerio.load(fixture), 18000, { itemSelector: '.rowData' });
  const items = text.split(ITEM_DELIMITER).map((s) => s.trim()).filter(Boolean);
  assert.equal(items.length, 2, 'three session times inside one card must NOT create three items');
  assert.ok(['10:00', '11:00', '12:00'].every((t) => items[0].includes(t)), 'all sessions stay in the same item');
  assert.ok(!items[0].includes('16:00'), 'the next card\'s time stays out');
});

test('NO FALSE SPLIT: a long description with nested markup stays inside its own item', () => {
  const long = 'תיאור ארוך מאוד. '.repeat(120);
  const fixture = `<body><div class="rowData"><h3>הצגה א</h3><div><p><span>${long}</span></p><ul><li>הערה 1</li><li>הערה 2</li></ul></div><div>שעה: 09:00</div></div><div class="rowData"><h3>הצגה ב</h3><div>שעה: 20:00</div></div></body>`;
  const text = pageTextForExtraction(cheerio.load(fixture), 18000, { itemSelector: '.rowData' });
  const items = text.split(ITEM_DELIMITER).map((s) => s.trim()).filter(Boolean);
  assert.equal(items.length, 2);
  assert.ok(items[0].includes('הערה 1') && items[0].includes('הערה 2') && items[0].includes('09:00'));
  assert.ok(!items[0].includes('20:00'));
});

// --- generic flattener behaviour (Section 3) ---------------------------------------------------
test('inline siblings get a space (never glued), block siblings get a newline', () => {
  const text = pageTextForExtraction(cheerio.load('<body><div><span>אבג</span><span>דהו</span></div><div>שורה שנייה</div></body>'));
  assert.ok(!text.includes('אבגדהו'), 'inline spans must not glue into one word');
  assert.match(text, /\n/, 'sibling blocks are separated by a newline');
});

test('no runaway blank lines, and normalization is idempotent', () => {
  const html = '<body><div><div><div>א</div></div></div><div>ב</div></body>';
  const once = pageTextForExtraction(cheerio.load(html));
  assert.ok(!/\n\n/.test(once), 'nested blocks must not produce repeated blank lines');
  assert.equal(once.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim(), once, 'already normalized');
});

test('a malformed item selector never throws - generic block boundaries still apply', () => {
  const text = pageTextForExtraction(cheerio.load(HOLON_FIXTURE), 18000, { itemSelector: '((((' });
  assert.ok(text.includes('גוליבר') && text.includes('ילדי בית העץ'));
  assert.ok(!/11:00ילדי/.test(text), 'block boundaries still separate the cards');
});

test('an absent item selector still beats zero-delimiter flattening', () => {
  const text = pageTextForExtraction(cheerio.load(HOLON_FIXTURE));
  assert.ok(!text.includes(ITEM_DELIMITER.trim()), 'no item delimiter is invented without a selector');
  assert.ok(!/11:00ילדי/.test(text), 'but the cards are still separated');
});

// --- chunking (Section 5) -----------------------------------------------------------------------
test('CHUNKING: a window boundary prefers an item delimiter over cutting inside a card', () => {
  const card = (i) => `כרטיס ${i}\nשעה: 1${i % 10}:00\nמחיר: ${10 + i} ש"ח`;
  const text = Array.from({ length: 60 }, (_, i) => card(i)).join(ITEM_DELIMITER);
  const limit = 400;
  const chunks = splitTextForExtraction(text, limit, 99);
  for (const c of chunks) assert.ok(c.length <= limit, 'window respects the limit');
  // every chunk must start at a card start and end at a card end - never mid-card
  for (const c of chunks) {
    assert.ok(/^כרטיס \d+/.test(c.trim()), `chunk starts at a card boundary: ${JSON.stringify(c.slice(0, 30))}`);
    assert.ok(/ש"ח$/.test(c.trim()), `chunk ends at a card boundary: ${JSON.stringify(c.slice(-20))}`);
  }
  const hardCuts = chunks.filter((c) => c.length === limit).length;
  assert.equal(hardCuts, 0, 'no hard-limit fallback cuts when item delimiters exist');
});

test('CHUNKING: falls back to newline, then to a hard cut only for a single oversized item', () => {
  const nl = splitTextForExtraction(('y'.repeat(99) + '\n').repeat(50), 1000, 99);
  assert.ok(nl.every((c) => c.length <= 1000));
  assert.ok(nl[0].endsWith('y'), 'cut on a line boundary, no dangling newline');
  const oversized = 'z'.repeat(2500); // one item, no boundary anywhere
  const hard = splitTextForExtraction(oversized, 1000, 99);
  assert.equal(hard[0].length, 1000, 'a single item larger than the window still splits (hard fallback)');
  assert.equal(hard.join('').length, 2500, 'nothing is lost by the fallback');
});

test('CHUNKING: pre-existing behaviour preserved - short text is one window, maxChunks respected', () => {
  assert.deepEqual(splitTextForExtraction('abc'), ['abc']);
  const long = ('x'.repeat(999) + '\n').repeat(100);
  const windows = splitTextForExtraction(long, 18000, 4);
  assert.equal(windows.length, 4);
  for (const w of windows) assert.ok(w.length <= 18000);
  assert.ok(windows[0].endsWith('x'));
  assert.equal(windows.join('').replace(/\n/g, '').length, 4 * 18 * 999);
});
