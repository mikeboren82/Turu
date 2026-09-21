// TuRu - the general "did this UPDATE actually happen?" primitive (2026-09-21).
//
// WHY THIS EXISTS. Every guarded `.from(table).update(patch).eq(...)` call in this codebase has the
// same failure mode: PostgREST answers a 0-row match with `error: null`, which a caller checking only
// `error` reads as success. That is not hypothetical - it is exactly how duplicate Resolution Batch #1
// reported two activities archived that were never archived (fixed by lib/activityArchive.js, the
// archive-specific door), and it is the same shape found across ~10 non-archive maintenance/admin
// UPDATE call sites during the 2026-09-21 hardening audit (server.js /api/manage/update,
// lib/activities.js#updateActivityAsAdmin, backfill-fingerprints.js, backfill-venue-links.js,
// enrich-playground-addresses.js, migrate-playground-names.js, propose-venues.js,
// repair-road-number-addresses.js, audit-place-duplicates.js, merge-occurrence-duplicates.js).
//
// RELATIONSHIP TO EXISTING PRIMITIVES.
//   cleaner/apply.js#verifiedUpdate/classifyZeroRowWrite - the Cleaner's own guarded-write primitive,
//     LEFT UNTOUCHED. Its 2-outcome vocabulary (`already_filled` / `write_denied`) is sufficient for
//     the Cleaner's fill-if-null semantics and is already tested (tests/zeroRowWrite.test.js); this
//     task does not need to (and should not) generalise it in place.
//   lib/activityArchive.js - the ARCHIVE-specific door (status -> 'archived' via the archive_activity
//     RPC). This module is deliberately NOT that: it never calls an RPC, never archives, and knows
//     nothing about activities specifically - it is a plain guarded-UPDATE verifier for any table.
// This is a narrowly-related, general-purpose sibling (option C, not a generalisation of either
// existing primitive) - the smallest new piece that gives every non-archive UPDATE caller the same
// honest, six-outcome vocabulary instead of five call sites each inventing their own partial check.
//
// OUTCOME VOCABULARY (never conflated):
//   SUCCESS                     the UPDATE matched and changed >=1 row, verified via .select()
//   ROW_NOT_FOUND                no row with that id exists on the fresh re-read
//   WRITE_DENIED                 the row exists, the guard condition still holds exactly as before,
//                                 and the UPDATE still matched 0 rows - the only remaining explanation
//                                 is RLS (or an equivalent permission boundary), never "probably fine"
//   PRECONDITION_CHANGED         the row exists, its guarded fields are neither what was expected NOR
//                                 what was desired - something else wrote it between read and write
//   NO_CHANGE_ALREADY_SATISFIED  the row already holds every value the caller wanted to write - a
//                                 genuinely idempotent no-op, not a failure
//   OTHER_FAILURE                a thrown/transport error, or a malformed response shape
const OUTCOME = Object.freeze({
  SUCCESS: 'SUCCESS',
  ROW_NOT_FOUND: 'ROW_NOT_FOUND',
  WRITE_DENIED: 'WRITE_DENIED',
  PRECONDITION_CHANGED: 'PRECONDITION_CHANGED',
  NO_CHANGE_ALREADY_SATISFIED: 'NO_CHANGE_ALREADY_SATISFIED',
  OTHER_FAILURE: 'OTHER_FAILURE',
});

// A thrown Postgres error shaped like an RLS violation is WRITE_DENIED too - rare (RLS on UPDATE
// normally manifests as a 0-row match, not a thrown error), but a caller must never fall through to
// OTHER_FAILURE for what is really the same permission boundary.
function classifyThrown(e) {
  const msg = `${e?.message || ''} ${e?.details || ''} ${e?.hint || ''}`.toLowerCase();
  if (e?.code === '42501' || msg.includes('permission denied') || msg.includes('row-level security')) {
    return { outcome: OUTCOME.WRITE_DENIED, error: e.message || 'permission denied' };
  }
  return { outcome: OUTCOME.OTHER_FAILURE, error: e?.message || String(e) };
}

/**
 * One guarded UPDATE, fully classified. Never reports SUCCESS unless the database confirmed >=1 row
 * changed.
 *
 * @param client   a supabase-js client (or any object exposing the same .from(table) chain)
 * @param table    table name (string)
 * @param id       the row's id
 * @param patch    fields to write
 * @param applyGuard   (query) => query - chain .eq()/.is() preconditions onto the UPDATE; omit for an
 *                     unconditional update (still id-scoped)
 * @param guardStillHolds  (freshRow) => boolean - true if the ORIGINAL precondition this call assumed
 *                     is still true on a fresh read (=> the 0-row result can only be RLS)
 * @param alreadySatisfied (freshRow) => boolean - true if the fresh row already holds the desired
 *                     patch values (=> the write is a genuine no-op, not a failure)
 * -> { outcome, rows? , row?, error? }
 */
async function verifiedFieldUpdate(client, { table, id, patch, applyGuard, guardStillHolds, alreadySatisfied }) {
  if (!table || !id || !patch || Object.keys(patch).length === 0) {
    return { outcome: OUTCOME.OTHER_FAILURE, error: 'verifiedFieldUpdate requires table, id and a non-empty patch' };
  }
  let data, error;
  try {
    let q = client.from(table).update(patch).eq('id', id);
    q = applyGuard ? applyGuard(q) : q;
    ({ data, error } = await q.select('id'));
  } catch (e) {
    return classifyThrown(e);
  }
  if (error) return classifyThrown(error);
  if (data && data.length) return { outcome: OUTCOME.SUCCESS, rows: data.length };

  // 0 rows, no error: PostgREST cannot distinguish "no row" / "guard no longer true" / "RLS denied"
  // from this response alone - re-read the row and classify by what actually holds now.
  let row;
  try {
    const { data: fresh, error: readErr } = await client.from(table).select('*').eq('id', id).maybeSingle();
    if (readErr) return classifyThrown(readErr);
    row = fresh;
  } catch (e) {
    return classifyThrown(e);
  }
  if (!row) return { outcome: OUTCOME.ROW_NOT_FOUND };
  if (alreadySatisfied && alreadySatisfied(row)) return { outcome: OUTCOME.NO_CHANGE_ALREADY_SATISFIED, row };
  if (guardStillHolds && guardStillHolds(row)) return { outcome: OUTCOME.WRITE_DENIED, row };
  return { outcome: OUTCOME.PRECONDITION_CHANGED, row };
}

// -> true when every key in `fields` has exactly that value on `row` (null-safe: {k: null} matches
// row[k] === null, same semantics as .is(k, null) below).
function fieldsMatch(row, fields) {
  return Object.entries(fields).every(([k, v]) => row[k] === v);
}
// (query) => query with one .eq()/.is() per field - the same guard shape every call site already
// hand-wrote (`.eq('category', old).eq('status','approved')`, `.is('venue_id', null)`, ...).
function fieldGuard(fields) {
  return (q) => Object.entries(fields).reduce((acc, [k, v]) => (v === null ? acc.is(k, null) : acc.eq(k, v)), q);
}

/**
 * The shape nearly every caller in this pass actually has: "write `patch`, but only while `expectedOld`
 * still holds" (fill-if-null, replace-if-still-the-old-value, category/status transitions, ...).
 * `expectedOld: {}` (no precondition) still works: the guard becomes a no-op and a 0-row result can
 * only mean ROW_NOT_FOUND or WRITE_DENIED, never a false PRECONDITION_CHANGED.
 * -> same result shape as verifiedFieldUpdate.
 */
async function verifiedConditionalUpdate(client, { table, id, patch, expectedOld = {} }) {
  return verifiedFieldUpdate(client, {
    table, id, patch,
    applyGuard: fieldGuard(expectedOld),
    guardStillHolds: (row) => fieldsMatch(row, expectedOld),
    alreadySatisfied: (row) => fieldsMatch(row, patch),
  });
}

const isSuccess = (r) => r.outcome === OUTCOME.SUCCESS;
// a no-op that means "nothing needed writing" - not a failure, callers should treat it as a benign skip
const isNoopOk = (r) => r.outcome === OUTCOME.SUCCESS || r.outcome === OUTCOME.NO_CHANGE_ALREADY_SATISFIED;
const describe = (r) => (isSuccess(r)
  ? `updated (${r.rows} row${r.rows === 1 ? '' : 's'})`
  : `NOT written: ${r.outcome}${r.error ? ' - ' + r.error : ''}`);

module.exports = { OUTCOME, verifiedFieldUpdate, verifiedConditionalUpdate, fieldsMatch, fieldGuard, isSuccess, isNoopOk, describe };
