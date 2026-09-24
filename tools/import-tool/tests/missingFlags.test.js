const test = require('node:test');
const assert = require('node:assert/strict');
const { applyMissingAccounting, writeMissingFlag, missingEligibility, scopeKey, FLAG_CLOSE } = require('../lib/missingScope');

// Table-backed fake that enforces idx_incoming_activities_missing_unique (one OPEN missing flag per activity).
function fakeDb(init, { failInsert = null, raceOnce = false } = {}) {
  const t = structuredClone(init);
  let seq = 0, raced = false;
  const from = (table) => {
    const q = { op: 'select', patch: null, f: [], ret: false };
    const match = (r) => q.f.every(([k, v, kind]) => kind === 'eq' ? r[k] === v : kind === 'in' ? v.includes(r[k]) : (r[k] ?? null) === v);
    const run = () => {
      const rows = (t[table] ||= []);
      if (q.op === 'insert') {
        if (failInsert) return { data: null, error: failInsert };
        const openDup = (r) => r.match_type === 'missing' && r.status === 'missing_flagged' && r.existing_activity_id === q.patch.existing_activity_id;
        if (raceOnce && !raced) { raced = true; rows.push({ id: `race-${++seq}`, ...q.patch }); return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }; }
        if (q.patch.match_type === 'missing' && q.patch.status === 'missing_flagged' && rows.some(openDup)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
        const r = { id: `inc-${++seq}`, ...q.patch }; rows.push(r); return { data: [{ id: r.id }], error: null };
      }
      const hit = rows.filter(match);
      if (q.op === 'update') { for (const r of hit) Object.assign(r, q.patch); return { data: q.ret ? hit.map((r) => ({ ...r })) : null, error: null }; }
      return { data: hit.map((r) => ({ ...r })), error: null };
    };
    const b = {
      select() { if (q.op !== 'select') q.ret = true; return b; }, update(p) { q.op = 'update'; q.patch = p; return b; }, insert(p) { q.op = 'insert'; q.patch = p; return b; },
      eq(k, v) { q.f.push([k, v, 'eq']); return b; }, in(k, v) { q.f.push([k, v, 'in']); return b; }, is(k, v) { q.f.push([k, v, 'is']); return b; },
      maybeSingle() { const r = run(); return Promise.resolve({ data: r.data ? r.data[0] ?? null : null, error: r.error }); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  };
  return { client: { from }, t, act: (id) => t.activities.find((a) => a.id === id), flags: () => t.incoming_activities.filter((r) => r.match_type === 'missing') };
}

const CAL = 'https://www.city.example/events';
const KEY = scopeKey(CAL);
const future = [{ schedule_type: 'one_time', one_time_date: '2026-12-01' }];
const base = (acts) => ({
  activities: acts.map((a) => ({ source_id: 'S', status: 'approved', consecutive_missing_scans: 0, missing_verified_streak: 0, entity_type: 'אירוע', activity_schedules: future, ...a })),
  activity_sources: acts.map((a) => ({ activity_id: a.id, source_id: 'S', page_url: `${CAL}#part=1`, url_role: 'listing' })),
  incoming_activities: [],
});
const changedWithout = new Map([[KEY, { complete: true, changedProcessed: true, text: 'לוח אירועים חדש לגמרי' }]]);
const run = (db, extra = {}) => applyMissingAccounting(db.client, { sourceId: 'S', scopes: changedWithout, matchedIds: new Set(), threshold: 3, flagsEnabled: true, today: '2026-09-24', ...extra });

test('CUTOVER: a legacy count of 19 with no verified evidence cannot create a flag', async () => {
  const db = fakeDb(base([{ id: 'x', name: 'מופע ילדים שהוסר', consecutive_missing_scans: 19 }]));
  await run(db);
  assert.equal(db.act('x').missing_verified_streak, 1); // one verified absence, starting from 0
  assert.equal(db.flags().length, 0);
});

test('THRESHOLD: a future dated event absent from N=3 complete changed pages opens exactly ONE flag; more absences never duplicate it', async () => {
  const db = fakeDb(base([{ id: 'x', name: 'מופע ילדים שהוסר' }]));
  const s1 = (await run(db)).summary, s2 = (await run(db)).summary, s3 = (await run(db)).summary, s4 = (await run(db)).summary;
  assert.deepEqual([s1.flags, s2.flags, s3.flags, s4.flags], [{}, {}, { CREATED: 1 }, { ALREADY_OPEN: 1 }]);
  assert.equal(db.flags().length, 1);
  assert.equal(db.flags()[0].extracted_data.missing_verified_streak, 4); // evidence refreshed in place
  assert.equal(db.flags()[0].extracted_data.next_occurrence, '2026-12-01');
});

test('REAPPEARANCE: the event is back on the page -> streak 0 and the open flag closes automatically', async () => {
  const db = fakeDb(base([{ id: 'x', name: 'מופע ילדים שהוסר' }]));
  for (let i = 0; i < 3; i++) await run(db);
  const s = (await run(db, { scopes: new Map([[KEY, { complete: true, changedProcessed: false, text: 'לוח ... מופע ילדים שהוסר ...' }]]) })).summary;
  assert.equal(db.act('x').missing_verified_streak, 0);
  assert.equal(db.flags()[0].status, 'rejected');
  assert.equal(db.flags()[0].archive_reason, FLAG_CLOSE.reappeared);
  assert.equal(s.flags_closed, 1);
});

test('FUZZY presence (listed, not verbatim) resets the streak and closes the flag, but claims no freshness', async () => {
  const db = fakeDb(base([{ id: 'x', name: 'מופע ילדים שהוסר מהלוח', last_seen_at: '2026-09-01T00:00:00Z' }]));
  for (let i = 0; i < 3; i++) await run(db);
  await run(db, { scopes: new Map([[KEY, { complete: true, changedProcessed: true, text: 'מופע ילדים שהוסר - מהדורה חדשה' }]]) });
  assert.equal(db.act('x').missing_verified_streak, 0);
  assert.equal(db.act('x').last_seen_at, '2026-09-01T00:00:00Z');
  assert.equal(db.flags()[0].archive_reason, FLAG_CLOSE.reappeared);
});

test('MATCHED by extraction (or P1 reconfirmation) also closes the open flag', async () => {
  const db = fakeDb(base([{ id: 'x', name: 'מופע ילדים שהוסר' }]));
  for (let i = 0; i < 3; i++) await run(db);
  await run(db, { matchedIds: new Set(['x']) });
  assert.equal(db.flags()[0].archive_reason, FLAG_CLOSE.reappeared);
});

test('PLACES / PROGRAMMES / PAST EVENTS: never accrue verified evidence, never flag', async () => {
  const db = fakeDb(base([
    { id: 'place', name: 'ספרייה עירונית', entity_type: 'מקום_קבוע', activity_schedules: [{ schedule_type: 'fixed_hours', one_time_date: null }] },
    { id: 'prog', name: 'תוכנית קבועה', entity_type: 'אירוע_קבוע', activity_schedules: [] },
    { id: 'past', name: 'אירוע שעבר', activity_schedules: [{ schedule_type: 'one_time', one_time_date: '2026-09-01' }] },
  ]));
  for (let i = 0; i < 5; i++) await run(db);
  for (const id of ['place', 'prog', 'past']) assert.equal(db.act(id).missing_verified_streak, 0);
  assert.equal(db.act('place').consecutive_missing_scans, 5); // informational legacy column only
  assert.equal(db.flags().length, 0);
});

test('INCOMPLETE / UNREADABLE / UNCHECKED pages never advance verified evidence', async () => {
  const db = fakeDb(base([{ id: 'x', name: 'מופע ילדים שהוסר', missing_verified_streak: 2 }]));
  for (const scopes of [new Map([[KEY, { complete: false, changedProcessed: true, text: '' }]]), new Map(), new Map([[KEY, { complete: true, changedProcessed: false, text: 'x' }]])]) await run(db, { scopes });
  assert.equal(db.act('x').missing_verified_streak, 2);
  assert.equal(db.flags().length, 0);
});

test('AGGREGATOR sources and the disabled switch never write a flag (disabled counts would_flag)', async () => {
  const agg = fakeDb(base([{ id: 'x', name: 'מופע ילדים שהוסר', missing_verified_streak: 5 }]));
  await run(agg, { sourceKind: 'aggregator' });
  const off = fakeDb(base([{ id: 'x', name: 'מופע ילדים שהוסר', missing_verified_streak: 5 }]));
  const s = (await run(off, { flagsEnabled: false })).summary;
  assert.equal(agg.flags().length + off.flags().length, 0);
  assert.equal(s.would_flag, 1);
});

test('LIFECYCLE: an open flag closes when the event becomes past, or the activity leaves approved (expiry / archive)', async () => {
  const db = fakeDb(base([{ id: 'x', name: 'מופע ילדים שהוסר' }, { id: 'y', name: 'עוד אירוע שהוסר' }]));
  for (let i = 0; i < 3; i++) await run(db);
  db.act('x').activity_schedules = [{ schedule_type: 'one_time', one_time_date: '2026-09-20' }];
  db.act('y').status = 'archived';
  await run(db);
  const byAct = Object.fromEntries(db.flags().map((f) => [f.existing_activity_id, f.archive_reason]));
  assert.deepEqual(byAct, { x: FLAG_CLOSE.notEligible, y: FLAG_CLOSE.notLive });
});

test('WRITE PATH: lost race (unique violation) resolves to the existing open flag; any other DB error surfaces', async () => {
  const race = fakeDb(base([{ id: 'x', name: 'n' }]), { raceOnce: true });
  const r1 = await writeMissingFlag(race.client, { sourceId: 'S', activityId: 'x', pageUrl: CAL, evidence: { a: 1 } });
  assert.equal(r1.code, 'ALREADY_OPEN');
  assert.equal(race.flags().length, 1);
  const broken = fakeDb(base([{ id: 'x', name: 'n' }]), { failInsert: { code: '42501', message: 'permission denied' } });
  const r2 = await writeMissingFlag(broken.client, { sourceId: 'S', activityId: 'x', pageUrl: CAL, evidence: {} });
  assert.deepEqual([r2.code, r2.error], ['ERROR', 'permission denied']);
});

test('eligibility by shape', () => {
  assert.equal(missingEligibility({ entity_type: 'אירוע', activity_schedules: [{ schedule_type: 'one_time', one_time_date: '2026-09-30' }, { schedule_type: 'one_time', one_time_date: '2026-09-01' }] }, '2026-09-24').shape, 'event_series');
  assert.equal(missingEligibility({ entity_type: 'אירוע', activity_schedules: [{ schedule_type: 'recurring', one_time_date: null }] }, '2026-09-24').eligible, false);
  assert.equal(missingEligibility({ entity_type: 'אירוע', activity_schedules: [{ schedule_type: 'one_time', one_time_date: '2026-09-24' }] }, '2026-09-24').eligible, true); // today still counts
});
