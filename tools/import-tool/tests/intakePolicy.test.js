const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../lib/intakePolicy');
const { classifyIncoming, reviewBudget } = require('../lib/reviewBudget');

const TODAY = '2026-09-24';

test('PRICE: unknown price is completeness, never a substantive issue; free stays distinguishable', () => {
  assert.equal(P.priceCompleteness({ price_type: null }), 'unknown');
  assert.equal(P.priceCompleteness({ price_type: 'free' }), 'known');
  assert.deepEqual(P.substantiveIssues(['מחיר']), []);
  assert.deepEqual(P.substantiveIssues(['מחיר', 'עיר']), ['עיר']);
  // legacy price-only rows are not human work in the budget
  assert.equal(classifyIncoming({ status: 'new', match_type: 'new', validation_issues: ['מחיר'], city: 'x', location_name: 'y' }), 'awaiting_publish_checks');
  assert.equal(classifyIncoming({ status: 'needs_review', match_type: 'new', validation_issues: ['מחיר', 'יחידת פעילות'], city: 'x', location_name: 'y' }), 'requires_human_judgment');
  // the Cleaner never opens a case for price (its metadata set has no 'מחיר')
  assert.ok(!/'מחיר'/.test(fs.readFileSync(path.join(__dirname, '../cleaner/discover.js'), 'utf8').match(/const META_ISSUES = [^;]+;/)[0]));
});

test('scan-source no longer writes the price flag into validation_issues (source guard)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../supabase/functions/scan-source/index.ts'), 'utf8');
  assert.ok(!/issues\.push\('מחיר'\)/.test(src), "no issues.push('מחיר')");
  assert.ok(/candidate\.completeness = \{ price: priceCompleteness\(candidate\) \}/.test(src));
});

test('REVIEW BUDGET: no invented extraction-confidence bucket; match confidence 0 on new rows means nothing', () => {
  const rows = [
    { status: 'new', match_type: 'new', validation_issues: [], city: 'x', location_name: 'y', confidence_score: 0 },
    { status: 'needs_review', match_type: 'new', validation_issues: ['יחידת פעילות'], city: 'x', location_name: 'y', confidence_score: 0 },
    { status: 'needs_review', match_type: 'duplicate', validation_issues: ['possible_duplicate_of_existing:STRONG_MATCH'], city: 'x' },
    { status: 'needs_review', match_type: 'update', diff: {} },
    { status: 'needs_review', match_type: 'update', diff: { start_time: { before: '17:00:00', after: '17:00' } } },
    { status: 'needs_review', match_type: 'update', diff: { one_time_date: { before: '2026-10-01', after: '2026-10-02' } } },
  ];
  const b = reviewBudget({ openQueue: rows });
  assert.equal(b.open.low_confidence_extraction, undefined);
  assert.deepEqual(b.open, { awaiting_publish_checks: 1, requires_human_judgment: 1, possible_duplicate_review: 1, update_no_material_change: 2, update_for_review: 1 });
  assert.equal(b.humanOnly, 3);
});

test('DIFF CLASS: empty / format-only / less-specific / enrichment-only / material', () => {
  assert.equal(P.classifyUpdateDiff({}).kind, 'empty');
  assert.equal(P.classifyUpdateDiff({ start_time: { before: '17:00:00', after: '17:00' }, end_time: { before: '18:30:00', after: '18:30' } }).kind, 'representation_only');
  assert.equal(P.classifyUpdateDiff({ booking_requirement: { before: 'none', after: 'walk_in' } }).kind, 'representation_only');
  assert.equal(P.classifyUpdateDiff({ price_amount: { before: '15', after: 15 } }).kind, 'representation_only');
  assert.equal(P.classifyUpdateDiff({ occurrences: { before: ['2026-09-29 20:00'], after: ['2026-09-29'] } }).kind, 'less_specific');
  assert.equal(P.classifyUpdateDiff({ address: { before: 'הרצל 5, חולון', after: 'הרצל 5' } }).kind, 'less_specific');
  assert.equal(P.classifyUpdateDiff({ description: { before: 'a', after: 'b' }, has_image: { before: 'אין תמונה', after: 'נמצאה תמונה' }, event_key: { before: null, after: 'k' }, start_time: { before: '10:00:00', after: '10:00' } }).kind, 'non_human');
  // real changes stay material - never fuzzy-equal
  assert.equal(P.classifyUpdateDiff({ start_time: { before: '17:30:00', after: '19:00' } }).kind, 'material');
  assert.equal(P.classifyUpdateDiff({ start_time: { before: null, after: '19:00' } }).kind, 'material');
  assert.equal(P.classifyUpdateDiff({ booking_requirement: { before: 'none', after: 'advance_booking' } }).kind, 'material');
  assert.equal(P.classifyUpdateDiff({ occurrences: { before: ['2026-09-28 17:30'], after: ['2026-09-28 19:00'] } }).kind, 'material');
  assert.equal(P.classifyUpdateDiff({ occurrences: { before: ['2026-09-28 17:00'], after: ['2026-09-29 17:00'] } }).kind, 'material');
  assert.equal(P.classifyUpdateDiff({ one_time_date: { before: '2026-09-29', after: '2026-09-30' } }).kind, 'material');
  assert.equal(P.classifyUpdateDiff({ description: { before: 'a', after: 'b' }, price_type: { before: null, after: 'fixed' } }).kind, 'material');
});

test('SPECIFICITY GUARD: less specific only when the value is a strict prefix at a boundary', () => {
  assert.equal(P.isLessSpecific('2026-09-29 20:00', '2026-09-29'), true);
  assert.equal(P.isLessSpecific('2026-09-29', '2026-09-30'), false);
  assert.equal(P.isLessSpecific('17:00', '17'), false);
  assert.equal(P.isLessSpecific('רחוב הרצל 15', 'רחוב הרצל 1'), false); // a different number is a different value
  assert.equal(P.isLessSpecific(null, 'x'), false);
});

test('EXPIRY: a one-time pending candidate expires only when its LAST known date passed', () => {
  const row = (ed, extra = {}) => ({ match_type: 'new', status: 'new', validation_issues: [], extracted_data: { entity_type: 'אירוע', schedule_type: 'one_time', ...ed }, ...extra });
  assert.equal(P.pendingLifecycle(row({ one_time_date: '2026-09-20' }), TODAY, 180).action, 'expire');
  assert.equal(P.pendingLifecycle(row({ one_time_date: '2026-09-24' }), TODAY, 180).action, 'keep'); // today still counts
  // multi-occurrence: 09-20 past, 09-27 and 10-01 ahead -> alive until after 10-01
  const multi = row({ one_time_date: '2026-09-20', occurrences: [{ date: '2026-09-20' }, { date: '2026-09-27' }, { date: '2026-10-01' }] });
  assert.equal(P.pendingLifecycle(multi, TODAY, 180).action, 'keep');
  assert.equal(P.pendingLifecycle(multi, '2026-10-01', 180).action, 'keep');
  assert.deepEqual([P.pendingLifecycle(multi, '2026-10-02', 180).action, P.pendingLifecycle(multi, '2026-10-02', 180).lastDate], ['expire', '2026-10-01']);
  assert.equal(P.pendingLifecycle(row({ one_time_date: '2026-09-01' }, { match_type: 'duplicate', status: 'needs_review' }), TODAY, 180).action, 'expire');
  assert.equal(P.pendingLifecycle(row({ one_time_date: '2026-09-01' }, { match_type: 'update', status: 'needs_review' }), TODAY, 180).action, 'keep');
  assert.equal(P.pendingLifecycle(row({ one_time_date: '2026-09-01' }, { status: 'rejected' }), TODAY, 180).action, 'keep');
});

test('REPERTOIRE / STANDING SAFETY: programmes, places and undated rows never expire or defer on a date', () => {
  const r = (ed) => ({ match_type: 'new', status: 'new', validation_issues: [], extracted_data: ed });
  assert.equal(P.pendingLifecycle(r({ entity_type: 'אירוע_קבוע', schedule_type: 'one_time', one_time_date: '2026-09-01' }), TODAY, 180).reason, 'standing_identity');
  assert.equal(P.pendingLifecycle(r({ entity_type: 'מקום_קבוע', schedule_type: 'one_time', one_time_date: '2026-09-01' }), TODAY, 180).reason, 'standing_identity');
  assert.equal(P.pendingLifecycle(r({ entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: null }), TODAY, 180).reason, 'undated');
  assert.equal(P.pendingLifecycle(r({ entity_type: 'אירוע', schedule_type: 'recurring', one_time_date: '2026-09-01' }), TODAY, 180).reason, 'undated');
});

test('FAR FUTURE: a clean event > 180 d ahead is deferred to the day it enters the window, never rejected', () => {
  const r = (date, extra = {}) => ({ match_type: 'new', status: 'new', validation_issues: ['מחיר'], extracted_data: { entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: date }, ...extra });
  const d = P.pendingLifecycle(r('2027-06-01'), TODAY, 180);
  assert.deepEqual([d.action, d.deferUntil], ['defer', '2026-12-03']);
  assert.equal(P.farFutureDeferUntil({ entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: '2027-06-01' }, '2026-12-03', 180), null); // inside the window that day
  assert.equal(P.pendingLifecycle(r('2027-03-23'), TODAY, 180).action, 'keep'); // exactly +180: inside
  assert.equal(P.pendingLifecycle(r('2027-03-24'), TODAY, 180).action, 'defer');
  assert.equal(P.pendingLifecycle(r('2027-06-01', { validation_issues: ['עיר'], status: 'needs_review' }), TODAY, 180).action, 'keep'); // real issue: not deferred
  assert.equal(P.pendingLifecycle(r('2027-06-01', { deferred_until: '2026-12-03' }), TODAY, 180).reason, 'deferred');
  assert.equal(P.pendingLifecycle(r('2027-06-01', { deferred_until: '2026-12-03' }), '2026-12-03', 180).action, 'release');
  assert.equal(P.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(P.addDays('2027-03-01', -1), '2027-02-28');
});

test('israelToday is the civil date in Asia/Jerusalem, not the machine or UTC date', () => {
  assert.equal(P.israelToday(new Date('2026-09-24T22:30:00Z')), '2026-09-25'); // 01:30 in Israel
  assert.equal(P.israelToday(new Date('2026-09-24T20:00:00Z')), '2026-09-24');
});

// (The Phase A section 12 finding - mall / retail / category 'אחר' auto-publishing - is asserted in
// tests/autoPublishSafety.test.js since the content-safety gate landed.)

// Deno twin parity: the same rule table must hold in supabase/functions/_shared/intakePolicy.test.ts
test('twin parity: both implementations export the same rule surface', () => {
  const ts = fs.readFileSync(path.join(__dirname, '../../../supabase/functions/_shared/intakePolicy.ts'), 'utf8');
  for (const name of ['substantiveIssues', 'priceCompleteness', 'sameBookingMeaning', 'isLessSpecific', 'occurrenceKnown', 'parseOccLabel', 'classifyUpdateDiff', 'addDays', 'knownDates', 'isDatedOneTime', 'farFutureDeferUntil', 'pendingLifecycle']) {
    assert.ok(new RegExp(`export function ${name}\\(`).test(ts), `TS exports ${name}`);
    assert.equal(typeof P[name], 'function', `JS exports ${name}`);
  }
});
