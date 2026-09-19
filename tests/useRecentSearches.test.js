// בדיקות ל-lib/useRecentSearches.js (Home Refactor Phase 2B): רק ה-transformation הטהורה
// (addRecentSearch) - הhook עצמו (useState/useEffect/AsyncStorage) דורש רינדור-React אמיתי
// לבדיקה, ואין בפרויקט הזה תשתית react-test-renderer/testing-library (ראו package.json) -
// בהתאם להנחיית-המשימה, לא מוסיפים תשתית-בדיקה כבדה בשביל שלב זה, רק בודקים את הליבה הדטרמיניסטית.
// אותו דפוס babel-commonjs hook כמו tests/homeSession.test.js - ה-matcher מוגבל ל-lib/ בלבד.
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

const { addRecentSearch } = require('../lib/useRecentSearches');

test('addRecentSearch: recording the first search on an empty history returns a single-item list', () => {
  assert.deepEqual(addRecentSearch([], 'גן חיות'), ['גן חיות']);
});

test('addRecentSearch: a new search is prepended (most-recent-first ordering)', () => {
  assert.deepEqual(addRecentSearch(['ישן יותר'], 'חדש'), ['חדש', 'ישן יותר']);
});

test('addRecentSearch: repeating an existing search moves it to the front instead of appearing twice (dedupe by exact string match)', () => {
  const prev = ['פארקים', 'מוזיאונים', 'גן חיות'];
  assert.deepEqual(addRecentSearch(prev, 'מוזיאונים'), ['מוזיאונים', 'פארקים', 'גן חיות']);
});

test('addRecentSearch: history is capped at 5 items - the oldest entry falls off when a 6th is recorded', () => {
  const prev = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(addRecentSearch(prev, 'f'), ['f', 'a', 'b', 'c', 'd']);
  assert.equal(addRecentSearch(prev, 'f').length, 5);
});

test('addRecentSearch: re-recording the most recent search still keeps the list at exactly 5 (no growth from the dedupe+cap interaction)', () => {
  const prev = ['a', 'b', 'c', 'd', 'e'];
  const result = addRecentSearch(prev, 'a');
  assert.deepEqual(result, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(result.length, 5);
});

test('addRecentSearch: dedupe is an exact-string match, NOT case/whitespace-insensitive (existing behavior - no normalization is performed)', () => {
  const prev = ['גן חיות'];
  assert.deepEqual(addRecentSearch(prev, 'גן חיות '), ['גן חיות ', 'גן חיות']);
});
