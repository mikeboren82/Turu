// PERMANENT GOOGLE-ORIGIN PROVENANCE (supabase/0115, 2026-09-27). The content_origin marker must keep a legacy Google
// row visible to every guard after its Maps source_url is scrubbed, and must never make an independent row (OSM,
// municipal) Google-origin because it carries a google_place_id.
//   - Node twin against the shared case table (the Deno, Python and client twins run the same table)
//   - the prompt's cases A-E, the Cleaner hold, and the selects that feed the classifier
//   - the P3 backfill planner (pure) and, when a local PostgreSQL is installed, 0115 + its canary + the generated
//     backfill SQL against a throwaway cluster (never a remote database): syntax, defaults, indexes, permanence,
//     drift aborts, idempotency, rollback, and the same answer before the backfill / after it / after the scrub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const policy = require('../lib/googlePlacesPolicy');
const { coordinateDuplicateSignal } = require('../lib/duplicateSignal');
const { planBackfill, renderBackfillSql, renderRollbackSql, parseRows, BackfillPlanError } = require('../google-origin-backfill');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const table = JSON.parse(read('supabase/functions/_shared/googlePlacesPolicy.cases.json'));
const MAPS = 'https://maps.google.com/?cid=4412345678901234567';
const MARK = 'google_places_legacy';

test('shared table: isGoogleOriginActivity / isGoogleOriginLocation / isGooglePlaceUrn (Node twin)', () => {
  assert.equal(policy.GOOGLE_CONTENT_ORIGIN, MARK);
  for (const [row, want] of table.googleOriginActivities) assert.equal(policy.isGoogleOriginActivity(row), want, JSON.stringify(row));
  for (const [loc, want] of table.googleOriginLocations) assert.equal(policy.isGoogleOriginLocation(loc), want, JSON.stringify(loc));
  for (const [v, want] of table.googlePlaceUrns) assert.equal(policy.isGooglePlaceUrn(v), want, String(v));
});

test('A: marker true + source_url null -> still Google-origin', () => {
  assert.equal(policy.isGoogleOriginActivity({ content_origin: MARK, source_url: null, google_place_id: 'ChIJ1' }), true);
});
test('B: independent row + google_place_id -> NOT Google-origin', () => {
  assert.equal(policy.isGoogleOriginActivity({ content_origin: null, source_url: 'https://www.raanana.muni.il/p/1', google_place_id: 'ChIJ1' }), false);
  assert.equal(policy.isGoogleOriginActivity({ content_origin: null, source_url: null, google_place_id: 'ChIJ1' }), false);
});
test('C: independent OSM row + place_id -> NOT Google-origin', () => {
  assert.equal(policy.isGoogleOriginActivity({ content_origin: null, source_url: 'https://www.openstreetmap.org/way/1', google_place_id: 'ChIJ1' }), false);
});
test('D: legacy Maps source_url without the marker -> recognised during the migration window', () => {
  assert.equal(policy.isGoogleOriginActivity({ content_origin: null, source_url: MAPS }), true);
});
test('E: a re-sourced Google-origin row keeps its historical Google-origin provenance', () => {
  assert.equal(policy.isGoogleOriginActivity({ content_origin: MARK, source_url: 'https://www.openstreetmap.org/way/9' }), true);
});

test('Cleaner hold follows the marker: a scrubbed marked row is still held, an independent place-id row is processed', () => {
  assert.deepEqual(policy.cleanerPolicyHold({ subjectKind: 'activity', activity: { content_origin: MARK, source_url: null } }), { reason: policy.POLICY_REASON, subject: 'google_origin_activity' });
  assert.equal(policy.cleanerPolicyHold({ subjectKind: 'activity', activity: { source_url: 'https://www.openstreetmap.org/way/1', google_place_id: 'ChIJ1' } }), null);
  // a side-table row rewritten to the place URN (scrub P11) is still Places-origin incoming
  assert.equal(policy.cleanerPolicyHold({ subjectKind: 'incoming', incoming: { extracted_data: { google_place_id: 'ChIJ1' }, page_url: 'urn:google-place:ChIJ1' } }).subject, 'places_origin_incoming');
});

test('every Node select feeding isGoogleOriginActivity / cleanerPolicyHold reads content_origin next to source_url', () => {
  const sites = {
    'tools/import-tool/cleaner.js': /from\('activities'\)\.select\('id, name, name_source, category, venue_id, source_id, source_url, content_origin,/,
    'tools/import-tool/cleaner/venueClusters.js': /from\('activities'\)\.select\('id, name, venue_id, source_id, source_url, content_origin,/,
    'tools/import-tool/enrich-playground-addresses.js': /\.select\('id, name, category, name_source, location_id, source_url, content_origin,/,
  };
  for (const [file, re] of Object.entries(sites)) assert.match(read(file), re, file);
});

test('duplicateSignal: a Google Maps listing is never a publisher - same answer before and after the source_url scrub', () => {
  const place = { lat: 32.18, lon: 34.87, entityType: 'מקום_קבוע' };
  const before = coordinateDuplicateSignal({ ...place, name: 'פארק הדקלים', sourceUrl: MAPS }, { ...place, name: 'פארק הדקלים', sourceUrl: 'https://maps.google.com/?cid=2' });
  const after = coordinateDuplicateSignal({ ...place, name: 'פארק הדקלים', sourceUrl: null }, { ...place, name: 'פארק הדקלים', sourceUrl: null });
  assert.ok(!before.venueRelatedness.some((s) => s.startsWith('same_publisher')), 'two Maps rows are not "same publisher"');
  assert.deepEqual(before.signals, after.signals);
  const mixed = coordinateDuplicateSignal({ ...place, name: 'פארק הדקלים הגדול', sourceUrl: MAPS }, { ...place, name: 'גינת הדקלים', sourceUrl: 'https://www.openstreetmap.org/way/7' });
  assert.ok(!mixed.identityEvidence.some((e) => e.startsWith('independent_sources_agree')), 'Maps + OSM is not two independent sources agreeing');
});

// ---- P3 backfill planner (pure) ----

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const snap = () => [
  { id: uuid(1), source_url: MAPS, content_origin: null, google_place_id: 'ChIJg1', location_id: uuid(101), status: 'approved' },
  { id: uuid(2), source_url: 'https://www.google.com/maps', content_origin: null, google_place_id: null, location_id: uuid(102), status: 'archived' },
  { id: uuid(3), source_url: 'https://maps.google.co.il/?cid=3', content_origin: null, google_place_id: 'ChIJg3', location_id: uuid(103), status: 'approved' },
  { id: uuid(4), source_url: 'https://www.raanana.muni.il/p/4', content_origin: null, google_place_id: 'ChIJm4', location_id: uuid(103), status: 'approved' },
  { id: uuid(5), source_url: 'https://www.openstreetmap.org/way/5', content_origin: null, google_place_id: 'ChIJo5', location_id: uuid(104), status: 'approved' },
  { id: uuid(6), source_url: 'https://www.openstreetmap.org/way/6', content_origin: null, google_place_id: null, location_id: uuid(105), status: 'approved' },
];
const ORPHANS = [uuid(106), uuid(107)];
const plan0 = (rows = snap(), extra = {}) => planBackfill({ rows, orphanIds: ORPHANS, expectActivities: 3, expectLocations: 5, expectIndependentPlaceIds: 2, ...extra });

test('planner: marks the Maps-sourced rows only - independent place-id rows are counted, never selected', () => {
  const p = plan0();
  assert.deepEqual(p.activities.map((a) => a.id), [uuid(1), uuid(2), uuid(3)]);
  assert.deepEqual(p.summary, { snapshotRows: 6, plannedActivities: 3, toMark: 3, alreadyMarked: 0, byStatus: { approved: 2, archived: 1 }, withoutPlaceId: 1, independentWithPlaceId: 2, linkedLocations: 3, orphanLocations: 2 });
  assert.deepEqual(p.locations.map((l) => l.kind), ['linked', 'linked', 'linked', 'orphan', 'orphan']);
});

test('planner: idempotent re-plan - already-marked rows (even with a scrubbed source_url) stay in the plan', () => {
  const rows = snap().map((r) => (r.id === uuid(1) ? { ...r, content_origin: MARK, source_url: null } : r));
  const p = plan0(rows);
  assert.equal(p.summary.alreadyMarked, 1);
  assert.equal(p.summary.toMark, 2);
});

test('planner: exact counts - drift in either direction refuses', () => {
  assert.throws(() => plan0(snap(), { expectActivities: 4 }), BackfillPlanError);
  assert.throws(() => plan0(snap(), { expectLocations: 4 }), BackfillPlanError);
  assert.throws(() => plan0(snap(), { expectIndependentPlaceIds: 216 }), BackfillPlanError);
  assert.throws(() => planBackfill({ rows: snap(), orphanIds: ORPHANS }), /required/);
  const extraMaps = [...snap(), { id: uuid(8), source_url: 'https://maps.app.goo.gl/x', content_origin: null, google_place_id: null, location_id: null, status: 'approved' }];
  assert.throws(() => plan0(extraMaps), /DRIFT: 4 Google-origin/);
});

test('planner: a stale orphan list (now used by an activity) refuses', () => {
  assert.throws(() => planBackfill({ rows: snap(), orphanIds: [uuid(101)], expectActivities: 3, expectLocations: 4 }), /stale/);
  assert.throws(() => planBackfill({ rows: snap(), orphanIds: [uuid(104)], expectActivities: 3, expectLocations: 4 }), /referenced/);
  assert.throws(() => planBackfill({ rows: snap(), orphanIds: [uuid(106), uuid(106)], expectActivities: 3, expectLocations: 5 }), /duplicate/);
  assert.throws(() => plan0([...snap(), { ...snap()[0] }]), /duplicate activity id/);
  assert.throws(() => plan0(snap().map((r, i) => (i === 5 ? { ...r, content_origin: 'osm' } : r))), /unknown content_origin/);
});

test('planner: parses the supabase CLI output (preamble + {"rows":[...]}) and plain arrays', () => {
  assert.equal(parseRows('Connecting to remote database...\n{"boundary":"x","rows":[{"id":"a"}]}').length, 1);
  assert.equal(parseRows('[{"id":"a"},{"id":"b"}]').length, 2);
  assert.throws(() => parseRows('no json'), BackfillPlanError);
});

test('planner: the generated SQL is one transaction, carries only ids + hashes, and never embeds a URL', () => {
  const sql = renderBackfillSql(plan0(), { generatedAt: 'T', snapshotSha256: 'S', expectActivities: 3, expectLocations: 5 });
  assert.match(sql, /^-- GENERATED/);
  assert.equal((sql.match(/^begin;$/gm) || []).length, 1);
  assert.equal((sql.match(/^commit;$/gm) || []).length, 1);
  assert.doesNotMatch(sql, /https?:\/\//);
  assert.doesNotMatch(sql, /google_place_id/);
  const rb = renderRollbackSql(plan0(), { generatedAt: 'T' });
  assert.match(rb, /set local turu\.content_origin_rollback = 'on';/);
  assert.match(rb, /FORBIDDEN after the Maps source_url scrub/);
});

test('generated backfill SQL files are git-ignored (private), the read-only snapshot query is tracked', () => {
  const r = spawnSync('git', ['check-ignore', '-q', 'tools/import-tool/reports/google-origin-backfill-2026-10-01-00-00-00.sql'], { cwd: ROOT });
  assert.equal(r.status, 0);
  const s = read('tools/import-tool/google-origin-backfill.snapshot.sql');
  assert.doesNotMatch(s.replace(/--.*$/gm, ''), /\b(insert|update|delete|alter|create|drop|truncate|grant)\b/i, 'SELECT only');
});

// ---- 0115 + canary + generated backfill against a THROWAWAY local PostgreSQL (skipped when none is installed) ----

const PG_BIN = process.env.TURU_PG_BIN || (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/17/bin' : '/usr/lib/postgresql/17/bin');
const exe = (n) => path.join(PG_BIN, process.platform === 'win32' ? `${n}.exe` : n);
const HAS_PG = fs.existsSync(exe('initdb')) && fs.existsSync(exe('pg_ctl')) && fs.existsSync(exe('psql'));

test('0115 migration + canary + generated backfill on a throwaway local PostgreSQL', { skip: !HAS_PG && `no local PostgreSQL at ${PG_BIN} (set TURU_PG_BIN)` }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turu-0115-'));
  const data = path.join(dir, 'data');
  const port = String(56000 + Math.floor(Math.random() * 900));
  // stdio 'ignore': the server pg_ctl leaves running would otherwise inherit our pipes and spawnSync never returns
  const run = (bin, args) => spawnSync(exe(bin), args, { stdio: 'ignore', timeout: 60000 });
  assert.equal(run('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-sync']).status, 0, 'initdb');
  t.after(() => { run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']); fs.rmSync(dir, { recursive: true, force: true }); });
  const started = run('pg_ctl', ['-D', data, '-o', `-p ${port} -c listen_addresses=127.0.0.1`, '-l', path.join(dir, 'pg.log'), '-w', 'start']);
  assert.equal(started.status, 0, 'pg_ctl start (see pg.log)');

  const psql = (args) => spawnSync(exe('psql'), ['-h', '127.0.0.1', '-p', port, '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8' });
  const sql = (s) => { const r = psql(['-At', '-c', s]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  const file = (f) => psql(['-f', f]);
  const tmp = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };

  // the production shape of the columns this touches (schema.sql + 0055)
  sql(`create table public.locations (id uuid primary key default gen_random_uuid(), name text not null, address text, city text, lat double precision, lng double precision);
       create table public.activities (id uuid primary key default gen_random_uuid(), name text not null, location_id uuid references public.locations(id) on delete set null,
         status text not null default 'approved', source text not null default 'manual', source_url text, google_place_id text);
       create unique index idx_activities_google_place_id on public.activities (google_place_id) where google_place_id is not null;`);
  const rows = snap();
  for (const n of [101, 102, 103, 104, 105, 106, 107, 108]) sql(`insert into public.locations (id, name, lat, lng) values ('${uuid(n)}', 'L${n}', 32.1, 34.8)`);
  for (const r of rows) sql(`insert into public.activities (id, name, status, source, source_url, google_place_id, location_id) values ('${r.id}', 'A', '${r.status}', 'scraped', ${r.source_url ? `'${r.source_url}'` : 'null'}, ${r.google_place_id ? `'${r.google_place_id}'` : 'null'}, '${r.location_id}')`);
  // to_jsonb(row): before 0115 the row simply has no content_origin key (exactly what a pre-migration reader sees)
  const readRows = () => JSON.parse(sql(`select coalesce(json_agg(to_jsonb(a) order by a.id), '[]') from public.activities a`));
  const googleSet = () => readRows().filter(policy.isGoogleOriginActivity).map((r) => r.id).sort();

  // phase A: before 0115 / before the backfill - the Maps source_url answers
  const phaseA = googleSet();
  assert.deepEqual(phaseA, [uuid(1), uuid(2), uuid(3)]);

  // syntax + idempotent re-apply
  const mig = path.join(ROOT, 'supabase/0115_content_origin_google_legacy.sql');
  for (let i = 0; i < 2; i++) { const r = file(mig); assert.equal(r.status, 0, `0115 apply #${i + 1}: ${r.stderr}`); }
  // defaults: every existing row NULL (incl. the independent place-id rows); readers unchanged
  assert.equal(sql('select count(*) from public.activities where content_origin is not null'), '0');
  assert.equal(sql('select count(*) from public.locations where content_origin is not null'), '0');
  assert.equal(sql(`select count(*) from public.activities where google_place_id is not null and content_origin is null`), '4');
  sql(`insert into public.activities (name, source_url, google_place_id) values ('new independent', 'https://www.openstreetmap.org/way/99', 'ChIJnew')`);
  assert.equal(sql(`select content_origin is null from public.activities where google_place_id = 'ChIJnew'`), 't', 'a new row with a place id is not Google-origin');
  sql(`delete from public.activities where google_place_id = 'ChIJnew'`);
  assert.deepEqual(googleSet(), phaseA, 'nothing changes by applying 0115 alone');
  // indexes: partial, on both tables
  const idx = sql(`select string_agg(indexname || ':' || indexdef, E'\\n' order by indexname) from pg_indexes where indexname in ('idx_activities_content_origin', 'idx_locations_content_origin')`);
  assert.match(idx, /idx_activities_content_origin:.*WHERE \(content_origin IS NOT NULL\)/);
  assert.match(idx, /idx_locations_content_origin:.*WHERE \(content_origin IS NOT NULL\)/);
  // CHECK + INSERT refusal
  assert.notEqual(psql(['-c', `update public.activities set content_origin = 'osm' where id = '${uuid(5)}'`]).status, 0, 'closed value set');
  assert.match(psql(['-c', `insert into public.locations (name, content_origin) values ('x', '${MARK}')`]).stderr, /cannot be created Google-origin/);

  // canary: always errors, PASS message, persists nothing
  const canary = file(path.join(ROOT, 'supabase/0115_content_origin_google_legacy.canary.sql'));
  assert.match(canary.stderr, /0115 canary PASS/, canary.stderr);
  assert.equal(sql('select count(*) from public.activities where content_origin is not null'), '0', 'canary persisted nothing');

  // generated backfill: plan from the tracked snapshot query's exact columns
  const snapshotSelect = read('tools/import-tool/google-origin-backfill.snapshot.sql').replace(/--.*$/gm, '').trim().replace(/;$/, '');
  const snapRows = JSON.parse(sql(`select coalesce(json_agg(t), '[]') from (${snapshotSelect}) t`));
  const plan = plan0(snapRows);
  const opts = { generatedAt: 'T', snapshotSha256: 'S', expectActivities: 3, expectLocations: 5 };
  const backfill = tmp('backfill.sql', renderBackfillSql(plan, opts));
  const rollback = tmp('rollback.sql', renderRollbackSql(plan, opts));

  // drift: a planned row re-sourced since the snapshot -> abort, 0 writes
  sql(`update public.activities set source_url = 'https://www.openstreetmap.org/way/1' where id = '${uuid(1)}'`);
  let r = file(backfill);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /source_url changed since the snapshot/);
  assert.equal(sql('select count(*) from public.activities where content_origin is not null'), '0', 'atomic: nothing marked');
  sql(`update public.activities set source_url = '${MAPS}' where id = '${uuid(1)}'`);
  // drift: an unplanned Maps row appeared -> abort
  sql(`insert into public.activities (id, name, source_url) values ('${uuid(9)}', 'late', 'https://www.google.com/maps/place/x')`);
  r = file(backfill); assert.notEqual(r.status, 0); assert.match(r.stderr, /unplanned activities have a Maps-looking source_url/);
  sql(`delete from public.activities where id = '${uuid(9)}'`);
  // drift: a frozen orphan got reused -> abort
  sql(`insert into public.activities (id, name, source_url, location_id) values ('${uuid(10)}', 'rescue', 'https://www.openstreetmap.org/way/10', '${uuid(106)}')`);
  r = file(backfill); assert.notEqual(r.status, 0); assert.match(r.stderr, /frozen orphan locations are referenced now/);
  sql(`delete from public.activities where id = '${uuid(10)}'`);
  assert.equal(sql('select count(*) from public.locations where content_origin is not null'), '0');

  // success, then idempotent re-run
  for (let i = 0; i < 2; i++) { r = file(backfill); assert.equal(r.status, 0, `backfill run #${i + 1}: ${r.stderr}`); }
  assert.equal(sql(`select string_agg(id::text, ',' order by id) from public.activities where content_origin = '${MARK}'`), [uuid(1), uuid(2), uuid(3)].join(','));
  assert.equal(sql(`select count(*) from public.activities where google_place_id is not null and content_origin is null`), '2', 'the independent place-id rows stay unmarked');
  assert.equal(sql(`select string_agg(id::text, ',' order by id) from public.locations where content_origin = '${MARK}'`), [101, 102, 103, 106, 107].map(uuid).join(','));
  // phase B: after the backfill, before the scrub
  assert.deepEqual(googleSet(), phaseA);

  // rollback (valid before the scrub), then the backfill again
  r = file(rollback); assert.equal(r.status, 0, r.stderr);
  assert.equal(sql('select count(*) from public.activities where content_origin is not null'), '0');
  assert.equal(sql('select count(*) from public.locations where content_origin is not null'), '0');
  r = file(backfill); assert.equal(r.status, 0, r.stderr);

  // the marker is permanent without the hatch
  assert.match(psql(['-c', `update public.activities set content_origin = null where id = '${uuid(1)}'`]).stderr, /permanent historical provenance/);
  assert.match(psql(['-c', `update public.locations set content_origin = null where id = '${uuid(106)}'`]).stderr, /permanent historical provenance/);

  // phase C: the Maps source_url scrub - the marker alone keeps the same answer
  sql(`update public.activities set source_url = null where content_origin = '${MARK}'`);
  assert.equal(sql(`select count(*) from public.activities where content_origin = '${MARK}' and source_url is null`), '3');
  assert.deepEqual(googleSet(), phaseA, 'stable across A (Maps URL), B (marker + URL) and C (marker only)');
  // and a re-plan after the scrub is still exact and still marks nothing new
  const replan = plan0(JSON.parse(sql(`select coalesce(json_agg(t), '[]') from (${snapshotSelect}) t`)));
  assert.equal(replan.summary.alreadyMarked, 3);
  assert.equal(replan.summary.toMark, 0);
});
