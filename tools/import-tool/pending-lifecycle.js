// TuRu - PENDING LIFECYCLE (Human Review Queue Policy Phase A, 2026-09-24). A pending candidate a person can no
// longer act on must not wait in the inbox forever, and a valid far-future one must not wait there for months:
//   expire   match_type new/duplicate, status new/needs_review, a dated one-time candidate whose LAST known date
//            passed (occurrences included - never the first date) -> rejected, archive_reason
//            activity_expired_before_resolution (the lifecycle reason the Cleaner already uses for its cases)
//   defer    a clean 'new' candidate (no substantive issue) whose first date is beyond event_max_days_ahead ->
//            deferred_until = the day it enters the auto-publish window (0110); the inbox hides it until then
//   release  a deferred row whose day came -> deferred_until cleared (the inbox shows it from that day anyway;
//            a rescan re-evaluates it through the full pipeline first when the page changes)
// Standing programmes (אירוע_קבוע), places (מקום_קבוע) and undated rows never expire or defer here; update rows
// are not candidates and are left alone. Every write is guarded on the row's observed state and verified.
//
//   node pending-lifecycle.js                                  dry run (read-only plan)
//   node pending-lifecycle.js --apply --max=200 --found-since=<ISO>   bounded apply, rows found since <ISO> only
// The historical queue (rows found before Phase A) is drained only by an explicitly approved run without
// --found-since; the Monster job applies to new ingestion only.
require('dotenv').config();
const { getClient } = require('./supabase');
const { pendingLifecycle, israelToday } = require('./lib/intakePolicy');
const { verifiedConditionalUpdate, isSuccess } = require('./lib/verifiedWrite');

const arg = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const APPLY = process.argv.includes('--apply');
const MAX = Number(arg('max')) || 200;
const FOUND_SINCE = arg('found-since');

async function loadPending(client) {
  let rows = [], from = 0;
  while (true) {
    let q = client.from('incoming_activities')
      .select('id, match_type, status, validation_issues, deferred_until, found_at, name:extracted_data->>name, schedule_type:extracted_data->>schedule_type, entity_type:extracted_data->>entity_type, one_time_date:extracted_data->>one_time_date, occurrences:extracted_data->occurrences')
      .in('status', ['new', 'needs_review']).in('match_type', ['new', 'duplicate']).order('id');
    if (FOUND_SINCE) q = q.gte('found_at', FOUND_SINCE);
    const { data, error } = await q.range(from, from + 999);
    if (error) throw error;
    rows = rows.concat(data); if (data.length < 1000) return rows; from += 1000;
  }
}

function plan(rows, today, maxDaysAhead) {
  const out = { expire: [], defer: [], release: [], keep: {} };
  for (const r of rows) {
    const lc = pendingLifecycle({ ...r, extracted_data: { schedule_type: r.schedule_type, entity_type: r.entity_type, one_time_date: r.one_time_date, occurrences: r.occurrences } }, today, maxDaysAhead);
    if (lc.action === 'keep') out.keep[lc.reason] = (out.keep[lc.reason] || 0) + 1;
    else out[lc.action].push({ row: r, ...lc });
  }
  return out;
}

async function applyOne(client, item, now) {
  const r = item.row;
  if (item.action === 'expire') {
    return verifiedConditionalUpdate(client, { table: 'incoming_activities', id: r.id,
      patch: { status: 'rejected', archive_reason: 'activity_expired_before_resolution', reject_reason: `מחזור חיים אוטומטי: כל מועדי האירוע עברו (אחרון: ${item.lastDate}) לפני הכרעה`, reviewed_at: now },
      expectedOld: { status: r.status, match_type: r.match_type } });
  }
  if (item.action === 'defer') {
    return verifiedConditionalUpdate(client, { table: 'incoming_activities', id: r.id, patch: { deferred_until: item.deferUntil }, expectedOld: { status: 'new', deferred_until: null } });
  }
  return verifiedConditionalUpdate(client, { table: 'incoming_activities', id: r.id, patch: { deferred_until: null }, expectedOld: { status: r.status, deferred_until: r.deferred_until } });
}

// A publication CLAIM (status 'processing', server.js publishIncoming) whose worker died is released back to the
// reviewer queue after CLAIM_STALE_MS - operational lock recovery, not queue cleanup (a live claim is never touched).
async function releaseStaleClaims(client, apply) {
  const { CLAIM_STALE_MS } = require('./server');
  const cutoff = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  const { data, error } = await client.from('incoming_activities').select('id, updated_at').eq('status', 'processing').lt('updated_at', cutoff);
  if (error) throw error;
  if (!apply || !data.length) return { stale: data.length, released: 0 };
  let released = 0;
  for (const r of data) {
    const { data: w } = await client.from('incoming_activities').update({ status: 'needs_review' }).eq('id', r.id).eq('status', 'processing').eq('updated_at', r.updated_at).select('id');
    if (w && w.length) released++;
  }
  return { stale: data.length, released };
}

(async () => {
  const { client } = await getClient();
  const claims = await releaseStaleClaims(client, APPLY);
  if (claims.stale) console.log(`stale publication claims: ${claims.stale}${APPLY ? `, released ${claims.released}` : ' (dry run)'}`);
  const { data: s } = await client.from('automation_settings').select('value').eq('key', 'event_max_days_ahead').maybeSingle();
  const maxDaysAhead = Number(s?.value ?? 180);
  const today = israelToday();
  const rows = await loadPending(client);
  const p = plan(rows, today, maxDaysAhead);
  console.log(`pending lifecycle ${APPLY ? 'APPLY' : 'DRY RUN'} today=${today} horizon=${maxDaysAhead}d${FOUND_SINCE ? ` found_since=${FOUND_SINCE}` : ' (whole queue)'}: ${rows.length} pending candidates -> expire ${p.expire.length}, defer ${p.defer.length}, release ${p.release.length}, keep ${JSON.stringify(p.keep)}`);
  for (const k of ['expire', 'defer', 'release']) for (const it of p[k].slice(0, 5)) console.log(`  ${k}: ${it.row.id} ${it.row.name} last=${it.lastDate}${it.deferUntil ? ' until=' + it.deferUntil : ''}`);
  if (!APPLY) return;
  const now = new Date().toISOString();
  const work = [...p.expire, ...p.release, ...p.defer].slice(0, MAX);
  const outcomes = {};
  for (const it of work) {
    let r;
    try { r = await applyOne(client, it, now); } catch (e) { r = { outcome: 'OTHER_FAILURE', error: e.message }; }
    const key = `${it.action}:${isSuccess(r) ? 'SUCCESS' : r.outcome}`;
    outcomes[key] = (outcomes[key] || 0) + 1;
  }
  console.log(`applied ${work.length} (max ${MAX}): ${JSON.stringify(outcomes)}`);
  if (Object.keys(outcomes).some((k) => /WRITE_DENIED|OTHER_FAILURE/.test(k))) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
