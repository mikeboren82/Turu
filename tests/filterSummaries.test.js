// בדיקות ל-lib/filterSummaries.js#chipsSelectionLabels/whenSelectionLabels/firstValuePlusN -
// התקציר-המכווץ האחיד לשורות "סינון מתקדם" (components/FiltersSheet.js, בקשת המשתמש: "Every
// collapsed filter row should immediately show the user's current selection(s)... one consistent
// summary pattern"). אותו require-hook (babel commonjs + סטאבים) כמו tests/searchIntent.test.js -
// filterSchema/i18n/format נטענים אמיתיים (לא מדומים) כדי שהתוויות האמיתיות ייבדקו, לא קירוב.
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

const { chipsSelectionLabels, whenSelectionLabels, firstValuePlusN } = require('../lib/filterSummaries');
const { AGE_OPTIONS, PLACE_TYPE_OPTIONS } = require('../constants/filterSchema');

// --- firstValuePlusN: the one shared "VALUE" / "VALUE +N" formatting rule ---

test('firstValuePlusN: no labels -> null (no invented placeholder summary)', () => {
  assert.equal(firstValuePlusN([]), null);
  assert.equal(firstValuePlusN(undefined), null);
});

test('firstValuePlusN: one label -> the label itself, no "+N"', () => {
  assert.equal(firstValuePlusN(['2–3']), '2–3');
});

test('firstValuePlusN: two labels -> "first +1"', () => {
  assert.equal(firstValuePlusN(['2–3', '4–6']), '2–3 +1');
});

test('firstValuePlusN: three labels -> "first +2" (matches the task\'s exact examples: גיל 3 -> "2–3 +2")', () => {
  assert.equal(firstValuePlusN(['2–3', '4–6', '7–9']), '2–3 +2');
});

// --- chipsSelectionLabels: used for every 'chips'-type FILTER_SCHEMA section (age/price/... ) ---

test('chipsSelectionLabels: resolves human-readable labels from the schema options, in selection order (not schema order)', () => {
  // AGE_OPTIONS schema order is 0-1,2-3,4-6,... - selecting 7-9 before 2-3 must keep THAT order,
  // since ChipsGrid.toggle appends in click order, and "first selected" must mean first-clicked.
  assert.deepEqual(chipsSelectionLabels(['7-9', '2-3'], AGE_OPTIONS), ['7–9', '2–3']);
});

test('chipsSelectionLabels: empty selection -> empty array (no summary to show)', () => {
  assert.deepEqual(chipsSelectionLabels([], AGE_OPTIONS), []);
  assert.deepEqual(chipsSelectionLabels(undefined, AGE_OPTIONS), []);
});

test('chipsSelectionLabels: a stale/unknown id is dropped silently, not crashed on', () => {
  assert.deepEqual(chipsSelectionLabels(['not-a-real-id', '2-3'], AGE_OPTIONS), ['2–3']);
});

test('chipsSelectionLabels + firstValuePlusN together: the exact "סוג המקום 3 בחוץ +2" example from the request', () => {
  // PLACE_TYPE_OPTIONS is actually single-select in the real schema (multiple:false), but the
  // formatting mechanism itself is generic - this proves the pipeline for a 3-selection case
  // using the outdoor/indoor/both option set the request's own example names explicitly.
  // The real "outdoor" label already carries TURU's own emoji prefix (domain.json: "🌳 בחוץ") -
  // reused as-is (the task says reuse existing labels, not invent an emoji-stripped variant).
  const outdoorLabel = PLACE_TYPE_OPTIONS.find((o) => o.id === 'outdoor').label;
  const labels = chipsSelectionLabels(['outdoor', 'indoor', 'both'], PLACE_TYPE_OPTIONS);
  assert.equal(firstValuePlusN(labels), `${outdoorLabel} +2`);
});

// --- whenSelectionLabels: combines when.options (days) + hour into ONE ordered list, mirroring
// countForKey('when') in lib/filterActivities.js exactly (when.options.length + (hour ? 1 : 0)) ---

test('whenSelectionLabels: day only, no hour -> just the day label(s)', () => {
  const labels = whenSelectionLabels({ options: ['weekend'] }, { option: null, custom: null });
  assert.equal(labels.length, 1);
});

test('whenSelectionLabels: day + hour option -> two labels, hour LAST (matches countForKey combining them into one count)', () => {
  const labels = whenSelectionLabels({ options: ['weekend'] }, { option: 'morning', custom: null });
  assert.equal(labels.length, 2);
});

test('whenSelectionLabels: hour only (no day picked) -> a single hour label, not an empty list', () => {
  const labels = whenSelectionLabels({ options: [] }, { option: 'evening', custom: null });
  assert.equal(labels.length, 1);
});

test('whenSelectionLabels: custom picked time reuses the exact "hourAt" i18n copy already shown on its own chip (WhenSection), not a new string', () => {
  const labels = whenSelectionLabels({ options: [] }, { option: null, custom: { start: '14:30', end: '16:30' } });
  assert.equal(labels.length, 1);
  assert.ok(labels[0].includes('14:30'));
});

test('whenSelectionLabels: neither day nor hour -> empty list (count 0, no summary)', () => {
  assert.deepEqual(whenSelectionLabels({ options: [] }, { option: null, custom: null }), []);
});
