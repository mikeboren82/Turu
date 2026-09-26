// venues.google_place_id as external identity (0114): the create-by-place-id door, the merge transfer invariant,
// retry/concurrency behaviour, and the migration's shape. Pure - an in-memory PostgREST fake, no DB / network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { CODES, normalizePlaceId, toVenueInsertRow, canonicalVenueByPlaceId, ensureVenueByPlaceId, planPlaceIdMerge, mergeVenuePlaceId } = require('../lib/venuePlaceId');

// Fake PostgREST over one venues table. Every statement is applied atomically when awaited (as Postgres does under
// the unique index), after yielding to the event loop so concurrent callers genuinely interleave.
// uniqueIndex=false models the pre-0114 schema (no arbiter: ON CONFLICT -> 42P10, duplicates insertable).
function fakeDb({ uniqueIndex = true, rows = [] } = {}) {
  const db = { uniqueIndex, venues: rows.map((r) => ({ is_active: true, merged_into: null, google_place_id: null, ...r })), writes: [], hooks: {}, seq: 0 };
  const tick = () => new Promise((r) => setImmediate(r));
  const clone = (r) => ({ ...r });
  const violation = { code: '23505', message: 'duplicate key value violates unique constraint "idx_venues_google_place_id_unique"' };
  const takenBy = (pid, exceptIds = []) => db.uniqueIndex && pid != null && db.venues.some((v) => v.google_place_id === pid && !exceptIds.includes(v.id));
  const insertRow = (row) => { const v = { id: `v${++db.seq}`, is_active: true, merged_into: null, google_place_id: null, ...row }; db.venues.push(v); return v; };

  class Query {
    constructor(table) { this.table = table; this.op = 'select'; this.filters = []; this.mode = 'many'; }
    select() { return this; }
    insert(row) { this.op = 'insert'; this.row = row; return this; }
    upsert(row, opts) { this.op = 'upsert'; this.row = row; this.opts = opts || {}; return this; }
    update(patch) { this.op = 'update'; this.patch = patch; return this; }
    eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
    is(c, v) { this.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
    in(c, vs) { this.filters.push((r) => vs.includes(r[c])); return this; }
    maybeSingle() { this.mode = 'maybe'; return this; }
    single() { this.mode = 'single'; return this; }
    then(res, rej) { return this.exec().then(res, rej); }
    async exec() {
      await tick();
      if (this.table !== 'venues') throw new Error(`fake has no table ${this.table}`);
      if (db.hooks.before) db.hooks.before(this, db);
      let out = this.apply();
      if (db.hooks.after) out = db.hooks.after(this, out, db) || out;
      return out;
    }
    apply() {
      const match = (r) => this.filters.every((f) => f(r));
      if (this.op === 'select') {
        const data = db.venues.filter(match).map(clone);
        if (this.mode === 'many') return { data, error: null };
        if (data.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' } };
        if (this.mode === 'single' && !data.length) return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
        return { data: data[0] || null, error: null };
      }
      db.writes.push({ op: this.op, row: this.row, patch: this.patch });
      if (this.op === 'insert') {
        if (takenBy(this.row.google_place_id)) return { data: null, error: violation };
        const v = insertRow(this.row);
        return { data: this.mode === 'many' ? [clone(v)] : clone(v), error: null };
      }
      if (this.op === 'upsert') {
        if (this.opts.onConflict !== 'google_place_id' || !this.opts.ignoreDuplicates) throw new Error('fake only models ON CONFLICT (google_place_id) DO NOTHING');
        if (!db.uniqueIndex) return { data: null, error: { code: '42P10', message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification' } };
        if (takenBy(this.row.google_place_id)) return { data: [], error: null }; // DO NOTHING returns no row
        return { data: [clone(insertRow(this.row))], error: null };
      }
      const targets = db.venues.filter(match);
      const pid = this.patch.google_place_id;
      if (pid != null && takenBy(pid, targets.map((t) => t.id))) return { data: null, error: violation }; // statement-atomic
      for (const t of targets) Object.assign(t, this.patch);
      return { data: targets.map((t) => ({ id: t.id })), error: null };
    }
  }
  db.client = { from: (t) => new Query(t) };
  db.owners = (pid) => db.venues.filter((v) => v.google_place_id === pid);
  db.byId = (id) => db.venues.find((v) => v.id === id);
  // the invariant 0114 exists for: no non-null id owned by two rows
  db.noDuplicateIds = () => { const seen = new Set(); for (const v of db.venues) { if (v.google_place_id == null) continue; if (seen.has(v.google_place_id)) return false; seen.add(v.google_place_id); } return true; };
  return db;
}

const LIB = { name_he: 'ספריית בית אריאלה', venue_type: 'library', city: 'תל אביב-יפו', address: 'שאול המלך 25', lat: 32.07, lng: 34.78 };

// ---------------------------------------------------------------- 8. unique writer
test('A: first venue with a place id inserts exactly one venue', async () => {
  const db = fakeDb();
  const r = await ensureVenueByPlaceId(db.client, { ...LIB, google_place_id: 'P1' });
  assert.equal(r.created, true);
  assert.equal(r.venue.google_place_id, 'P1');
  assert.equal(db.owners('P1').length, 1);
});

test('B: the same place id submitted again resolves to the same canonical venue', async () => {
  const db = fakeDb();
  const a = await ensureVenueByPlaceId(db.client, { ...LIB, google_place_id: 'P1' });
  const b = await ensureVenueByPlaceId(db.client, { ...LIB, google_place_id: 'P1' });
  assert.equal(b.created, false);
  assert.equal(b.venue.id, a.venue.id);
  assert.equal(db.venues.length, 1);
});

test('C: retry after an uncertain response (insert committed, response lost) returns the same venue', async () => {
  const db = fakeDb();
  let dropped = false;
  db.hooks.after = (q, out) => { if (q.op === 'upsert' && !dropped) { dropped = true; return { data: null, error: { message: 'fetch failed: socket hang up' } }; } };
  const first = await ensureVenueByPlaceId(db.client, { ...LIB, google_place_id: 'P1' });
  assert.ok(first.error, 'the caller saw a failure');
  assert.equal(db.owners('P1').length, 1, '...but the row was committed');
  const retry = await ensureVenueByPlaceId(db.client, { ...LIB, google_place_id: 'P1' });
  assert.equal(retry.created, false);
  assert.equal(retry.venue.id, db.owners('P1')[0].id);
  assert.equal(db.venues.length, 1);
});

test('D: two concurrent creates with the same place id -> one venue, both callers get its id', async () => {
  const db = fakeDb();
  const [a, b] = await Promise.all([
    ensureVenueByPlaceId(db.client, { ...LIB, google_place_id: 'P1' }),
    ensureVenueByPlaceId(db.client, { ...LIB, name_he: 'ספרייה בית אריאלה', google_place_id: 'P1' }),
  ]);
  assert.equal(db.venues.length, 1);
  assert.equal(a.venue.id, b.venue.id);
  assert.deepEqual([a.created, b.created].sort(), [false, true]);
});

test('E: a place id still held by a merged loser (legacy) resolves to the active keeper', async () => {
  const db = fakeDb({ rows: [
    { id: 'L', name_he: 'old', google_place_id: 'P1', is_active: false, merged_into: 'M' },
    { id: 'M', name_he: 'middle', is_active: false, merged_into: 'K' },
    { id: 'K', name_he: 'keeper' },
  ] });
  const r = await ensureVenueByPlaceId(db.client, { ...LIB, google_place_id: 'P1' });
  assert.equal(r.venue.id, 'K');
  assert.equal(r.created, false);
  assert.equal(r.inactive, false);
  assert.deepEqual(r.followed, ['M', 'K']);
  assert.equal(db.venues.length, 3, 'no new venue');
});

test('E: a merged_into cycle is reported, never looped or silently resolved', async () => {
  const db = fakeDb({ rows: [{ id: 'A', name_he: 'a', google_place_id: 'P1', is_active: false, merged_into: 'B' }, { id: 'B', name_he: 'b', is_active: false, merged_into: 'A' }] });
  const r = await canonicalVenueByPlaceId(db.client, 'P1');
  assert.equal(r.code, CODES.MERGE_CHAIN_BROKEN);
});

test('F: a null / blank place id never takes the external-identity path and writes nothing', async () => {
  for (const pid of [null, undefined, '', '   ']) {
    const db = fakeDb();
    const r = await ensureVenueByPlaceId(db.client, { ...LIB, google_place_id: pid });
    assert.equal(r.code, CODES.PLACE_ID_REQUIRED);
    assert.equal(db.writes.length, 0);
  }
  assert.equal(normalizePlaceId('  ChIJ123  '), 'ChIJ123');
});

test('F: venues without an id do not collide with each other (NULLs are distinct under the unique index)', async () => {
  const db = fakeDb();
  await db.client.from('venues').insert({ name_he: 'a' }).select('*').single();
  await db.client.from('venues').insert({ name_he: 'b' }).select('*').single();
  assert.equal(db.venues.length, 2);
});

test('G: a second discovery never overwrites the existing venue\'s descriptive fields', async () => {
  const db = fakeDb({ rows: [{ id: 'K', ...LIB, google_place_id: 'P1', notes: 'human note' }] });
  const r = await ensureVenueByPlaceId(db.client, { name_he: 'Beit Ariela Library', venue_type: 'other', city: 'רמת גן', address: 'elsewhere 1', lat: 1, lng: 2, notes: 'osm:node/9', google_place_id: 'P1' });
  assert.equal(r.venue.id, 'K');
  assert.deepEqual(db.byId('K'), { id: 'K', is_active: true, merged_into: null, ...LIB, google_place_id: 'P1', notes: 'human note' });
});

test('pre-0114 schema (no unique index): the helper refuses instead of creating a possible duplicate', async () => {
  const db = fakeDb({ uniqueIndex: false });
  const r = await ensureVenueByPlaceId(db.client, { ...LIB, google_place_id: 'P1' });
  assert.equal(r.code, CODES.INDEX_MISSING);
  assert.equal(db.venues.length, 0);
});

test('coverage writer contract: a plan venue object goes through the same door; plan-only keys never reach the table', async () => {
  // shape of tools/coverage/lib/plan.js CREATE_VENUE (coverage-phase1 76091b4)
  const planned = { kind: 'venue', id: 'new:libraries:1', name_he: 'הספרייה העירונית רמת השרון', venue_type: 'library', city: 'רמת השרון', lat: 32.14, lng: 34.84,
    address: null, chain: null, branch: 'מרכז', website_url: null, google_place_id: 'P7', aliases: ['ספריית רמת השרון'], is_active: true, notes: 'osm:node/1' };
  assert.deepEqual(Object.keys(toVenueInsertRow(planned)).sort(), ['address', 'chain', 'city', 'google_place_id', 'is_active', 'lat', 'lng', 'name_he', 'notes', 'venue_type', 'website_url']);
  const db = fakeDb();
  const r = await ensureVenueByPlaceId(db.client, planned);
  assert.equal(r.created, true);
  assert.notEqual(r.venue.id, 'new:libraries:1');
  for (const k of ['kind', 'aliases', 'branch']) assert.equal(k in db.venues[0], false, k);
});

// ---------------------------------------------------------------- 9. merge invariant
test('merge A: loser has the id, keeper none -> id transfers to the keeper, loser cleared', async () => {
  const db = fakeDb({ rows: [{ id: 'K', name_he: 'k' }, { id: 'L', name_he: 'l', google_place_id: 'P1' }] });
  const r = await mergeVenuePlaceId(db.client, { keeper: db.byId('K'), loser: db.byId('L') });
  assert.deepEqual(r, { outcome: 'TRANSFERRED', placeId: 'P1' });
  assert.equal(db.byId('K').google_place_id, 'P1');
  assert.equal(db.byId('L').google_place_id, null);
});

test('merge B: keeper and loser share the id (pre-0114 legacy) -> keeper keeps it, loser cleared', async () => {
  const db = fakeDb({ uniqueIndex: false, rows: [{ id: 'K', name_he: 'k', google_place_id: 'P1' }, { id: 'L', name_he: 'l', google_place_id: 'P1' }] });
  const r = await mergeVenuePlaceId(db.client, { keeper: db.byId('K'), loser: db.byId('L') });
  assert.equal(r.outcome, 'CLEARED_LOSER');
  assert.deepEqual(db.owners('P1').map((v) => v.id), ['K']);
});

test('merge C: loser without an id -> normal merge, nothing written', async () => {
  for (const keeperId of [null, 'P2']) {
    const db = fakeDb({ rows: [{ id: 'K', name_he: 'k', google_place_id: keeperId }, { id: 'L', name_he: 'l' }] });
    assert.deepEqual(await mergeVenuePlaceId(db.client, { keeper: db.byId('K'), loser: db.byId('L') }), { outcome: 'NONE' });
    assert.equal(db.writes.length, 0);
  }
});

test('merge D: different ids on keeper and loser -> refused with VENUE_MERGE_EXTERNAL_ID_CONFLICT, nothing written', async () => {
  const db = fakeDb({ rows: [{ id: 'K', name_he: 'k', google_place_id: 'P2' }, { id: 'L', name_he: 'l', google_place_id: 'P1' }] });
  const r = await mergeVenuePlaceId(db.client, { keeper: db.byId('K'), loser: db.byId('L') });
  assert.equal(r.code, 'VENUE_MERGE_EXTERNAL_ID_CONFLICT');
  assert.deepEqual([r.keeperPlaceId, r.loserPlaceId], ['P2', 'P1']);
  assert.equal(db.writes.length, 0);
  assert.equal(planPlaceIdMerge({ google_place_id: 'P2' }, { google_place_id: 'P1' }).action, 'CONFLICT');
});

test('merge E: keeper assignment fails -> loser restored, never two owners', async () => {
  const db = fakeDb({ rows: [{ id: 'K', name_he: 'k' }, { id: 'L', name_he: 'l', google_place_id: 'P1' }] });
  let fired = false; // a concurrent edit gives the keeper another id between our read and our write
  db.hooks.before = (q) => { if (!fired && q.op === 'update' && q.patch.google_place_id === 'P1') { fired = true; db.byId('K').google_place_id = 'Q9'; } };
  const r = await mergeVenuePlaceId(db.client, { keeper: { id: 'K', google_place_id: null }, loser: db.byId('L') });
  assert.equal(r.code, CODES.TRANSFER_FAILED);
  assert.equal(r.stage, 'assign_keeper');
  assert.equal(r.compensation, 'RESTORED');
  assert.equal(db.byId('L').google_place_id, 'P1');
  assert.ok(db.noDuplicateIds());
});

test('merge E: even when the restore also fails (a new owner appeared), no id is ever owned twice', async () => {
  const db = fakeDb({ rows: [{ id: 'K', name_he: 'k' }, { id: 'L', name_he: 'l', google_place_id: 'P1' }] });
  let fired = false; // between "clear loser" and "set keeper" another writer creates a venue for P1
  db.hooks.before = (q) => { if (!fired && q.op === 'update' && q.patch.google_place_id === 'P1') { fired = true; db.venues.push({ id: 'X', name_he: 'x', google_place_id: 'P1', is_active: true, merged_into: null }); } };
  const r = await mergeVenuePlaceId(db.client, { keeper: db.byId('K'), loser: db.byId('L') });
  assert.equal(r.code, CODES.TRANSFER_FAILED);
  assert.equal(r.compensation, 'FAILED');
  assert.match(r.error, /P1/);
  assert.deepEqual(db.owners('P1').map((v) => v.id), ['X']);
  assert.ok(db.noDuplicateIds());
});

test('merge E: loser changed since it was read -> nothing is moved', async () => {
  const db = fakeDb({ rows: [{ id: 'K', name_he: 'k' }, { id: 'L', name_he: 'l', google_place_id: 'P5' }] });
  const r = await mergeVenuePlaceId(db.client, { keeper: db.byId('K'), loser: { id: 'L', google_place_id: 'P1' } });
  assert.equal(r.stage, 'clear_loser');
  assert.equal(db.byId('L').google_place_id, 'P5');
  assert.equal(db.byId('K').google_place_id, null);
});

test('merge F: after a merge the merged loser is never the canonical lookup result', async () => {
  const db = fakeDb({ rows: [{ id: 'K', name_he: 'k' }, { id: 'L', name_he: 'l', google_place_id: 'P1' }] });
  await mergeVenuePlaceId(db.client, { keeper: db.byId('K'), loser: db.byId('L') });
  Object.assign(db.byId('L'), { is_active: false, merged_into: 'K' }); // the rest of the merge
  const r = await ensureVenueByPlaceId(db.client, { ...LIB, google_place_id: 'P1' });
  assert.equal(r.venue.id, 'K');
  assert.deepEqual(r.followed, []);
  assert.equal(db.venues.length, 2);
});

// ---------------------------------------------------------------- 10. concurrency / retry proof
test('RACE: SELECT-then-INSERT without the index makes two venues; with 0114 the second caller fails; the helper gives both one id', async () => {
  const naiveCreate = async (client, pid) => {
    const { data: found } = await client.from('venues').select('*').eq('google_place_id', pid).maybeSingle();
    if (found) return { venue: found };
    const { data, error } = await client.from('venues').insert({ ...LIB, google_place_id: pid }).select('*').single();
    return error ? { error } : { venue: data };
  };
  const before = fakeDb({ uniqueIndex: false });
  await Promise.all([naiveCreate(before.client, 'P1'), naiveCreate(before.client, 'P1')]);
  assert.equal(before.owners('P1').length, 2, 'today: both writers saw "no place" and both inserted');

  const indexOnly = fakeDb();
  const naive = await Promise.all([naiveCreate(indexOnly.client, 'P1'), naiveCreate(indexOnly.client, 'P1')]);
  assert.equal(indexOnly.owners('P1').length, 1);
  assert.equal(naive.filter((r) => r.error && r.error.code === '23505').length, 1, 'the index alone turns the loser of the race into an error');

  const helper = fakeDb();
  const got = await Promise.all(Array.from({ length: 5 }, () => ensureVenueByPlaceId(helper.client, { ...LIB, google_place_id: 'P1' })));
  assert.equal(helper.venues.length, 1);
  assert.equal(new Set(got.map((r) => r.venue.id)).size, 1, 'every caller resolves to the one venue');
});

test('RETRY: the identical request repeated sequentially is a no-op after the first', async () => {
  const db = fakeDb();
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await ensureVenueByPlaceId(db.client, { ...LIB, google_place_id: 'P1' })).venue.id);
  assert.equal(new Set(ids).size, 1);
  assert.equal(db.venues.length, 1);
});

// ---------------------------------------------------------------- integration pins (source + migration shape)
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const between = (from, to) => server.slice(server.indexOf(from), server.indexOf(to, server.indexOf(from)));

test('admin POST /api/venues: a place id goes through ensureVenueByPlaceId; a null id keeps the plain insert', () => {
  const create = between("app.post('/api/venues',", "app.post('/api/venues/:id/alias'");
  assert.match(create, /delete fields\.google_place_id/);
  assert.match(create, /if \(placeId\)[\s\S]*ensureVenueByPlaceId\(/);
  assert.match(create, /from\('venues'\)\.insert\(\{ \.\.\.fields/);
  assert.ok(create.indexOf('delete fields.google_place_id') < create.indexOf(".from('venues').insert("), 'the plain insert can never carry a place id');
});

test('venue merge: reads keeper and loser, transfers the place id BEFORE re-pointing anything, returns on refusal', () => {
  const m = server.slice(server.indexOf("app.post('/api/venues/merge'"));
  const transfer = m.indexOf('mergeVenuePlaceId(');
  assert.ok(transfer > 0 && transfer < m.indexOf("for (const table of ['activities', 'locations', 'sources'])"));
  assert.match(m.slice(0, m.indexOf("for (const table of")), /\.in\('id', \[keeperId, loserId\]\)/);
  assert.match(m.slice(transfer, m.indexOf("for (const table of")), /if \(placeIdMove\.error\) return res\.status/);
});

test('0114 SQL: non-partial unique index, not concurrent, created before the old index is dropped, in one transaction', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'supabase', '0114_venues_place_id_unique.sql'), 'utf8');
  const sql = raw.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').toLowerCase();
  assert.match(sql, /create unique index idx_venues_google_place_id_unique on public\.venues \(google_place_id\);/);
  assert.doesNotMatch(sql, /concurrently/);
  assert.doesNotMatch(sql.slice(sql.indexOf('create unique index'), sql.indexOf(';', sql.indexOf('create unique index'))), /where/);
  const begin = sql.indexOf('begin;'), create = sql.indexOf('create unique index'), drop = sql.indexOf('drop index if exists public.idx_venues_google_place_id;'), commit = sql.lastIndexOf('commit;');
  assert.ok(begin >= 0 && begin < create && create < drop && drop < commit);
  assert.match(sql, /set local lock_timeout/);
  const preflight = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'supabase', '0114_venues_place_id_unique.preflight.sql'), 'utf8').toLowerCase();
  assert.doesNotMatch(preflight.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n'), /\b(insert|update|delete|alter|create|drop)\b/, 'preflight is SELECT-only');
});
