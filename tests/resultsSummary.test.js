// בדיקות ל-lib/filterSummaries.js#buildResultsSummary - "TURU — ACTIVITY RESULTS SEARCH SUMMARY"
// (2026-09-20): המשפט "מציג כעת..." שמופיע מעל תוצאות-החיפוש (app/activities.js), נבנה תמיד
// מ-filters מנורמל בלבד (constants/filterSchema.js DEFAULT_FILTERS) - בלי שום מערכת-פרשנות
// מקבילה לחיפוש-חופשי/route-params. חלק מהבדיקות עוברות דרך intentToFilters (lib/smartSearch.js)
// עם intent סינתטי, בדיוק כמו tests/searchIntent.test.js, כדי לוודא שגם ה-flow המלא (חיפוש חופשי)
// מתכנס לאותו תקציר - לא רק filters שנבנו ידנית בבדיקה.
// אותו require-hook (babel commonjs + סטאבים) כמו tests/filterSummaries.test.js/searchIntent.test.js.
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
  './supabase': { supabase: { from: () => ({ select: () => ({ ilike: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) } },
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

const { buildResultsSummary } = require('../lib/filterSummaries');
const { intentToFilters } = require('../lib/smartSearch');
const { locationWithDrivingTime, locationWithNoTravelPreference } = require('../lib/filterActivities');
const { DEFAULT_FILTERS } = require('../constants/filterSchema');

const base = () => JSON.parse(JSON.stringify(DEFAULT_FILTERS));

// --- 13. default/unfiltered state -----------------------------------------------------------

test('default filters (nothing chosen) -> null, "כל הפעילויות" already says it', () => {
  assert.equal(buildResultsSummary(DEFAULT_FILTERS), null);
});

test('buildResultsSummary(null/undefined) -> null, never throws', () => {
  assert.equal(buildResultsSummary(null), null);
  assert.equal(buildResultsSummary(undefined), null);
});

// --- 1. category only -------------------------------------------------------------------------

test('category only -> "מציג כעת <קטגוריה>"', () => {
  const f = { ...base(), category: ['גן שעשועים'] };
  assert.equal(buildResultsSummary(f), 'מציג כעת גן שעשועים');
});

test('category only, 4+ selected -> falls back to the existing "{{count}} קטגוריות" summary (reused, not a new format)', () => {
  const f = { ...base(), category: ['גן שעשועים', 'פארק', 'חווה', 'בריכה'] };
  assert.equal(buildResultsSummary(f), 'מציג כעת 4 קטגוריות');
});

// --- 2. location only --------------------------------------------------------------------------

test('city only -> "מציג כעת פעילויות באזור <עיר>"', () => {
  const f = { ...base(), location: { ...base().location, mode: 'city', city: 'נתניה' } };
  assert.equal(buildResultsSummary(f), 'מציג כעת פעילויות באזור נתניה');
});

test('region only -> "באזור <region>"', () => {
  const f = { ...base(), location: { ...base().location, mode: 'region', region: ['השרון'] } };
  assert.equal(buildResultsSummary(f), 'מציג כעת פעילויות באזור השרון');
});

test('nationwide -> explicit "בכל הארץ" (dedicated prose phrase, not the bare chip label), not treated as "no location"', () => {
  const f = { ...base(), location: { ...base().location, mode: 'nationwide' } };
  assert.equal(buildResultsSummary(f), 'מציג כעת פעילויות בכל הארץ');
});

// --- 3. category + location ---------------------------------------------------------------------

test('category + location -> flow together without a comma (one adverbial clause)', () => {
  const f = { ...base(), category: ['גן שעשועים'], location: { ...base().location, mode: 'city', city: 'נתניה' } };
  assert.equal(buildResultsSummary(f), 'מציג כעת גן שעשועים באזור נתניה');
});

// --- 4. age ---------------------------------------------------------------------------------------

test('age: two contiguous bands merge into one range ("לגילאי 0–3"), matches the request\'s own example', () => {
  const f = { ...base(), category: ['גן שעשועים'], age: ['0-1', '2-3'] };
  assert.equal(buildResultsSummary(f), 'מציג כעת גן שעשועים, לגילאי 0–3');
});

test('age: "13+" band -> "מגיל 13", not a fabricated upper bound', () => {
  const f = { ...base(), category: ['ספורט'], age: ['13+'] };
  assert.equal(buildResultsSummary(f), 'מציג כעת ספורט, מגיל 13');
});

test('age alone (no category/location) is still meaningful context -> summary shown', () => {
  const f = { ...base(), age: ['4-6'] };
  assert.equal(buildResultsSummary(f), 'מציג כעת פעילויות, לגילאי 4–6');
});

// --- 5. travel time (distance) ---------------------------------------------------------------------

test('driving in a CITY -> truthful "ובסביבה" (city-name match + Smart Radius), never a travel-time promise', () => {
  let loc = { ...base().location, mode: 'city', city: 'נתניה' };
  loc = locationWithDrivingTime(loc, 15);
  const f = { ...base(), category: ['גן שעשועים'], location: loc };
  assert.equal(buildResultsSummary(f), 'מציג כעת גן שעשועים באזור נתניה, ובסביבה');
});

test('walking -> "במרחק הליכה"', () => {
  const f = { ...base(), location: { ...base().location, mode: 'current', travelMode: 'walking', radiusKm: 0.75 } };
  assert.equal(buildResultsSummary(f), 'מציג כעת פעילויות קרוב אליי, במרחק הליכה');
});

test('explicit "any distance" (travelMode:"any") is NOT mentioned - an active non-choice, not a constraint', () => {
  const f = { ...base(), location: { ...base().location, mode: 'city', city: 'נתניה', travelMode: 'any' } };
  assert.equal(buildResultsSummary(f), 'מציג כעת פעילויות באזור נתניה');
});

test('no travel preference set at all -> distance omitted entirely (not "0 minutes" or similar)', () => {
  let loc = { ...base().location, mode: 'city', city: 'נתניה' };
  loc = locationWithDrivingTime(loc, 15);
  loc = locationWithNoTravelPreference(loc); // user picked, then explicitly cleared it again
  const f = { ...base(), category: ['גן שעשועים'], location: loc };
  assert.equal(buildResultsSummary(f), 'מציג כעת גן שעשועים באזור נתניה');
});

// --- 6/7. date, date + daypart -----------------------------------------------------------------

test('when: single day option -> day phrase attached directly (no comma)', () => {
  const f = { ...base(), when: { options: ['tomorrow'], date: null } };
  assert.equal(buildResultsSummary(f), 'מציג כעת פעילויות מחר');
});

test('when: day + hour -> "<day> <hour>" combined, matches the request\'s "בשבת בבוקר" shape', () => {
  const f = { ...base(), when: { options: ['weekend'], date: null }, hour: { option: 'morning', custom: null } };
  assert.equal(buildResultsSummary(f), 'מציג כעת פעילויות בסוף השבוע בבוקר');
});

test('when: hour only, no day chosen -> hour phrase alone', () => {
  const f = { ...base(), hour: { option: 'evening', custom: null } };
  assert.equal(buildResultsSummary(f), 'מציג כעת פעילויות בערב');
});

test('when: a specific calendar date formats via the shared formatDate helper, not a raw ISO string', () => {
  const f = { ...base(), when: { options: ['specific'], date: '2026-10-01' } };
  const summary = buildResultsSummary(f);
  assert.ok(summary.startsWith('מציג כעת פעילויות '));
  assert.ok(!summary.includes('2026-10-01'), 'raw ISO date must not leak into the natural-language sentence');
});

test('when: 3+ day options falls back to the existing "{{count}} אפשרויות זמן" summary (reused, not invented)', () => {
  const f = { ...base(), when: { options: ['today', 'tomorrow', 'weekend'], date: null } };
  assert.equal(buildResultsSummary(f), 'מציג כעת פעילויות ב-3 אפשרויות זמן'.replace('ב-3', '3'));
});

// --- 8. category + location + age + travel time (the request's own full worked example) ----------

test('full combination -> matches the shape of the request\'s own example almost verbatim', () => {
  let loc = { ...base().location, mode: 'city', city: 'נתניה' };
  loc = locationWithDrivingTime(loc, 15);
  const f = { ...base(), category: ['גן שעשועים'], location: loc, age: ['0-1', '2-3'] };
  assert.equal(buildResultsSummary(f), 'מציג כעת גן שעשועים באזור נתניה, לגילאי 0–3, ובסביבה');
});

test('advanced-filter change after the original search updates the summary deterministically (same inputs -> same output, different inputs -> different output)', () => {
  let loc = { ...base().location, mode: 'city', city: 'נתניה' };
  const before = { ...base(), category: ['גן שעשועים'], location: loc };
  const beforeSummary = buildResultsSummary(before);
  assert.equal(beforeSummary, 'מציג כעת גן שעשועים באזור נתניה');

  loc = locationWithDrivingTime(loc, 15);
  const after = { ...before, location: loc, age: ['0-1', '2-3'] };
  const afterSummary = buildResultsSummary(after);
  assert.equal(afterSummary, 'מציג כעת גן שעשועים באזור נתניה, לגילאי 0–3, ובסביבה');
  assert.notEqual(beforeSummary, afterSummary);
});

// --- 9. Free Search parsed state (through the real intentToFilters pipeline) ----------------------

test('Free Search: a fully-parsed intent (category+city+age+today) summarizes from the EFFECTIVE filters, not the raw query text', () => {
  const intent = {
    category: 'משחקייה',
    location: { city: 'נתניה', cityVerified: true },
    age: { min: 2, max: 2 },
    when: { option: 'today', date: null },
    timeRange: null,
    priceHint: null, durationHint: null, placeTypeHint: null, amenityHints: [], benefitsHint: null,
    childNameMentioned: null,
    rawQuery: "משחקייה בנתניה היום לילד בן שנתיים",
  };
  const filters = intentToFilters(intent, {});
  const summary = buildResultsSummary(filters);
  assert.equal(summary, 'מציג כעת משחקייה היום באזור נתניה, לגילאי 2–3');
  assert.ok(!summary.includes('שנתיים'), 'must not merely echo the raw free-text query once it was structurally understood');
});

test('Free Search: leftover free text that could NOT be structurally understood is preserved (quoted), not silently dropped', () => {
  const intent = {
    category: null,
    location: { city: null },
    age: null,
    when: { option: null, date: null },
    timeRange: null,
    priceHint: null, durationHint: null, placeTypeHint: null, amenityHints: [], benefitsHint: null,
    childNameMentioned: null,
    rawQuery: 'זהבה ושלושת הדובים',
  };
  const filters = intentToFilters(intent, {});
  const summary = buildResultsSummary(filters);
  assert.ok(summary, 'a leftover free-text query is meaningful context - must not be hidden as if it were the default state');
  assert.ok(summary.includes('זהבה ושלושת הדובים'), 'the unresolved search text must be preserved somewhere in the summary');
});

// --- 10. Quick Choice (Home "בחירה מהירה") --------------------------------------------------------

test('Quick Choice: category + location chosen via the guided-search card -> the exact same summary system, no separate implementation', () => {
  const f = { ...base(), category: ['גן שעשועים'], location: { ...base().location, mode: 'city', city: 'נתניה' } };
  assert.equal(buildResultsSummary(f), 'מציג כעת גן שעשועים באזור נתניה');
});

// --- 11. Near Me ------------------------------------------------------------------------------------

test('Near Me: the exact filters shape goNearMe (app/index.js) produces -> "קרוב אליי", no invented city/coords exposed', () => {
  const f = { ...base(), location: { ...base().location, mode: 'current', radiusKm: null } };
  const summary = buildResultsSummary(f);
  assert.equal(summary, 'מציג כעת פעילויות קרוב אליי');
  assert.ok(!/\d/.test(summary), 'no raw coordinates/numbers should ever leak into the Near Me summary');
});

test('Near Me + a category added afterward via advanced filters -> category leads, "קרוב אליי" still trails as WHERE', () => {
  const f = { ...base(), category: ['פארק'], location: { ...base().location, mode: 'current', radiusKm: null } };
  assert.equal(buildResultsSummary(f), 'מציג כעת פארק קרוב אליי');
});

// --- 14. missing/partial metadata -------------------------------------------------------------------

test('city mode with an empty city string is treated as "no location" (never invents a place name)', () => {
  const f = { ...base(), category: ['גן שעשועים'], location: { ...base().location, mode: 'city', city: '' } };
  assert.equal(buildResultsSummary(f), 'מציג כעת גן שעשועים');
});

test('an unknown/stale age id is dropped silently, not crashed on', () => {
  const f = { ...base(), category: ['גן שעשועים'], age: ['not-a-real-band'] };
  assert.equal(buildResultsSummary(f), 'מציג כעת גן שעשועים');
});

test('hour.custom without both start/end is ignored (no "בין undefined ל-undefined")', () => {
  const f = { ...base(), category: ['פארק'], hour: { option: null, custom: { start: '14:00' } } };
  assert.equal(buildResultsSummary(f), 'מציג כעת פארק');
});

// --- 15. narrow-screen-safe long combination (content correctness here; visual wrapping is
// verified separately in-browser at ~375px/~320px, not something Node can assert) -------------------

test('a long combination of every fragment still produces one well-formed sentence, no double spaces/commas', () => {
  let loc = { ...base().location, mode: 'region', region: ['השרון', 'גוש דן והמרכז'] };
  loc = locationWithDrivingTime(loc, 30);
  const f = {
    ...base(),
    category: ['גן שעשועים', 'פארק'],
    location: loc,
    age: ['2-3', '4-6'],
    when: { options: ['weekend'], date: null },
    hour: { option: 'morning', custom: null },
  };
  const summary = buildResultsSummary(f);
  assert.ok(!summary.includes('  '), 'no double spaces');
  assert.ok(!summary.includes(' ,'), 'no space-before-comma artifacts');
  // הקטגוריות מצטרפות עם "ו" (listJoin, אותו מנגנון בדיוק כמו categorySummary בכל מקום אחר
  // באפליקציה - לא פסיק) - "גן שעשועים ופארק", לא "גן שעשועים, פארק".
  assert.equal(summary, 'מציג כעת גן שעשועים ופארק בסוף השבוע בבוקר באזור השרון, גוש דן והמרכז, לגילאי 2–6, ובסביבה');
});
