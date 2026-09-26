// TuRu - pure carousel-centering math for the Home discovery carousel (2026-09-26, Mobile UI
// Polish). No React/RN here - same "presentational logic extracted to a plain function" pattern
// as lib/homeSession.js, so this is testable with node --test, without a component-rendering
// harness. Two small decisions:
//   1. how much blank padding on EACH side makes the first (and last) card sit dead-center in the
//      viewport, instead of hugging the physical edge like a plain, unpadded horizontal list;
//   2. given a scroll offset, which card is currently the centered one (for the dot pagination
//      and to keep it in sync with native snapping).
// Both assume a fixed card pitch (cardWidth + gap between cards) - not a growing/shrinking layout.

// -> the horizontal padding (applied to BOTH sides of the scrollable content) that centers a
// cardWidth-wide item inside a viewportWidth-wide viewport. Clamped to 0: a viewport narrower
// than the card itself must never produce negative padding (which RN would just clamp to 0
// anyway, but a negative number read directly - e.g. by a test - would be a wrong answer).
function carouselSidePadding(viewportWidth, cardWidth) {
  if (!Number.isFinite(viewportWidth) || !Number.isFinite(cardWidth)) return 0;
  return Math.max(0, (viewportWidth - cardWidth) / 2);
}

// -> the index of the item whose center the scroll offset is currently closest to. offsetX is
// contentOffset.x, measured (like RN's own snapToInterval) from the START of the padded content
// box - i.e. offsetX=0 is exactly the first card's centered resting position when the ScrollView's
// contentContainerStyle carries carouselSidePadding(viewportWidth, cardWidth) as its own
// horizontal padding. Each item's resting offset is a multiple of (cardWidth + gap); rounding
// (not floor/ceil) picks the nearest one, matching where native momentum scrolling actually stops.
// Clamped to [0, count-1] so a rubber-banded over/under-scroll never reports an out-of-range index.
function carouselActiveIndex(offsetX, cardWidth, gap, count) {
  if (!count || count <= 0) return 0;
  const pitch = cardWidth + gap;
  if (!Number.isFinite(offsetX) || !(pitch > 0)) return 0;
  const raw = Math.round(offsetX / pitch);
  return Math.min(Math.max(raw, 0), count - 1);
}

// -> the exact contentOffset.x a ScrollView must be at for `index` to be centered - the inverse of
// carouselActiveIndex's rounding. Not currently used to imperatively scroll (padding alone already
// centers the first card with no post-mount jump - see the component), but kept alongside its
// inverse so the two stay obviously consistent, and so a future explicit "jump to card N" has a
// ready, tested answer instead of a freshly-invented one.
function carouselOffsetForIndex(index, cardWidth, gap) {
  return Math.max(0, index) * (cardWidth + gap);
}

module.exports = { carouselSidePadding, carouselActiveIndex, carouselOffsetForIndex };
