// Regenerates constants/holidays.generated.json from @hebcal/core (a DEVELOPMENT-TIME-ONLY
// dependency, see package.json devDependencies - the runtime app never imports @hebcal/core,
// only the generated JSON it produces here; see lib/jewishCalendar.js).
//
// Run: node scripts/generate-holidays.js
//
// Why generated rather than hand-maintained: Hebrew-calendar dates shift every Gregorian year
// (architecture audit section F) - hand-entering them risks exactly the "hardcoded 2026 dates"
// mistake this file exists to avoid. Re-run this script periodically (a coverage test in
// tests/jewishCalendar.test.js fails once the table's remaining future-year margin gets low,
// which is the signal to regenerate) rather than editing the JSON by hand.
//
// @hebcal/core is ESM-only (package.json "type":"module") - loaded here via dynamic import()
// from this otherwise-CommonJS script, which is the standard way to consume an ESM-only package
// from a CJS one-off script.
const fs = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, '..', 'constants', 'holidays.generated.json');
const YEARS_BEFORE = 2;
const YEARS_AFTER = 23; // ~25 years total, comfortably above the coverage test's safety margin

// Curated classification: hebcal emits many events (Parasha, Daf Yomi, Molad, minor school-
// observance days like "Hebrew Language Day"/"Family Day"/"Jabotinsky Day"/"Ben-Gurion Day") that
// carry no commercial opening-hours signal at all. This is the FACT layer only - it assigns a
// `class` to each date-relevant event; lib/hoursPolicy.js (a separate module) decides which
// classes actually warrant an "hours may vary" warning. Keeping this split (calendar fact vs
// TURU policy) is the audit's explicit recommendation (section G) - it lets the warn/no-warn set
// change later without touching this generator or the calendar data at all.
const CIVIC_MAJOR_NAMES = new Set(["Yom HaZikaron", "Yom HaAtzma'ut"]); // meaningful commercial-hours impact (sirens, national day)

function classify(desc, basename, hasFlag, flags) {
  if (desc === 'Yom Kippur') return 'yom_kippur';
  if (desc === 'Erev Yom Kippur') return 'erev_yom_kippur';
  if (/^Chanukah/.test(desc)) return 'chanukah';
  if (/Purim/.test(desc)) return 'purim';
  if (hasFlag(flags.ROSH_CHODESH)) return 'rosh_chodesh';
  if (hasFlag(flags.CHOL_HAMOED)) return 'chol_hamoed';
  if (hasFlag(flags.MAJOR_FAST)) return 'major_fast'; // Tish'a B'Av + its erev
  if (hasFlag(flags.CHAG)) return 'yom_tov';
  if (hasFlag(flags.EREV)) return 'erev_yom_tov'; // Erev Rosh Hashana/Pesach/Shavuot/Sukkot
  if (hasFlag(flags.MINOR_FAST)) return 'minor_fast';
  if (hasFlag(flags.MODERN_HOLIDAY)) return CIVIC_MAJOR_NAMES.has(desc) ? 'civic_major' : 'civic_minor';
  if (hasFlag(flags.MINOR_HOLIDAY)) return 'minor_holiday';
  return 'other';
}

function slug(s) {
  return String(s).toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// @hebcal/core's HDate#greg() returns a plain JS Date constructed as LOCAL midnight of the
// correct Gregorian civil date (i.e. via `new Date(year, month, day)` semantics, not a UTC
// instant) - see @hebcal/hdate's HDate.greg(). Reading it back with LOCAL getters is therefore
// the correct, symmetric way to recover that same civil date, regardless of what timezone this
// script happens to run in.
//
// BUG THIS FIXES (found via the Erev/Yom Kippur civil-date report): the previous version read it
// with `.toISOString().slice(0,10)`, which converts through UTC first. On any machine whose
// system timezone is AHEAD of UTC (this sandbox runs as Asia/Jerusalem, UTC+2/+3) that conversion
// silently rolls local midnight back into the PREVIOUS UTC calendar day - e.g. local midnight
// 2026-09-21 (the correct civil date for Yom Kippur) became "2026-09-20T21:00:00.000Z", sliced to
// "2026-09-20". This shifted EVERY generated date one civil day too early, uniformly (verified:
// all ~2100 events in the table), which is why Erev Yom Kippur/Yom Kippur both looked shifted -
// this was never an erev/sunset semantics bug (see lib/jewishCalendar.js and lib/hoursPolicy.js,
// which already keep erev and the holiday itself as separate facts/classes on separate date keys -
// that separation was correct all along, just filed under the wrong dates).
function isoDateFromLocalGregDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function main() {
  const { HebrewCalendar, Locale, flags } = await import('@hebcal/core');

  const now = new Date();
  const startYear = now.getUTCFullYear() - YEARS_BEFORE;
  const endYear = now.getUTCFullYear() + YEARS_AFTER;

  const events = HebrewCalendar.calendar({
    start: new Date(Date.UTC(startYear, 0, 1)),
    end: new Date(Date.UTC(endYear, 11, 31)),
    il: true, // Israel holiday schedule (single-day Yom Tov, IL-only observances)
    noMinorFast: false,
    noModern: false,
    noRoshChodesh: false,
    noSpecialShabbat: true, // "Shabbat Shuva" etc - not a hours-relevant calendar fact
    omer: false,
    sedrot: false,
    molad: false,
  });

  const days = {};
  let kept = 0;
  let skipped = 0;

  for (const ev of events) {
    const f = ev.getFlags();
    const hasFlag = (bit) => (f & bit) !== 0;
    const desc = ev.getDesc();
    const basename = ev.basename();
    const cls = classify(desc, basename, hasFlag, flags);
    if (cls === 'other') { skipped += 1; continue; }

    const isErev = cls === 'erev_yom_tov' || cls === 'erev_yom_kippur';
    const nameHeBase = Locale.gettext(basename, 'he-x-NoNikud');
    const nameHe = isErev ? `ערב ${nameHeBase}` : nameHeBase;

    const isoDate = isoDateFromLocalGregDate(ev.getDate().greg());
    const key = `${slug(basename)}${isErev ? '-erev' : ''}`;

    if (!days[isoDate]) days[isoDate] = [];
    days[isoDate].push({ key, nameHe, nameEn: desc, class: cls, isErev });
    kept += 1;
  }

  const output = {
    meta: {
      generator: '@hebcal/core',
      generatedAt: new Date().toISOString(),
      rangeStart: `${startYear}-01-01`,
      rangeEnd: `${endYear}-12-31`,
      il: true,
      eventCount: kept,
      skippedEventCount: skipped,
    },
    days,
  };

  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log(`Range: ${output.meta.rangeStart} .. ${output.meta.rangeEnd} | ${kept} holiday-day entries across ${Object.keys(days).length} dates (${skipped} non-commercial calendar events skipped)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
