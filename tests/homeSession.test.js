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
