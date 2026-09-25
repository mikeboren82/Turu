// Tests for lib/placeholderImages.js - the placeholder-mapping root cause fix (Card Metadata +
// Placeholder Mapping task, 2026-09-25): גן שעשועים (a public playground) was showing the same
// roller-coaster art as פארק שעשועים (a paid amusement park) about 1/3 of the time, because
// placeholderImageFor picked among ALL of a bucket's images purely by a hash of the activity id,
// with no idea which specific category it was looking at. No react-native/RN component involved -
// require() returns each asset's numeric module id in this Node/Jest-less setup, so assertions
// compare which INDEX within PLAY_AND_FUN a category resolves to, not image content.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const babel = require('@babel/core');
const { addHook } = require('pirates');

const ROOT = path.resolve(__dirname, '..');
addHook(
  (code, filename) => babel.transformSync(code, { filename, babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'] }).code,
  { exts: ['.js'], matcher: (f) => f.startsWith(path.join(ROOT, 'lib')) },
);
// lib/placeholderImages.js does Metro-style require('*.jpg') for each asset - plain Node has no
// loader for that extension. The actual pixel content is irrelevant here (these tests only compare
// WHICH image a category resolves to, by identity) - a require.extensions hook that returns each
// file's own path is a distinct, stable value per asset, exactly like Metro's real numeric module id.
require.extensions['.jpg'] = (mod, filename) => { mod.exports = filename; };

const { placeholderImageFor, PLACEHOLDER_IMAGES } = require('../lib/placeholderImages');

const PLAY_AND_FUN = PLACEHOLDER_IMAGES.PLAY_AND_FUN;
const SWING_IMAGES = new Set([PLAY_AND_FUN[0], PLAY_AND_FUN[1]]);
const RIDE_IMAGE = PLAY_AND_FUN[2];

// Try enough seeds that a hash-based bug (picking from the full 3-image pool instead of the
// category-specific subset) would show up at least once, not just get lucky on a single id.
const SEEDS = Array.from({ length: 30 }, (_, i) => `activity-${i}`);

// --- C/D. Exact category contract: precise concepts never collapse into the wrong art ---

test('A/B. גן שעשועים (playground) always resolves to a swing image, never the roller-coaster ride, across many ids', () => {
  for (const seed of SEEDS) {
    const image = placeholderImageFor('PLAY_AND_FUN', seed, 'גן שעשועים');
    assert.ok(SWING_IMAGES.has(image), `seed=${seed} got the ride image instead of a swing image`);
  }
});

test("ג'ימבורי and משחקייה (indoor play) and טרמפולינות also map to the swing subset - the existing playground asset is the closest fit, no new art needed", () => {
  for (const category of ["ג'ימבורי", 'משחקייה', 'טרמפולינות']) {
    for (const seed of SEEDS.slice(0, 5)) {
      assert.ok(SWING_IMAGES.has(placeholderImageFor('PLAY_AND_FUN', seed, category)), `${category}/${seed}`);
    }
  }
});

test('C. פארק שעשועים (amusement park) always resolves to the roller-coaster/attraction image, never a swing', () => {
  for (const seed of SEEDS) {
    assert.equal(placeholderImageFor('PLAY_AND_FUN', seed, 'פארק שעשועים'), RIDE_IMAGE, `seed=${seed}`);
  }
});

test('גן שעשועים and פארק שעשועים are visually distinguishable for the same id - the whole bug was that they were not', () => {
  for (const seed of SEEDS.slice(0, 10)) {
    const playground = placeholderImageFor('PLAY_AND_FUN', seed, 'גן שעשועים');
    const amusementPark = placeholderImageFor('PLAY_AND_FUN', seed, 'פארק שעשועים');
    assert.notEqual(playground, amusementPark, `seed=${seed}`);
  }
});

// --- Deliberate fallback: exact mapping first, then the pre-existing hash-wide behavior ---

test('unmapped category within PLAY_AND_FUN (e.g. free-text-classified "קרנבל") keeps the old hash-across-the-whole-bucket behavior - deliberate fallback, not a crash or a silent swing-only default', () => {
  const seen = new Set();
  for (const seed of SEEDS) seen.add(placeholderImageFor('PLAY_AND_FUN', seed, 'קרנבל'));
  // With 30 different ids and no category-specific subset, all 3 images in the bucket should still
  // be reachable via the existing hash - proving this path was not accidentally narrowed too.
  assert.equal(seen.size, 3);
});

test('no category argument at all -> unchanged pre-existing behavior (backward compatible, not a breaking change)', () => {
  const seen = new Set();
  for (const seed of SEEDS) seen.add(placeholderImageFor('PLAY_AND_FUN', seed));
  assert.equal(seen.size, 3);
});

test('a category with no exact mapping in a DIFFERENT bucket (e.g. NATURE_AND_ANIMALS has no subsets) is unaffected by this fix', () => {
  const images = PLACEHOLDER_IMAGES.NATURE_AND_ANIMALS;
  assert.equal(placeholderImageFor('NATURE_AND_ANIMALS', 'x', 'חווה'), images[0]);
});

test('same seed always returns the same image (stability across renders/refreshes is unaffected by adding category)', () => {
  const a = placeholderImageFor('PLAY_AND_FUN', 'stable-1', 'גן שעשועים');
  const b = placeholderImageFor('PLAY_AND_FUN', 'stable-1', 'גן שעשועים');
  assert.equal(a, b);
});

test('unknown placeholder group still returns null, regardless of category', () => {
  assert.equal(placeholderImageFor('NOT_A_GROUP', 'x', 'גן שעשועים'), null);
});
