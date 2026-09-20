// בדיקות ל-lib/activities.js#formatAgeRange - "reliability pass" audit (2026-09-20) סעיף 2:
// מידע-גיל חסר (min_age+max_age שניהם null) פירושו "לא ידוע", לא "מתאים לכל גיל" - התיקון שינה
// רק את הניסוח של הענף הזה (מ"כל הגילאים" ל"לא צוין", domain.activityMeta.ageUnknown), לא את
// שאר הענפים (min בלבד/max בלבד/טווח מלא/גיל בודד) שנשארו כפי שהיו. lib/matchReasons.js#ageMatchFact
// (ההסבר "✓ מתאים לגיל...") כבר טיפל נכון במקרה הזה מלפני התיקון - ראו tests/matchReasons.test.js
// ("missing min_age/max_age is never treated as a match"), לא נגוע כאן שוב.
// אותו require-hook (babel commonjs + סטאבים) כמו tests/filterSummaries.test.js.
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

const { formatAgeRange } = require('../lib/activities');

test('known age range (min != max) -> the full range, unaffected by this fix', () => {
  assert.equal(formatAgeRange(2, 6), 'גילאים 2-6');
});

test('minimum only (max missing) -> "מגיל X", not treated as fully unknown', () => {
  assert.equal(formatAgeRange(3, null), 'מגיל 3');
});

test('maximum only (min missing) -> "עד גיל X", not treated as fully unknown', () => {
  assert.equal(formatAgeRange(null, 12), 'עד גיל 12');
});

test('a single exact age (min === max) -> "גיל X"', () => {
  assert.equal(formatAgeRange(5, 5), 'גיל 5');
});

test('explicit wide range that legitimately covers everyone (e.g. 0-99, entered by a real submitter) is NOT treated as "unknown" - only true null/null is', () => {
  assert.equal(formatAgeRange(0, 99), 'גילאים 0-99');
});

test('THE BUG: both fields missing -> neutral "לא צוין", never the old positive "כל הגילאים" claim', () => {
  const result = formatAgeRange(null, null);
  assert.equal(result, 'לא צוין');
  assert.notEqual(result, 'כל הגילאים');
});

test('both fields missing -> the SAME neutral copy regardless of which is checked first (undefined behaves like null)', () => {
  assert.equal(formatAgeRange(undefined, undefined), 'לא צוין');
});
