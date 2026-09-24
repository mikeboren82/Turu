// TuRu - the ONE door for archiving an activity from system tooling (supabase/0105).
//
// WHY THIS EXISTS. A direct `.from('activities').update({status:'archived'})` is unsafe from the bot
// in two separate ways, and both bit us on 2026-09-21:
//   1. AUTHORISATION. activities_update is USING ((created_by = auth.uid()) OR is_admin()). The bot is
//      'importer' (is_trusted_uploader, NOT is_admin), so for the 55 rows with created_by IS NULL the
//      UPDATE simply matches nothing.
//   2. SILENCE. PostgREST answers such an UPDATE with 200 / error=null / zero rows. A caller that
//      only checks `error` reads that as success. Duplicate Resolution Batch #1 reported two
//      activities archived that were never archived, for exactly this reason.
// The RPC fixes (1) by granting a narrow, forward-only transition; this module fixes (2) by refusing
// to call any write a success unless the RPC said so in its own words.
//
// DELIBERATELY NO FALLBACK. If the RPC is missing this module fails loudly instead of dropping back
// to a direct UPDATE. A fallback would be a second archival mechanism with exactly the failure mode
// this replaces.
//
// RELATIONSHIP TO cleaner/apply.js verifiedUpdate. verifiedUpdate stays the primitive for GUARDED
// FIELD writes (fill-if-null enrichment), where a 0-row result is genuinely ambiguous and has to be
// classified by re-reading the row. Archiving no longer has that ambiguity: the RPC returns an
// authoritative outcome, so there is nothing to infer. Same vocabulary, different layer - archive
// callers use this module, field-enrichment callers keep using verifiedUpdate.

// Every reason the RPC's allowlist accepts (supabase/0105). Mirrored here to fail before the round
// trip and to keep the two lists reviewable side by side; the DB remains the enforcing copy.
const ARCHIVE_REASONS = Object.freeze([
  'duplicate_of_existing_activity',
  'expired',
  'missing_address_unresolved',
  'missing_from_source',
  'outside_service_area',
  'commitment_policy',
  'wrong_entity_type',
  'private_hire_policy',
  // 0111: a published business / retail / market listing that was never a children's activity (pre-v81
  // auto-publish false positive, now held by autoPublishSafety). Reviewed cohorts only.
  'auto_publish_false_positive_retail',
]);

const OUTCOME = Object.freeze({
  SUCCESS: 'SUCCESS',
  ROW_NOT_FOUND: 'ROW_NOT_FOUND',
  RLS_OR_PERMISSION_DENIED: 'RLS_OR_PERMISSION_DENIED',
  PRECONDITION_CHANGED: 'PRECONDITION_CHANGED',
  OTHER_FAILURE: 'OTHER_FAILURE',
});

const MIGRATION_MISSING = 'archive_activity() is not in the database - supabase/0105_archive_activity_rpc.sql has not been applied';

// Postgres error codes the RPC raises on purpose, plus the ones PostgREST maps around them.
function classifyError(error) {
  const code = error.code || '';
  const msg = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`.toLowerCase();
  if (code === '42501' || msg.includes('permission denied') || msg.includes('row-level security')) {
    return { outcome: OUTCOME.RLS_OR_PERMISSION_DENIED, error: error.message || 'permission denied' };
  }
  if (code === '42883' || code === 'PGRST202' || msg.includes('could not find the function') || msg.includes('does not exist')) {
    return { outcome: OUTCOME.OTHER_FAILURE, error: `${MIGRATION_MISSING} (${error.message || code})` };
  }
  return { outcome: OUTCOME.OTHER_FAILURE, error: error.message || String(code || 'unknown error') };
}

// The RPC's own vocabulary -> this module's five outcomes.
const RPC_OUTCOMES = {
  archived: OUTCOME.SUCCESS,
  row_not_found: OUTCOME.ROW_NOT_FOUND,
  already_archived: OUTCOME.PRECONDITION_CHANGED,
  precondition_changed: OUTCOME.PRECONDITION_CHANGED,
  keeper_not_found: OUTCOME.OTHER_FAILURE,
  keeper_not_approved: OUTCOME.OTHER_FAILURE,
};

/**
 * Archive exactly one activity through the controlled transition.
 * Returns { outcome, activityId, archiveReason, keeperActivityId, detail, error? } and NEVER reports
 * SUCCESS unless the database confirmed that this call archived the row.
 */
async function archiveActivity(client, { activityId, expectedStatus = 'approved', archiveReason, keeperActivityId = null } = {}) {
  const base = { activityId, archiveReason, keeperActivityId };
  if (!activityId) return { ...base, outcome: OUTCOME.OTHER_FAILURE, error: 'activityId is required' };
  if (!ARCHIVE_REASONS.includes(archiveReason)) {
    return { ...base, outcome: OUTCOME.OTHER_FAILURE, error: `archive_reason not allowed: ${archiveReason ?? '(null)'}` };
  }
  if (keeperActivityId && keeperActivityId === activityId) {
    return { ...base, outcome: OUTCOME.OTHER_FAILURE, error: 'keeperActivityId must differ from activityId' };
  }

  let data, error;
  try {
    ({ data, error } = await client.rpc('archive_activity', {
      p_activity_id: activityId,
      p_expected_status: expectedStatus,
      p_archive_reason: archiveReason,
      p_keeper_activity_id: keeperActivityId,
    }));
  } catch (e) {
    return { ...base, outcome: OUTCOME.OTHER_FAILURE, error: e.message || String(e) };
  }

  if (error) return { ...base, ...classifyError(error) };
  // A null/!outcome body is NOT success. This is the exact shape the old direct-UPDATE path returned
  // when RLS filtered the row out, and the whole point of this module is to never read it as a write.
  if (!data || !data.outcome) {
    return { ...base, outcome: OUTCOME.OTHER_FAILURE, error: 'archive_activity returned no outcome - treating as NOT archived' };
  }
  const outcome = RPC_OUTCOMES[data.outcome];
  if (!outcome) return { ...base, outcome: OUTCOME.OTHER_FAILURE, error: `unknown outcome: ${data.outcome}`, detail: data };
  return { ...base, outcome, detail: data, ...(outcome === OUTCOME.SUCCESS ? {} : { error: data.outcome }) };
}

const isArchived = (r) => r.outcome === OUTCOME.SUCCESS;
// One line a script can print/throw. Keeps every caller's failure text consistent and specific.
const describe = (r) => (isArchived(r)
  ? `archived ${r.activityId} (${r.archiveReason})`
  : `NOT archived ${r.activityId}: ${r.outcome}${r.error ? ' - ' + r.error : ''}`);

module.exports = { archiveActivity, ARCHIVE_REASONS, OUTCOME, isArchived, describe, classifyError, MIGRATION_MISSING };
