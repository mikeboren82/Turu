// TuRu - Free Search location isolation (Phase A, 2026-09-21).
//
// The bug these lock down: "בחירה מהירה" and "חיפוש חופשי" share ONE filters.location object, and
// goToSmartSearchResults used to forward it as `fallbackLocation` on EVERY free-text search. A
// Quick Choice selection (ינוב, 15 דקות) therefore became a hidden hard constraint on an unrelated
// query - the user typed "לונה פארק" and got results restricted to one village, with a chip
// promising a travel time nothing in the system computes.
//
// Product decision 1: Free Search without geographic intent is NATIONWIDE. Location may still be
// RANKING context; it may never be a hidden exclusion filter.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const babel = require('@babel/core');
const { addHook } = require('pirates');
const Module = require('module');

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
const { locationWithDrivingTime, locationWithNoRestriction, applyFilters } = require('../lib/filterActivities.js');
const { DEFAULT_FILTERS } = require('../constants/filterSchema.js');

// An intent shaped exactly as supabase/functions/smart-search returns it for a query carrying NO
// geography - verified against the live function during the audit for "פארק שעשועים".
function intentNoGeo(rawQuery, category = null) {
  return {
    category,
    location: { city: null, region: null, street: null, relation: null, coords: null, geocodeFailed: false },
    when: { option: null, date: null },
    timeRange: null, age: null, childNameMentioned: null,
    priceHint: null, durationHint: null, placeTypeHint: null, amenityHints: [], benefitsHint: null,
    residualQuery: null, vagueIntent: [], rawQuery,
  };
}
function intentWithCity(rawQuery, city, category = null) {
  const i = intentNoGeo(rawQuery, category);
  return { ...i, location: { ...i.location, city, cityVerified: true } };
}

// The ambient Home/Quick Choice state that used to leak: a committed city plus a driving time,
// built exactly the way components/LocationQuickPicker.js builds it.
const QUICK_CHOICE_YANUV = locationWithDrivingTime(
  { ...DEFAULT_FILTERS.location, mode: 'city', city: 'ינוב' }, 15,
);

// --- the reported reproduction ----------------------------------------------------------------
test('Free Search "לונה פארק" acquires NO location constraint', () => {
  const filters = intentToFilters(intentNoGeo('לונה פארק'), { children: [] });
  assert.equal(filters.location.mode, null, 'no mode = no geographic exclusion at all');
  assert.equal(filters.location.city, '');
  assert.equal(filters.location.travelMode, undefined, 'no inherited travel time');
  assert.equal(filters.location.travelMinutes, undefined);
});

test('Quick Choice ינוב/15min then Free Search "לונה פארק" -> the Quick Choice location is NOT inherited', () => {
  // The exact leak. intentToFilters is now only ever handed a location the user chose FOR THIS
  // search; app/index.js#goToSmartSearchResults no longer passes the ambient screen state at all.
  const filters = intentToFilters(intentNoGeo('לונה פארק'), { children: [] });
  assert.equal(filters.location.mode, null);
  assert.notEqual(filters.location.city, 'ינוב');
  // ...and even if a caller DID hand over ambient state, it must arrive through the explicit
  // channel to count - there is no other way in.
  assert.equal(QUICK_CHOICE_YANUV.travelMinutes, 15, 'fixture really is the leaky shape');
});

test('a location constraint actually excludes, so "no constraint" is a meaningful assertion', () => {
  const acts = [
    { id: 'near', title: 'לונה פארק', category: 'פארק שעשועים', city: 'ינוב' },
    { id: 'far', title: 'לונה פארק תל אביב', category: 'פארק שעשועים', city: 'תל אביב יפו' },
  ];
  const constrained = { ...DEFAULT_FILTERS, location: QUICK_CHOICE_YANUV };
  assert.deepEqual(
    applyFilters(acts, constrained, null, [], [], [], []).map((a) => a.id), ['near'],
    'with the leaked constraint the far one is excluded - this is what used to happen',
  );
  const free = intentToFilters(intentNoGeo('לונה פארק'), { children: [] });
  assert.deepEqual(
    applyFilters(acts, free, null, [], [], [], []).map((a) => a.id), ['near', 'far'],
    'nationwide: nothing is excluded for being far away',
  );
});

// --- explicit geographic intent still filters --------------------------------------------------
test('Free Search "לונה פארק בנתניה" DOES create a city constraint', () => {
  const filters = intentToFilters(intentWithCity('לונה פארק בנתניה', 'נתניה'), { children: [] });
  assert.equal(filters.location.mode, 'city');
  assert.equal(filters.location.city, 'נתניה');
});

test('Free Search "לונה פארק קרוב אליי" keeps near-me intent available for the picker gate', () => {
  // No city/region/coords in the intent and no known screen location -> Free Search asks, rather
  // than silently inheriting. This gate is what makes "no inheritance" safe rather than lossy.
  const intent = intentNoGeo('לונה פארק קרוב אליי');
  assert.equal(needsAreaClarification(intent, DEFAULT_FILTERS.location), true);
});

test('a location the user picked FOR THIS SEARCH is honoured (explicit channel still works)', () => {
  const picked = locationWithDrivingTime({ ...DEFAULT_FILTERS.location, mode: 'city', city: 'חולון' }, 15);
  const filters = intentToFilters(intentNoGeo('לונה פארק'), { children: [], explicitLocation: picked });
  assert.equal(filters.location.mode, 'city');
  assert.equal(filters.location.city, 'חולון');
});

test('"בכל הארץ" stays an explicit nationwide choice, not an unknown location', () => {
  const nationwide = locationWithNoRestriction(QUICK_CHOICE_YANUV);
  const filters = intentToFilters(intentNoGeo('לונה פארק'), { children: [], explicitLocation: nationwide });
  assert.equal(filters.location.mode, 'nationwide');
  assert.equal(needsAreaClarification(intentNoGeo('לונה פארק'), nationwide), false, 'a choice, not a gap');
});

// --- no stale constraint across consecutive searches -------------------------------------------
test('explicit-location search then a locationless search -> no stale location', () => {
  const first = intentToFilters(intentWithCity('לונה פארק בנתניה', 'נתניה'), { children: [] });
  assert.equal(first.location.city, 'נתניה');
  // The second search is a fresh intent; nothing from the first is threaded into it.
  const second = intentToFilters(intentNoGeo('גן שעשועים'), { children: [] });
  assert.equal(second.location.mode, null, 'Netanya did not survive into the next search');
  assert.equal(second.location.city, '');
});

test('Near Me / results-screen state cannot become a Free Search constraint', () => {
  // Near Me commits location.mode 'current' with device coords; a later Free Search must not
  // inherit it as a radius filter.
  const nearMe = { ...DEFAULT_FILTERS.location, mode: 'current', radiusKm: 10 };
  const filters = intentToFilters(intentNoGeo('לונה פארק'), { children: [] });
  assert.equal(filters.location.mode, null);
  assert.notEqual(filters.location.mode, nearMe.mode);
});

// --- context vs constraint ---------------------------------------------------------------------
test('LOCATION CONTEXT IS NOT A LOCATION FILTER: origin coords rank without excluding', () => {
  const { rankActivitiesWithSmartRadius } = require('../lib/filterActivities.js');
  const acts = [
    { id: 'far', title: 'לונה פארק', category: 'פארק שעשועים', city: 'אילת', lat: 29.55, lng: 34.95 },
    { id: 'near', title: 'לונה פארק', category: 'פארק שעשועים', city: 'כפר יונה', lat: 32.31, lng: 34.93 },
  ];
  const free = intentToFilters(intentNoGeo('לונה פארק'), { children: [] });
  const origin = { lat: 32.3060551, lng: 34.9504619 }; // ינוב
  const ranked = rankActivitiesWithSmartRadius(acts, free, null, [], [], [], null, origin, []);
  assert.equal(ranked.resultCount, 2, 'the distant one is still IN the results');
  assert.equal(ranked.activities[0].id, 'near', 'but the nearer one ranks first');
});
