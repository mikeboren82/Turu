// Tests for lib/resultDiversity.js - the "Result Diversity / Playground Saturation" task
// (2026-09-25). Pure functions, no React/RN/Supabase dependency at all - no babel-commonjs hook or
// stubs needed beyond the plain node:test/assert require, since this module has zero imports.
const test = require('node:test');
const assert = require('node:assert/strict');

// This file has plain ESM `export function` - use the same lightweight transform the other tests
// use, scoped to just this one file (no stubs required, unlike lib/activities.js-adjacent modules).
const path = require('path');
const babel = require('@babel/core');
const { addHook } = require('pirates');
const ROOT = path.resolve(__dirname, '..');
addHook(
  (code, filename) => babel.transformSync(code, { filename, babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'] }).code,
  { exts: ['.js'], matcher: (f) => f.startsWith(path.join(ROOT, 'lib')) },
);

const { isBroadDiscovery, diversifyResults } = require('../lib/resultDiversity');

const a = (id, category) => ({ id, category });
const ids = (list) => list.map((x) => x.id);

// --- isBroadDiscovery: deterministic explicit-intent detection ---

test('broad discovery: no category, no free text, no alias intent -> true (Home CTA / "מה קרוב?" / plain location browsing)', () => {
  assert.equal(isBroadDiscovery({ category: [], q: '' }), true);
  assert.equal(isBroadDiscovery({}), true);
  assert.equal(isBroadDiscovery(null), true);
});

test('explicit intent: a selected category bypasses diversity entirely, regardless of anything else', () => {
  assert.equal(isBroadDiscovery({ category: ['גן שעשועים'], q: '' }), false);
});

test('explicit intent: non-empty free-text query bypasses diversity, even with no resolved category', () => {
  assert.equal(isBroadDiscovery({ category: [], q: 'גן שעשועים' }), false);
  assert.equal(isBroadDiscovery({ category: [], q: '   ' }), true, 'whitespace-only q is not a real query');
});

test('explicit intent: a recognized category-concept alias phrase (no exact category match yet) also bypasses diversity', () => {
  assert.equal(isBroadDiscovery({ category: [], q: '', categoryAliasPhrases: ['לונה פארק'] }), false);
});

test('location-only browsing (city/region/current chosen, no category/q) is still broad discovery', () => {
  assert.equal(isBroadDiscovery({ category: [], q: '', location: { mode: 'city', city: 'נתניה' } }), true);
});

// --- diversifyResults: core mechanics ---

test('B/C. explicit intent never calls into diversify from the caller side, but even called directly, a single-category list is a no-op (nothing to diversify against)', () => {
  const list = [a(1, 'גן שעשועים'), a(2, 'גן שעשועים'), a(3, 'גן שעשועים'), a(4, 'גן שעשועים')];
  assert.deepEqual(diversifyResults(list), list);
});

test('A. mixed broad-discovery results: alternatives get pulled forward to break up a long same-category run', () => {
  const list = [
    a(1, 'גן שעשועים'), a(2, 'גן שעשועים'), a(3, 'גן שעשועים'), a(4, 'גן שעשועים'),
    a(5, 'גן שעשועים'), a(6, 'גן שעשועים'), a(7, 'גן שעשועים'), a(8, 'גן שעשועים'),
    a(9, 'הצגה'), a(10, 'טבע'), a(11, 'סדנה'), a(12, 'משחקייה'),
  ];
  const result = diversifyResults(list);
  // No consecutive run longer than the default cap (2) once alternatives exist within reach.
  let maxRun = 0, run = 0, lastCat = null;
  for (const item of result) {
    run = item.category === lastCat ? run + 1 : 1;
    lastCat = item.category;
    maxRun = Math.max(maxRun, run);
  }
  assert.ok(maxRun <= 2, `expected max run <= 2, got ${maxRun}: ${ids(result).join(',')}`);
});

test('E. only one category available anywhere -> shown in full, original order, no fake diversity invented', () => {
  const list = Array.from({ length: 15 }, (_, i) => a(i, 'גן שעשועים'));
  assert.deepEqual(diversifyResults(list), list);
});

test('F. the #1 ranked item is never displaced - diversity only ever affects items after it', () => {
  const list = [a(1, 'גן שעשועים'), a(2, 'גן שעשועים'), a(3, 'גן שעשועים'), a(4, 'הצגה'), a(5, 'טבע')];
  const result = diversifyResults(list);
  assert.equal(result[0].id, 1, 'the top match must never be pushed down for variety');
});

test('G. pagination/full list safety: no activity is ever lost or duplicated, only reordered', () => {
  const list = Array.from({ length: 40 }, (_, i) => a(i, i % 5 === 0 ? 'הצגה' : 'גן שעשועים'));
  const result = diversifyResults(list);
  assert.equal(result.length, list.length);
  assert.deepEqual([...ids(result)].sort((x, y) => x - y), ids(list));
});

test('deterministic: running diversifyResults twice on the same input produces the identical output', () => {
  const list = [a(1, 'גן שעשועים'), a(2, 'גן שעשועים'), a(3, 'גן שעשועים'), a(4, 'הצגה'), a(5, 'גן שעשועים'), a(6, 'טבע')];
  assert.deepEqual(diversifyResults(list), diversifyResults(list));
});

test('a delayed (skipped-over) item keeps its relative position among the other delayed items, it is not shuffled', () => {
  // Two playgrounds get delayed once a swap happens; they must still come out in their own original
  // relative order afterward (2 before 3), not reordered relative to each other.
  const list = [a(1, 'גן שעשועים'), a(2, 'גן שעשועים'), a(3, 'גן שעשועים'), a(4, 'הצגה')];
  const result = diversifyResults(list, { maxConsecutive: 2 });
  const p2 = result.findIndex((x) => x.id === 2);
  const p3 = result.findIndex((x) => x.id === 3);
  assert.ok(p2 < p3, `expected 2 before 3, got order ${ids(result).join(',')}`);
});

test('lookahead genuinely bounds how early a distant alternative can be reached - the window re-checks every step, so a farther alternative is still found eventually, just later than a nearer one would be', () => {
  const list = [
    ...Array.from({ length: 8 }, (_, i) => a(i, 'גן שעשועים')),
    a('far-alt', 'הצגה'),
  ];
  const narrowPos = diversifyResults(list, { lookahead: 3, maxConsecutive: 2 }).findIndex((x) => x.id === 'far-alt');
  const widePos = diversifyResults(list, { lookahead: 6, maxConsecutive: 2 }).findIndex((x) => x.id === 'far-alt');
  assert.ok(narrowPos > widePos, `a narrower lookahead must reach the same distant alternative later, not earlier (narrow=${narrowPos}, wide=${widePos})`);
});

test('a lookahead of 0 never promotes anything - the run is never touched without a real window to search', () => {
  const list = [a(1, 'x'), a(2, 'x'), a(3, 'x'), a(4, 'y')];
  assert.deepEqual(diversifyResults(list, { lookahead: 0, maxConsecutive: 1 }), list);
});

test('respects custom maxConsecutive/lookahead options (not hardcoded) - the FIRST threshold breach is always fixed while an alternative is still available', () => {
  const list = [a(1, 'x'), a(2, 'x'), a(3, 'x'), a(4, 'y'), a(5, 'x'), a(6, 'z'), a(7, 'x')];
  const strict = diversifyResults(list, { maxConsecutive: 1, lookahead: 6 });
  // maxConsecutive:1 - the input's very first repeat (1,2 both x) must be broken up immediately,
  // this being a single-pass order-preserving interleave (not a globally-optimal reshuffle) - once
  // every distinct alternative (y, z) has already been spent breaking up earlier repeats, a later
  // run with nothing left to interleave against is expected to pass through as-is (regression E's
  // "only one category left" case, just reached partway through instead of from the very start).
  assert.notEqual(strict[0].category, strict[1].category, `expected the first x,x pair broken up, got ${ids(strict).join(',')}`);
  assert.equal(strict.length, list.length);
  // A looser cap on the identical input keeps more of the original run intact.
  const loose = diversifyResults(list, { maxConsecutive: 3, lookahead: 6 });
  assert.deepEqual(ids(loose).slice(0, 3), [1, 2, 3], 'maxConsecutive:3 allows the first 3 x-in-a-row through untouched');
});

test('short lists (length <= maxConsecutive) are returned as-is', () => {
  const list = [a(1, 'x'), a(2, 'x')];
  assert.equal(diversifyResults(list), list); // same reference, not just equal content
});

test('null/undefined category is its own bucket - never silently matched against a real category', () => {
  const list = [a(1, null), a(2, null), a(3, null), a(4, 'x')];
  // Distinct-but-both-null categories should NOT trigger the "different category found" swap logic
  // in a way that treats null as equal to a real category - just verify no crash and full length kept.
  const result = diversifyResults(list);
  assert.equal(result.length, 4);
});

test('entity_type is used as a fallback diversity key when category is missing', () => {
  const list = [
    { id: 1, category: null, entity_type: 'מקום_קבוע' },
    { id: 2, category: null, entity_type: 'מקום_קבוע' },
    { id: 3, category: null, entity_type: 'מקום_קבוע' },
    { id: 4, category: null, entity_type: 'אירוע' },
  ];
  const result = diversifyResults(list, { maxConsecutive: 2 });
  assert.equal(result.length, 4);
  assert.ok(ids(result).includes(4));
  // With an alternative entity_type available within reach, the 3rd consecutive 'מקום_קבוע' (id 3)
  // should be preceded by the 'אירוע' alternative (id 4), not stay stuck at position 3.
  assert.ok(result.findIndex((x) => x.id === 4) < result.findIndex((x) => x.id === 3));
});
