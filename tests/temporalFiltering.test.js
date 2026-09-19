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

const { applyFilters, matchesWhenAndHour, __setClockForTests, isOpenOrOpeningSoon } = require('../lib/filterActivities');
const { isBareTemporalPhrase } = require('../lib/searchIntent');
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
// isOpenOrOpeningSoon (2026-09-20, "מה קרוב?" open-now fix) - getOpenNowInfo intentionally uses
// the real wall clock (not __setClockForTests, see its own comment), so these fixtures are built
// relative to the ACTUAL current time with wide safety margins, instead of a fixed "today" like
// the tests above. hh() below never crosses midnight for the offsets used here (max ±90min),
// which keeps the tiny theoretical flakiness window under two hours out of a day - acceptable
// since getOpenNowInfo's own same-day-only hour model (no wraparound support) is unchanged/
// out of scope here, exactly as it was left in the temporal-search audit.
function hh(minutesFromNow) {
  const d = new Date(Date.now() + minutesFromNow * 60000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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

test('isOpenOrOpeningSoon: an activity open right now (wide safe window) is open', () => {
  const act = { category: 'x', entity_type: 'x', sourceUrl: '', availableDays: ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'], occurrences: [], openHours: { start: hh(-90), end: hh(90) } };
  assert.equal(isOpenOrOpeningSoon(act), true);
});

test('isOpenOrOpeningSoon: an activity opening in 15 minutes is eligible under the 30-minute allowance', () => {
  const act = { category: 'x', entity_type: 'x', sourceUrl: '', availableDays: ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'], occurrences: [], openHours: { start: hh(15), end: hh(90) } };
  assert.equal(isOpenOrOpeningSoon(act, 30), true);
});

test('isOpenOrOpeningSoon: an activity opening in 45 minutes is NOT eligible under a 30-minute allowance', () => {
  const act = { category: 'x', entity_type: 'x', sourceUrl: '', availableDays: ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'], occurrences: [], openHours: { start: hh(45), end: hh(120) } };
  assert.equal(isOpenOrOpeningSoon(act, 30), false);
});

test('isOpenOrOpeningSoon: an activity opening in 45 minutes IS eligible under a wider 60-minute allowance (custom threshold honored)', () => {
  const act = { category: 'x', entity_type: 'x', sourceUrl: '', availableDays: ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'], occurrences: [], openHours: { start: hh(45), end: hh(120) } };
  assert.equal(isOpenOrOpeningSoon(act, 60), true);
});
