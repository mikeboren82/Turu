// lib/hoursPolicy.js - TURU's warn/no-warn POLICY layer, kept separate from calendar FACT
// (lib/jewishCalendar.js). See file header comments there for the split's rationale.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const babel = require('@babel/core');
const { addHook } = require('pirates');

const ROOT = path.resolve(__dirname, '..');
addHook(
  (code, filename) => babel.transformSync(code, { filename, babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'] }).code,
  { exts: ['.js'], matcher: (f) => f.startsWith(path.join(ROOT, 'lib')) || f.startsWith(path.join(ROOT, 'constants')) },
);

const { HOLIDAY_WARNING_POLICY, classWarns, resolveHolidayWarning } = require('../lib/hoursPolicy.js');

test('brief\'s explicit WARN list all resolve to true', () => {
  for (const cls of ['yom_tov', 'erev_yom_tov', 'yom_kippur', 'erev_yom_kippur', 'chol_hamoed', 'major_fast', 'civic_major']) {
    assert.equal(classWarns(cls), true, `${cls} should warn by default`);
  }
});

test('brief\'s explicit DO-NOT-WARN list all resolve to false', () => {
  for (const cls of ['rosh_chodesh', 'minor_holiday', 'minor_fast', 'civic_minor']) {
    assert.equal(classWarns(cls), false, `${cls} should NOT warn by default`);
  }
});

test('Purim and Chanukah are configurable and default to warning', () => {
  assert.equal(classWarns('purim'), true);
  assert.equal(classWarns('chanukah'), true);
  // configurability: an override policy can turn them off without touching the module
  const relaxed = { ...HOLIDAY_WARNING_POLICY, purim: false, chanukah: false };
  assert.equal(classWarns('purim', relaxed), false);
  assert.equal(classWarns('chanukah', relaxed), false);
});

test('an unknown class never warns', () => {
  assert.equal(classWarns('something_new'), false);
});

// 2026-09-20 (not 09-19 - see the 2026-09-20 holiday civil-date fix, scripts/generate-holidays.js#
// isoDateFromLocalGregDate): hebcal.com publishes Yom Kippur 2026 as "Sun, 20 September sunset -
// Mon, 21 September nightfall", so Erev's civil day is Sunday 2026-09-20.
test('resolveHolidayWarning: Erev Yom Kippur produces a warning with the Hebrew name', () => {
  const { holidays, warning } = resolveHolidayWarning('2026-09-20');
  assert.equal(holidays.length, 1);
  assert.ok(warning);
  assert.equal(warning.kind, 'holiday_hours_may_vary');
  assert.equal(warning.nameHe, 'ערב יום כיפור');
});

test('resolveHolidayWarning: Rosh Chodesh produces the fact but no warning', () => {
  const { holidays, warning } = resolveHolidayWarning('2026-06-15'); // Rosh Chodesh Tamuz 2026 (day 1 of 2)
  assert.equal(holidays.length, 1);
  assert.equal(holidays[0].class, 'rosh_chodesh');
  assert.equal(warning, null);
});

test('resolveHolidayWarning: an ordinary date has no facts and no warning', () => {
  const { holidays, warning } = resolveHolidayWarning('2026-06-18');
  assert.deepEqual(holidays, []);
  assert.equal(warning, null);
});

test('resolveHolidayWarning: a custom policy is honored (Purim silenced)', () => {
  const noPurimWarning = { ...HOLIDAY_WARNING_POLICY, purim: false };
  const { warning } = resolveHolidayWarning('2026-03-03', noPurimWarning); // Purim 2026
  assert.equal(warning, null);
});
