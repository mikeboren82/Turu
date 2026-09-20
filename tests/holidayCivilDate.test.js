// Regression suite for the 2026-09-20 holiday CIVIL-DATE off-by-one bug (see scripts/
// generate-holidays.js#isoDateFromLocalGregDate and its file-header comment for the full root-
// cause writeup). Root cause: the generator computed each event's Gregorian date key via
// `ev.getDate().greg().toISOString().slice(0,10)`, which converts a LOCAL-midnight Date through
// UTC first - on any machine whose system timezone is ahead of UTC (this sandbox runs as
// Asia/Jerusalem) that silently rolls every date back into the previous civil day. It was NOT an
// erev/sunset-semantics bug: lib/jewishCalendar.js's `class` values (erev_yom_tov vs yom_tov vs
// chol_hamoed etc.) already kept erev and the holiday itself as separate facts on separate date
// keys - they were just filed one civil day too early, uniformly, for every single event.
//
// These expected dates are NOT re-derived from constants/holidays.generated.json (an incorrectly
// generated table must not be able to validate itself) - they are transcribed from hebcal.com's
// own published sunset/nightfall ranges (fetched independently while diagnosing this bug) and
// converted to civil days by one fixed, stated rule: a holiday that "begins sunset on Gregorian
// date X" has Erev's civil day = X, and its own first civil day = X+1. Multi-day festivals are
// walked forward day-by-day from there, matching Israel's shorter (non-diaspora) observance where
// relevant (7-day Pesach, 1-day Shavuot, Shemini Atzeret+Simchat Torah combined into one civil day).
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

const { holidaysOnDate } = require('../lib/jewishCalendar.js');
const { resolveHolidayWarning } = require('../lib/hoursPolicy.js');

function classesOn(isoDate) {
  return holidaysOnDate(isoDate).map((h) => h.class).sort();
}
function isErevClass(cls) { return cls === 'erev_yom_tov' || cls === 'erev_yom_kippur'; }

// ---- A. Yom Kippur -----------------------------------------------------------------------
// hebcal.com: "Sun, 20 September sunset - Mon, 21 September nightfall" (2026); "Sun, 10 October
// sunset - Mon, 11 October nightfall" (2027).

test('A. Yom Kippur 2026: erev/holiday/day-after civil dates', () => {
  assert.deepEqual(classesOn('2026-09-20'), ['erev_yom_kippur']); // day before
  assert.deepEqual(classesOn('2026-09-21'), ['yom_kippur']); // holiday civil date
  assert.deepEqual(classesOn('2026-09-22'), []); // day after - no lingering fact
});

test('A2. Yom Kippur 2027 (a different year - not just 2026): same relationship holds', () => {
  assert.deepEqual(classesOn('2027-10-10'), ['erev_yom_kippur']);
  assert.deepEqual(classesOn('2027-10-11'), ['yom_kippur']);
  assert.deepEqual(classesOn('2027-10-12'), []);
});

// ---- B. Rosh Hashanah ----------------------------------------------------------------------
// hebcal.com: "Fri, 11 September sunset - Sun, 13 September nightfall" (2026) - a 2-day Yom Tov.

test('B. Rosh Hashanah 2026: erev + both civil holiday dates, then a genuinely different fact after', () => {
  assert.deepEqual(classesOn('2026-09-11'), ['erev_yom_tov']);
  assert.deepEqual(classesOn('2026-09-12'), ['yom_tov']);
  assert.deepEqual(classesOn('2026-09-13'), ['yom_tov']);
  // the day after Rosh Hashanah is Tzom Gedaliah - a REAL, different fast-day fact, not a leftover
  // Rosh Hashanah classification and not an empty day either.
  assert.deepEqual(classesOn('2026-09-14'), ['minor_fast']);
});

// ---- C. Sukkot ------------------------------------------------------------------------------
// hebcal.com: "Fri, 25 September sunset - Fri, 2 October nightfall" (2026), followed immediately
// by Shemini Atzeret "Fri, 2 October sunset - Sat, 3 October nightfall" (Israel combines Shemini
// Atzeret + Simchat Torah into that single civil day).

test('C. Sukkot 2026: erev, first Yom Tov day, and chol hamoed are NOT flattened into one label', () => {
  assert.deepEqual(classesOn('2026-09-25'), ['erev_yom_tov']);
  assert.deepEqual(classesOn('2026-09-26'), ['yom_tov']); // Sukkot I
  assert.deepEqual(classesOn('2026-09-27'), ['chol_hamoed']); // Sukkot II - distinct from Sukkot I
  assert.deepEqual(classesOn('2026-10-01'), ['chol_hamoed']); // still chol hamoed
  assert.deepEqual(classesOn('2026-10-02'), ['chol_hamoed']); // Hoshana Raba - last chol hamoed day, not yet Shmini Atzeret
  assert.deepEqual(classesOn('2026-10-03'), ['yom_tov']); // Shemini Atzeret (IL: combined with Simchat Torah)
  assert.deepEqual(classesOn('2026-10-04'), []); // genuinely over
});

// ---- D. Pesach (Israel: 7 days, not diaspora's 8) ---------------------------------------------
// hebcal.com: "Wed, 1 April sunset - ..." beginning; Israel's Pesach runs 7 civil days from the
// first Yom Tov day, ending a day earlier than the diaspora's 8-day observance.

test('D. Pesach 2026 (Israel): erev, first day, chol hamoed, and the correct (7-day IL) last day', () => {
  assert.deepEqual(classesOn('2026-04-01').filter(isErevClass), ['erev_yom_tov']); // Ta'anit Bechorot also legitimately falls here
  assert.deepEqual(classesOn('2026-04-02'), ['yom_tov']); // Pesach I
  assert.deepEqual(classesOn('2026-04-05'), ['chol_hamoed']); // a middle chol-hamoed day
  assert.deepEqual(classesOn('2026-04-08'), ['yom_tov']); // Pesach VII - IL's last day
  assert.deepEqual(classesOn('2026-04-09'), []); // day after - IL is done (would still be Pesach in the diaspora, but il:true is what we generate)
});

// ---- E. Shavuot (Israel: 1 day, not diaspora's 2) ---------------------------------------------
// hebcal.com: "Thu, 21 May sunset - ..." beginning; Israel observes a single Yom Tov day.

test('E. Shavuot 2026 (Israel): erev, the single holiday day, and an ordinary day after', () => {
  assert.deepEqual(classesOn('2026-05-21'), ['erev_yom_tov']);
  assert.deepEqual(classesOn('2026-05-22'), ['yom_tov']);
  assert.deepEqual(classesOn('2026-05-23'), []); // IL has only one day - would still be Shavuot in the diaspora
});

// ---- F. Policy warnings follow the corrected calendar facts, not a display-layer patch --------

test('F. hoursPolicy warns on the corrected Erev/Yom Kippur civil dates specifically', () => {
  assert.ok(resolveHolidayWarning('2026-09-20').warning, 'Erev Yom Kippur (correct civil date) should warn');
  assert.ok(resolveHolidayWarning('2026-09-21').warning, 'Yom Kippur (correct civil date) should warn');
  // the OLD (buggy) dates must no longer carry the Yom Kippur warning at all - the calendar fact
  // itself moved, not just its display; a residual warning on 09-19 would mean the fix only
  // patched a symptom instead of the calendar layer.
  assert.equal(resolveHolidayWarning('2026-09-19').warning, null);
  assert.deepEqual(resolveHolidayWarning('2026-09-19').holidays, []);
});

test('F2. representative erev/yom-tov dates across all five holiday families still warn under Phase 1 policy', () => {
  const shouldWarn = [
    '2026-09-11', '2026-09-12', // Rosh Hashanah erev + day 1
    '2026-09-20', '2026-09-21', // Yom Kippur erev + day
    '2026-09-25', '2026-09-26', // Sukkot erev + day 1
    '2026-04-01', '2026-04-02', // Pesach erev + day 1
    '2026-05-21', '2026-05-22', // Shavuot erev + day
  ];
  for (const iso of shouldWarn) {
    assert.ok(resolveHolidayWarning(iso).warning, `${iso} should trigger an hours-may-vary warning`);
  }
});

// ---- Ordinary days must never receive a spurious warning (guards against an over-broad fix) ----

test('ordinary days well outside any holiday window get no calendar facts and no warning', () => {
  for (const iso of ['2026-09-15', '2026-09-16', '2026-06-01', '2026-08-01']) {
    assert.deepEqual(holidaysOnDate(iso), [], `${iso} should have no holiday facts`);
    assert.equal(resolveHolidayWarning(iso).warning, null, `${iso} should not warn`);
  }
});
