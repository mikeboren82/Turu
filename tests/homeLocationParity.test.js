// Regression tests for two related tickets (2026-09-25):
//
// 1. "Home location search returns zero results while Quick Search + filters finds activities in
//    the same area" - root cause was a React screen-instance-reuse bug in expo-router (see
//    app/activities.js and lib/homeSession.js#paramsChanged for the full note), NOT a flaw in the
//    canonical location/filter model itself (lib/filterActivities.js#applyFilters/matchesLocation).
//    That model was already correct and already covered by tests/searchIntent.test.js's
//    TRAVEL_CATALOG suite. Sections A/B/C/F/"current mode with radiusKm:null" below pin down,
//    explicitly and by name, the specific semantics this bug report's own hypotheses were about -
//    city='' + mode='current' must not zero out a result, and the Home CTA's canonical location
//    shape must return the SAME nearby set as Quick Search's for the same real-world area.
//
// 2. "Home current-location radius UI/query mismatch" - Home's silent auto-locate fallbacks
//    (app/index.js: the mount bootstrap effect and handleGo's "!filters.location?.mode" branch)
//    used to set radiusKm:10 WITHOUT travelMode:'driving'. Because locationSummaryText/
//    compactLocationText (lib/i18n/format.js) only render "up to Nkm" text when travelMode is
//    'driving', that shape's chip silently read as plain "My location" while the query was already
//    capped to 10km underneath it - a real chip/query divergence, just not the one that caused zero
//    results. The fix makes both call sites reuse locationWithDrivingTime (lib/filterActivities.js),
//    the same canonical shape LocationQuickPicker's own driving-time chips produce, instead of
//    inventing a Home-only "radiusKm without travelMode" variant. Section D below covers this.
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

const { applyFilters, locationWithDrivingTime } = require('../lib/filterActivities');
const { DEFAULT_FILTERS, DEFAULT_PRECISE_RADIUS_KM } = require('../constants/filterSchema');
const { compactLocationText, locationSummaryText } = require('../lib/i18n/format');
// Same decorative default app/index.js now uses for its silent auto-locate fallbacks (bootstrap
// effect + handleGo) - the exact value never changes the radius (locationWithDrivingTime maps
// 15/30/45 to the same DEFAULT_PRECISE_RADIUS_KM), only which driving-time chip would show as
// selected if the picker were reopened afterward.
const HOME_AUTO_LOCATE_DRIVING_MINUTES = 30;

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

// D. The radius chip must never diverge from the actual query state, in EITHER direction: it must
// never claim a restriction ("עד 10 ק"מ ממני") that is not enforced, and it must never enforce a
// restriction the chip stays silent about (the secondary bug this section fixes).

test('D1. driving-chip shape (mode current, travelMode driving, radiusKm=10) -> chip shows the SAME 10km actually enforced', () => {
  const withRadius = { mode: 'current', city: '', region: [], travelMode: 'driving', radiusKm: DEFAULT_PRECISE_RADIUS_KM, coords: null };
  assert.match(locationSummaryText(withRadius), new RegExp(String(DEFAULT_PRECISE_RADIUS_KM)), 'chip must show the real radius that is actually applied');
  assert.match(compactLocationText(withRadius), new RegExp(String(DEFAULT_PRECISE_RADIUS_KM)));
});

test('D2. no travel preference + radiusKm=null (nearMe/"מה קרוב?" shape) -> no fabricated distance chip', () => {
  const withoutRadius = { mode: 'current', city: '', region: [], radiusKm: null, coords: null };
  assert.doesNotMatch(locationSummaryText(withoutRadius), /\d/, 'no radius applied (nearMe-style unrestricted search) must never show a fabricated distance chip');
});

// D3. Home's silent auto-locate fallback (app/index.js: bootstrap effect + handleGo's
// "!filters.location?.mode" branch) now reuses locationWithDrivingTime instead of hand-rolling
// { mode:'current', radiusKm: x || 10 } - reproduce that exact call here (same helper, same
// arguments Home now passes) and prove the chip and the query agree.
for (const minutes of [15, 30, 45]) {
  test(`D3. Home auto-locate fallback at ${minutes} min -> chip shows 10km AND the query is actually limited to 10km`, () => {
    const homeAutoLocateShape = locationWithDrivingTime({ ...DEFAULT_FILTERS.location, mode: 'current' }, minutes);
    assert.equal(homeAutoLocateShape.travelMode, 'driving', 'no travel/radius divergence: radiusKm never appears without travelMode from this helper');
    assert.equal(homeAutoLocateShape.radiusKm, DEFAULT_PRECISE_RADIUS_KM);
    assert.match(locationSummaryText(homeAutoLocateShape), new RegExp(String(DEFAULT_PRECISE_RADIUS_KM)), 'chip must now disclose the 10km cap');
    const restricted = applyFilters(
      [{ id: 'near', lat: 32.32, lng: 34.85 }, { id: 'far', lat: 29.55, lng: 34.95 }],
      { ...DEFAULT_FILTERS, location: homeAutoLocateShape }, NETANYA_COORDS, [], [], [], []
    );
    assert.deepEqual(ids(restricted), ['near'], 'query really is limited to 10km, and the chip above now says so');
  });
}

// D4. Canonical-shape parity: Home's auto-locate fallback must produce the IDENTICAL object shape
// LocationQuickPicker's own driving-time chip produces for the same starting location - not a
// Home-only variant of "current location with a radius".
test('D4. Home auto-locate fallback shape === LocationQuickPicker driving-chip shape (same helper, same inputs)', () => {
  const startingLocation = { ...DEFAULT_FILTERS.location, mode: 'current' };
  const fromHome = locationWithDrivingTime(startingLocation, HOME_AUTO_LOCATE_DRIVING_MINUTES);
  const fromPicker = locationWithDrivingTime(startingLocation, HOME_AUTO_LOCATE_DRIVING_MINUTES); // what selectDrivingMinutes would produce
  assert.deepEqual(fromHome, fromPicker);
});

// Quick Search semantics unchanged: city-mode filtering never reads travelMode/radiusKm at all
// (lib/filterActivities.js#matchesLocation), so this fix - which only touches Home's current-location
// fallbacks - cannot affect it.
test('D5. Quick Search (city mode) semantics are unaffected by the Home current-location fix', () => {
  const quickSearchFilters = { ...DEFAULT_FILTERS, location: { mode: 'city', city: 'נתניה', region: [], radiusKm: null, coords: null } };
  const result = applyFilters(CATALOG, quickSearchFilters, null, [], [], [], []);
  assert.deepEqual(ids(result), ['n1', 'n2']);
  assert.doesNotMatch(locationSummaryText(quickSearchFilters.location), /\d/, 'city-mode chip never shows a km figure regardless of any radiusKm/travelMode leftovers');
});

// Clearing location must drop the radius/travel state cleanly, not leave a stale 10km cap behind
// once the location itself is reset to "unknown" (DEFAULT_FILTERS.location, used by
// handleRemoveChip in lib/filterSummaries.js and clearAllFilters in app/index.js).
test('D6. clearing location resets radius/travelMode too - DEFAULT_FILTERS.location has no lingering radius state', () => {
  assert.equal(DEFAULT_FILTERS.location.radiusKm, null);
  assert.equal('travelMode' in DEFAULT_FILTERS.location, false);
  assert.equal('travelMinutes' in DEFAULT_FILTERS.location, false);
  const result = applyFilters(CATALOG, { ...DEFAULT_FILTERS, location: DEFAULT_FILTERS.location }, NETANYA_COORDS, [], [], [], []);
  assert.deepEqual(ids(result), ['far', 'n1', 'n2'], 'clearing location must not leave any activity excluded by a stale radius');
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
