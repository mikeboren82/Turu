// Regression tests for the reported bug: "Home location search returns zero results while Quick
// Search + filters finds activities in the same area" (2026-09-25).
//
// Root cause (see app/activities.js and lib/homeSession.js#paramsChanged for the full note): a
// React screen-instance-reuse bug in expo-router, NOT a flaw in the canonical location/filter model
// itself (lib/filterActivities.js#applyFilters/matchesLocation). That model was already correct and
// already covered by tests/searchIntent.test.js's TRAVEL_CATALOG suite. This file exists to pin down,
// explicitly and by name, the specific semantics this bug report's own hypotheses were about -
// city='' + mode='current' must not zero out a result, and the Home CTA's canonical location shape
// must return the SAME nearby set as Quick Search's for the same real-world area - so a future change
// cannot silently reintroduce either failure mode even though the actual fix lived elsewhere.
//
// Same require-hook (babel commonjs + stubs) as tests/searchIntent.test.js / tests/i18n.test.js.
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
  './supabase': { supabase: {} }, // lib/activities pulls the Supabase client; no network in tests
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

const { applyFilters } = require('../lib/filterActivities');
const { DEFAULT_FILTERS, DEFAULT_PRECISE_RADIUS_KM } = require('../constants/filterSchema');
const { compactLocationText, locationSummaryText } = require('../lib/i18n/format');

// Netanya-area catalog + one far-away control (~280 km away, Eilat) - mirrors the ticket's own
// "an area around Netanya" repro scenario.
const NETANYA_COORDS = { latitude: 32.3215, longitude: 34.8532 };
const CATALOG = [
  { id: 'n1', title: 'גן שעשועים בנתניה', category: 'גן שעשועים', city: 'נתניה', region: 'השרון', lat: 32.32, lng: 34.85 },
  { id: 'n2', title: 'סדנה בנתניה', category: 'סדנה', city: 'נתניה', region: 'השרון', lat: 32.33, lng: 34.86 },
  { id: 'far', title: 'מוזיאון באילת', category: 'מוזיאון', city: 'אילת', region: 'הדרום והנגב', lat: 29.55, lng: 34.95 },
];
const ids = (list) => list.map((a) => a.id).sort();

// A. Home CTA + current location + coordinates + 10 km -> the query actually receives and applies
// those coordinates/radius (the nearby Netanya activities match, the far one does not).
test('A. Home CTA shape (mode current, empty city, 10km radius) with Netanya coords -> nearby activities match, the Eilat one does not', () => {
  const homeCtaFilters = { ...DEFAULT_FILTERS, location: { mode: 'current', city: '', region: [], radiusKm: 10, coords: null } };
  const result = applyFilters(CATALOG, homeCtaFilters, NETANYA_COORDS, [], [], [], []);
  assert.deepEqual(ids(result), ['n1', 'n2']);
});

// B. Quick Search with an equivalent location (city:'נתניה') -> same nearby set, proving both entry
// points agree on what "the Netanya area" means once they reach the shared filter engine.
test('B. Quick Search shape (mode city, "נתניה") -> the SAME nearby set as the Home CTA above', () => {
  const quickSearchFilters = { ...DEFAULT_FILTERS, location: { mode: 'city', city: 'נתניה', region: [], radiusKm: null, coords: null } };
  const result = applyFilters(CATALOG, quickSearchFilters, null, [], [], [], []);
  assert.deepEqual(ids(result), ['n1', 'n2'], 'city-mode and current-mode must agree on the same real-world area');
});

// C. current-location mode with an empty city string but valid coordinates must NOT produce zero
// results merely because city is empty - this was the report's own leading hypothesis (section 3).
test('C. current mode + city:"" + valid coords -> does not zero out (city is never consulted in current mode)', () => {
  const filters = { ...DEFAULT_FILTERS, location: { mode: 'current', city: '', region: [], radiusKm: 10, coords: null } };
  const result = applyFilters(CATALOG, filters, NETANYA_COORDS, [], [], [], []);
  assert.ok(result.length > 0, 'an empty city string must never be treated as "no matches" for mode:current');
});

// D. The radius chip must never CLAIM a distance restriction ("עד 10 ק"מ ממני") that the query does
// not actually apply. locationSummaryText/compactLocationText only render that "up to Nkm" text for
// travelMode:'driving' (the explicit picker chip, which always sets radiusKm+travelMode together via
// locationWithDrivingTime, lib/filterActivities.js) - so this direction of the report's own leading
// hypothesis (a chip claiming a radius that is not enforced) cannot occur through that path.
test('D1. driving-chip shape (mode current, travelMode driving, radiusKm=10) -> chip shows the SAME 10km actually enforced', () => {
  const withRadius = { mode: 'current', city: '', region: [], travelMode: 'driving', radiusKm: DEFAULT_PRECISE_RADIUS_KM, coords: null };
  assert.match(locationSummaryText(withRadius), new RegExp(String(DEFAULT_PRECISE_RADIUS_KM)), 'chip must show the real radius that is actually applied');
  assert.match(compactLocationText(withRadius), new RegExp(String(DEFAULT_PRECISE_RADIUS_KM)));
});

test('D2. no travel preference + radiusKm=null (nearMe/"מה קרוב?" shape) -> no fabricated distance chip', () => {
  const withoutRadius = { mode: 'current', city: '', region: [], radiusKm: null, coords: null };
  assert.doesNotMatch(locationSummaryText(withoutRadius), /\d/, 'no radius applied (nearMe-style unrestricted search) must never show a fabricated distance chip');
});

// D3. Separately-discovered gap (NOT the reported zero-results cause, left as-is in this fix - see
// final report): handleGo's own auto-locate fallback (app/index.js, "!filters.location?.mode" branch)
// sets radiusKm:10 WITHOUT travelMode:'driving'. Because the "up to Nkm" text requires travelMode
// (see the note above locationSummaryText), that shape's chip reads as a plain "My location" while
// the query IS quietly capped to 10km underneath it - the opposite direction from the report's
// hypothesis (an unstated restriction, not a stated-but-unenforced one). Documented here so this
// does not get "silently fixed" as a side effect of an unrelated change without a deliberate decision.
test('D3 (documents an existing gap, not a regression): radiusKm set without travelMode -> chip stays silent about the 10km cap that IS enforced', () => {
  const homeGoFallbackShape = { mode: 'current', city: '', region: [], radiusKm: 10, coords: null }; // no travelMode
  assert.doesNotMatch(locationSummaryText(homeGoFallbackShape), /\d/, 'current behavior: chip does not mention the radius here (travelMode is required for that branch)');
  const restricted = applyFilters(
    [{ id: 'near', lat: 32.32, lng: 34.85 }, { id: 'far', lat: 29.55, lng: 34.95 }],
    { ...DEFAULT_FILTERS, location: homeGoFallbackShape }, NETANYA_COORDS, [], [], [], []
  );
  assert.deepEqual(ids(restricted), ['near'], 'meanwhile the query really is limited to 10km, undisclosed by the chip above');
});

// F. A normal city-based filter still works standalone (no coordinates involved at all) - the fix
// for A/C must not have narrowed city-mode matching.
test('F. plain city filter (no coords, no current-location involvement) still returns the right activities', () => {
  const filters = { ...DEFAULT_FILTERS, location: { mode: 'city', city: 'נתניה', region: [], radiusKm: null, coords: null } };
  const result = applyFilters(CATALOG, filters, null, [], [], [], []);
  assert.deepEqual(ids(result), ['n1', 'n2']);
});

// Documents the OTHER legitimate current-mode shape in this app ("מה קרוב?"/goNearMe: radiusKm is
// intentionally null, see app/index.js#goNearMe) so it is not confused with the Home CTA bug above -
// null radius means "no distance restriction at all", not "broken", and must keep returning
// everything including the far activity.
test('current mode with radiusKm:null ("מה קרוב?" shape) is intentionally unrestricted - includes the far activity too', () => {
  const filters = { ...DEFAULT_FILTERS, location: { mode: 'current', city: '', region: [], radiusKm: null, coords: null } };
  const result = applyFilters(CATALOG, filters, NETANYA_COORDS, [], [], [], []);
  assert.deepEqual(ids(result), ['far', 'n1', 'n2']);
});
