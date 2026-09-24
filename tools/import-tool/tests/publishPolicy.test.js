// Canonical incoming eligibility (2026-09-24): one policy for intake, the evaluate/approve routes, the Cleaner
// hand-back and reprocess-review-queue.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { evaluatePublishPolicy } = require('../lib/publishPolicy');
const { evaluateIncomingRow, approvalBlockers, rowFactReasons } = require('../lib/incomingEligibility');
const { assessChildRelevance, ADULT_MARKERS, CHILD_MARKERS } = require('../childRelevance');

const SHARED = path.join(__dirname, '../../../supabase/functions/_shared');
const table = JSON.parse(fs.readFileSync(path.join(SHARED, 'publishPolicy.cases.json'), 'utf8'));
const merge = (k) => ({
  c: { ...table.base.c, ...(k.c || {}) },
  source: { ...table.base.source, ...(k.source || {}) },
  issues: k.issues || table.base.issues,
  row: k.row === null ? null : { ...table.base.row, ...(k.row || {}) },
});

test('canonical policy table (shared with the Deno twin): every gate, exact reason codes', () => {
  for (const k of table.cases) {
    const m = merge(k);
    const r = evaluatePublishPolicy(m.c, { source: m.source, issues: m.issues, today: table.today, minTrust: table.minTrust, maxDaysAhead: table.maxDaysAhead, row: m.row, trustOverride: k.trustOverride || null });
    assert.deepEqual([r.decision, r.humanApprovable, r.reasons.map((x) => x.code)], k.expect, k.id);
  }
});

// ---- a table-aware fake Supabase client (read paths + guarded writes) ----
function fakeDb({ incoming, source, activities = [], settings = [], writeError = null, writeHook = null }) {
  const t = { incoming_activities: incoming ? [structuredClone(incoming)] : [], sources: source ? [structuredClone(source)] : [], activities, automation_settings: settings };
  const writes = [];
  const from = (table) => {
    const q = { op: 'select', patch: null, f: [] };
    const rows = () => (t[table] || []).filter((r) => q.f.every(([k, v, kind]) => kind === 'eq' ? r[k] === v : kind === 'in' ? v.includes(r[k]) : kind === 'neq' ? r[k] !== v : true));
    const run = () => {
      if (q.op === 'update') {
        writes.push({ table, patch: q.patch });
        if (writeHook) writeHook(t, table);
        if (writeError) return { data: null, error: writeError };
        const hit = rows(); for (const r of hit) Object.assign(r, q.patch); return { data: hit.map((r) => ({ id: r.id })), error: null };
      }
      return { data: rows().map((r) => ({ ...r })), error: null };
    };
    const b = {
      select() { return b; }, update(p) { q.op = 'update'; q.patch = p; return b; },
      eq(k, v) { q.f.push([k, v, 'eq']); return b; }, in(k, v) { q.f.push([k, v, 'in']); return b; }, neq(k, v) { q.f.push([k, v, 'neq']); return b; },
      is(k, v) { q.f.push([k, v, 'eq']); return b; }, not() { return b; }, gte() { return b; }, lte() { return b; }, order() { return b; }, range() { return b; }, limit() { return b; }, or() { return b; }, ilike() { return b; },
      maybeSingle() { const r = run(); return Promise.resolve({ data: r.data ? r.data[0] ?? null : null, error: r.error }); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  };
  return { client: { from, rpc: async () => ({ data: null, error: null }) }, t, writes };
}
const B = merge({});
const incomingRow = (over = {}) => ({ id: 'inc-1', source_id: 'src-1', page_url: 'https://x/events', validation_issues: B.issues, status: 'new', match_type: 'new', deferred_until: null, existing_activity_id: null, extracted_data: { ...B.c, ...(over.c || {}) }, ...(over.row || {}) });
const sourceRow = (over = {}) => ({ id: 'src-1', ...B.source, ...over });
const opts = { today: table.today, serviceAreaIndex: null };

test('row evaluator: CURRENT state - resolved location ELIGIBLE, unresolved held, exact duplicate terminal', async () => {
  let db = fakeDb({ incoming: incomingRow(), source: sourceRow() });
  let ev = await evaluateIncomingRow(db.client, 'inc-1', opts);
  assert.deepEqual([ev.decision, ev.reasons.map((r) => r.code)], ['ELIGIBLE', []]);
  db = fakeDb({ incoming: incomingRow({ c: { lat: null, lng: null } }), source: sourceRow() });
  ev = await evaluateIncomingRow(db.client, 'inc-1', opts);
  assert.deepEqual([ev.decision, ev.reasons.map((r) => r.code)], ['HELD', ['location_unverified']]);
  const fp = require('../eventFingerprint').computeEventFingerprint({ name: B.c.name, venueId: null, city: B.c.city, scheduleType: 'one_time', oneTimeDate: B.c.one_time_date, recurringDays: undefined, startTime: undefined });
  db = fakeDb({ incoming: incomingRow(), source: sourceRow(), activities: [{ id: 'act-9', event_fingerprint: fp, status: 'approved' }] });
  ev = await evaluateIncomingRow(db.client, 'inc-1', opts);
  assert.deepEqual([ev.decision, ev.reasons.map((r) => r.code), ev.reasons[0].detail.activityId], ['INELIGIBLE', ['exact_duplicate'], 'act-9']);
  assert.deepEqual(rowFactReasons({ lat: 1, lng: 2 }, { serviceArea: { klass: 'OUTSIDE_SERVICE_AREA', reason: 'pa' } }).map((r) => r.code), ['outside_service_area']);
  assert.equal(db.writes.length, 0, 'evaluation never writes');
});

test('POLICY CHANGE after the Cleaner case opened: the row is re-read and CURRENT rules win (category, trust, access, granularity)', async () => {
  // the case was opened when this row was clean and eligible; each mutation below happened afterwards
  const cases = [
    ['category אחר now held', { c: { category: 'אחר', description: 'סדנה' } }, {}, 'content_safety'],
    ['source trust dropped', {}, { source_trust_score: 50 }, 'untrusted_source'],
    ['access re-classified', { c: { offering_access_type: 'private_group' } }, {}, 'access'],
    ['granularity re-assessed', { c: { name: 'פעילויות לילדים', description: 'מגוון פעילויות לילדים: סדנאות, הצגות, שעות סיפור ומתנפחים' , schedule_type: 'recurring', recurring_days: ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי'], entity_type: 'אירוע_קבוע', one_time_date: null } }, {}, 'granularity'],
  ];
  for (const [label, rowOver, srcOver, code] of cases) {
    const db = fakeDb({ incoming: incomingRow(rowOver), source: sourceRow(srcOver) });
    const ev = await evaluateIncomingRow(db.client, 'inc-1', opts);
    assert.ok(ev.reasons.some((r) => r.code === code), `${label}: ${JSON.stringify(ev.reasons.map((r) => r.code))}`);
    assert.notEqual(ev.decision, 'ELIGIBLE', label);
  }
});

test('approve route boundary: auto publishes only ELIGIBLE; a human decides holds but never a terminal rule', () => {
  const ev = (codes) => ({ reasons: codes.map(([code, severity, humanOverridable]) => ({ code, severity, humanOverridable })) });
  assert.deepEqual(approvalBlockers(ev([]), 'auto'), []);
  assert.deepEqual(approvalBlockers(ev([['untrusted_source', 'hold', true], ['content_safety', 'hold', true]]), 'auto').map((r) => r.code), ['untrusted_source', 'content_safety']);
  assert.deepEqual(approvalBlockers(ev([['untrusted_source', 'hold', true], ['content_safety', 'hold', true]]), 'human'), []);
  assert.deepEqual(approvalBlockers(ev([['expired', 'terminal', false]]), 'human').map((r) => r.code), ['expired']);
  // duplicates / service area are turned into their terminal writes by the route's own guards, in both modes
  assert.deepEqual(approvalBlockers(ev([['exact_duplicate', 'terminal', false], ['outside_service_area', 'terminal', false]]), 'auto'), []);
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  // the route is a thin interface to publishIncoming, which re-evaluates (under its claim) before any publish write
  const route = server.slice(server.indexOf('async function publishIncoming('), server.indexOf("app.post('/api/incoming/:id/reject'"));
  const underClaim = route.indexOf('evaluateIncomingRow(client, id, { claimedFromStatus: priorStatus })');
  assert.ok(underClaim > 0 && underClaim < route.indexOf('saveNewActivity(') && underClaim < route.indexOf('applyIncomingUpdate('), 're-evaluated before any publish write');
  assert.ok(/mode: b\.mode === 'human' \? 'human' : 'auto'/.test(route), 'programmatic callers default to auto');
  const evaluate = server.slice(server.indexOf("app.post('/api/incoming/:id/evaluate'"), server.indexOf('// ---- INCOMING PUBLICATION'));
  assert.ok(evaluate.includes('evaluateIncomingRow(') && !/\.update\(|\.insert\(|saveNewActivity|fetch\(/.test(evaluate), 'evaluate is read-only');
  const ui = fs.readFileSync(path.join(__dirname, '../incoming.js'), 'utf8');
  assert.equal((ui.match(/mode: 'human'/g) || []).length, 2, 'both inbox approve buttons identify as a reviewer');
});

test('Cleaner hand-back: HELD rows are not published (retail trust 95, even with trustedOverride); an ELIGIBLE row goes to the publish path', async () => {

  const { handBackIncoming } = require('../cleaner/apply');
  const settings = { thresholds: { duplicate: 0.9, needsReview: 0.6, proximityKm: 0.15 }, minTrust: 80, maxDaysAhead: 180 };
  const mcd = { c: { name: 'מקדונלדס', description: 'רשת מקדונלד׳ס המציעה תפריט לכל המשפחה', category: 'אחר', entity_type: 'מקום_קבוע', schedule_type: 'fixed_hours', one_time_date: null, audience: 'family', location_name: 'קניון כפר סבא הירוקה', city: 'כפר סבא' } };
  for (const trustedOverride of [false, true]) {
    const db = fakeDb({ incoming: incomingRow(mcd), source: sourceRow({ source_trust_score: 95, name: 'קניון כפר סבא הירוקה - לוח אירועים' }) });
    const r = await handBackIncoming(db.client, db.t.incoming_activities[0], { settings, userId: 'u', cache: new Map(), today: table.today, counters: null, trustedOverride });
    assert.equal(r.outcome, 'awaiting_policy'); assert.deepEqual(r.reasons, ['content_safety']); assert.equal(r.why, 'content_safety:business_listing');
    assert.equal(db.writes.length, 0);
  }
  // ELIGIBLE: proceeds to the ONE publication implementation, in-process, mode auto (stubbed here)
  const { setPublishImplForTests } = require('../cleaner/apply');
  const modes = []; setPublishImplForTests(async (_c, _u, _id, o) => { modes.push(o.mode); return { outcome: 'PUBLISHED', status: 200, body: { activityId: 'act-1' } }; });
  const ok = fakeDb({ incoming: incomingRow(), source: sourceRow() });
  const e = await handBackIncoming(ok.client, ok.t.incoming_activities[0], { settings, userId: 'u', cache: new Map(), today: table.today, counters: null });
  setPublishImplForTests(null);
  assert.deepEqual([e.outcome, modes], ['published', ['auto']]);
  // untrusted: held with the canonical reason code
  const un = fakeDb({ incoming: incomingRow(), source: sourceRow({ source_trust_score: 50 }) });
  const u = await handBackIncoming(un.client, un.t.incoming_activities[0], { settings, userId: 'u', cache: new Map(), today: table.today, counters: null });
  assert.deepEqual([u.outcome, u.reasons], ['awaiting_policy', ['untrusted_source']]);
  // closed meanwhile by another process: resolved_externally, no write
  const closed = fakeDb({ incoming: incomingRow({ row: { status: 'approved' } }), source: sourceRow() });
  const cl = await handBackIncoming(closed.client, closed.t.incoming_activities[0], { settings, userId: 'u', cache: new Map(), today: table.today, counters: null });
  assert.deepEqual([cl.outcome, cl.why], ['resolved_externally', 'status:approved']);
});

test('guarded write contract: written / already_satisfied / resolved_externally (row closed) / error (open row, write failed) - never guessed', async () => {
  const { handBackIncoming } = require('../cleaner/apply');
  const settings = { thresholds: { duplicate: 0.9, needsReview: 0.6, proximityKm: 0.15 }, minTrust: 80, maxDaysAhead: 180 };
  const adult = { c: { name: 'הרצאה על השקעות', description: 'הרצאה למבוגרים בלבד', category: 'פעילות קהילתית', audience: 'adults' } };
  const run = async (dbOpts) => { const db = fakeDb({ incoming: incomingRow(adult), source: sourceRow(), ...dbOpts }); return [await handBackIncoming(db.client, db.t.incoming_activities[0], { settings, userId: 'u', cache: new Map(), today: table.today, counters: null }), db]; };
  let [r, db] = await run({});
  assert.deepEqual([r.outcome, r.reason, r.write], ['archived', 'invalid_event', 'written']);
  assert.equal(db.t.incoming_activities[0].status, 'rejected');
  // the write errors while the row is STILL OPEN -> error (the case retries), never resolved_externally
  [r] = await run({ writeError: { code: '23514', message: 'check constraint violated' } });
  assert.equal(r.outcome, 'error'); assert.match(r.error, /OTHER_FAILURE/);
  // another process closed the row between the evaluation and the write -> resolved_externally
  [r] = await run({ writeHook: (t, tbl) => { if (tbl === 'incoming_activities') t.incoming_activities[0].status = 'approved'; } });
  assert.deepEqual([r.outcome, r.why], ['resolved_externally', 'status:approved']);
  // the exact target state is already there -> harmless, not an error
  [r] = await run({ writeHook: (t, tbl) => { if (tbl === 'incoming_activities') Object.assign(t.incoming_activities[0], { status: 'rejected', archive_reason: 'invalid_event' }); } });
  assert.deepEqual([r.outcome, r.write], ['archived', 'already_satisfied']);
});

test('reprocess-review-queue.js keeps no policy of its own: the canonical decision maps to its action', () => {
  const { reprocessAction } = require('../reprocess-review-queue');
  assert.equal(reprocessAction({ decision: 'ELIGIBLE', reasons: [] }).action, 'approve');
  assert.equal(reprocessAction({ decision: 'INELIGIBLE', reasons: [{ code: 'relevance_reject' }] }).action, 'reject');
  assert.deepEqual(reprocessAction({ decision: 'HELD', reasons: [{ code: 'content_safety' }, { code: 'untrusted_source' }] }), { action: 'leave', why: 'content_safety,untrusted_source' });
  assert.equal(reprocessAction({ decision: 'INELIGIBLE', reasons: [{ code: 'expired' }] }).action, 'leave', 'expiry belongs to pending-lifecycle.js');
  const src = fs.readFileSync(path.join(__dirname, '../reprocess-review-queue.js'), 'utf8');
  for (const copy of ['childRelevance', 'temporalEvidence', 'autoPublishSafety', 'source_trust_score >=', 'SOFT']) assert.ok(!src.includes(copy), `no private policy copy: ${copy}`);
  const apply = fs.readFileSync(path.join(__dirname, '../cleaner/apply.js'), 'utf8');
  for (const copy of ["require('../childRelevance')", "require('../lib/temporalEvidence')", "require('../lib/autoPublishSafety')", 'blocksAutoPublish', 'settings.minTrust', 'settings.maxDaysAhead']) assert.ok(!apply.includes(copy), `Cleaner has no shadow policy: ${copy}`);
});

test('relevance: the Node rule is the Deno rule (explicit child age, 18+ adult signal, identical markers)', () => {
  const ext = fs.readFileSync(path.join(SHARED, 'extraction.ts'), 'utf8');
  const list = (name) => eval(ext.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);`))[1]); // eslint-disable-line no-eval
  assert.deepEqual(ADULT_MARKERS, list('ADULT_MARKERS')); assert.deepEqual(CHILD_MARKERS, list('CHILD_MARKERS'));
  assert.equal(assessChildRelevance({ name: 'מופע מוזיקלי לגיל 2-4', audience: 'unknown' }), 'ok', 'explicit child age is evidence (was review in the old Node copy)');
  assert.equal(assessChildRelevance({ name: 'חדר בריחה', audience: 'family', min_age: 18 }), 'reject', 'an 18+ minimum is adult evidence, even under a family label');
  assert.equal(assessChildRelevance({ name: 'הצגה', audience: 'adults', max_age: 8 }), 'review', 'adults label vs explicit child age is reviewable');
});

test('stale-case sweep says WHY an issue vanished: a Cleaner-patched open row is handback_pending, never "resolved_externally"', () => {
  const { staleCaseResolution } = require('../cleaner/discover');
  assert.deepEqual(staleCaseResolution('incoming', { status: 'new', cleaner_location: { method: 'existing_source_venue' } }).outcome, 'handback_pending');
  assert.deepEqual(staleCaseResolution('incoming', { status: 'needs_review', cleaner_location: null }).outcome, 'issue_cleared');
  assert.deepEqual(staleCaseResolution('incoming', { status: 'approved', cleaner_location: { method: 'x' } }), { outcome: 'resolved_externally', why: 'status:approved' });
  assert.deepEqual(staleCaseResolution('incoming', null), { outcome: 'resolved_externally', why: 'row_not_found' });
  assert.deepEqual(staleCaseResolution('activity', undefined), { outcome: 'resolved_externally' });
  // and a hand-back ERROR in the metadata path retries (markFail) instead of closing the case
  const cleaner = fs.readFileSync(path.join(__dirname, '../cleaner.js'), 'utf8');
  assert.ok(/const hb = await handBackIncoming\(client, patched, ctx\); if \(hb\.outcome === 'error'\) return markFail\(/.test(cleaner));
});
