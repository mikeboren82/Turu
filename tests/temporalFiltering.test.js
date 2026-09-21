// בדיקות ל-temporal-search audit (2026-09-19) - lib/filterActivities.js (D1/D2/D4/week-semantics)
// + lib/searchIntent.js#isBareTemporalPhrase (D3). כל בדיקת-יום/שבוע קובעת "היום" במפורש דרך
// __setClockForTests - "אל תכתבי בדיקות שתלויות באיזה יום ה-suite באמת רץ" (סעיף 11 בבקשה).
// אותו require-hook (babel commonjs + סטאבים) בדיוק כמו tests/searchIntent.test.js.
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

const { applyFilters, matchesWhenAndHour, __setClockForTests, isOpenOrOpeningSoon, getOpenNowInfo } = require('../lib/filterActivities');
const { isBareTemporalPhrase } = require('../lib/searchIntent');
const { jerusalemInstant } = require('./support/jerusalemInstant.js');
const { HOUR_OPTIONS } = require('../constants/filterSchema');

// "היום" קבוע = רביעי, 2026-09-16 (נבחר כדי שיהיה בדיוק באמצע השבוע - גם ימים-שכבר-עברו וגם
// ימים-שעוד-יבואו באותו שבוע קלנדרי, ל-week/weekend). כל בדיקה שצריכה "היום" אחר קובעת אותו
// בעצמה (setToday למטה) ומחזירה לרביעי ב-afterEach, כדי שבדיקות לא ידלפו state זו לזו.
function setToday(iso) {
  __setClockForTests(() => new Date(`${iso}T09:00:00`));
}
test.beforeEach(() => setToday('2026-09-16')); // רביעי
test.after(() => __setClockForTests(null));

// --- כלי-עזר: פעילויות סינתטיות, offsets תמיד יחסית ל-"היום" הקבוע שהוגדר ב-beforeEach/setToday ---
const ALL_DAYS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
function isoPlusDays(baseIso, days) {
  const d = new Date(`${baseIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const osmPlayground = (overrides = {}) => ({
  id: 'osm-pg', category: 'גן שעשועים', entity_type: 'מקום_קבוע',
  sourceUrl: 'https://www.openstreetmap.org/node/1003559102',
  availableDays: [], occurrences: [], openHours: null, hoursByDay: {},
  ...overrides,
});
const googlePlayground = (overrides = {}) => ({
  id: 'google-pg', category: 'גן שעשועים', entity_type: 'מקום_קבוע',
  sourceUrl: 'https://maps.google.com/?cid=123',
  availableDays: [], occurrences: [], openHours: null, hoursByDay: {},
  ...overrides,
});
const scheduleLessShow = (overrides = {}) => ({
  id: 'show-no-sched', category: 'הצגה', entity_type: 'אירוע_קבוע',
  sourceUrl: 'https://example.com/show',
  availableDays: [], occurrences: [], openHours: null, hoursByDay: {},
  ...overrides,
});

function search(activities, filters) {
  return applyFilters(activities, filters, null, [], [], [], []).map((a) => a.id);
}
function whenFilter(options, date = null) {
  return { q: '', location: {}, when: { options, date }, hour: { option: null, custom: null } };
}
function hourFilter(optionId) {
  return { q: '', location: {}, when: { options: [], date: null }, hour: { option: optionId, custom: null } };
}
function whenHourFilter(options, date, hourOptionId) {
  return { q: '', location: {}, when: { options, date }, hour: { option: hourOptionId, custom: null } };
}

// ---------------------------------------------------------------------------
// D1: matchesHour actually filters by preset dayparts (was a no-op before)
// ---------------------------------------------------------------------------

test('D1: HOUR_OPTIONS presets have the exact TURU semantics from the task', () => {
  const byId = Object.fromEntries(HOUR_OPTIONS.map((o) => [o.id, o]));
  assert.deepEqual(byId.morning, { id: 'morning', start: '06:00', end: '12:00', label: byId.morning.label });
  assert.deepEqual({ start: byId.noon.start, end: byId.noon.end }, { start: '12:00', end: '15:00' });
  assert.deepEqual({ start: byId.afternoon.start, end: byId.afternoon.end }, { start: '15:00', end: '18:00' });
  assert.deepEqual({ start: byId.evening.start, end: byId.evening.end }, { start: '18:00', end: '22:00' });
  assert.deepEqual({ start: byId.night.start, end: byId.night.end }, { start: '20:00', end: '00:00' });
});

test('D1: בבוקר / בצהריים / אחר הצהריים / בערב / בלילה each actually exclude non-matching activities', () => {
  const morningOnly = { id: 'm', category: 'x', entity_type: 'x', sourceUrl: '', availableDays: ALL_DAYS, occurrences: [], hoursByDay: {}, openHours: { start: '08:00', end: '11:00' } };
  const noonOnly = { id: 'n', category: 'x', entity_type: 'x', sourceUrl: '', availableDays: ALL_DAYS, occurrences: [], hoursByDay: {}, openHours: { start: '12:30', end: '14:30' } };
  const afternoonOnly = { id: 'a', category: 'x', entity_type: 'x', sourceUrl: '', availableDays: ALL_DAYS, occurrences: [], hoursByDay: {}, openHours: { start: '16:00', end: '17:30' } };
  const eveningOnly = { id: 'e', category: 'x', entity_type: 'x', sourceUrl: '', availableDays: ALL_DAYS, occurrences: [], hoursByDay: {}, openHours: { start: '19:00', end: '21:00' } };
  // 22:30 (לא 21:00) - חייב להיות *אחרי* סיום "ערב" (22:00) כדי לבדוק בידוד אמיתי בין הטווחים,
  // לא רק חפיפה חלקית מקרית עם "ערב" (18:00-22:00) - עדיין חופף ל"לילה" (20:00-00:00).
  const nightOnly = { id: 'ni', category: 'x', entity_type: 'x', sourceUrl: '', availableDays: ALL_DAYS, occurrences: [], hoursByDay: {}, openHours: { start: '22:30', end: '23:30' } };
  const acts = [morningOnly, noonOnly, afternoonOnly, eveningOnly, nightOnly];
  assert.deepEqual(search(acts, hourFilter('morning')), ['m']);
  assert.deepEqual(search(acts, hourFilter('noon')), ['n']);
  assert.deepEqual(search(acts, hourFilter('afternoon')), ['a']);
  assert.deepEqual(search(acts, hourFilter('evening')), ['e']);
  // night (20:00-00:00) overlaps the evening-only (19-21) AND the night-only (21-23:30) activity
  assert.deepEqual(search(acts, hourFilter('night')).sort(), ['e', 'ni']);
});

test('D1: with NO hour filter, all activities still pass regardless of their hours (baseline unaffected)', () => {
  const acts = [
    { id: 'm', category: 'x', entity_type: 'x', sourceUrl: '', availableDays: ALL_DAYS, occurrences: [], hoursByDay: {}, openHours: { start: '08:00', end: '11:00' } },
    { id: 'e', category: 'x', entity_type: 'x', sourceUrl: '', availableDays: ALL_DAYS, occurrences: [], hoursByDay: {}, openHours: { start: '19:00', end: '21:00' } },
  ];
  assert.deepEqual(search(acts, { q: '', location: {}, when: { options: [], date: null }, hour: { option: null, custom: null } }).sort(), ['e', 'm']);
});

// ---------------------------------------------------------------------------
// D2: OSM playground schedule-evidence exemption (D2 audit) - OSM only, not Google, not others
// ---------------------------------------------------------------------------

test('D2: OSM playground with no schedule at all is eligible for a plain weekday query', () => {
  assert.deepEqual(search([osmPlayground()], whenFilter(['specific'], isoPlusDays('2026-09-16', 3))), ['osm-pg']); // Saturday
});

test('D2: OSM playground with no schedule is eligible for date+daypart together ("שבת בבוקר")', () => {
  const sat = isoPlusDays('2026-09-16', 3);
  assert.deepEqual(search([osmPlayground()], whenHourFilter(['specific'], sat, 'morning')), ['osm-pg']);
});

test('D2: schedule-less performance (אירוע_קבוע) is NOT eligible for "שבת" - no exemption without OSM playground provenance', () => {
  const sat = isoPlusDays('2026-09-16', 3);
  assert.deepEqual(search([scheduleLessShow()], whenFilter(['specific'], sat)), []);
});

test('D2: schedule-less performance is NOT eligible for "בערב" (hour-only, no date filter)', () => {
  assert.deepEqual(search([scheduleLessShow()], hourFilter('evening')), []);
});

test('D2: Google-sourced schedule-less "playground" is NOT exempt (audit: untrustworthy provenance, businesses/sports facilities found in this set)', () => {
  const sat = isoPlusDays('2026-09-16', 3);
  assert.deepEqual(search([googlePlayground()], whenFilter(['specific'], sat)), []);
});

test('D2: an activity with category=גן שעשועים but entity_type=אירוע (a one-off event, not a permanent place) is NOT exempt', () => {
  const sat = isoPlusDays('2026-09-16', 3);
  const notAPlace = osmPlayground({ id: 'event-pg', entity_type: 'אירוע' });
  assert.deepEqual(search([notAPlace], whenFilter(['specific'], sat)), []);
});

test('D2: a scheduled performance IS eligible for שבת when it actually occurs that Saturday', () => {
  const sat = isoPlusDays('2026-09-16', 3);
  const scheduledShow = scheduleLessShow({ id: 'show-sat', occurrences: [{ date: sat, start: '19:00', end: '21:00' }] });
  assert.deepEqual(search([scheduledShow], whenFilter(['specific'], sat)), ['show-sat']);
});

// ---------------------------------------------------------------------------
// D4: date + daypart must be enforced as ONE combined intent, on the SAME day
// ---------------------------------------------------------------------------

test('D4: Saturday-evening performance IS eligible for "שבת בערב"', () => {
  const sat = isoPlusDays('2026-09-16', 3);
  const show = scheduleLessShow({ id: 'sat-evening', occurrences: [{ date: sat, start: '19:00', end: '21:00' }] });
  assert.deepEqual(search([show], whenHourFilter(['specific'], sat, 'evening')), ['sat-evening']);
});

test('D4: Saturday-evening performance is NOT eligible for "שבת בבוקר" (correct day, wrong time on that day)', () => {
  const sat = isoPlusDays('2026-09-16', 3);
  const show = scheduleLessShow({ id: 'sat-evening', occurrences: [{ date: sat, start: '19:00', end: '21:00' }] });
  assert.deepEqual(search([show], whenHourFilter(['specific'], sat, 'morning')), []);
});

test('D4: a recurring activity open Sat-morning but Fri-evening must match "שבת בבוקר" and NOT "שישי בבוקר"', () => {
  const fri = isoPlusDays('2026-09-16', 2);
  const sat = isoPlusDays('2026-09-16', 3);
  const act = {
    id: 'mixed-hours', category: 'x', entity_type: 'מקום_קבוע', sourceUrl: '',
    availableDays: ['ו', 'ש'], occurrences: [],
    hoursByDay: { ו: { start: '18:00', end: '22:00' }, ש: { start: '09:00', end: '12:00' } },
    openHours: { start: '09:00', end: '22:00' }, // the flattened envelope spans both days' hours
  };
  assert.deepEqual(search([act], whenHourFilter(['specific'], sat, 'morning')), ['mixed-hours'], 'Saturday morning: matches (09-12 on Saturday)');
  assert.deepEqual(search([act], whenHourFilter(['specific'], fri, 'morning')), [], 'Friday morning: must NOT match - Friday itself only opens at 18:00');
  assert.deepEqual(search([act], whenHourFilter(['specific'], fri, 'evening')), ['mixed-hours'], 'Friday evening: matches (18-22 on Friday)');
});

// ---------------------------------------------------------------------------
// week / next_week / weekend semantics (audit D5 + task sections 5/7)
// ---------------------------------------------------------------------------

test('השבוע (week): today through the coming Saturday INCLUSIVE, not a rolling 7 days', () => {
  // today = Wednesday 2026-09-16. "week" must include Wed/Thu/Fri/Sat only, NOT next Sun/Mon/Tue.
  const nextMon = isoPlusDays('2026-09-16', 5); // Monday of next calendar week
  const show = scheduleLessShow({ id: 'next-mon-show', occurrences: [{ date: nextMon, start: '10:00', end: '11:00' }] });
  assert.deepEqual(search([show], whenFilter(['week'])), [], 'next Monday must NOT be included in "השבוע" from a Wednesday');
  const thisSat = scheduleLessShow({ id: 'this-sat-show', occurrences: [{ date: isoPlusDays('2026-09-16', 3), start: '10:00', end: '11:00' }] });
  assert.deepEqual(search([thisSat], whenFilter(['week'])), ['this-sat-show'], 'this coming Saturday IS included');
});

test('השבוע on a Saturday means today only', () => {
  setToday('2026-09-19'); // Saturday
  const today = scheduleLessShow({ id: 'today-show', occurrences: [{ date: '2026-09-19', start: '10:00', end: '11:00' }] });
  const nextFri = scheduleLessShow({ id: 'next-fri-show', occurrences: [{ date: isoPlusDays('2026-09-19', 6), start: '10:00', end: '11:00' }] });
  assert.deepEqual(search([today, nextFri], whenFilter(['week'])), ['today-show']);
});

test('שבוע הבא (next_week): Sunday-Saturday of the NEXT calendar week, distinct from השבוע', () => {
  // today = Wednesday 2026-09-16 -> next week is Sun 2026-09-20 .. Sat 2026-09-26
  const thisSat = isoPlusDays('2026-09-16', 3); // still THIS week - must be excluded from next_week
  const nextSun = isoPlusDays('2026-09-16', 4);
  const nextSat = isoPlusDays('2026-09-16', 10);
  const theFollowingSun = isoPlusDays('2026-09-16', 11); // one day past next week - must be excluded
  const mk = (id, date) => scheduleLessShow({ id, occurrences: [{ date, start: '10:00', end: '11:00' }] });
  const acts = [mk('this-sat', thisSat), mk('next-sun', nextSun), mk('next-sat', nextSat), mk('after', theFollowingSun)];
  assert.deepEqual(search(acts, whenFilter(['next_week'])).sort(), ['next-sat', 'next-sun']);
});

test('בסופ"ש on a Wednesday: the upcoming Friday+Saturday only', () => {
  const fri = isoPlusDays('2026-09-16', 2);
  const sat = isoPlusDays('2026-09-16', 3);
  const nextFri = isoPlusDays('2026-09-16', 9);
  const mk = (id, date) => scheduleLessShow({ id, occurrences: [{ date, start: '10:00', end: '11:00' }] });
  assert.deepEqual(search([mk('fri', fri), mk('sat', sat), mk('next-fri', nextFri)], whenFilter(['weekend'])).sort(), ['fri', 'sat']);
});

test('בסופ"ש on a Friday: today + tomorrow (Saturday) only', () => {
  setToday('2026-09-18'); // Friday
  const mk = (id, date) => scheduleLessShow({ id, occurrences: [{ date, start: '10:00', end: '11:00' }] });
  const today = mk('fri', '2026-09-18');
  const tomorrow = mk('sat', '2026-09-19');
  const nextFri = mk('next-fri', isoPlusDays('2026-09-18', 7));
  assert.deepEqual(search([today, tomorrow, nextFri], whenFilter(['weekend'])).sort(), ['fri', 'sat']);
});

test('בסופ"ש on a Saturday: today only - the audit D2/D5 bug (next Friday used to leak in)', () => {
  setToday('2026-09-19'); // Saturday
  const mk = (id, date) => scheduleLessShow({ id, occurrences: [{ date, start: '10:00', end: '11:00' }] });
  const today = mk('sat', '2026-09-19');
  const nextFri = mk('next-fri', isoPlusDays('2026-09-19', 6));
  assert.deepEqual(search([today, nextFri], whenFilter(['weekend'])), ['sat'], 'next Friday must NOT leak in when today is already Saturday');
});

// ---------------------------------------------------------------------------
// D3: an unrecognized temporal phrase must not become a literal (doomed) text filter
// ---------------------------------------------------------------------------

test('D3: a bare temporal phrase with nothing else strips to empty (would otherwise become a 0-result text filter)', () => {
  for (const q of ['שבוע הבא', 'מחר בבוקר', 'בסופ"ש', 'סוף השבוע', 'שבת בערב', 'בעוד 3 ימים', '25.9', '25 בספטמבר']) {
    assert.equal(isBareTemporalPhrase(q), true, `"${q}" should be recognized as a bare temporal phrase`);
  }
});

test('D3: a real activity/place name is never mistaken for a temporal phrase', () => {
  for (const q of ['זהבה ושלושת הדובים', 'גן שעשועים', 'הקוסם מארץ עוץ', 'פיטר פן']) {
    assert.equal(isBareTemporalPhrase(q), false, `"${q}" must NOT be treated as temporal`);
  }
});

test('D3: a temporal phrase combined with a real search term is NOT bare (the term must still search)', () => {
  assert.equal(isBareTemporalPhrase('זהבה ושלושת הדובים מחר בבוקר'), false);
});

// ---------------------------------------------------------------------------
// isOpenOrOpeningSoon / getOpenNowInfo (2026-09-20, "מה קרוב?" open-now fix, then "reliability
// pass" audit סעיף 1) - getOpenNowInfo now routes both "what day is it" and "what time is it"
// through nowDate() (the same injectable clock as every other test in this file), so these
// fixtures can finally be pinned to a known moment via setNow() below instead of the old
// Date.now()-relative hh() helper (real-wall-clock-relative fixtures, which carried a small but
// real flakiness window near midnight - this removes that entirely; nowDate() still equals the
// real Date() in production, so this is test-only, no runtime behavior change).
// Phase 3 (2026-09-20): setNow pins a JERUSALEM wall-clock moment, not a device-local one.
// getOpenNowInfo is Jerusalem-anchored now, so '2026-09-20T15:00:00' has to mean "Sunday 15:00
// in Israel" on every machine - read as a device-local literal it silently meant something else
// on any non-Israeli CI box, and these fixtures would have quietly tested the wrong hour there.
// The search-path tests in this file (weekday offsets via nowDate().getDay()) are unaffected in
// practice: their anchors are mid-day, far from any date boundary.
function setNow(iso) {
  const [date, time] = iso.split('T');
  const at = jerusalemInstant(date, time.slice(0, 5));
  __setClockForTests(() => at);
}

test('isOpenOrOpeningSoon: OSM playground with no schedule is always "open" (D2 exemption reused)', () => {
  const pg = { category: 'גן שעשועים', entity_type: 'מקום_קבוע', sourceUrl: 'https://www.openstreetmap.org/node/1', openHours: null, availableDays: [], occurrences: [] };
  assert.equal(isOpenOrOpeningSoon(pg), true);
});

test('isOpenOrOpeningSoon: Google-sourced "playground" with no schedule is NOT exempt (same untrusted-provenance rule as D2)', () => {
  const pg = { category: 'גן שעשועים', entity_type: 'מקום_קבוע', sourceUrl: 'https://maps.google.com/?cid=1', openHours: null, availableDays: [], occurrences: [] };
  assert.equal(isOpenOrOpeningSoon(pg), false);
});

test('isOpenOrOpeningSoon: a schedule-less non-playground activity is NOT open by default (never guesses)', () => {
  const show = { category: 'הצגה', entity_type: 'אירוע_קבוע', sourceUrl: 'https://example.com', openHours: null, availableDays: [], occurrences: [] };
  assert.equal(isOpenOrOpeningSoon(show), false);
});

// אותה שעה בכל 7 הימים ב-hoursByDay (לא רק openHours) - כך שמדמה נכון fixed_hours אמיתי
// (scheduleSummary.js ממלא hoursByDay לכל יום ב-DAY_LETTERS.forEach), עכשיו כש-openHours כשלעצמו
// כבר לא fallback מספיק לפעילות חוזרת (ראו "day-specific hours 5" למעלה) - הבדיקות האלה בודקות
// את סף-הדקות של isOpenOrOpeningSoon, לא את הבחירה בין הימים, אז הן צריכות שעות-היום תקינות.
const ALL_DAYS_SAME_HOURS = (hours) => Object.fromEntries(['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'].map((d) => [d, hours]));

test('isOpenOrOpeningSoon: an activity open right now (wide safe window) is open', () => {
  setNow('2026-09-16T12:00:00'); // Wednesday noon
  const hours = { start: '10:30', end: '13:30' };
  const act = { category: 'x', entity_type: 'x', sourceUrl: '', availableDays: ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'], hoursByDay: ALL_DAYS_SAME_HOURS(hours), occurrences: [], openHours: hours };
  assert.equal(isOpenOrOpeningSoon(act), true);
});

test('isOpenOrOpeningSoon: an activity opening in 15 minutes is eligible under the 30-minute allowance', () => {
  setNow('2026-09-16T12:00:00');
  const hours = { start: '12:15', end: '13:30' };
  const act = { category: 'x', entity_type: 'x', sourceUrl: '', availableDays: ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'], hoursByDay: ALL_DAYS_SAME_HOURS(hours), occurrences: [], openHours: hours };
  assert.equal(isOpenOrOpeningSoon(act, 30), true);
});

test('isOpenOrOpeningSoon: an activity opening in 45 minutes is NOT eligible under a 30-minute allowance', () => {
  setNow('2026-09-16T12:00:00');
  const hours = { start: '12:45', end: '14:00' };
  const act = { category: 'x', entity_type: 'x', sourceUrl: '', availableDays: ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'], hoursByDay: ALL_DAYS_SAME_HOURS(hours), occurrences: [], openHours: hours };
  assert.equal(isOpenOrOpeningSoon(act, 30), false);
});

test('isOpenOrOpeningSoon: an activity opening in 45 minutes IS eligible under a wider 60-minute allowance (custom threshold honored)', () => {
  setNow('2026-09-16T12:00:00');
  const hours = { start: '12:45', end: '14:00' };
  const act = { category: 'x', entity_type: 'x', sourceUrl: '', availableDays: ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'], hoursByDay: ALL_DAYS_SAME_HOURS(hours), occurrences: [], openHours: hours };
  assert.equal(isOpenOrOpeningSoon(act, 60), true);
});

// ---------------------------------------------------------------------------
// getOpenNowInfo: day-specific hours (2026-09-20, "reliability pass" audit סעיף 1 - reproduced
// and fixed bug). Root cause: getOpenNowInfo used to compare "now" against activity.openHours,
// which is earliestStart/latestEnd flattened ACROSS EVERY WEEKDAY (lib/scheduleSummary.js), not
// today's own hours - so a Sunday-narrow/Monday-wide activity read as open all Sunday afternoon
// because Monday's later closing time widened the flattened envelope. Fixed by preferring
// activity.hoursByDay[today] (already computed per-day for the "מתי" filter) over the flattened
// openHours, which is now only a fallback for activities that don't populate hoursByDay at all
// (one-off dated events - see scheduleSummary.js, those already carry today-specific hours in
// openHours itself, so no bug there). 2026-09-20 is a Sunday (א'), 2026-09-21 a Monday (ב') -
// picked so day letters read naturally in these tests, not because the fix is date-specific.
test('day-specific hours 1: Sunday 09:00-12:00 vs Monday 09:00-20:00 - Sunday 15:00 must be CLOSED (the exact audit regression case)', () => {
  setNow('2026-09-20T15:00:00'); // Sunday 15:00
  const act = {
    availableDays: ['א', 'ב'],
    hoursByDay: { א: { start: '09:00', end: '12:00' }, ב: { start: '09:00', end: '20:00' } },
    openHours: { start: '09:00', end: '20:00' }, // the flattened envelope - deliberately still wide
    occurrences: [],
  };
  const info = getOpenNowInfo(act);
  assert.equal(info.isOpen, false, 'Sunday\'s own hours (09:00-12:00) already ended by 15:00');
  assert.equal(info.hasScheduleData, true);
});

test('day-specific hours 2: currently inside today\'s own range -> open', () => {
  setNow('2026-09-20T10:00:00'); // Sunday 10:00, inside 09:00-12:00
  const act = {
    availableDays: ['א', 'ב'],
    hoursByDay: { א: { start: '09:00', end: '12:00' }, ב: { start: '09:00', end: '20:00' } },
    openHours: { start: '09:00', end: '20:00' },
    occurrences: [],
  };
  const info = getOpenNowInfo(act);
  assert.equal(info.isOpen, true);
  assert.equal(info.minutesUntilClose, 120);
});

test('day-specific hours 3: currently outside today\'s own range (before it opens) -> closed, with a same-day "opens in" estimate', () => {
  setNow('2026-09-20T07:00:00'); // Sunday 07:00, before today's 09:00 open
  const act = {
    availableDays: ['א', 'ב'],
    hoursByDay: { א: { start: '09:00', end: '12:00' }, ב: { start: '09:00', end: '20:00' } },
    openHours: { start: '09:00', end: '20:00' },
    occurrences: [],
  };
  const info = getOpenNowInfo(act);
  assert.equal(info.isOpen, false);
  assert.equal(info.minutesUntilOpenToday, 120);
});

test('day-specific hours 4: another weekday has a later closing time, but that must not leak into today\'s own comparison', () => {
  setNow('2026-09-20T13:00:00'); // Sunday 13:00 - already past Sunday's 12:00 close
  const act = {
    availableDays: ['א', 'ב'],
    hoursByDay: { א: { start: '09:00', end: '12:00' }, ב: { start: '09:00', end: '23:00' } }, // Monday closes very late
    openHours: { start: '09:00', end: '23:00' },
    occurrences: [],
  };
  assert.equal(getOpenNowInfo(act).isOpen, false, 'Monday\'s late closing time must not make Sunday afternoon read as open');
});

// day-specific hours 5 - CORRECTED (2026-09-20, "post-reliability follow-up"): the first pass's
// fix still fell back to the flattened openHours whenever hoursByDay[today] was missing, which
// silently recreated the original cross-weekday bug for a recurring venue that simply has no
// entry for today (e.g. closed Sundays) - openHours is a real-hours envelope for a RECURRING
// schedule (Monday's 09:00-20:00 here), not evidence about Sunday. Flattened openHours is only
// ever safe as a fallback for a dated one-off event (see the "legitimate one-off dated event"
// test below) - never for a recurring/fixed schedule, regardless of which other day it belongs to.
test('day-specific hours 5 (recurring venue open Monday, no entry for Sunday, queried Sunday): must NOT borrow Monday\'s hours - the exact residual bug from the first pass', () => {
  setNow('2026-09-20T15:00:00'); // Sunday 15:00
  const act = {
    availableDays: ['א', 'ב'],
    hoursByDay: { ב: { start: '09:00', end: '20:00' } }, // no 'א' entry at all
    openHours: { start: '09:00', end: '20:00' }, // Monday's envelope only - must not leak to Sunday
    occurrences: [],
  };
  const info = getOpenNowInfo(act);
  assert.equal(info.isOpen, false, 'a recurring venue with no hours recorded for today must never be reported open via another day\'s flattened envelope');
});

test('day-specific hours: a recurring venue with a Sunday row that has NO valid start/end (data exists but hours are blank) still must not borrow Monday\'s hours', () => {
  // scheduleSummary.js adds a day to availableDays unconditionally once its day_of_week is valid,
  // but only adds it to hoursByDay when start/end are BOTH present - so a Sunday row with blank
  // times leaves Sunday "available" but without a usable hoursByDay entry, exactly like test 5
  // above but via a subtly different (and more realistic, real-import-data) root cause.
  setNow('2026-09-20T15:00:00'); // Sunday 15:00
  const act = {
    availableDays: ['א', 'ב'], // 'א' row exists (blank hours) - still added to availableDays
    hoursByDay: { ב: { start: '09:00', end: '20:00' } }, // no 'א' entry - blank times were dropped
    openHours: { start: '09:00', end: '20:00' },
    occurrences: [],
  };
  assert.equal(getOpenNowInfo(act).isOpen, false);
});

test('a fixed_hours activity with genuinely no per-day breakdown recorded (hoursByDay absent entirely) may still use openHours - the same pre-existing "no restriction recorded" heuristic as availableDays:[], not the cross-weekday bug', () => {
  // this is deliberately the SAME shape as tests/matchReasons.test.js's OPEN_ALL_DAY fixture -
  // it must keep working exactly as before; only the case where hoursByDay proves day-to-day
  // variation exists (see the tests above) is what got tightened by this fix.
  setNow('2026-09-20T15:00:00');
  const act = { availableDays: [], openHours: { start: '00:00', end: '23:59' }, occurrences: [] };
  assert.equal(getOpenNowInfo(act).isOpen, true);
});

test('unknown/malformed schedule: today\'s own hoursByDay entry exists but is itself incomplete (no end time) must NOT become a positive "open now" claim', () => {
  setNow('2026-09-20T15:00:00'); // Sunday 15:00
  const act = {
    availableDays: ['א'],
    hoursByDay: { א: { start: '09:00', end: null } }, // corrupt/partial row for today itself
    openHours: { start: '09:00', end: null },
    occurrences: [],
  };
  const info = getOpenNowInfo(act);
  assert.equal(info.isOpen, false, 'an incomplete hour range for today must never be treated as evidence of being open');
});

// UPDATED BY OPENING HOURS PHASE 3 (2026-09-20). The two tests below used to PIN two known legacy
// gaps ("last row wins" and '"00:00" end is not end-of-day'). Phase 3 fixes both, so they now
// assert the corrected behavior instead. Their original assertions are kept in the comments as
// the record of what changed - this is an intentional differential, not a regression.
test('day-specific hours 6 (CORRECTED by Phase 3): two schedule rows for the same weekday are both honored via intervalsByDay, no longer "last one wins"', () => {
  // scheduleSummary.js#summarizeSchedules still assigns hoursByDay[letter] by plain overwrite,
  // but it ALSO accumulates every row into intervalsByDay - and getOpenStatus now reads that
  // (useIntervalsByDay:true). Was: isOpen false at 14:00 because only 16:00-19:00 survived.
  setNow('2026-09-20T14:00:00'); // Sunday 14:00 - between the two slots
  const act = {
    availableDays: ['א'],
    hoursByDay: { א: { start: '16:00', end: '19:00' } }, // whichever row was processed last
    intervalsByDay: { א: [{ start: '09:00', end: '12:00' }, { start: '16:00', end: '19:00' }] },
    openHours: { start: '09:00', end: '19:00' },
    occurrences: [],
  };
  const gap = getOpenNowInfo(act);
  assert.equal(gap.isOpen, false, '14:00 is genuinely between the two slots - closed, but for the right reason now');
  assert.equal(gap.minutesUntilOpenToday, 120, 'and it knows the 16:00 slot is still coming, rather than treating the day as over');

  setNow('2026-09-20T10:00:00'); // Sunday 10:00 - inside the FIRST slot, invisible before Phase 3
  assert.equal(getOpenNowInfo(act).isOpen, true, 'the morning slot is no longer discarded by "last one wins"');
});

// Overnight/end-of-day "00:00": getOpenNowInfo used to compare via plain toMinutes() on both ends
// rather than the file's own toEndMinutes() helper, so a 20:00-00:00 window read as closed all
// evening (toMinutes('00:00') === 0, and 1380 <= 0 is false). Phase 3 moved that end-of-day
// correction into the shared resolver (lib/hoursResolver.js#intervalBounds), so the live open-now
// path and the hour-range SEARCH filter finally agree about what "00:00" as an END time means.
test('day-specific hours 7 (CORRECTED by Phase 3): an "end":"00:00" window is open-until-midnight, not closed all evening', () => {
  setNow('2026-09-20T23:00:00'); // Sunday 23:00, inside a 20:00-00:00 "night" window
  const act = {
    availableDays: ['א'],
    hoursByDay: { א: { start: '20:00', end: '00:00' } },
    openHours: { start: '20:00', end: '00:00' },
    occurrences: [],
  };
  const info = getOpenNowInfo(act);
  assert.equal(info.isOpen, true, 'was: false (the pre-Phase-3 gap this test used to pin)');
  assert.equal(info.minutesUntilClose, 60, 'closes at midnight, 60 minutes away');
});

test('overnight window (Phase 3): a 20:00-02:00 Friday venue is open late Friday AND after midnight on Saturday', () => {
  const act = {
    availableDays: ['ו', 'ש'],
    hoursByDay: { ו: { start: '20:00', end: '02:00' } },
    openHours: { start: '20:00', end: '02:00' },
    occurrences: [],
  };
  setNow('2026-09-18T19:00:00'); // Friday 19:00 - before it opens
  assert.equal(getOpenNowInfo(act).isOpen, false);
  setNow('2026-09-18T23:30:00'); // Friday 23:30
  assert.equal(getOpenNowInfo(act).isOpen, true);
  setNow('2026-09-19T00:30:00'); // Saturday 00:30 - Friday's interval, resolved from YESTERDAY
  const afterMidnight = getOpenNowInfo(act);
  assert.equal(afterMidnight.isOpen, true, 'previous-day spillover: Saturday has no hours of its own here');
  assert.equal(afterMidnight.minutesUntilClose, 90);
  setNow('2026-09-19T02:30:00'); // Saturday 02:30 - after Friday's window has closed
  assert.equal(getOpenNowInfo(act).isOpen, false);
});

test('day-specific hours: no schedule data at all -> unknown, never guessed open (unchanged)', () => {
  setNow('2026-09-20T15:00:00');
  const act = { availableDays: [], hoursByDay: {}, openHours: null, occurrences: [] };
  const info = getOpenNowInfo(act);
  assert.equal(info.isOpen, false);
  assert.equal(info.hasScheduleData, false);
});

test('day-specific hours: a dated one-off occurrence (no hoursByDay at all) still uses its own occurrence hours, unaffected by this fix', () => {
  setNow('2026-09-20T15:00:00'); // Sunday
  const act = {
    availableDays: ['א'],
    hoursByDay: {}, // one_time schedules never populate hoursByDay (scheduleSummary.js)
    openHours: { start: '14:00', end: '16:00' }, // the occurrence's own hours, already today-specific
    occurrences: [{ date: '2026-09-20', start: '14:00', end: '16:00' }],
  };
  assert.equal(getOpenNowInfo(act).isOpen, true);
});

// ---------------------------------------------------------------------------
// "מה קרוב?" semantics (2026-09-20, "post-reliability follow-up" סעיף 2) - the hard open-now/
// opening-soon eligibility filter that used to live in app/activities.js (nearMe==='true' branch)
// was removed there; these tests pin the layer it used to sit on top of - applyFilters (the
// shared eligibility pipeline every screen, including Near Me via rankActivitiesWithSmartRadius,
// filters through) - to prove availability was NEVER part of that shared pipeline and still isn't.
// A CLOSED activity passing through with no explicit "מתי"/hour filter set (DEFAULT_FILTERS'
// when/hour shape, exactly what goNearMe's nearMeFilters use - app/index.js) is the deterministic,
// testable proxy for "Near Me no longer excludes nearby closed activities" - the actual
// distance-sort/50-cap happens inline in app/activities.js itself (not a separately-testable
// module) and was verified live in the browser instead, per the task's own scope boundary
// ("do not reopen the broader reliability project" - i.e. do not refactor that screen just to
// make this one behavior unit-testable in isolation).
test('Near Me eligibility layer: a CLOSED-right-now activity is NOT excluded by applyFilters when no explicit "מתי"/hour filter is set (proves availability was never a hidden eligibility gate in the shared pipeline)', () => {
  setNow('2026-09-20T15:00:00'); // Sunday 15:00 - after this activity's 09:00-12:00 closes
  const closedNearby = {
    id: 'closed-nearby', category: 'גן שעשועים', entity_type: 'מקום_קבוע', sourceUrl: 'https://example.com',
    availableDays: ['א'], hoursByDay: { א: { start: '09:00', end: '12:00' } }, openHours: { start: '09:00', end: '12:00' }, occurrences: [],
  };
  assert.equal(getOpenNowInfo(closedNearby).isOpen, false, 'sanity check - this fixture really is closed right now');
  const nearMeFilters = { q: '', location: { mode: 'current' }, when: { options: [], date: null }, hour: { option: null, custom: null } };
  assert.deepEqual(search([closedNearby], nearMeFilters), ['closed-nearby']);
});

test('Near Me eligibility layer: an OPEN-right-now activity also remains present (not a tautology - proves the pipeline does not exclude on any availability signal, open or closed)', () => {
  setNow('2026-09-20T15:00:00');
  const openNearby = {
    id: 'open-nearby', category: 'גן שעשועים', entity_type: 'מקום_קבוע', sourceUrl: 'https://example.com',
    availableDays: ['א'], hoursByDay: { א: { start: '09:00', end: '20:00' } }, openHours: { start: '09:00', end: '20:00' }, occurrences: [],
  };
  assert.equal(getOpenNowInfo(openNearby).isOpen, true);
  const nearMeFilters = { q: '', location: { mode: 'current' }, when: { options: [], date: null }, hour: { option: null, custom: null } };
  assert.deepEqual(search([openNearby], nearMeFilters), ['open-nearby']);
});

test('explicit temporal/open filters elsewhere are unaffected: an explicit "מתי"/hour filter (unrelated to Near Me) still excludes a closed/non-matching activity exactly as before', () => {
  setNow('2026-09-16T09:00:00'); // Wednesday (the file\'s default "today")
  const eveningOnly = {
    id: 'evening-only', category: 'הצגה', entity_type: 'אירוע_קבוע', sourceUrl: 'https://example.com',
    availableDays: ALL_DAYS, hoursByDay: Object.fromEntries(ALL_DAYS.map((d) => [d, { start: '18:00', end: '22:00' }])), openHours: { start: '18:00', end: '22:00' }, occurrences: [],
  };
  // "בבוקר" (morning) explicit hour filter - this activity only runs evenings, so it must still
  // be excluded here exactly as before; this has nothing to do with Near Me or getOpenNowInfo.
  assert.deepEqual(search([eveningOnly], hourFilter('morning')), []);
});
