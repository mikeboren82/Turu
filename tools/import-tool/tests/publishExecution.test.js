// Automated publish EXECUTION (2026-09-24): one publication implementation (server.js publishIncoming), run
// in-process - no admin server - with a row claim, policy re-evaluation under the claim, explicit outcomes and a
// canonical region at the location write boundary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { publishIncoming, classifyPublishError, plannedLocationWrite, PUBLISH_OUTCOME } = require('../server');
const { canonicalRegion, regionForWrite, REGIONS } = require('../lib/regions');
const { handBackFromPublish, setPublishImplForTests, handBackIncoming } = require('../cleaner/apply');

// ---- an in-memory PostgREST-shaped fake: enough of supabase-js for the publication path ----
function fakeDb(init, { failOn = null } = {}) {
  const t = structuredClone(init); let seq = 0;
  const from = (table) => {
    const q = { op: 'select', patch: null, f: [], orExpr: null, single: false };
    const test1 = (r, [k, v, kind]) => kind === 'eq' ? r[k] === v : kind === 'neq' ? r[k] !== v : kind === 'in' ? v.includes(r[k]) : kind === 'is' ? (r[k] ?? null) === v : kind === 'lt' ? String(r[k]) < String(v) : kind === 'ilike' ? String(r[k] || '').toLowerCase() === String(v).toLowerCase() : true;
    const rows = () => (t[table] ||= []).filter((r) => q.f.every((f) => test1(r, f)));
    const run = () => {
      if (failOn && failOn(table, q)) return { data: null, error: failOn(table, q) };
      if (q.op === 'insert') {
        const list = (Array.isArray(q.patch) ? q.patch : [q.patch]).map((p) => ({ id: `${table}-${++seq}`, ...p }));
        (t[table] ||= []).push(...list); return { data: list.map((r) => ({ ...r })), error: null };
      }
      if (q.op === 'upsert') { const list = (Array.isArray(q.patch) ? q.patch : [q.patch]).map((p) => ({ id: `${table}-${++seq}`, ...p })); (t[table] ||= []).push(...list); return { data: list, error: null }; }
      if (q.op === 'update') { const hit = rows(); for (const r of hit) Object.assign(r, q.patch); return { data: hit.map((r) => ({ ...r })), error: null }; }
      return { data: rows().map((r) => ({ ...r })), error: null };
    };
    const b = {
      select() { return b; }, insert(p) { q.op = 'insert'; q.patch = p; return b; }, upsert(p) { q.op = 'upsert'; q.patch = p; return b; }, update(p) { q.op = 'update'; q.patch = p; return b; },
      eq(k, v) { q.f.push([k, v, 'eq']); return b; }, neq(k, v) { q.f.push([k, v, 'neq']); return b; }, in(k, v) { q.f.push([k, v, 'in']); return b; }, is(k, v) { q.f.push([k, v, 'is']); return b; }, lt(k, v) { q.f.push([k, v, 'lt']); return b; }, ilike(k, v) { q.f.push([k, v, 'ilike']); return b; },
      or() { return b; }, not() { return b; }, gte() { return b; }, lte() { return b; }, gt() { return b; }, order() { return b; }, range() { return b; }, limit() { return b; }, match() { return b; }, contains() { return b; }, filter() { return b; },
      single() { const r = run(); return Promise.resolve({ data: r.data ? r.data[0] ?? null : null, error: r.error }); },
      maybeSingle() { const r = run(); return Promise.resolve({ data: r.data ? r.data[0] ?? null : null, error: r.error }); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  };
  return { client: { from, rpc: async () => ({ data: null, error: null }) }, t };
}
const TODAY_ISO = new Date().toISOString();
const ahead = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const candidate = (over = {}) => ({ name: 'סדנת יצירה לילדים', description: 'סדנת יצירה לילדים בגילאי 4-8', category: 'יצירה', entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: ahead(10), city: 'חולון', location_name: 'מתנ"ס נווה ארזים', audience: 'children', lat: 32.01, lng: 34.77, image_urls: ['https://x/img.jpg'], registration_url: 'https://x/register', ...over });
const world = (over = {}, srcOver = {}) => ({
  incoming_activities: [{ id: 'inc-1', source_id: 'src-1', page_url: 'https://x/events', match_type: 'new', status: 'new', validation_issues: ['מחיר'], deferred_until: null, existing_activity_id: null, created_activity_id: null, updated_at: TODAY_ISO, extracted_data: candidate(over) }],
  sources: [{ id: 'src-1', name: 'עיריית חולון - לוח אירועים', seed_url: 'https://www.holon.muni.il/events', is_trusted: false, source_trust_score: 85, activities_approved_total: 0, ...srcOver }],
  activities: [], locations: [], activity_schedules: [], activity_images: [], activity_sources: [], venues: [], venue_aliases: [], automation_settings: [], settlements: [], settlement_aliases: [],
});

test('AUTOMATION WITHOUT AN ADMIN SERVER: in-process publication creates exactly one activity; nothing listens on 4321', async () => {
  const db = fakeDb(world());
  const r = await publishIncoming(db.client, 'bot', 'inc-1', { mode: 'auto' });
  assert.equal(r.outcome, PUBLISH_OUTCOME.PUBLISHED, JSON.stringify(r.body));
  assert.equal(db.t.activities.length, 1); assert.equal(db.t.locations.length, 1);
  assert.deepEqual([db.t.incoming_activities[0].status, db.t.incoming_activities[0].created_activity_id], ['approved', db.t.activities[0].id]);
  // idempotent: a second attempt (any actor) never creates a second activity
  const again = await publishIncoming(db.client, 'bot', 'inc-1', { mode: 'auto' });
  assert.deepEqual([again.outcome, db.t.activities.length], [PUBLISH_OUTCOME.ALREADY_PUBLISHED, 1]);
  // and loading the server module opened no port
  const busy = await new Promise((res) => { const s = net.connect(4321, '127.0.0.1'); s.on('connect', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
  assert.equal(busy && process.env.EXPECT_ADMIN_SERVER !== '1', false, 'require(\'../server\') must not start the HTTP listener');
});

test('CONCURRENCY: two actors publish the same row at once -> one PUBLISHED, one CONCURRENT_STATE_CHANGE / ALREADY_PUBLISHED, one activity', async () => {
  const db = fakeDb(world());
  const [a, b] = await Promise.all([publishIncoming(db.client, 'bot', 'inc-1', { mode: 'auto' }), publishIncoming(db.client, 'bot', 'inc-1', { mode: 'auto' })]);
  const outcomes = [a.outcome, b.outcome].sort();
  assert.ok(outcomes.includes('PUBLISHED'), JSON.stringify(outcomes));
  assert.ok(['ALREADY_PUBLISHED', 'CONCURRENT_STATE_CHANGE'].some((o) => outcomes.includes(o)), JSON.stringify(outcomes));
  assert.equal(db.t.activities.length, 1, 'never two activities');
});

test('HUMAN vs AUTOMATED: auto refuses a HELD row (no write); a reviewer may approve it; nobody approves a terminal rule', async () => {
  let db = fakeDb(world({}, { source_trust_score: 50 }));
  let r = await publishIncoming(db.client, 'bot', 'inc-1', { mode: 'auto' });
  assert.deepEqual([r.outcome, r.body.blockers, db.t.activities.length, db.t.incoming_activities[0].status], [PUBLISH_OUTCOME.POLICY_HELD, ['untrusted_source'], 0, 'new']);
  r = await publishIncoming(db.client, 'reviewer', 'inc-1', { mode: 'human' });
  assert.deepEqual([r.outcome, db.t.activities.length], [PUBLISH_OUTCOME.PUBLISHED, 1]);
  db = fakeDb(world({ one_time_date: '2026-01-01' }));
  r = await publishIncoming(db.client, 'reviewer', 'inc-1', { mode: 'human' });
  assert.deepEqual([r.outcome, r.body.blockers, db.t.activities.length], [PUBLISH_OUTCOME.POLICY_INELIGIBLE, ['expired'], 0]);
  // an unknown mode is automation, never human
  db = fakeDb(world({}, { source_trust_score: 50 }));
  r = await publishIncoming(db.client, 'bot', 'inc-1', { mode: 'HUMAN' });
  assert.equal(r.outcome, PUBLISH_OUTCOME.POLICY_HELD);
});

test('retail / category אחר stays HELD at the publication boundary for any trust', async () => {
  const db = fakeDb(world({ name: 'מקדונלדס', description: 'רשת מקדונלד׳ס המציעה תפריט לכל המשפחה', category: 'אחר', entity_type: 'מקום_קבוע', schedule_type: 'fixed_hours', one_time_date: null, audience: 'family' }, { is_trusted: true, source_trust_score: 100, name: 'קניון כפר סבא הירוקה - לוח אירועים' }));
  const r = await publishIncoming(db.client, 'bot', 'inc-1', { mode: 'auto' });
  assert.deepEqual([r.outcome, r.body.blockers, db.t.activities.length], [PUBLISH_OUTCOME.POLICY_HELD, ['content_safety'], 0]);
});

test('outside the service area: terminal, the row is rejected with its evidence, nothing published', async () => {
  const db = fakeDb(world({ city: 'רמאללה', lat: 31.9038, lng: 35.2034, location_name: 'מרכז העיר' }));
  const r = await publishIncoming(db.client, 'bot', 'inc-1', { mode: 'auto' });
  assert.equal(r.outcome, PUBLISH_OUTCOME.POLICY_INELIGIBLE, JSON.stringify(r.body).slice(0, 300));
  assert.equal(db.t.activities.length, 0);
  assert.equal(db.t.incoming_activities[0].status, 'rejected');
});

test('REGION at the write boundary: canonical kept, legacy / geocoder text -> null, never remapped ("שביל האלות" regression)', async () => {
  assert.equal(canonicalRegion('השפלה'), 'השפלה');
  assert.equal(canonicalRegion('השפלה והדרום'), null, 'pre-0084 value');
  assert.equal(canonicalRegion('מחוז ירושלים'), null, 'geocoder admin area');
  assert.equal(canonicalRegion(null), null); assert.equal(canonicalRegion('  הדרום והנגב '), 'הדרום והנגב');
  assert.deepEqual(regionForWrite('השפלה והדרום'), { region: null, dropped: 'השפלה והדרום' });
  // the list is exactly the enforcing DB constraint (0084 locations_region_check)
  const sql = fs.readFileSync(path.join(__dirname, '../../../supabase/0084_split_north_south_regions.sql'), 'utf8');
  const block = sql.slice(sql.indexOf('add constraint locations_region_check'));
  assert.deepEqual([...block.slice(0, block.indexOf(';')).matchAll(/'([^']+)'/g)].map((m) => m[1]), REGIONS);
  // the real failing candidate shape: its location is written with region NULL, and it publishes
  const db = fakeDb(world({ name: 'שביל האלות בפארק בריטניה', city: 'מועצה אזורית מטה יהודה', location_name: 'פארק בריטניה', region: 'השפלה והדרום', lat: 31.6888919, lng: 34.927992, category: 'טבע', description: 'מסלול טבע משפחתי לילדים מגיל 3', min_age: 3 }));
  assert.deepEqual(plannedLocationWrite(db.t.incoming_activities[0].extracted_data).region, null);
  const r = await publishIncoming(db.client, 'bot', 'inc-1', { mode: 'auto' });
  assert.equal(r.outcome, PUBLISH_OUTCOME.PUBLISHED, JSON.stringify(r.body));
  assert.equal(db.t.locations[0].region, null);
  const ok = fakeDb(world({ region: 'השפלה' }));
  await publishIncoming(ok.client, 'bot', 'inc-1', { mode: 'auto' });
  assert.equal(ok.t.locations[0].region, 'השפלה');
});

test('FAILURE SEMANTICS: a temporary infrastructure failure is explicit, releases the claim, and creates nothing', async () => {
  const db = fakeDb(world(), { failOn: (table, q) => (table === 'activities' && q.op === 'insert' ? { message: 'TypeError: fetch failed', code: '' } : null) });
  const r = await publishIncoming(db.client, 'bot', 'inc-1', { mode: 'auto' });
  assert.equal(r.outcome, PUBLISH_OUTCOME.TEMPORARY_INFRA_FAILURE);
  assert.equal(db.t.incoming_activities[0].status, 'new', 'claim released - the row is retryable');
  assert.equal(classifyPublishError({ code: '23514', message: 'new row for relation "locations" violates check constraint "locations_region_check"' }), 'LOCATION_INVALID');
  assert.equal(classifyPublishError({ code: '42501', message: 'permission denied' }), 'WRITE_DENIED');
  assert.equal(classifyPublishError({ message: 'socket hang up' }), 'TEMPORARY_INFRA_FAILURE');
  assert.equal(classifyPublishError({ message: 'something odd' }), 'ERROR');
  // dry run: evaluates + plans, claims and writes nothing
  const dry = fakeDb(world({ region: 'השפלה והדרום' }));
  const d = await publishIncoming(dry.client, 'bot', 'inc-1', { mode: 'auto', dryRun: true });
  assert.deepEqual([d.outcome, d.body.plannedLocation.region, d.body.plannedLocation.region_dropped, dry.t.incoming_activities[0].status, dry.t.activities.length], ['DRY_RUN', null, 'השפלה והדרום', 'new', 0]);
});

test('Cleaner: publication outcome -> hand-back outcome (policy decisions resolve, infrastructure failures retry)', async () => {
  assert.equal(handBackFromPublish({ outcome: 'PUBLISHED', body: { activityId: 'a1' } }).outcome, 'published');
  assert.equal(handBackFromPublish({ outcome: 'ALREADY_PUBLISHED', body: {} }).outcome, 'already_resolved');
  assert.equal(handBackFromPublish({ outcome: 'DUPLICATE_RESOLVED', body: { duplicateOf: 'a2' } }).outcome, 'duplicate_merged');
  assert.equal(handBackFromPublish({ outcome: 'POLICY_HELD', body: { reasons: [{ code: 'untrusted_source' }] } }).outcome, 'awaiting_policy');
  assert.equal(handBackFromPublish({ outcome: 'CONCURRENT_STATE_CHANGE', body: { currentStatus: 'approved' } }).outcome, 'resolved_externally');
  const temp = handBackFromPublish({ outcome: 'TEMPORARY_INFRA_FAILURE', body: { error: 'fetch failed' } });
  assert.deepEqual([temp.outcome, temp.retryable], ['error', true]);
  assert.equal(handBackFromPublish({ outcome: 'LOCATION_INVALID', body: { error: 'x' } }).outcome, 'error');
  // the hand-back publishes IN-PROCESS: an eligible row reaches publication with no server; mode is always 'auto'
  const calls = [];
  setPublishImplForTests(async (client, userId, id, opts) => { calls.push(opts.mode); return { outcome: 'PUBLISHED', status: 200, body: { activityId: 'act-1' } }; });
  const db = fakeDb(world());
  const settings = { thresholds: { duplicate: 0.9, needsReview: 0.6, proximityKm: 0.15 }, minTrust: 80, maxDaysAhead: 180 };
  const hb = await handBackIncoming(db.client, db.t.incoming_activities[0], { settings, userId: 'bot', cache: new Map(), today: new Date().toISOString().slice(0, 10), counters: { gain: {} } });
  assert.deepEqual([hb.outcome, calls], ['published', ['auto']]);
  setPublishImplForTests(null);
});

test('no automated caller can identify as human; no automated path needs the admin server', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  for (const f of ['cleaner/apply.js', 'reprocess-review-queue.js', 'cleaner.js', 'pending-lifecycle.js']) {
    const s = read(f);
    assert.ok(!/mode:\s*'human'/.test(s), `${f} never passes mode 'human'`);
    assert.ok(!/localhost:4321|ADMIN_BASE|\/api\/incoming\/[^'`]*\/approve/.test(s), `${f} does not call the admin server`);
  }
  const server = read('server.js');
  assert.ok(/if \(require\.main === module\) \{\s*const PORT/.test(server), 'the listener starts only when server.js is run');
  const route = server.slice(server.indexOf("app.post('/api/incoming/:id/approve'"));
  assert.ok(/mode: b\.mode === 'human' \? 'human' : 'auto'/.test(route.slice(0, 600)), 'human only from the inbox request body');
});
