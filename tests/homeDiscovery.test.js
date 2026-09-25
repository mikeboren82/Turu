// בדיקות-איפיון (characterization) ל-buildHomeDiscoveryCandidates (lib/homeDiscovery.js, Home
// Refactor Phase 3A): נועדו לנעול את ההתנהגות הקיימת של קרוסלת-הגילוי (app/index.js) *לפני*
// השינוי - לא ממציאות סמנטיקת-דירוג חדשה. rankActivitiesWithSmartRadius עצמו (lib/filterActivities.js)
// לא שוכפל/שוכתב - רק נבדק כאן דרך ה-wrapper כדי לוודא שהחיווט המדויק (hidden/limit/favorite/
// visited/hasNote/benefitTag/matchReason) נשאר זהה. אותו דפוס STUBS+babel-commonjs-hook בדיוק
// כמו tests/temporalFiltering.test.js.
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
  './supabase': { supabase: {} },
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
addHook(
  (code, filename) => babel.transformSync(code, { filename, babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'] }).code,
  { exts: ['.js'], matcher: (f) => f.startsWith(path.join(ROOT, 'lib')) || f.startsWith(path.join(ROOT, 'constants')) },
);

const { buildHomeDiscoveryCandidates } = require('../lib/homeDiscovery');
const { DEFAULT_FILTERS } = require('../constants/filterSchema');

// --- כלי-עזר: קלט בסיסי ל-buildHomeDiscoveryCandidates, נעים לדריסה חלקית לכל בדיקה ---
const baseInput = (overrides = {}) => ({
  activities: [],
  filters: DEFAULT_FILTERS,
  deviceCoords: null,
  excludedCategories: [],
  benefitClubs: [],
  excludedCities: [],
  originCoords: null,
  excludedRegions: [],
  hiddenIds: new Set(),
  favoriteIds: new Set(),
  visitedIds: new Set(),
  notesByActivity: new Map(),
  childAges: [],
  limit: 8,
  ...overrides,
});

// פעילות סינתטית מינימלית - בלי rating/created_at/imageUrl/description/openHours/benefits
// (כל אלה ניטרליים/0 בניקוד, ראו lib/filterActivities.js scoreActivity), כדי שרק rating
// (כשמוזן במפורש) יקבע סדר בבדיקות-הסדר.
const activity = (id, overrides = {}) => ({
  id, title: `activity-${id}`, category: 'גן שעשועים', city: 'ינוב', lat: null, lng: null, ...overrides,
});

test('buildHomeDiscoveryCandidates: empty catalog -> empty candidate array (no crash on empty state)', () => {
  const result = buildHomeDiscoveryCandidates(baseInput());
  assert.deepEqual(result, []);
});

test('buildHomeDiscoveryCandidates: ranks by score descending - higher rating wins, exact order preserved from the ranker', () => {
  const activities = [
    activity('low', { rating: 2 }),
    activity('high', { rating: 5 }),
    activity('mid', { rating: 3.5 }),
  ];
  const result = buildHomeDiscoveryCandidates(baseInput({ activities }));
  assert.deepEqual(result.map((a) => a.id), ['high', 'mid', 'low']);
});

test('buildHomeDiscoveryCandidates: hidden IDs are removed entirely, relative order of survivors is preserved', () => {
  const activities = [
    activity('a', { rating: 5 }),
    activity('b', { rating: 4 }),
    activity('c', { rating: 3 }),
  ];
  const result = buildHomeDiscoveryCandidates(baseInput({ activities, hiddenIds: new Set(['b']) }));
  assert.deepEqual(result.map((a) => a.id), ['a', 'c']);
});

test('buildHomeDiscoveryCandidates: result is capped at `limit`, keeping the top-scored candidates', () => {
  const activities = ['a', 'b', 'c', 'd', 'e'].map((id, i) => activity(id, { rating: 5 - i }));
  const result = buildHomeDiscoveryCandidates(baseInput({ activities, limit: 3 }));
  assert.deepEqual(result.map((a) => a.id), ['a', 'b', 'c']);
});

test('buildHomeDiscoveryCandidates: favorite/visited/hasNote flags reflect membership in the given sets/map, independent of score/order', () => {
  const activities = [activity('a'), activity('b')];
  const result = buildHomeDiscoveryCandidates(baseInput({
    activities,
    favoriteIds: new Set(['a']),
    visitedIds: new Set(['b']),
    notesByActivity: new Map([['a', 'טקסט הערה']]),
  }));
  const byId = Object.fromEntries(result.map((a) => [a.id, a]));
  assert.equal(byId.a.favorite, true);
  assert.equal(byId.a.visited, false);
  assert.equal(byId.a.hasNote, true);
  assert.equal(byId.b.favorite, false);
  assert.equal(byId.b.visited, true);
  assert.equal(byId.b.hasNote, false);
});

test('buildHomeDiscoveryCandidates: every candidate gets a distance string field (formatDistance is always applied)', () => {
  const result = buildHomeDiscoveryCandidates(baseInput({ activities: [activity('a')] }));
  assert.equal(typeof result[0].distance, 'string');
  assert.ok(result[0].distance.length > 0);
});

test('buildHomeDiscoveryCandidates: benefitTag is null when the activity has no benefits', () => {
  const result = buildHomeDiscoveryCandidates(baseInput({ activities: [activity('a')] }));
  assert.equal(result[0].benefitTag, null);
});

test('buildHomeDiscoveryCandidates: benefitTag is a non-null string when the activity has an active benefit', () => {
  const activities = [activity('a', { benefits: [{ provider: 'club-x', value: '10%', status: 'active' }] })];
  const result = buildHomeDiscoveryCandidates(baseInput({ activities, benefitClubs: ['club-x'] }));
  assert.equal(typeof result[0].benefitTag, 'string');
  assert.ok(result[0].benefitTag.length > 0);
});

test('buildHomeDiscoveryCandidates: matchReason is null when no child ages are given (no personalization to explain)', () => {
  const activities = [activity('a', { min_age: 2, max_age: 6 })];
  const result = buildHomeDiscoveryCandidates(baseInput({ activities, childAges: [] }));
  assert.equal(result[0].matchReason, null);
});

test('buildHomeDiscoveryCandidates: matchReason is a non-null "✓ ..." string when the activity age range fits every given child age', () => {
  const activities = [activity('a', { min_age: 2, max_age: 6 })];
  const result = buildHomeDiscoveryCandidates(baseInput({ activities, childAges: [4] }));
  assert.equal(typeof result[0].matchReason, 'string');
  assert.ok(result[0].matchReason.startsWith('✓'));
});

test('buildHomeDiscoveryCandidates: committed-location filtering is applied end-to-end (city mode excludes non-matching cities), not bypassed by the wrapper', () => {
  const activities = [
    activity('here', { city: 'ינוב' }),
    activity('elsewhere', { city: 'חיפה' }),
  ];
  const filters = { ...DEFAULT_FILTERS, location: { mode: 'city', city: 'ינוב', region: [], radiusKm: null, coords: null } };
  const result = buildHomeDiscoveryCandidates(baseInput({ activities, filters }));
  assert.deepEqual(result.map((a) => a.id), ['here']);
});

test('buildHomeDiscoveryCandidates: excludedCategories/excludedCities are applied end-to-end, same as the pre-extraction inline call', () => {
  const activities = [
    activity('kept', { category: 'טבע', city: 'ינוב' }),
    activity('bad-category', { category: 'מוזיאון', city: 'ינוב' }),
    activity('bad-city', { category: 'טבע', city: 'חיפה' }),
  ];
  const result = buildHomeDiscoveryCandidates(baseInput({
    activities, excludedCategories: ['מוזיאון'], excludedCities: ['חיפה'],
  }));
  assert.deepEqual(result.map((a) => a.id), ['kept']);
});

// --- Result Diversity (2026-09-25, lib/resultDiversity.js) - the carousel's own filters always
// strip category (buildCarouselFilters), so it is always broad discovery: diversify runs BEFORE the
// `limit` slice, so an alternative sitting just past the cut can still make it onto the carousel.

test('diversity: an alternative-category activity ranked just below the limit is pulled into the visible carousel instead of being cut off', () => {
  // Playground-heavy ranking (rating ties, so score order == input order) with one workshop at
  // position 9 - just past a limit of 8. Without diversity it would never be shown at all.
  const activities = [
    ...Array.from({ length: 8 }, (_, i) => activity(`gs-${i}`, { rating: 5 })),
    activity('workshop', { category: 'סדנה', rating: 5 }),
  ];
  const result = buildHomeDiscoveryCandidates(baseInput({ activities, limit: 8 }));
  assert.equal(result.length, 8);
  assert.ok(result.some((a) => a.id === 'workshop'), 'the workshop must be pulled into the top 8, not silently dropped by the limit');
});

test('diversity is skipped entirely when the caller has explicit category intent (defensive - the carousel itself never sets this today, but the shared gate must still work if it ever does)', () => {
  const activities = [
    ...Array.from({ length: 8 }, (_, i) => activity(`gs-${i}`, { rating: 5 })),
    activity('workshop', { category: 'סדנה', rating: 5 }),
  ];
  const filters = { ...DEFAULT_FILTERS, category: ['גן שעשועים'] };
  const result = buildHomeDiscoveryCandidates(baseInput({ activities, filters, limit: 8 }));
  // Explicit category intent: matchesCategoryIntent/hasExactCategoryMatch (lib/filterActivities.js)
  // already restrict the ranked set to גן שעשועים itself, and diversity is bypassed on top of that -
  // the workshop is excluded by the category filter regardless, proving no special-case is needed for
  // "explicit intent + workshop already filtered out" to coexist correctly.
  assert.deepEqual(result.map((a) => a.id).sort(), Array.from({ length: 8 }, (_, i) => `gs-${i}`).sort());
});

test('buildHomeDiscoveryCandidates: Smart Radius expansion still fires when stage-1 (city match) has too few results and originCoords is supplied - a more-distant activity is pulled in rather than left out', () => {
  // מרכז-ינוב בערך (32.0/34.9) - originCoords מייצג את נקודת-הייחוס להרחבה (למשל settlementCoords
  // של homeLocation, ראו app/index.js). 'far' רחוקה מספיק שלא הייתה נכללת ב-city match ישיר
  // (city שונה), אבל בתוך רדיוס-ההרחבה (10 ק"מ) מ-originCoords.
  const origin = { lat: 32.0, lng: 34.9 };
  const nearButWrongCity = activity('far', { city: 'עיר-אחרת', lat: 32.03, lng: 34.93 }); // ~4 ק"מ
  const filters = { ...DEFAULT_FILTERS, location: { mode: 'city', city: 'ינוב', region: [], radiusKm: null, coords: null } };
  const result = buildHomeDiscoveryCandidates(baseInput({
    activities: [nearButWrongCity], filters, originCoords: origin,
  }));
  assert.deepEqual(result.map((a) => a.id), ['far']);
});
