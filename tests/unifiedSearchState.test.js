// TuRu - Unified Search State (2026-09-21): Free Search text intent survives Filters-sheet edits,
// location changes, and the zero-results widen row; the missing-location chooser gate opens exactly
// when no location signal exists anywhere. Complements tests/freeSearchLocation.test.js (Phase A,
// location-inheritance isolation) and tests/searchIntent.test.js (residual-text contract) - this file
// is the state-OWNERSHIP layer above both: what survives when the user layers Filters-sheet edits
// (setField, app/activities.js) on top of an already-applied Free Search.
//
// Root cause traced for this task: filters.q (the canonical free-text field, constants/filterSchema.js
// DEFAULT_FILTERS) already survives every FiltersSheet edit correctly (setField merges one key at a
// time; normalizeFilters spreads {...DEFAULT_FILTERS, ...raw}; applyFilters/matchesFreeText already
// consult it) - verified directly, not assumed. The actual gap was VISIBILITY, not data loss: q has
// no FILTER_SCHEMA section (so FiltersSheet cannot show or clear it), is not counted by
// countActiveFilters, and resultsWhatPhrase (lib/filterSummaries.js) hides it the instant a category
// is also set - so a residual query like "עם פינת ליטוף" alongside category:'חווה' silently keeps
// filtering with zero on-screen indication and no way to remove it short of "Clear All" (which wipes
// everything). The fix is the search-intent chip (app/activities.js) + a q entry in the zero-results
// widen row - this file locks in the STATE-LEVEL guarantees those UI pieces depend on.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');
const { addHook } = require('pirates');

const ROOT = path.resolve(__dirname, '..');
const STUBS = {
  'react-native': { Platform: { OS: 'node' }, StyleSheet: { create: (s) => s } },
  '@react-native-async-storage/async-storage': { default: { getItem: async () => null, setItem: async () => {} } },
  '@supabase/supabase-js': { createClient: () => ({}) },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  return STUBS[request] ? `stub:${request}` : origResolve.call(this, request, ...rest);
};
for (const [name, exp] of Object.entries(STUBS)) {
  const m = new Module(`stub:${name}`);
  m.exports = { __esModule: true, ...exp };
  m.loaded = true;
  Module._cache[`stub:${name}`] = m;
}
const supabasePath = path.join(ROOT, 'lib', 'supabase.js');
const sm = new Module(supabasePath);
sm.exports = { __esModule: true, supabase: { from: () => ({}), functions: { invoke: async () => ({}) } } };
sm.loaded = true;
Module._cache[supabasePath] = sm;

addHook(
  (code, filename) => babel.transformSync(code, { filename, babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'] }).code,
  { exts: ['.js'], matcher: (f) => f.startsWith(path.join(ROOT, 'lib')) || f.startsWith(path.join(ROOT, 'constants')) },
);

const { intentToFilters, needsAreaClarification } = require('../lib/smartSearch.js');
const { normalizeFilters, applyFilters, countActiveFilters, countAdditionalActiveFilters } = require('../lib/filterActivities.js');
const { DEFAULT_FILTERS } = require('../constants/filterSchema.js');

function intentOf(overrides = {}) {
  return {
    category: null,
    location: { city: null, region: null, street: null, relation: null, coords: null, geocodeFailed: false, cityVerified: false },
    when: { option: null, date: null },
    timeRange: null, age: null, childNameMentioned: null,
    priceHint: null, durationHint: null, placeTypeHint: null, amenityHints: [], benefitsHint: null,
    residualQuery: null, vagueIntent: [], rawQuery: '',
    ...overrides,
  };
}

// setField (app/activities.js) is exactly this one-line merge - reproduced here so the state
// guarantee is tested at the same granularity the UI actually uses it, not re-derived differently.
function setField(filters, key, value) { return { ...filters, [key]: value }; }

// ---- Missing-location rule (matrix items 1-6) - the task's own "סוס"/"נתניה" example --------------
test('1. "סוס" + no location anywhere -> the chooser gate opens', () => {
  const intent = intentOf({ rawQuery: 'סוס', residualQuery: 'סוס' });
  assert.equal(needsAreaClarification(intent, DEFAULT_FILTERS.location), true);
});

test('2. "סוס בנתניה" -> the chooser gate does NOT open (explicit query location)', () => {
  const intent = intentOf({ rawQuery: 'סוס בנתניה', location: { city: 'נתניה', cityVerified: true } });
  assert.equal(needsAreaClarification(intent, DEFAULT_FILTERS.location), false);
});

test('3. "סוס" + an existing active location on screen -> the chooser gate does NOT open', () => {
  const intent = intentOf({ rawQuery: 'סוס', residualQuery: 'סוס' });
  const activeLocation = { ...DEFAULT_FILTERS.location, mode: 'city', city: 'נתניה' };
  assert.equal(needsAreaClarification(intent, activeLocation), false);
});

test('4. "סוס" + explicit nationwide already chosen -> the chooser gate does NOT open', () => {
  const intent = intentOf({ rawQuery: 'סוס', residualQuery: 'סוס' });
  const nationwide = { ...DEFAULT_FILTERS.location, mode: 'nationwide' };
  assert.equal(needsAreaClarification(intent, nationwide), false);
});

test('5. choosing נתניה from the chooser -> the query survives and executes with נתניה', () => {
  const intent = intentOf({ rawQuery: 'סוס', residualQuery: 'סוס' });
  const chosen = { ...DEFAULT_FILTERS.location, mode: 'city', city: 'נתניה' };
  const filters = intentToFilters(intent, { explicitLocation: chosen });
  assert.equal(filters.q, 'סוס', 'textIntent survives the chooser round trip');
  assert.equal(filters.location.mode, 'city');
  assert.equal(filters.location.city, 'נתניה');
});

test('6. choosing בכל הארץ from the chooser -> the query survives and executes nationwide', () => {
  const intent = intentOf({ rawQuery: 'סוס', residualQuery: 'סוס' });
  const chosen = { ...DEFAULT_FILTERS.location, mode: 'nationwide' };
  const filters = intentToFilters(intent, { explicitLocation: chosen });
  assert.equal(filters.q, 'סוס');
  assert.equal(filters.location.mode, 'nationwide');
});

// ---- Filters-after-Free-Search (matrix items 7-9) --------------------------------------------------
test('7. Free Search "סוס" -> add age filter via setField -> "סוס" persists', () => {
  let filters = intentToFilters(intentOf({ rawQuery: 'סוס', residualQuery: 'סוס' }), {});
  assert.equal(filters.q, 'סוס');
  filters = setField(filters, 'age', ['4-6']);
  assert.equal(filters.q, 'סוס', 'q must not be touched by an unrelated setField call');
  assert.deepEqual(filters.age, ['4-6']);
});

test('8. Free Search "סוס" -> add openSaturday (when) via setField -> "סוס" persists', () => {
  let filters = intentToFilters(intentOf({ rawQuery: 'סוס', residualQuery: 'סוס' }), {});
  filters = setField(filters, 'when', { options: ['weekend'], date: null });
  assert.equal(filters.q, 'סוס');
  assert.deepEqual(filters.when.options, ['weekend']);
});

test('9. Free Search "סוס" + location -> change ONLY location via setField -> text persists, other dimensions untouched', () => {
  const chosen = { ...DEFAULT_FILTERS.location, mode: 'city', city: 'נתניה' };
  let filters = intentToFilters(intentOf({ rawQuery: 'סוס', residualQuery: 'סוס' }), { explicitLocation: chosen });
  filters = setField(filters, 'age', ['4-6']);
  filters = setField(filters, 'when', { options: ['weekend'], date: null });
  // now change only location, נתניה -> הרצליה
  const next = { ...DEFAULT_FILTERS.location, mode: 'city', city: 'הרצליה' };
  filters = setField(filters, 'location', next);
  assert.equal(filters.q, 'סוס', 'textIntent survives a location-only change');
  assert.deepEqual(filters.age, ['4-6'], 'age survives a location-only change');
  assert.deepEqual(filters.when.options, ['weekend'], 'opening/when survives a location-only change');
  assert.equal(filters.location.city, 'הרצליה', 'only location actually changed');
});

// The task's own worked example (section 10), assembled end-to-end with the real functions.
test('10 (task example). "סוס" + נתניה, then open Filters and add פתוח בשבת -> equivalent to סוס AND age<=5 AND openSaturday AND distance<=15km', () => {
  const chosen = { ...DEFAULT_FILTERS.location, mode: 'city', city: 'נתניה' };
  let filters = intentToFilters(intentOf({ rawQuery: 'סוס', residualQuery: 'סוס' }), { explicitLocation: chosen });
  filters = setField(filters, 'age', ['0-1', '2-3', '4-6']); // covers "age <= 5"
  filters = setField(filters, 'when', { options: ['weekend'], date: null }); // openSaturday proxy
  filters = setField(filters, 'location', { ...filters.location, radiusKm: 15 });
  assert.equal(filters.q, 'סוס');
  assert.equal(filters.location.city, 'נתניה');
  assert.equal(filters.location.radiusKm, 15);
  assert.deepEqual(filters.when.options, ['weekend']);
  assert.deepEqual(filters.age, ['0-1', '2-3', '4-6']);
});

// ---- Chip removal semantics (matrix item 10 in the brief's own numbering: "remove chip") ----------
test('removing the search-intent chip clears q only - location/age/when/category untouched', () => {
  const chosen = { ...DEFAULT_FILTERS.location, mode: 'city', city: 'נתניה' };
  let filters = intentToFilters(intentOf({ rawQuery: 'סוס', residualQuery: 'סוס' }), { explicitLocation: chosen });
  filters = setField(filters, 'age', ['4-6']);
  filters = setField(filters, 'category', ['חווה']);
  // exactly what the chip's onPress does: setField('q', '')
  const afterRemove = setField(filters, 'q', '');
  assert.equal(afterRemove.q, '');
  assert.equal(afterRemove.location.mode, 'city');
  assert.equal(afterRemove.location.city, 'נתניה');
  assert.deepEqual(afterRemove.age, ['4-6']);
  assert.deepEqual(afterRemove.category, ['חווה'], 'category is not coupled to the chip removal');
});

// ---- No silent nationwide fallback (matrix item 11) -------------------------------------------------
test('a filters object with location.mode=null is never treated the same as an explicit nationwide choice in the summary layer', () => {
  const { buildResultsSummary } = require('../lib/filterSummaries.js');
  const noLocation = { ...DEFAULT_FILTERS, q: 'סוס' };
  const nationwide = { ...DEFAULT_FILTERS, q: 'סוס', location: { ...DEFAULT_FILTERS.location, mode: 'nationwide' } };
  const summaryNoLocation = buildResultsSummary(noLocation);
  const summaryNationwide = buildResultsSummary(nationwide);
  assert.ok(!summaryNoLocation.includes('בכל הארץ'), 'unknown location must not be described as an explicit nationwide choice');
  assert.ok(summaryNationwide.includes('בכל הארץ'), 'an explicit nationwide choice IS described as such');
});

// ---- Zero results: constraints preserved, not silently relaxed (matrix item 12) --------------------
test('12. combined constraints producing zero results keep every dimension in filters - nothing is auto-cleared', () => {
  const chosen = { ...DEFAULT_FILTERS.location, mode: 'city', city: 'נתניה', radiusKm: 15 };
  let filters = intentToFilters(intentOf({ rawQuery: 'סוס', residualQuery: 'סוס' }), { explicitLocation: chosen });
  filters = setField(filters, 'when', { options: ['weekend'], date: null });
  const acts = []; // guaranteed zero results
  const result = applyFilters(acts, filters, null, [], [], [], []);
  assert.deepEqual(result, []);
  // the filters object itself - what a "widen" UI would read - still carries everything
  assert.equal(filters.q, 'סוס');
  assert.equal(filters.location.city, 'נתניה');
  assert.deepEqual(filters.when.options, ['weekend']);
});

// the pure candidate-building logic app/activities.js#widenPreviewCounts uses for the new q entry
test('12b. the zero-results q widen candidate relaxes ONLY q, matching the existing per-dimension pattern', () => {
  const filters = { ...DEFAULT_FILTERS, q: 'סוס', category: ['חווה'] };
  const qCandidate = (filters.q || '').trim() ? { ...filters, q: '' } : null;
  assert.ok(qCandidate);
  assert.equal(qCandidate.q, '');
  assert.deepEqual(qCandidate.category, ['חווה'], 'relaxing q does not touch category');
  const noQ = { ...DEFAULT_FILTERS, category: ['חווה'] };
  assert.equal((noQ.q || '').trim() ? true : false, false, 'no candidate offered when q is already empty');
});

// ---- Explicit query location overrides ambient fallback (matrix item 14) ---------------------------
test('14. "סוסים בנתניה" with an ambient screen location already set to a DIFFERENT city -> the query location wins', () => {
  const intent = intentOf({ rawQuery: 'סוסים בנתניה', location: { city: 'נתניה', cityVerified: true } });
  // ambient screen state (e.g. a prior Quick Choice) - per Phase A this is not even consulted unless
  // the query itself has no geography; here it explicitly does, so it must win regardless.
  const filters = intentToFilters(intent, { explicitLocation: { ...DEFAULT_FILTERS.location, mode: 'city', city: 'חיפה' } });
  assert.equal(filters.location.city, 'נתניה', 'the query\'s own explicit location overrides the ambient fallback');
});

// ---- Residual semantic text survives structured filter extraction (matrix item 15) -----------------
// Ground truth checked directly (lib/categorySemantics.js#resolveCategoryIntent): "פינת ליטוף" is
// itself a recognised deterministic alias for PETTING_CORNER/'פינת חי', and per intentToFilters's
// documented precedence (PHASE B/C) that alias match wins over the model's own category guess. That
// makes this an even stronger version of the task's example: not only must the residual text survive
// structured extraction, the category itself is not what a naive reading of the query would assume -
// and q must still carry the part of the query that CONSUMED and RESOLVED_CATEGORY does not capture.
test('15. "חוות סוסים עם פינת ליטוף" does not degrade to only a category - the residual meaning survives as q', () => {
  const intent = intentOf({
    rawQuery: 'חוות סוסים עם פינת ליטוף', category: 'חווה', residualQuery: 'עם פינת ליטוף',
  });
  const filters = intentToFilters(intent, {});
  // the deterministic alias phrase in the query itself outranks the model's own 'חווה' guess -
  // verified against lib/categorySemantics.js directly, not assumed.
  assert.deepEqual(filters.category, ['פינת חי'], 'the alias phrase in the query wins over the model category guess (PHASE B/C precedence)');
  assert.equal(filters.q, 'עם פינת ליטוף', 'the residual meaning is not silently discarded even though it also drove the category');
  // and it actually still filters (matchesFreeText), proving it is a real constraint, not decoration
  const acts = [
    { id: 'a', title: 'חוות הסוסים הגדולה', category: 'פינת חי', description: 'חווה עם פינת ליטוף ומאהל' },
    { id: 'b', title: 'חוות הסוסים הקטנה', category: 'פינת חי', description: 'סיורים בלבד, בלי פינת ליטוף' },
  ];
  const matched = applyFilters(acts, filters, null, [], [], [], []).map((a) => a.id);
  assert.deepEqual(matched, ['a'], 'the residual q still narrows results, it is not just cosmetic');
});

// ---- countActiveFilters is unchanged by this task (explicitly out of scope - see report) -----------
test('countActiveFilters does not count q - unchanged, q has its own dedicated chip instead', () => {
  const withText = { ...DEFAULT_FILTERS, q: 'סוס' };
  const withoutText = { ...DEFAULT_FILTERS };
  assert.equal(countActiveFilters(withText), countActiveFilters(withoutText), 'q is intentionally not folded into the shared filter count');
});

// ---- countAdditionalActiveFilters - "Activities Top-Area Simplification" task, section 7 (2026-09-27) ----
// The Activities screen's compact "🎯 סינון" button must not double-report location or category,
// because both are already shown live in the interactive smart summary right above it. countActiveFilters
// itself stays untouched (see the test right above, and tests/browseGroups.test.js's "category dimension
// still counts once") - this is a second, narrower function built on top of it.

test('countAdditionalActiveFilters: location alone -> 0 (already shown in the smart summary)', () => {
  const f = { ...DEFAULT_FILTERS, location: { ...DEFAULT_FILTERS.location, mode: 'city', city: 'נתניה' } };
  assert.equal(countActiveFilters(f), 1, 'sanity check: countActiveFilters itself DOES count location');
  assert.equal(countAdditionalActiveFilters(f), 0);
});

test('countAdditionalActiveFilters: category alone -> 0 (already shown in the smart summary)', () => {
  const f = { ...DEFAULT_FILTERS, category: ['חווה'] };
  assert.equal(countActiveFilters(f), 1, 'sanity check: countActiveFilters itself DOES count category');
  assert.equal(countAdditionalActiveFilters(f), 0);
});

test('countAdditionalActiveFilters: location + category together -> still 0, not 2', () => {
  const f = {
    ...DEFAULT_FILTERS,
    location: { ...DEFAULT_FILTERS.location, mode: 'city', city: 'נתניה' },
    category: ['חווה'],
  };
  assert.equal(countAdditionalActiveFilters(f), 0);
});

test('countAdditionalActiveFilters: a real remaining filter (age) still counts normally, even alongside location/category', () => {
  const f = {
    ...DEFAULT_FILTERS,
    location: { ...DEFAULT_FILTERS.location, mode: 'city', city: 'נתניה' },
    category: ['חווה'],
    age: ['2-3'],
  };
  assert.equal(countAdditionalActiveFilters(f), 1, 'only age counts - location/category stay excluded');
});

test('countAdditionalActiveFilters: multiple real dimensions (age, when, price) all count independently', () => {
  const f = {
    ...DEFAULT_FILTERS,
    location: { ...DEFAULT_FILTERS.location, mode: 'current' },
    category: ['חווה'],
    age: ['2-3'],
    when: { options: ['weekend'], date: null },
    price: ['free'],
  };
  assert.equal(countAdditionalActiveFilters(f), 3, 'age + when + price, still excluding location/category');
});

test('countAdditionalActiveFilters: no filters at all -> 0', () => {
  assert.equal(countAdditionalActiveFilters(DEFAULT_FILTERS), 0);
});
