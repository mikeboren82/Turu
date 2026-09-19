// בדיקות ל-lib/homeSession.js: שתי ההכרעות הטהורות שתומכות בייצוב-התנהגות עמוד-הבית (ראו
// הביקורת הארכיטקטונית + בקשת-התיקון) - אתחול-ברירות-מחדל מול רענון-במיקוד, והפרדת קרוסלת-
// הגילוי מטיוטת "בחירה מהירה". ניווט הסרגל התחתון (components/BottomNav.js) לא נבדק כאן יותר -
// אחרי בדיקה ממוקדת (ראו lib/homeSession.js) הוברר שכל פריטי-הסרגל צריכים אותה פעולה בדיוק
// (dismissTo), אז ה-resolveBottomNavAction שהבחין ביניהן (2 מקרים בלבד) הוסר - אין יותר החלטה
// לבדוק כפונקציה טהורה, BottomNav.js קורא ל-router.dismissTo ישירות לכל הפריטים. lib/homeSession.js
// עצמו בלי שום import (פונקציות טהורות, אין React/react-native/Supabase) - עדיין דרוש babel-
// commonjs hook כי הקובץ כתוב ב-export syntax (ESM), בדיוק כמו שאר קבצי lib/ בפרויקט. אין STUBS
// (בניגוד לשאר קבצי הבדיקה) - אין מה לסטב, הקובץ הנבדק לא תלוי בכלום.
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

const {
  shouldApplyHomeDefaults, buildCarouselFilters, resolveCommittedHomeLocation,
  buildResultsParams, resolveSmartSearchCoords,
} = require('../lib/homeSession');

// --- 1. shouldApplyHomeDefaults (app/index.js focus effect) ---

test('shouldApplyHomeDefaults: true the first time (not yet initialized) - a fresh Home session should initialize from saved defaults', () => {
  assert.equal(shouldApplyHomeDefaults(false), true);
});

test('shouldApplyHomeDefaults: false once already initialized - regaining focus must not re-apply defaults over an explicit in-session choice', () => {
  assert.equal(shouldApplyHomeDefaults(true), false);
});

// --- 2. resolveCommittedHomeLocation (app/index.js homeLocation) ---

test('resolveCommittedHomeLocation: no committed location yet -> the candidate becomes committed (first-time resolution, e.g. GPS bootstrap or the first city ever picked)', () => {
  const candidate = { mode: 'city', city: 'ינוב' };
  assert.deepEqual(resolveCommittedHomeLocation(null, candidate), candidate);
  assert.deepEqual(resolveCommittedHomeLocation(undefined, candidate), candidate);
});

test('resolveCommittedHomeLocation: a location is already committed -> a new Quick Choice draft edit does NOT overwrite it (the reported bug: picking נתניה in Quick Choice must not silently become the carousel\'s location before submitting)', () => {
  const committed = { mode: 'city', city: 'ינוב' };
  const draftEdit = { mode: 'city', city: 'נתניה' };
  assert.deepEqual(resolveCommittedHomeLocation(committed, draftEdit), committed);
});

// --- 3. buildCarouselFilters (app/index.js recommendations useMemo) ---

test('buildCarouselFilters: strips category entirely regardless of what is drafted in Quick Choice\'s "מה עושים?" field (the reported bug: selecting מוזיאונים must not turn the carousel into a museum carousel)', () => {
  const draftFilters = { category: ['מוזיאון לילדים'], age: ['3-5'], location: { mode: 'city', city: 'ינוב' } };
  const result = buildCarouselFilters(draftFilters, null, { mode: null });
  assert.deepEqual(result.category, []);
});

test('buildCarouselFilters: uses the committed homeLocation, not the live Quick Choice draft location, when a committed location exists', () => {
  const draftFilters = { category: [], age: [], location: { mode: 'city', city: 'נתניה (טיוטה לא-מוגשת)' } };
  const committedHomeLocation = { mode: 'city', city: 'ינוב' };
  const result = buildCarouselFilters(draftFilters, committedHomeLocation, { mode: null });
  assert.deepEqual(result.location, committedHomeLocation);
});

test('buildCarouselFilters: falls back to the given default location when nothing is committed yet (e.g. a guest who has not resolved a location) - not the live draft', () => {
  const draftFilters = { category: [], age: [], location: { mode: 'city', city: 'טיוטה-בלבד' } };
  const defaultLocation = { mode: null };
  const result = buildCarouselFilters(draftFilters, null, defaultLocation);
  assert.deepEqual(result.location, defaultLocation);
});

test('buildCarouselFilters: passes through every other field unchanged (age/when/hour/etc. have no inline Quick Choice draft UI, so they are legitimate carousel personalization)', () => {
  const draftFilters = {
    category: ['משהו'], age: ['0-2', '3-5'], when: { options: ['this_weekend'] }, hour: { option: 'morning' },
    location: { mode: 'current' },
  };
  const result = buildCarouselFilters(draftFilters, { mode: 'current' }, { mode: null });
  assert.deepEqual(result.age, draftFilters.age);
  assert.deepEqual(result.when, draftFilters.when);
  assert.deepEqual(result.hour, draftFilters.hour);
});

// --- 4. buildResultsParams (Home Refactor Phase 2A) ---
// כל הבדיקות למטה משחזרות את הצורה המדויקת שכל אתר-קריאה ב-app/index.js בונה בפועל (ראו
// ההערות ב-lib/homeSession.js) - לא סמנטיקה חדשה, רק ה-behaviour הקיים שנלכד לפני ה-extraction.

test('buildResultsParams: basic Quick Choice submission (handleGo shape) - homeFilters/homeChildAges always JSON-stringified, homeCoords stringified when present', () => {
  const filters = { category: ['גן שעשועים'], age: ['3-5'], location: { mode: 'city', city: 'ינוב' } };
  const coords = { latitude: 32.1, longitude: 34.9 };
  const childAges = [4, 6];
  const result = buildResultsParams({ filters, coords, childAges });
  assert.deepEqual(result, {
    homeFilters: JSON.stringify(filters),
    homeCoords: JSON.stringify(coords),
    homeChildAges: JSON.stringify(childAges),
  });
});

test('buildResultsParams: category selected vs. no category - homeFilters just mirrors whatever filters object is passed, untouched', () => {
  const withCategory = buildResultsParams({ filters: { category: ['מוזיאון'] }, coords: null, childAges: [] });
  const withoutCategory = buildResultsParams({ filters: { category: [] }, coords: null, childAges: [] });
  assert.equal(withCategory.homeFilters, JSON.stringify({ category: ['מוזיאון'] }));
  assert.equal(withoutCategory.homeFilters, JSON.stringify({ category: [] }));
});

test('buildResultsParams: default coordsMode ("always") - falsy coords (null/undefined) become an empty string, the key is still present (matches handleGo/handleAdvancedFilters/handleSpontaneous/navigateToCategoryResults)', () => {
  const withNull = buildResultsParams({ filters: {}, coords: null, childAges: [] });
  const withUndefined = buildResultsParams({ filters: {}, coords: undefined, childAges: [] });
  assert.equal(withNull.homeCoords, '');
  assert.equal(withUndefined.homeCoords, '');
  assert.ok('homeCoords' in withNull);
  assert.ok('homeCoords' in withUndefined);
});

test('buildResultsParams: coordsMode "omit-if-absent" - falsy coords means the homeCoords key is missing entirely, not an empty string (matches goToSmartSearchResults)', () => {
  const result = buildResultsParams({ filters: {}, coords: undefined, childAges: [], coordsMode: 'omit-if-absent' });
  assert.ok(!('homeCoords' in result));
});

test('buildResultsParams: coordsMode "omit-if-absent" with real coords still stringifies them like the default mode', () => {
  const coords = { latitude: 1, longitude: 2 };
  const result = buildResultsParams({ filters: {}, coords, childAges: [], coordsMode: 'omit-if-absent' });
  assert.equal(result.homeCoords, JSON.stringify(coords));
});

test('buildResultsParams: extra flags are merged as-is (openFilters/spontaneous/nearMe are each string "true", not boolean, matching the existing route-param convention)', () => {
  const openFilters = buildResultsParams({ filters: {}, coords: null, childAges: [], extra: { openFilters: 'true' } });
  const spontaneous = buildResultsParams({ filters: {}, coords: null, childAges: [], extra: { spontaneous: 'true' } });
  const nearMe = buildResultsParams({ filters: {}, coords: null, childAges: [], extra: { nearMe: 'true' } });
  assert.equal(openFilters.openFilters, 'true');
  assert.equal(spontaneous.spontaneous, 'true');
  assert.equal(nearMe.nearMe, 'true');
});

test('buildResultsParams: goNearMe shape - coords always present (post permission-check), nearMe flag included alongside a DEFAULT_FILTERS-based filter set', () => {
  const nearMeFilters = { category: [], location: { mode: 'current', radiusKm: null } };
  const coords = { latitude: 32.5, longitude: 35.0 };
  const result = buildResultsParams({ filters: nearMeFilters, coords, childAges: [7], extra: { nearMe: 'true' } });
  assert.deepEqual(result, {
    homeFilters: JSON.stringify(nearMeFilters),
    homeCoords: JSON.stringify(coords),
    homeChildAges: JSON.stringify([7]),
    nearMe: 'true',
  });
});

test('buildResultsParams: childAges serializes an empty array distinctly from a populated one (no personalization vs. active personalization)', () => {
  const empty = buildResultsParams({ filters: {}, coords: null, childAges: [] });
  const populated = buildResultsParams({ filters: {}, coords: null, childAges: [3, 5, 9] });
  assert.equal(empty.homeChildAges, '[]');
  assert.equal(populated.homeChildAges, '[3,5,9]');
});

// --- 5. resolveSmartSearchCoords (goToSmartSearchResults only) ---

test('resolveSmartSearchCoords: address-mode intent with coords wins over deviceCoords, converting {lat,lng} -> {latitude,longitude}', () => {
  const builtFilters = { location: { mode: 'address', coords: { lat: 31.5, lng: 34.8 } } };
  const deviceCoords = { latitude: 99, longitude: 99 };
  assert.deepEqual(resolveSmartSearchCoords(builtFilters, deviceCoords), { latitude: 31.5, longitude: 34.8 });
});

test('resolveSmartSearchCoords: non-address-mode intent falls back to deviceCoords when known', () => {
  const builtFilters = { location: { mode: 'city', city: 'חיפה' } };
  const deviceCoords = { latitude: 32.8, longitude: 34.98 };
  assert.deepEqual(resolveSmartSearchCoords(builtFilters, deviceCoords), deviceCoords);
});

test('resolveSmartSearchCoords: address-mode intent but WITHOUT coords still falls back to deviceCoords (not silently address-mode-locked to nothing)', () => {
  const builtFilters = { location: { mode: 'address' } };
  const deviceCoords = { latitude: 32.8, longitude: 34.98 };
  assert.deepEqual(resolveSmartSearchCoords(builtFilters, deviceCoords), deviceCoords);
});

test('resolveSmartSearchCoords: neither address coords nor deviceCoords known -> undefined (buildResultsParams then omits homeCoords entirely)', () => {
  const builtFilters = { location: { mode: 'city', city: 'ינוב' } };
  assert.equal(resolveSmartSearchCoords(builtFilters, null), undefined);
  assert.equal(resolveSmartSearchCoords(builtFilters, undefined), undefined);
});

test('resolveSmartSearchCoords: location can be missing mode entirely (e.g. no fallback resolved) without throwing', () => {
  const builtFilters = { location: {} };
  assert.equal(resolveSmartSearchCoords(builtFilters, null), undefined);
});
