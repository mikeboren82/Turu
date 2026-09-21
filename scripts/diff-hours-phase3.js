// Opening Hours PHASE 3 differential harness (task section 11) - compares the FROZEN pre-Phase-3
// open-now implementation against the corrected one across the REAL production catalogue, and
// CLASSIFIES every difference by which of the phase's deliberate corrections caused it.
//
// This is the opposite contract from scripts/diff-hours-resolver.js, which was a parity lock
// ("prove nothing changed") for the Foundation phase. Phase 3 fixes known legacy bugs, so a
// non-zero difference count is the EXPECTED, correct outcome. The bar is instead:
//     every difference falls into a named, intended category, and UNEXPECTED is zero.
// Forcing this number back to zero by weakening the fix would defeat the purpose.
//
// "Old" is not re-typed from memory: it is literally `git show <BASE_COMMIT>:lib/hoursResolver.js`,
// materialised into a temp file with its two relative imports repointed at the (unchanged) real
// modules, so the comparison cannot drift from what actually shipped.
//
// Run: node scripts/diff-hours-phase3.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const babel = require('@babel/core');
const { addHook } = require('pirates');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// INTENTIONALLY PINNED to the frozen pre-Phase-3 baseline commit ("style: polish weekly opening
// hours presentation" - the tree Phase 3 started from and diffed against throughout). This stays
// df859fa even after Phase 3 itself is committed on top of it - the whole point of this harness is
// "what did Phase 3 change relative to the code that shipped before it", so it must NOT be updated
// to HEAD (dynamically or otherwise) as Phase 3 and later work land. Only repoint this if a FUTURE
// phase needs a new frozen baseline for ITS OWN before/after comparison - never as routine upkeep.
const BASE_COMMIT = 'df859fa';

const STUBS = {
  'react-native': { Platform: { OS: 'node' }, StyleSheet: { create: (s) => s } },
  '@react-native-async-storage/async-storage': { default: { getItem: async () => null, setItem: async () => {} } },
};
const Module = require('module');
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

const LEGACY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'turu-phase3-legacy-'));
const LEGACY_FILE = path.join(LEGACY_DIR, 'legacyHoursResolver.js');
function materialiseLegacyResolver() {
  const source = execFileSync('git', ['show', `${BASE_COMMIT}:lib/hoursResolver.js`], { cwd: ROOT, encoding: 'utf8' });
  const libDir = path.join(ROOT, 'lib').replace(/\\/g, '/');
  const repointed = source.replace(/from '\.\/([a-zA-Z]+)'/g, (_, mod) => `from '${libDir}/${mod}'`);
  fs.writeFileSync(LEGACY_FILE, repointed);
}
materialiseLegacyResolver();

addHook(
  (code, filename) => babel.transformSync(code, { filename, babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'] }).code,
  {
    exts: ['.js'],
    matcher: (f) => f.startsWith(path.join(ROOT, 'lib')) || f.startsWith(path.join(ROOT, 'constants')) || f === LEGACY_FILE,
  },
);

const { getOpenStatus: getOpenStatusOld } = require(LEGACY_FILE);
const { getOpenStatus: getOpenStatusNew, intervalBounds, addDaysToIsoDate, resolveHoursForDate } = require('../lib/hoursResolver');
const { summarizeSchedules } = require('../lib/scheduleSummary');
const { toJerusalemParts } = require('../lib/jerusalemTime');

const SUPABASE_URL = 'https://kkvgzubwsjsbqxzjejcs.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_t1vcj_DxtlmdSeCt1AW6HA_LrXrZaI-';
const PAGE_SIZE = 1000;

async function fetchAllSchedules() {
  const rows = [];
  let offset = 0;
  for (;;) {
    const url = `${SUPABASE_URL}/rest/v1/activities?select=id,name,entity_type,activity_schedules(schedule_type,day_of_week,start_time,end_time,one_time_date)&status=eq.approved&order=id.asc&offset=${offset}&limit=${PAGE_SIZE}`;
    const res = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY } });
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

function buildActivity(row) {
  const { availableDays, openHours, occurrences, hoursByDay, intervalsByDay } = summarizeSchedules(row.activity_schedules);
  return { id: row.id, name: row.name, entity_type: row.entity_type, availableDays, openHours, occurrences, hoursByDay, intervalsByDay };
}

function hasScheduleSignal(a) {
  return (a.hoursByDay && Object.keys(a.hoursByDay).length > 0) || !!a.openHours || (a.occurrences && a.occurrences.length > 0);
}

// The UTC instant at which Jerusalem's civil clock reads isoDate/hhmm (same inverse as
// tests/support/jerusalemInstant.js).
function jerusalemInstant(isoDate, hhmm) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const [hour, minute] = hhmm.split(':').map(Number);
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (ms) => toJerusalemParts(new Date(ms)).utcOffsetMinutes;
  let epoch = wallClockAsUtc - offsetAt(wallClockAsUtc) * 60000;
  epoch = wallClockAsUtc - offsetAt(epoch) * 60000;
  return new Date(epoch);
}

// A Date whose DEVICE-LOCAL wall clock reads what Jerusalem's reads at `instant`. Feeding this to
// the OLD (device-local) implementation isolates the timezone correction from everything else:
// old(instant) vs old(aligned) is purely "what did the device's timezone change", and
// old(aligned) vs new(instant) is purely "what did the interval-math corrections change".
function deviceAlignedInstant(instant) {
  const jerusalemOffset = toJerusalemParts(instant).utcOffsetMinutes;
  const deviceOffset = -instant.getTimezoneOffset();
  return new Date(instant.getTime() + (jerusalemOffset - deviceOffset) * 60000);
}

const TIMES = ['00:30', '02:00', '06:00', '08:59', '10:00', '14:30', '20:00', '23:30'];
const DEVICE_TIMEZONES = ['Asia/Jerusalem', 'UTC', 'America/New_York'];

function isoDatesFromToday(count) {
  const start = toJerusalemParts(new Date()).isoDate;
  return Array.from({ length: count }, (_, i) => addDaysToIsoDate(start, i));
}

function sameResult(a, b) {
  return a.isOpen === b.isOpen
    && a.hasScheduleData === b.hasScheduleData
    && a.minutesUntilClose === b.minutesUntilClose
    && a.minutesUntilOpenToday === b.minutesUntilOpenToday;
}

const RESOLVE_OPTS = { strictness: 'display', useIntervalsByDay: true };

// Why did old and new disagree here? Categories are additive - one difference can legitimately be
// caused by more than one correction at once, and every one that applies is counted.
function classify(activity, instant) {
  const reasons = new Set();
  const aligned = deviceAlignedInstant(instant);
  const old = getOpenStatusOld(activity, { now: instant });
  const oldOnJerusalemClock = getOpenStatusOld(activity, { now: aligned });
  const fresh = getOpenStatusNew(activity, { now: instant });

  // A. Jerusalem timezone correction - the same activity+instant answered differently once the
  // device's own clock stopped deciding what "today"/"now" mean.
  if (!sameResult(old, oldOnJerusalemClock)) reasons.add('A_jerusalem_timezone');

  // Everything below explains the REMAINING delta: the interval math itself, evaluated on the
  // Jerusalem clock both sides.
  if (!sameResult(oldOnJerusalemClock, fresh)) {
    const jerusalem = toJerusalemParts(instant);
    const today = resolveHoursForDate(activity, jerusalem.isoDate, RESOLVE_OPTS);
    const yesterday = resolveHoursForDate(activity, addDaysToIsoDate(jerusalem.isoDate, -1), RESOLVE_OPTS);
    const nowMinutes = jerusalem.minutesSinceMidnight;

    const legacyToday = old.resolved ? old.resolved.intervals : [];
    const validToday = today.intervals.filter((iv) => iv && iv.start && iv.end);

    // B. "00:00" end read as end-of-day rather than minute zero.
    if (validToday.some((iv) => iv.end === '00:00')) reasons.add('B_midnight_end_of_day');

    // C. an interval that crosses midnight, matched on the day it STARTS (late evening).
    if (validToday.some((iv) => intervalBounds(iv).isOvernight)) reasons.add('C_overnight_same_day');

    // D. an interval that started YESTERDAY and is still running after midnight today.
    if (!today.isDatedEvent && !yesterday.isDatedEvent) {
      const spilling = yesterday.intervals
        .filter((iv) => iv && iv.start && iv.end && intervalBounds(iv).isOvernight)
        .some((iv) => nowMinutes <= intervalBounds(iv).endMinutes - 24 * 60);
      if (spilling) reasons.add('D_previous_day_spillover');
    }

    // E. a day with several intervals, where the legacy single-interval view saw only one of them.
    if (validToday.length > 1 || (validToday.length === 1 && legacyToday.length === 1
      && (validToday[0].start !== legacyToday[0].start || validToday[0].end !== legacyToday[0].end))) {
      reasons.add('E_multiple_intervals');
    }

    if (reasons.size === 0 || (reasons.size === 1 && reasons.has('A_jerusalem_timezone'))) {
      reasons.add('F_UNEXPECTED');
    }
  }

  return { reasons: [...reasons], old, fresh };
}

async function main() {
  console.log(`Opening Hours Phase 3 differential: legacy = git ${BASE_COMMIT}:lib/hoursResolver.js\n`);
  console.log('Fetching real catalog schedules from Supabase...');
  const rows = await fetchAllSchedules();
  console.log(`Fetched ${rows.length} approved activities.`);

  const activities = rows.map(buildActivity);
  const withSignal = activities.filter(hasScheduleSignal);
  const withoutSignal = activities.filter((a) => !hasScheduleSignal(a));
  console.log(`${withSignal.length} carry a schedule signal; ${withoutSignal.length} carry none.`);

  const dates = isoDatesFromToday(7);
  const instants = [];
  for (const date of dates) for (const time of TIMES) instants.push({ label: `${date} ${time} Jerusalem`, date: jerusalemInstant(date, time) });
  console.log(`${dates.length} Jerusalem dates x ${TIMES.length} times = ${instants.length} instants, evaluated under ${DEVICE_TIMEZONES.length} device timezones.\n`);

  // Sanity check, so the no-signal shortcut below is a measured fact rather than an assumption.
  let noSignalChecked = 0;
  for (const activity of withoutSignal.slice(0, 200)) {
    for (const ts of instants) {
      const old = getOpenStatusOld(activity, { now: ts.date });
      const fresh = getOpenStatusNew(activity, { now: ts.date });
      noSignalChecked += 1;
      if (!sameResult(old, fresh) || old.hasScheduleData || old.isOpen) {
        throw new Error(`no-signal activity ${activity.id} did not trivially agree at ${ts.label}`);
      }
    }
  }
  console.log(`Sanity: ${noSignalChecked} comparisons across 200 no-schedule-signal activities - all trivially agree (isOpen:false, hasScheduleData:false).`);

  const originalTz = process.env.TZ;
  const byReason = new Map();
  const byTimezone = new Map();
  const examples = new Map();
  const unexpected = [];
  const changedActivityIds = new Set();
  let comparisons = 0;
  let changed = 0;

  for (const tz of DEVICE_TIMEZONES) {
    process.env.TZ = tz;
    for (const activity of withSignal) {
      for (const ts of instants) {
        comparisons += 1;
        const old = getOpenStatusOld(activity, { now: ts.date });
        const fresh = getOpenStatusNew(activity, { now: ts.date });
        if (sameResult(old, fresh)) continue;
        changed += 1;
        byTimezone.set(tz, (byTimezone.get(tz) || 0) + 1);
        changedActivityIds.add(activity.id);
        const { reasons } = classify(activity, ts.date);
        const key = reasons.sort().join(' + ');
        byReason.set(key, (byReason.get(key) || 0) + 1);
        if (!examples.has(key)) {
          examples.set(key, {
            activity: activity.name, id: activity.id, deviceTz: tz, at: ts.label,
            hoursByDay: activity.hoursByDay, openHours: activity.openHours,
            old: { isOpen: old.isOpen, minutesUntilClose: old.minutesUntilClose, minutesUntilOpenToday: old.minutesUntilOpenToday },
            new: { isOpen: fresh.isOpen, minutesUntilClose: fresh.minutesUntilClose, minutesUntilOpenToday: fresh.minutesUntilOpenToday },
          });
        }
        if (reasons.includes('F_UNEXPECTED') && unexpected.length < 20) {
          unexpected.push({ id: activity.id, name: activity.name, deviceTz: tz, at: ts.label, old, new: fresh });
        }
      }
    }
  }
  if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz;

  console.log(`\n${comparisons} comparisons (${withSignal.length} activities x ${instants.length} instants x ${DEVICE_TIMEZONES.length} device timezones).`);
  console.log(`${changed} changed results, across ${changedActivityIds.size} distinct activities.\n`);

  console.log('Changed results by DEVICE timezone (shows how much of the delta is the timezone fix alone):');
  for (const tz of DEVICE_TIMEZONES) console.log(`  ${String(byTimezone.get(tz) || 0).padStart(7)}  ${tz}`);

  console.log('Changed results by reason:');
  const sorted = [...byReason.entries()].sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of sorted) console.log(`  ${String(count).padStart(7)}  ${reason}`);

  console.log('\nOne worked example per reason:');
  for (const [reason] of sorted) console.log(`\n  [${reason}]\n  ${JSON.stringify(examples.get(reason))}`);

  const unexpectedCount = sorted.filter(([r]) => r.includes('F_UNEXPECTED')).reduce((n, [, c]) => n + c, 0);
  console.log(`\nUNEXPECTED differences: ${unexpectedCount}`);
  if (unexpectedCount) {
    console.log('\nFirst unexplained differences:');
    for (const u of unexpected) console.log('  ' + JSON.stringify(u));
    process.exitCode = 1;
  } else {
    console.log('Every difference is attributable to a deliberate Phase 3 correction.');
  }

  fs.rmSync(LEGACY_DIR, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  fs.rmSync(LEGACY_DIR, { recursive: true, force: true });
  process.exit(1);
});
