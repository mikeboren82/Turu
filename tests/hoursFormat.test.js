// lib/i18n/format.js's Opening Hours Phase 2 string builders (hoursStatusText/hoursDayLabel/
// hoursDayValueText/hoursTodayWarningText/hoursDayWarningText). Real translations are exercised
// (not mocked), same require-hook (babel commonjs + stubs) as tests/filterSummaries.test.js.
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

const {
  hoursStatusText, hoursTodayWarningText, hoursDayWarningText, hoursDayLabel, hoursDayValueText,
} = require('../lib/i18n/format.js');
const { buildTodayStatus, buildUpcomingDays } = require('../lib/hoursDisplay.js');
const { setLocale } = require('../lib/i18n/index.js');

test.beforeEach(() => setLocale('he'));
test.after(() => setLocale('he'));

test('open now with a known closing time', () => {
  const activity = { hoursByDay: { ד: { start: '09:00', end: '18:00' } }, openHours: { start: '09:00', end: '18:00' } };
  const status = buildTodayStatus(activity, { now: new Date('2026-06-17T10:00:00') });
  assert.equal(hoursStatusText(status), '🟢 פתוח עכשיו · עד 18:00');
});

test('closed now, opens later the same day (lunch-break-style gap)', () => {
  const activity = { intervalsByDay: { ד: [{ start: '09:00', end: '12:00' }, { start: '16:00', end: '20:00' }] }, hoursByDay: { ד: { start: '16:00', end: '20:00' } }, openHours: { start: '09:00', end: '20:00' } };
  const status = buildTodayStatus(activity, { now: new Date('2026-06-17T14:00:00') });
  assert.equal(hoursStatusText(status), 'סגור עכשיו · נפתח היום ב־16:00');
});

test('closed now, opens tomorrow', () => {
  const activity = { hoursByDay: { ה: { start: '09:00', end: '18:00' } }, openHours: { start: '09:00', end: '18:00' } };
  const status = buildTodayStatus(activity, { now: new Date('2026-06-17T20:00:00') }); // Wed 20:00, Wed has no hours, Thu (tomorrow) does
  assert.equal(hoursStatusText(status), 'סגור עכשיו · נפתח מחר ב־09:00');
});

test('closed now, opens on a later weekday (not tomorrow)', () => {
  const activity = { hoursByDay: { א: { start: '09:00', end: '12:00' } }, openHours: { start: '09:00', end: '12:00' } };
  const status = buildTodayStatus(activity, { now: new Date('2026-06-16T10:00:00') }); // Tuesday; next opening is Sunday (offset 5)
  assert.equal(hoursStatusText(status), 'סגור עכשיו · נפתח ביום ראשון ב־09:00');
});

test('always open', () => {
  const activity = { hoursByDay: { ד: { start: '00:00', end: '23:59' } }, openHours: { start: '00:00', end: '23:59' } };
  const status = buildTodayStatus(activity, { now: new Date('2026-06-17T03:00:00') });
  assert.equal(hoursStatusText(status), '🟢 פתוח 24 שעות');
});

test('unknown hours falls back to the shared "hours not specified" string', () => {
  const status = buildTodayStatus({ hoursByDay: {}, openHours: null }, { now: new Date('2026-06-17T10:00:00') });
  assert.equal(hoursStatusText(status), 'שעות לא צוינו');
});

test('closed with nothing known to open within the horizon', () => {
  const activity = { occurrences: [{ date: '2099-01-01', start: '10:00', end: '11:00' }], openHours: { start: '10:00', end: '11:00' }, hoursByDay: {} };
  const status = buildTodayStatus(activity, { now: new Date('2026-06-17T10:00:00') });
  assert.equal(hoursStatusText(status), 'סגור עכשיו');
});

test('today holiday warning line - present only when a warning applies', () => {
  const withWarning = buildTodayStatus({ hoursByDay: { א: { start: '09:00', end: '14:00' } }, openHours: { start: '09:00', end: '14:00' } }, { now: new Date('2026-09-20T10:00:00') }); // Erev Yom Kippur
  assert.equal(hoursTodayWarningText(withWarning), '⚠️ היום ערב יום כיפור · השעות עשויות להשתנות');

  const noWarning = buildTodayStatus({ hoursByDay: { ד: { start: '09:00', end: '18:00' } }, openHours: { start: '09:00', end: '18:00' } }, { now: new Date('2026-06-17T10:00:00') });
  assert.equal(hoursTodayWarningText(noWarning), null);
});

test('per-day warning line is compact and generic', () => {
  assert.equal(hoursDayWarningText(), '⚠️ השעות עשויות להשתנות');
});

test('day label: today/tomorrow get the prefix, later days just the weekday', () => {
  const days = buildUpcomingDays({ hoursByDay: {}, openHours: null }, { now: new Date('2026-06-17T10:00:00') }); // Wed
  assert.equal(hoursDayLabel(days[0]), 'היום, רביעי');
  assert.equal(hoursDayLabel(days[1]), 'מחר, חמישי');
  assert.equal(hoursDayLabel(days[2]), 'שישי');
});

test('day label appends the holiday/eve name when present', () => {
  const days = buildUpcomingDays({ hoursByDay: {}, openHours: null }, { now: new Date('2026-09-17T10:00:00') }); // includes Erev Yom Kippur (09-20) and Yom Kippur (09-21)
  const erev = days.find((d) => d.date === '2026-09-20');
  const yk = days.find((d) => d.date === '2026-09-21');
  assert.equal(hoursDayLabel(erev), 'ראשון · ערב יום כיפור');
  assert.equal(hoursDayLabel(yk), 'שני · יום כיפור');
});

test('day value text: intervals win, then closed, then unknown - never conflated', () => {
  const openDay = { state: 'open', intervals: [{ start: '09:00', end: '12:00' }] };
  assert.equal(hoursDayValueText(openDay), '09:00–12:00');

  const multiIntervalDay = { state: 'open', intervals: [{ start: '09:00', end: '12:00' }, { start: '16:00', end: '20:00' }] };
  assert.equal(hoursDayValueText(multiIntervalDay), '09:00–12:00, 16:00–20:00');

  const closedDay = { state: 'closed', intervals: [] };
  assert.equal(hoursDayValueText(closedDay), 'סגור');

  const unknownDay = { state: 'unknown', intervals: [] };
  assert.equal(hoursDayValueText(unknownDay), 'שעות לא ידועות');
  assert.notEqual(hoursDayValueText(unknownDay), hoursDayValueText(closedDay));

  // always_open shows the friendly "24 hours" phrasing in the day list too, not raw 00:00-23:59
  // digits - a deliberate readability choice (task section 9: avoid a spreadsheet-like feel).
  const alwaysOpenDay = { state: 'always_open', intervals: [{ start: '00:00', end: '23:59' }] };
  assert.equal(hoursDayValueText(alwaysOpenDay), 'פתוח 24 שעות');
});

test('English locale produces English strings for the same data', () => {
  setLocale('en');
  const status = buildTodayStatus({ hoursByDay: { ד: { start: '09:00', end: '18:00' } }, openHours: { start: '09:00', end: '18:00' } }, { now: new Date('2026-06-17T10:00:00') });
  assert.equal(hoursStatusText(status), '🟢 Open now · until 18:00');
  const days = buildUpcomingDays({ hoursByDay: {}, openHours: null }, { now: new Date('2026-06-17T10:00:00') });
  assert.equal(hoursDayLabel(days[0]), 'Today, Wed');
});
