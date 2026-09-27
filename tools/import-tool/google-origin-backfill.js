// TuRu - Google legacy scrub P3: plan the permanent content_origin backfill (supabase/0115). PREPARE ONLY.
//
// This tool NEVER connects to a database, calls Google, or writes anything but the two SQL files it is asked for.
// It turns a read-only snapshot into ONE single-transaction SQL file that marks exactly the planned rows and aborts on
// any drift. The owner runs that file later (after 0115 and the P1/P2 phases), with `supabase db query --linked -f`.
//
// WHICH ROWS
//   activities  the rows whose snapshot source_url is a Google Maps URL (or a urn:google-place URN) - the 2026-09-27
//               inventory marker, decided by lib/googlePlacesPolicy.js (the single definition; no SQL copy of the
//               rule), plus rows already marked (idempotent re-plan). NEVER by google_place_id: the 216 independent
//               rows that only carry a place id are counted and reported, never selected.
//   locations   their own marker, planned separately (never inferred from the activity rows at run time):
//               - linked: the location_id of every planned activity (Google name/address/city/coords copied there)
//               - orphan: the FROZEN forensic list of Google-origin locations no activity references (643 on
//                 2026-09-27), passed with --orphans. Never discovered by proximity or name.
//
// GUARDS (all in the generated SQL, one transaction, 0 writes on any failure)
//   - 0115 applied (the column exists)
//   - every planned activity still exists and is either already marked or its source_url is byte-identical to the
//     snapshot (md5) - so a row re-sourced or scrubbed since the snapshot aborts the run instead of being guessed
//   - nothing outside the plan is already marked (activities and locations)
//   - no unplanned activity has a Maps-looking source_url (a deliberately loose SQL superset net: it can only abort)
//   - every orphan location still exists and is still unreferenced (a rescue that reused one must be re-planned)
//   - every linked location is still used by a planned activity
//   - after the update: exact counts == --expect-activities / --expect-locations
//
//   node google-origin-backfill.js --snapshot <private rows.json> --orphans <private orphan-ids.json> \
//     --expect-activities 514 --expect-locations 1157 [--expect-independent-place-ids 216] [--out-dir <private dir>]
//
// Snapshot: the JSON output of `npx supabase db query --linked -f google-origin-backfill.snapshot.sql` (the CLI's
// {"rows":[...]} after its preamble), or a plain array of rows. Snapshot and generated SQL hold row ids, source-url
// hashes and (snapshot only) Maps URLs: keep both private (TuruPrivate/google-scrub-2026-10/), never in the repo.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isGoogleMapsUrl, isGooglePlaceUrn, GOOGLE_CONTENT_ORIGIN } = require('./lib/googlePlacesPolicy');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class BackfillPlanError extends Error {}

// `supabase db query` prints a preamble, then {"rows":[...]}; a plain array (or {activities:[...]}) is accepted too
function parseRows(text) {
  const s = String(text);
  const i = s.search(/[[{]/);
  if (i < 0) throw new BackfillPlanError('snapshot: no JSON found');
  const j = JSON.parse(s.slice(i));
  const rows = Array.isArray(j) ? j : Array.isArray(j.rows) ? j.rows : Array.isArray(j.activities) ? j.activities : null;
  if (!rows) throw new BackfillPlanError('snapshot: expected an array or {rows:[...]}');
  return rows;
}

function md5(s) { return crypto.createHash('md5').update(s, 'utf8').digest('hex'); }

function isMapsSource(url) { return isGoogleMapsUrl(url) || isGooglePlaceUrn(url); }

// Pure. rows: [{ id, source_url, content_origin, google_place_id, location_id, status }]; orphanIds: [uuid]
function planBackfill({ rows, orphanIds = [], expectActivities, expectLocations, expectIndependentPlaceIds = null }) {
  if (!Number.isInteger(expectActivities) || !Number.isInteger(expectLocations)) throw new BackfillPlanError('--expect-activities and --expect-locations are required (exact counts)');
  const seen = new Set();
  for (const r of rows) {
    if (!r || !UUID_RE.test(String(r.id))) throw new BackfillPlanError(`snapshot: bad activity id ${JSON.stringify(r && r.id)}`);
    if (seen.has(r.id)) throw new BackfillPlanError(`snapshot: duplicate activity id ${r.id}`);
    seen.add(r.id);
    if (r.content_origin != null && r.content_origin !== GOOGLE_CONTENT_ORIGIN) throw new BackfillPlanError(`snapshot: unknown content_origin on ${r.id}`);
  }
  const planned = rows.filter((r) => r.content_origin === GOOGLE_CONTENT_ORIGIN || isMapsSource(r.source_url));
  const toMark = planned.filter((r) => r.content_origin == null);
  const independentWithPlaceId = rows.filter((r) => !planned.includes(r) && r.google_place_id).length;
  if (planned.length !== expectActivities) throw new BackfillPlanError(`DRIFT: ${planned.length} Google-origin activities in the snapshot, expected exactly ${expectActivities}`);
  if (expectIndependentPlaceIds != null && independentWithPlaceId !== expectIndependentPlaceIds) throw new BackfillPlanError(`DRIFT: ${independentWithPlaceId} independent rows carry a google_place_id, expected ${expectIndependentPlaceIds}`);

  const linked = [...new Set(planned.map((r) => r.location_id).filter(Boolean))];
  const orphans = [...new Set(orphanIds)];
  for (const id of orphans) if (!UUID_RE.test(String(id))) throw new BackfillPlanError(`orphans: bad location id ${JSON.stringify(id)}`);
  if (orphans.length !== orphanIds.length) throw new BackfillPlanError('orphans: duplicate ids in the frozen list');
  const linkedSet = new Set(linked);
  const clash = orphans.filter((id) => linkedSet.has(id));
  if (clash.length) throw new BackfillPlanError(`orphans: ${clash.length} "orphan" ids are used by planned activities - the frozen list is stale`);
  const usedByAny = new Set(rows.map((r) => r.location_id).filter(Boolean));
  const referenced = orphans.filter((id) => usedByAny.has(id));
  if (referenced.length) throw new BackfillPlanError(`orphans: ${referenced.length} "orphan" ids are referenced by activities in the snapshot - re-plan`);
  if (linked.length + orphans.length !== expectLocations) throw new BackfillPlanError(`DRIFT: ${linked.length} linked + ${orphans.length} orphan locations, expected exactly ${expectLocations}`);

  return {
    activities: planned.map((r) => ({ id: r.id, srcMd5: md5(r.source_url == null ? '' : String(r.source_url)), marked: r.content_origin === GOOGLE_CONTENT_ORIGIN })),
    locations: [...linked.map((id) => ({ id, kind: 'linked' })), ...orphans.map((id) => ({ id, kind: 'orphan' }))],
    summary: {
      snapshotRows: rows.length, plannedActivities: planned.length, toMark: toMark.length, alreadyMarked: planned.length - toMark.length,
      byStatus: planned.reduce((a, r) => ((a[r.status || 'unknown'] = (a[r.status || 'unknown'] || 0) + 1), a), {}),
      withoutPlaceId: planned.filter((r) => !r.google_place_id).length, independentWithPlaceId,
      linkedLocations: linked.length, orphanLocations: orphans.length,
    },
  };
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
function values(list, fmt) {
  const out = [];
  for (let i = 0; i < list.length; i += 200) out.push(list.slice(i, i + 200).map(fmt).join(',\n  '));
  return out;
}

// Loose SQL NET (guard only, never a classifier): anything Maps-looking outside the plan aborts the run.
const MAPS_NET_SQL = `a.source_url ~* '(maps\\.google\\.|google\\.[a-z.]+/maps|goo\\.gl/maps|maps\\.app\\.goo\\.gl|^urn:google-place)'`;

function renderBackfillSql(plan, { generatedAt, snapshotSha256, expectActivities, expectLocations }) {
  const acts = values(plan.activities, (a) => `(${q(a.id)}::uuid, ${q(a.srcMd5)})`).map((v) => `insert into _g_act (id, src_md5) values\n  ${v};`);
  const locs = values(plan.locations, (l) => `(${q(l.id)}::uuid, ${q(l.kind)})`).map((v) => `insert into _g_loc (id, kind) values\n  ${v};`);
  return `-- GENERATED by tools/import-tool/google-origin-backfill.js at ${generatedAt} - PRIVATE, never commit.
-- Google legacy scrub P3: mark ${expectActivities} activities + ${expectLocations} locations content_origin='${GOOGLE_CONTENT_ORIGIN}'.
-- Snapshot sha256 ${snapshotSha256}. One transaction; any guard failure raises and writes NOTHING. Idempotent: a
-- second run marks 0 new rows and passes the same exact-count checks.
begin;
set local lock_timeout = '5s';

do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'activities' and column_name = 'content_origin')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'locations' and column_name = 'content_origin') then
    raise exception 'google-origin backfill ABORTED: 0115 is not applied';
  end if;
end $$;

create temp table _g_act (id uuid primary key, src_md5 text not null) on commit drop;
create temp table _g_loc (id uuid primary key, kind text not null check (kind in ('linked', 'orphan'))) on commit drop;
${acts.join('\n')}
${locs.join('\n')}

do $$
declare n int;
begin
  if (select count(*) from _g_act) <> ${expectActivities} or (select count(*) from _g_loc) <> ${expectLocations} then
    raise exception 'google-origin backfill ABORTED: plan size differs from the expected counts';
  end if;
  select count(*) into n from _g_act g left join public.activities a on a.id = g.id
    where a.id is null or (a.content_origin is null and md5(coalesce(a.source_url, '')) <> g.src_md5);
  if n > 0 then raise exception 'google-origin backfill ABORTED: % planned activities are missing or their source_url changed since the snapshot', n; end if;
  select count(*) into n from public.activities a where a.content_origin is not null and not exists (select 1 from _g_act g where g.id = a.id);
  if n > 0 then raise exception 'google-origin backfill ABORTED: % activities outside the plan are already marked', n; end if;
  select count(*) into n from public.activities a where not exists (select 1 from _g_act g where g.id = a.id) and ${MAPS_NET_SQL};
  if n > 0 then raise exception 'google-origin backfill ABORTED: % unplanned activities have a Maps-looking source_url - re-plan', n; end if;
  select count(*) into n from _g_loc g left join public.locations l on l.id = g.id where l.id is null;
  if n > 0 then raise exception 'google-origin backfill ABORTED: % planned locations no longer exist', n; end if;
  select count(*) into n from public.locations l where l.content_origin is not null and not exists (select 1 from _g_loc g where g.id = l.id);
  if n > 0 then raise exception 'google-origin backfill ABORTED: % locations outside the plan are already marked', n; end if;
  select count(*) into n from _g_loc g where g.kind = 'orphan' and exists (select 1 from public.activities a where a.location_id = g.id);
  if n > 0 then raise exception 'google-origin backfill ABORTED: % frozen orphan locations are referenced now (reused by a rescue?) - re-plan', n; end if;
  select count(*) into n from _g_loc g where g.kind = 'linked'
    and not exists (select 1 from public.activities a join _g_act ga on ga.id = a.id where a.location_id = g.id);
  if n > 0 then raise exception 'google-origin backfill ABORTED: % linked locations are no longer used by a planned activity', n; end if;

  update public.activities a set content_origin = '${GOOGLE_CONTENT_ORIGIN}' from _g_act g where a.id = g.id and a.content_origin is null;
  update public.locations l set content_origin = '${GOOGLE_CONTENT_ORIGIN}' from _g_loc g where l.id = g.id and l.content_origin is null;

  select count(*) into n from public.activities where content_origin = '${GOOGLE_CONTENT_ORIGIN}';
  if n <> ${expectActivities} then raise exception 'google-origin backfill ABORTED: % activities marked after the update, expected ${expectActivities}', n; end if;
  select count(*) into n from public.locations where content_origin = '${GOOGLE_CONTENT_ORIGIN}';
  if n <> ${expectLocations} then raise exception 'google-origin backfill ABORTED: % locations marked after the update, expected ${expectLocations}', n; end if;
  raise notice 'google-origin backfill OK: activities=% locations=%', ${expectActivities}, ${expectLocations};
end $$;

commit;
`;
}

// Rollback of THIS backfill only - valid until the source_url scrub (P7). After P7 it is forbidden: it would make the
// scrubbed rows invisible to every guard. Uses the 0115 escape hatch, scoped to its own transaction.
function renderRollbackSql(plan, { generatedAt }) {
  const newlyMarked = plan.activities.filter((a) => !a.marked);
  const ids = (list) => values(list, (x) => `${q(x.id)}::uuid`).join(',\n  ');
  return `-- GENERATED rollback for the google-origin backfill planned at ${generatedAt} - PRIVATE.
-- FORBIDDEN after the Maps source_url scrub (P7). Clears only the markers THIS plan adds.
begin;
set local turu.content_origin_rollback = 'on';
${newlyMarked.length ? `update public.activities set content_origin = null where id in (\n  ${ids(newlyMarked)}\n);` : '-- no activity markers to clear'}
${plan.locations.length ? `update public.locations set content_origin = null where id in (\n  ${ids(plan.locations)}\n);` : '-- no location markers to clear'}
commit;
`;
}

function arg(argv, name) {
  const i = argv.findIndex((a) => a === name || a.startsWith(name + '='));
  if (i < 0) return null;
  return argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : argv[i + 1];
}

function main(argv = process.argv.slice(2)) {
  const snapshotPath = arg(argv, '--snapshot');
  const orphansPath = arg(argv, '--orphans');
  const expectActivities = Number(arg(argv, '--expect-activities'));
  const expectLocations = Number(arg(argv, '--expect-locations'));
  const indep = arg(argv, '--expect-independent-place-ids');
  const outDir = arg(argv, '--out-dir') || path.join(__dirname, 'reports');
  if (!snapshotPath) throw new BackfillPlanError('--snapshot <file> is required');
  const snapshotText = fs.readFileSync(snapshotPath, 'utf8');
  const rows = parseRows(snapshotText);
  const orphanIds = orphansPath ? parseRows(fs.readFileSync(orphansPath, 'utf8')).map((o) => (typeof o === 'string' ? o : o.id)) : [];
  const plan = planBackfill({ rows, orphanIds, expectActivities, expectLocations, expectIndependentPlaceIds: indep == null ? null : Number(indep) });
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.slice(0, 19).replace(/[:T]/g, '-');
  const opts = { generatedAt, snapshotSha256: crypto.createHash('sha256').update(snapshotText).digest('hex'), expectActivities, expectLocations };
  fs.mkdirSync(outDir, { recursive: true });
  const sqlPath = path.join(outDir, `google-origin-backfill-${stamp}.sql`);
  const rollbackPath = path.join(outDir, `google-origin-backfill-${stamp}-rollback.sql`);
  fs.writeFileSync(sqlPath, renderBackfillSql(plan, opts));
  fs.writeFileSync(rollbackPath, renderRollbackSql(plan, opts));
  console.log('PLAN ONLY - nothing was written to any database.', JSON.stringify(plan.summary));
  console.log('backfill SQL :', sqlPath);
  console.log('rollback SQL :', rollbackPath);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e instanceof BackfillPlanError ? 'REFUSED - ' + e.message : e); process.exit(2); }
}

module.exports = { planBackfill, renderBackfillSql, renderRollbackSql, parseRows, BackfillPlanError, MAPS_NET_SQL };
