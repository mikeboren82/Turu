// CONTROLLED ARCHIVE CAPABILITY (supabase/0105 + lib/activityArchive.js).
//
// Two separate defects are under test here, both found on 2026-09-21 when duplicate Resolution
// Batch #1 reported two activities archived that were never archived:
//   AUTHORISATION - activities_update is USING ((created_by = auth.uid()) OR is_admin()); the importer
//                   bot owns neither of the 55 created_by IS NULL rows, so its UPDATE matched nothing.
//   SILENCE       - PostgREST answers such an UPDATE 200 / error=null / zero rows, which a caller that
//                   only inspects `error` reads as success.
// The RPC answers the first; this module answers the second by refusing to call anything a success
// that the database did not itself call 'archived'.
const test = require('node:test');
const assert = require('node:assert/strict');
const { archiveActivity, ARCHIVE_REASONS, OUTCOME, isArchived, describe: describeResult } = require('../lib/activityArchive');

// records every rpc call so a test can assert WHAT was sent, not just what came back
function stub(respond) {
  const calls = [];
  return { calls, rpc: async (fn, params) => { calls.push({ fn, params }); return respond(params); } };
}
const ok = (extra = {}) => stub(() => ({ data: { outcome: 'archived', activity_id: 'a1', previous_status: 'approved', ...extra }, error: null }));

test('authorised controlled archive succeeds for an activity created by SOMEBODY ELSE', async () => {
  // The bot could never UPDATE this row directly (created_by is null / another identity). The RPC is
  // SECURITY DEFINER, so the caller identity never appears in the request at all - which is the point:
  // authorisation is the function's internal is_admin() OR is_trusted_uploader() gate, not row ownership.
  const c = ok({ archive_reason: 'duplicate_of_existing_activity' });
  const r = await archiveActivity(c, { activityId: '38ba9f4b', expectedStatus: 'approved', archiveReason: 'duplicate_of_existing_activity', keeperActivityId: '06e48ef2' });
  assert.equal(r.outcome, OUTCOME.SUCCESS);
  assert.equal(isArchived(r), true);
  assert.equal(c.calls[0].fn, 'archive_activity');
  assert.match(describeResult(r), /^archived 38ba9f4b/);
});

test('unauthorised caller cannot archive - a permission error is never a success', async () => {
  for (const err of [
    { code: '42501', message: 'permission denied: admin or trusted uploader only' },
    { code: '', message: 'new row violates row-level security policy for table "activities"' },
    { code: '', message: 'permission denied for function archive_activity' },
  ]) {
    const r = await archiveActivity(stub(() => ({ data: null, error: err })), { activityId: 'a1', archiveReason: 'expired' });
    assert.equal(r.outcome, OUTCOME.RLS_OR_PERMISSION_DENIED, `for ${err.message}`);
    assert.equal(isArchived(r), false);
  }
});

test('the capability cannot carry arbitrary field mutations - only the 4 documented parameters are sent', async () => {
  const c = ok();
  await archiveActivity(c, {
    activityId: 'a1', expectedStatus: 'approved', archiveReason: 'expired', keeperActivityId: 'k1',
    // everything below is an attempt to smuggle a field mutation through the archive call
    category: 'חווה', name: 'renamed', created_by: 'someone-else', status: 'approved', price_amount: 0,
  });
  assert.deepEqual(Object.keys(c.calls[0].params).sort(),
    ['p_activity_id', 'p_archive_reason', 'p_expected_status', 'p_keeper_activity_id']);
  assert.deepEqual(c.calls[0].params, { p_activity_id: 'a1', p_expected_status: 'approved', p_archive_reason: 'expired', p_keeper_activity_id: 'k1' });
});

test('archive_reason is a closed list - arbitrary text never reaches the database', async () => {
  const c = ok();
  for (const bad of ['because i said so', 'restore', null, undefined, '', 'DROP TABLE']) {
    const r = await archiveActivity(c, { activityId: 'a1', archiveReason: bad });
    assert.equal(r.outcome, OUTCOME.OTHER_FAILURE);
    assert.equal(isArchived(r), false);
  }
  assert.equal(c.calls.length, 0, 'a disallowed reason must not even be sent');
  // and the allowlist itself carries no status-changing or restore-ish value
  assert.ok(!ARCHIVE_REASONS.some((x) => /restore|approve|delete/i.test(x)));
});

test('the JS mirror equals the enforcing SQL allowlist of the latest archive_activity() migration (0111)', () => {
  const sql = require('fs').readFileSync(require('path').join(__dirname, '../../../supabase/0111_archive_reason_auto_publish_false_positive.sql'), 'utf8');
  const list = sql.slice(sql.indexOf('p_archive_reason not in ('), sql.indexOf(') then', sql.indexOf('p_archive_reason not in (')));
  assert.deepEqual([...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), [...ARCHIVE_REASONS]);
});

test('expected-old-status precondition is enforced, and a moved row is not archived', async () => {
  const changed = stub(() => ({ data: { outcome: 'precondition_changed', current_status: 'archived', expected_status: 'approved' }, error: null }));
  const r = await archiveActivity(changed, { activityId: 'a1', archiveReason: 'expired' });
  assert.equal(r.outcome, OUTCOME.PRECONDITION_CHANGED);
  assert.equal(isArchived(r), false);
  assert.equal(r.detail.current_status, 'archived');

  // a row somebody already archived is reported as a precondition, never as work this call did
  const already = stub(() => ({ data: { outcome: 'already_archived', current_status: 'archived' }, error: null }));
  assert.equal((await archiveActivity(already, { activityId: 'a1', archiveReason: 'expired' })).outcome, OUTCOME.PRECONDITION_CHANGED);
});

test('a nonexistent row is ROW_NOT_FOUND, never success', async () => {
  const r = await archiveActivity(stub(() => ({ data: { outcome: 'row_not_found' }, error: null })), { activityId: 'gone', archiveReason: 'expired' });
  assert.equal(r.outcome, OUTCOME.ROW_NOT_FOUND);
  assert.equal(isArchived(r), false);
});

test('THE BATCH #1 REGRESSION: error=null with no confirmed outcome is never reported as archived', async () => {
  // This is the exact shape the old direct UPDATE produced when RLS filtered the row out: no error,
  // nothing written. Every one of these must be a failure.
  for (const body of [null, undefined, {}, { outcome: null }, { outcome: '' }, { rows: 0 }]) {
    const r = await archiveActivity(stub(() => ({ data: body, error: null })), { activityId: 'a1', archiveReason: 'expired' });
    assert.equal(r.outcome, OUTCOME.OTHER_FAILURE, `body ${JSON.stringify(body)}`);
    assert.equal(isArchived(r), false);
    assert.match(describeResult(r), /NOT archived/);
  }
  // an outcome the module does not know is also not a success
  const unknown = await archiveActivity(stub(() => ({ data: { outcome: 'probably_fine' }, error: null })), { activityId: 'a1', archiveReason: 'expired' });
  assert.equal(unknown.outcome, OUTCOME.OTHER_FAILURE);
});

test('duplicate provenance: the keeper is passed through and validated, and a bad keeper blocks the archive', async () => {
  const c = ok();
  await archiveActivity(c, { activityId: 'loser', archiveReason: 'duplicate_of_existing_activity', keeperActivityId: 'keeper' });
  assert.equal(c.calls[0].params.p_keeper_activity_id, 'keeper');
  assert.equal(c.calls[0].params.p_archive_reason, 'duplicate_of_existing_activity');

  for (const outcome of ['keeper_not_found', 'keeper_not_approved']) {
    const r = await archiveActivity(stub(() => ({ data: { outcome }, error: null })), { activityId: 'loser', archiveReason: 'duplicate_of_existing_activity', keeperActivityId: 'k' });
    assert.equal(r.outcome, OUTCOME.OTHER_FAILURE);
    assert.equal(isArchived(r), false);
  }
  // a row cannot be its own keeper, and that is refused before any round trip
  const self = ok();
  const r = await archiveActivity(self, { activityId: 'x', archiveReason: 'duplicate_of_existing_activity', keeperActivityId: 'x' });
  assert.equal(r.outcome, OUTCOME.OTHER_FAILURE);
  assert.equal(self.calls.length, 0);
});

test('a missing migration fails loudly and names 0105 - it never falls back to a direct UPDATE', async () => {
  for (const err of [{ code: '42883', message: 'function public.archive_activity(uuid, text, text, uuid) does not exist' },
    { code: 'PGRST202', message: 'Could not find the function public.archive_activity' }]) {
    const r = await archiveActivity(stub(() => ({ data: null, error: err })), { activityId: 'a1', archiveReason: 'expired' });
    assert.equal(r.outcome, OUTCOME.OTHER_FAILURE);
    assert.match(r.error, /0105/);
  }
  // a thrown transport error (the 'fetch failed' class seen in batch #1) is also not a success
  const thrown = { rpc: async () => { throw new Error('fetch failed'); } };
  const r = await archiveActivity(thrown, { activityId: 'a1', archiveReason: 'expired' });
  assert.equal(r.outcome, OUTCOME.OTHER_FAILURE);
  assert.equal(isArchived(r), false);
});

test('ordinary owner/admin field-write behaviour is untouched: verifiedUpdate stays the guarded-write primitive', async () => {
  // The archive capability is additive. The Cleaner's guarded fill-if-null path must keep its own
  // classifier (that 0-row case IS genuinely ambiguous and is resolved by re-reading the row).
  const apply = require('../cleaner/apply');
  assert.equal(typeof apply.verifiedUpdate, 'function');
  assert.equal(typeof apply.classifyZeroRowWrite, 'function');
  const archive = require('../lib/activityArchive');
  assert.equal(archive.verifiedUpdate, undefined, 'the archive door must not shadow or re-implement verifiedUpdate');
});
