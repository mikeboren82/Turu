// בדיקות ל-lib/homeCarousel.js - חשבון-המירכוז הטהור של קרוסלת-הגילוי בעמוד הבית (Mobile UI
// Polish, 2026-09-26). CommonJS ישיר (module.exports), אין React/RN/babel-hook נדרש - בדיוק כמו
// שאר קבצי lib/ הטהורים-לגמרי (בלי import כלשהו).
const test = require('node:test');
const assert = require('node:assert/strict');
const { carouselSidePadding, carouselActiveIndex, carouselOffsetForIndex } = require('../lib/homeCarousel');

// --- 1. carouselSidePadding ---

test('carouselSidePadding: centers a 260-wide card in a wider viewport (padding on both sides)', () => {
  // viewport 360 (a real target width from the request), card 260 -> 50px each side
  assert.equal(carouselSidePadding(360, 260), 50);
  assert.equal(carouselSidePadding(430, 260), 85);
});

test('carouselSidePadding: a viewport exactly as wide as the card needs no padding at all', () => {
  assert.equal(carouselSidePadding(260, 260), 0);
});

test('carouselSidePadding: never negative - a viewport narrower than the card clamps to 0, it does not push the card off-screen', () => {
  assert.equal(carouselSidePadding(200, 260), 0);
});

test('carouselSidePadding: non-finite input never throws or produces NaN', () => {
  assert.equal(carouselSidePadding(undefined, 260), 0);
  assert.equal(carouselSidePadding(360, null), 0);
  assert.equal(carouselSidePadding(NaN, 260), 0);
});

// --- 2. carouselActiveIndex ---
// offsetX is measured from the START of the padded content box (offset 0 = first card centered,
// exactly where carouselSidePadding puts it at rest) - see the module's own header comment.

test('carouselActiveIndex: offset 0 is card 0 - the initial, padding-centered position, no scroll needed', () => {
  assert.equal(carouselActiveIndex(0, 260, 12, 5), 0);
});

test('carouselActiveIndex: one full pitch (cardWidth+gap) forward is exactly the next card', () => {
  const pitch = 260 + 12;
  assert.equal(carouselActiveIndex(pitch, 260, 12, 5), 1);
  assert.equal(carouselActiveIndex(pitch * 2, 260, 12, 5), 2);
  assert.equal(carouselActiveIndex(pitch * 4, 260, 12, 5), 4);
});

test('carouselActiveIndex: rounds to the NEAREST card (matches where native momentum scrolling actually stops), not floor/ceil', () => {
  const pitch = 260 + 12;
  assert.equal(carouselActiveIndex(pitch * 1.4, 260, 12, 5), 1, 'closer to card 1 than card 2');
  assert.equal(carouselActiveIndex(pitch * 1.6, 260, 12, 5), 2, 'closer to card 2 than card 1');
  assert.equal(carouselActiveIndex(pitch * 0.5, 260, 12, 5), 1, 'exactly halfway rounds up, same as Math.round');
});

test('carouselActiveIndex: clamps to [0, count-1] - a rubber-banded over/under-scroll never reports an out-of-range card', () => {
  assert.equal(carouselActiveIndex(-40, 260, 12, 5), 0, 'over-scrolled past the start');
  assert.equal(carouselActiveIndex(999999, 260, 12, 5), 4, 'over-scrolled past the end (count=5 -> last index 4)');
});

test('carouselActiveIndex: a single card (count=1) is always index 0, regardless of offset', () => {
  assert.equal(carouselActiveIndex(0, 260, 12, 1), 0);
  assert.equal(carouselActiveIndex(500, 260, 12, 1), 0);
});

test('carouselActiveIndex: no items (count=0) or a degenerate zero pitch never throws', () => {
  assert.equal(carouselActiveIndex(100, 260, 12, 0), 0);
  assert.equal(carouselActiveIndex(100, 0, 0, 5), 0);
});

// --- 3. carouselOffsetForIndex - the exact inverse relationship carouselActiveIndex rounds toward ---

test('carouselOffsetForIndex: index 0 is offset 0 (the same "no jump after mount" resting position)', () => {
  assert.equal(carouselOffsetForIndex(0, 260, 12), 0);
});

test('carouselOffsetForIndex is the inverse of carouselActiveIndex at every exact resting point', () => {
  const cardWidth = 260, gap = 12, count = 6;
  for (let i = 0; i < count; i += 1) {
    const offset = carouselOffsetForIndex(i, cardWidth, gap);
    assert.equal(carouselActiveIndex(offset, cardWidth, gap, count), i, `index ${i} round-trips`);
  }
});

test('carouselOffsetForIndex: a negative index (defensive) never returns a negative offset', () => {
  assert.equal(carouselOffsetForIndex(-3, 260, 12), 0);
});
