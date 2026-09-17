// בדיקות ל-lib/matchReasons.js: התאמת-גיל לילדים *שנבחרו* (לא כל הפרופיל), "פתוח עכשיו"/"ללא
// הרשמה" רק כשהמידע ידוע, איחוד עם מצב ספונטני (לא שתי שורות מקבילות), ותקרת-2-סיבות. אותו
// require-hook (babel commonjs + סטאב react-native/AsyncStorage) כמו tests/i18n.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');
const { addHook } = require('pirates');

const ROOT = path.resolve(__dirname, '..');
const STUBS = {
  'react-native': { Platform: { OS: 'node' }, StyleSheet: { create: (s) => s } },
  '@react-native-async-storage/async-storage': {
    default: { getItem: async () => null, setItem: async () => {} },
  },
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

const { buildMatchReasons, selectedChildAges } = require('../lib/matchReasons');
const { setLocale } = require('../lib/i18n');

setLocale('he', { persist: false });

const OPEN_ALL_DAY = { openHours: { start: '00:00', end: '23:59' }, availableDays: [] };
const NEVER_OPEN_INFO = { openHours: null, availableDays: [] }; // getOpenNowInfo -> hasScheduleData:false

test('age match: one selected child within range -> singular reason', () => {
  const activity = { min_age: 2, max_age: 6, ...NEVER_OPEN_INFO };
  const reason = buildMatchReasons(activity, { childAges: [4] });
  assert.equal(reason, '✓ מתאים לגיל הילד/ה שנבחר/ה');
});

test('age match: exactly two selected children, both within range -> dual form', () => {
  const activity = { min_age: 2, max_age: 6, ...NEVER_OPEN_INFO };
  const reason = buildMatchReasons(activity, { childAges: [3, 5] });
  assert.equal(reason, '✓ מתאים לגילים של שני הילדים');
});

test('age match: three selected children, all within range -> generic "all selected"', () => {
  const activity = { min_age: 2, max_age: 10, ...NEVER_OPEN_INFO };
  const reason = buildMatchReasons(activity, { childAges: [3, 5, 8] });
  assert.equal(reason, '✓ מתאים לגילים של כל הילדים שנבחרו');
});

test('age match: does NOT claim a match unless it fits every selected child', () => {
  const activity = { min_age: 2, max_age: 6, ...NEVER_OPEN_INFO };
  assert.equal(buildMatchReasons(activity, { childAges: [4, 9] }), null);
});

test('missing min_age/max_age is never treated as a match (no data is not proof of fit)', () => {
  const activity = { min_age: null, max_age: null, ...NEVER_OPEN_INFO };
  assert.equal(buildMatchReasons(activity, { childAges: [5] }), null);
});

test('no selected children -> no age reason (never falls back to "all profile children")', () => {
  const activity = { min_age: 2, max_age: 6, ...NEVER_OPEN_INFO };
  assert.equal(buildMatchReasons(activity, { childAges: [] }), null);
});

test('open now + no registration required, both known -> combined reason', () => {
  const activity = { min_age: null, max_age: null, ...OPEN_ALL_DAY, booking_requirement: 'walk_in' };
  const reason = buildMatchReasons(activity, { childAges: [] });
  assert.equal(reason, '✓ פתוח עכשיו · ללא הרשמה מראש');
});

test('booking_requirement present but requires registration -> no "no registration" claim', () => {
  const activity = { min_age: null, max_age: null, ...OPEN_ALL_DAY, booking_requirement: 'registration_required' };
  const reason = buildMatchReasons(activity, { childAges: [] });
  assert.equal(reason, '✓ פתוח עכשיו');
});

test('closed with no schedule data at all -> no reason invented', () => {
  const activity = { min_age: null, max_age: null, ...NEVER_OPEN_INFO, booking_requirement: null };
  assert.equal(buildMatchReasons(activity, { childAges: [] }), null);
});

test('caps at two reasons: age fits + open now shown, "no registration" silently dropped', () => {
  const activity = { min_age: 2, max_age: 6, ...OPEN_ALL_DAY, booking_requirement: 'walk_in' };
  const reason = buildMatchReasons(activity, { childAges: [4] });
  assert.equal(reason, '✓ מתאים לגיל הילד/ה שנבחר/ה · פתוח עכשיו');
});

test('spontaneous mode: open-now/registration facts are suppressed (buildSpontaneousBadge already covers that row)', () => {
  const activity = { min_age: null, max_age: null, ...OPEN_ALL_DAY, booking_requirement: 'walk_in' };
  assert.equal(buildMatchReasons(activity, { childAges: [], spontaneousActive: true }), null);
});

test('spontaneous mode still surfaces a real age-match reason (not fully suppressed)', () => {
  const activity = { min_age: 2, max_age: 6, ...OPEN_ALL_DAY, booking_requirement: 'walk_in' };
  const reason = buildMatchReasons(activity, { childAges: [4], spontaneousActive: true });
  assert.equal(reason, '✓ מתאים לגיל הילד/ה שנבחר/ה');
});

test('selectedChildAges: only children in the selected id set, skips missing/invalid birthdates', () => {
  const children = [
    { id: 'a', birthdate: '2020-01-01' },
    { id: 'b', birthdate: '2022-06-15' },
    { id: 'c', birthdate: null },
    { id: 'd' /* not selected */ },
  ];
  const selected = new Set(['a', 'b', 'c']);
  const ages = selectedChildAges(children, selected);
  assert.equal(ages.length, 2); // 'c' dropped (no birthdate), 'd' excluded (not selected)
});
