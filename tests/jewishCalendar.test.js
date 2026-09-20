// lib/jewishCalendar.js - runtime FACT lookup over the pre-generated constants/holidays.generated.json
// (see scripts/generate-holidays.js). No @hebcal/core import at this layer - these tests pin the
// generated table's shape, and a small set of KNOWN 2026 dates as a sanity cross-check.
//
// require-hook (babel commonjs) needed because lib/jewishCalendar.js uses ES `import ... from
// '*.json'` - Node's native ESM loader demands an import-attribute for JSON that Metro/webpack
// (the app's real bundler) doesn't require, so tests route it through babel's CJS transform
// instead, same as tests/temporalFiltering.test.js does for its own lib/ imports.
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

const {
  holidaysOnDate, isHolidayDate, holidayTableRange, remainingFutureYears,
} = require('../lib/jewishCalendar.js');

// Dates below are the independently-verified civil dates (2026-09-20 fix, holiday civil-date
// bug: scripts/generate-holidays.js#isoDateFromLocalGregDate) - cross-checked against hebcal.com's
// own published Gregorian dates, not merely re-derived from this same generated table. Yom Kippur
// 2026: "Sun, 20 September sunset - Mon, 21 September nightfall" -> Erev civil day Sun 2026-09-20,
// Yom Kippur civil day Mon 2026-09-21 (see tests/holidayCivilDate.test.js for the full cross-check
// across Rosh Hashanah/Sukkot/Pesach/Shavuot and multiple years).
test('known 2026 dates resolve to the expected holiday facts', () => {
  const erevYK = holidaysOnDate('2026-09-20');
  assert.equal(erevYK.length, 1);
  assert.equal(erevYK[0].class, 'erev_yom_kippur');
  assert.equal(erevYK[0].isErev, true);
  assert.equal(erevYK[0].nameHe, 'ערב יום כיפור');

  const yomKippur = holidaysOnDate('2026-09-21');
  assert.equal(yomKippur.length, 1);
  assert.equal(yomKippur[0].class, 'yom_kippur');
  assert.equal(yomKippur[0].nameHe, 'יום כיפור');

  const sukkotCholHamoed = holidaysOnDate('2026-09-28');
  assert.equal(sukkotCholHamoed.length, 1);
  assert.equal(sukkotCholHamoed[0].class, 'chol_hamoed');

  const purim = holidaysOnDate('2026-03-03');
  assert.equal(purim.length, 1);
  assert.equal(purim[0].class, 'purim');
});

test('an ordinary date has no holiday facts', () => {
  assert.deepEqual(holidaysOnDate('2026-06-18'), []);
  assert.equal(isHolidayDate('2026-06-18'), false);
});

test('isHolidayDate is true exactly when holidaysOnDate is non-empty', () => {
  assert.equal(isHolidayDate('2026-09-21'), true);
  assert.equal(isHolidayDate('2026-06-18'), false);
});

test('every classified fact carries a well-formed shape', () => {
  const KNOWN_CLASSES = new Set([
    'yom_tov', 'erev_yom_tov', 'yom_kippur', 'erev_yom_kippur', 'chol_hamoed', 'major_fast',
    'minor_fast', 'civic_major', 'civic_minor', 'purim', 'chanukah', 'minor_holiday', 'rosh_chodesh',
  ]);
  for (const isoDate of ['2026-09-20', '2026-09-21', '2026-09-26', '2026-12-05', '2026-04-21']) {
    for (const fact of holidaysOnDate(isoDate)) {
      assert.equal(typeof fact.key, 'string');
      assert.ok(fact.key.length > 0);
      assert.equal(typeof fact.nameHe, 'string');
      assert.ok(/[֐-׿]/.test(fact.nameHe), `nameHe should contain Hebrew: ${fact.nameHe}`);
      assert.equal(typeof fact.nameEn, 'string');
      assert.ok(KNOWN_CLASSES.has(fact.class), `unexpected class: ${fact.class}`);
      assert.equal(typeof fact.isErev, 'boolean');
    }
  }
});

test('coverage: the generated table still has a safe number of future years remaining', () => {
  const SAFE_FUTURE_YEARS = 10; // regenerate (npm run holidays:generate) once this margin gets low
  const years = remainingFutureYears(new Date('2026-09-20'));
  assert.ok(
    years >= SAFE_FUTURE_YEARS,
    `holiday table only covers ${years} more years from 2026 - run "npm run holidays:generate"`,
  );
});

test('the generated table range is internally consistent', () => {
  const range = holidayTableRange();
  assert.ok(/^\d{4}-01-01$/.test(range.start));
  assert.ok(/^\d{4}-12-31$/.test(range.end));
  assert.ok(Number(range.end.slice(0, 4)) > Number(range.start.slice(0, 4)));
});
