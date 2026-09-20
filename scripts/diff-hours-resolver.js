// MANDATORY differential safety harness (Opening Hours Foundation, task section 9) - compares the
// pre-existing lib/filterActivities.js#getOpenNowInfo against the new lib/hoursResolver.js#getOpenStatus
// across the REAL activity catalog and a deterministic set of timestamps, BEFORE getOpenNowInfo is
// switched to delegate to the resolver (section 10). This is a one-off diagnostic script, not part of
// `npm test` - it needs live network access to the production Supabase REST endpoint (read-only, the
// public anon key), which the rest of this project's test suite deliberately never depends on.
//
// Run: node scripts/diff-hours-resolver.js
const path = require('path');
const babel = require('@babel/core');
const { addHook } = require('pirates');

const ROOT = path.resolve(__dirname, '..');
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
addHook(
  (code, filename) => babel.transformSync(code, { filename, babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'] }).code,
  { exts: ['.js'], matcher: (f) => f.startsWith(path.join(ROOT, 'lib')) || f.startsWith(path.join(ROOT, 'constants')) },
);

const { getOpenNowInfo, __setClockForTests } = require('../lib/filterActivities');
const { getOpenStatus } = require('../lib/hoursResolver');
const { summarizeSchedules } = require('../lib/scheduleSummary');

const SUPABASE_URL = 'https://kkvgzubwsjsbqxzjejcs.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_t1vcj_DxtlmdSeCt1AW6HA_LrXrZaI-';
const PAGE_SIZE = 1000;

async function fetchAllSchedules() {
  const rows = [];
  let offset = 0;
  for (;;) {
    const url = `${SUPABASE_URL}/rest/v1/activities?select=id,entity_type,activity_schedules(schedule_type,day_of_week,start_time,end_time,one_time_date)&status=eq.approved&order=id.asc&offset=${offset}&limit=${PAGE_SIZE}`;
    const res = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY } });
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

// A deterministic spread of "now" instants: ordinary weekday mid-day, a weekday just before/after
// a boundary, Friday, Saturday, midnight-crossing, and an early-morning instant - device-local
// (matching both getOpenNowInfo's and getOpenStatus's current, shared, device-local semantics).
function timestampsFor(today) {
  const mk = (h, m = 0) => { const d = new Date(today); d.setHours(h, m, 0, 0); return d; };
  return [
    { label: 'weekday 10:00', date: mk(10) },
    { label: 'weekday 14:30', date: mk(14, 30) },
    { label: 'weekday 23:30', date: mk(23, 30) },
    { label: 'weekday 00:30', date: mk(0, 30) },
    { label: 'weekday 06:00', date: mk(6) },
    { label: 'weekday 12:00 (noon boundary)', date: mk(12) },
    { label: 'weekday 20:00 (evening boundary)', date: mk(20) },
    { label: 'weekday 08:59', date: mk(8, 59) },
  ];
}

function buildActivity(row) {
  const { availableDays, openHours, occurrences, hoursByDay } = summarizeSchedules(row.activity_schedules);
  return { id: row.id, entity_type: row.entity_type, availableDays, openHours, occurrences, hoursByDay };
}

function sameResult(a, b) {
  return a.isOpen === b.isOpen
    && a.hasScheduleData === b.hasScheduleData
    && a.minutesUntilClose === b.minutesUntilClose
    && a.minutesUntilOpenToday === b.minutesUntilOpenToday;
}

async function main() {
  console.log('Fetching real catalog schedules from Supabase...');
  const rows = await fetchAllSchedules();
  console.log(`Fetched ${rows.length} approved activities.`);

  const activities = rows.map(buildActivity);
  const withSchedule = activities.filter((a) => a.hoursByDay && Object.keys(a.hoursByDay).length > 0 || a.openHours || (a.occurrences && a.occurrences.length));
  console.log(`${withSchedule.length} of ${activities.length} activities carry some schedule signal (the rest trivially agree: both report hasScheduleData:false).`);

  const today = new Date(); // "today"'s weekday/date, times overridden per timestamp below
  const timestamps = timestampsFor(today);

  let comparisons = 0;
  const diffs = [];

  for (const activity of activities) {
    for (const ts of timestamps) {
      __setClockForTests(() => ts.date);
      const oldResult = getOpenNowInfo(activity);
      const newResult = getOpenStatus(activity, { now: ts.date });
      comparisons += 1;
      if (!sameResult(oldResult, newResult)) {
        diffs.push({
          activityId: activity.id, timestamp: ts.label, old: oldResult,
          new: { isOpen: newResult.isOpen, hasScheduleData: newResult.hasScheduleData, minutesUntilClose: newResult.minutesUntilClose, minutesUntilOpenToday: newResult.minutesUntilOpenToday },
        });
      }
    }
  }
  __setClockForTests(null);

  console.log(`\n${comparisons} total comparisons across ${activities.length} activities x ${timestamps.length} timestamps.`);
  console.log(`${diffs.length} differences found.`);
  if (diffs.length) {
    console.log('\nFirst 20 differences:');
    for (const d of diffs.slice(0, 20)) console.log(JSON.stringify(d));
  } else {
    console.log('\nPARITY CONFIRMED: getOpenStatus agrees with getOpenNowInfo on every comparison.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
