// GENERAL ZERO-ROW UPDATE HARDENING (2026-09-21) - lib/verifiedWrite.js.
//
// Same root cause as lib/activityArchive.js's own regression suite (activityArchive.test.js): a plain
// `.update(patch).eq('id', id)` with only `error` checked cannot tell "wrote 1 row" apart from "wrote
// 0 rows, error=null" - which is exactly how duplicate Resolution Batch #1 silently failed to archive
// two rows. This module is the general (non-archive) sibling; these tests hold it to the same standard:
// a 0-row UPDATE must never be reported as SUCCESS, and must be classified into one of the other five
// outcomes by re-reading the row, never collapsed into one generic "failed" bucket.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OUTCOME, verifiedFieldUpdate, verifiedConditionalUpdate, fieldsMatch, fieldGuard, isSuccess, isNoopOk, describe,
} = require('../lib/verifiedWrite');

// A minimal chainable stand-in for the two query shapes this module issues:
//   client.from(t).update(patch).eq('id', id)[.eq/.is(...)].select('id')       -> updateResult
//   client.from(t).select('*').eq('id', id).maybeSingle()                       -> readResult
function makeClient({ updateResult, readResult, updateThrows, readThrows } = {}) {
  const calls = [];
  function from(table) {
    return {
      update(patch) {
        calls.push({ op: 'update', table, patch });
        const guardCalls = [];
        const builder = {
          eq(k, v) { guardCalls.push(['eq', k, v]); return builder; },
          is(k, v) { guardCalls.push(['is', k, v]); return builder; },
          select(cols) {
            calls.push({ op: 'update.select', cols, guardCalls });
            if (updateThrows) return Promise.reject(updateThrows);
            return Promise.resolve(updateResult);
          },
        };
        return builder;
      },
      select(cols) {
        calls.push({ op: 'read.select', table, cols });
        const builder = {
          eq() { return builder; },
          maybeSingle() {
            if (readThrows) return Promise.reject(readThrows);
            return Promise.resolve(readResult);
          },
        };
        return builder;
      },
    };
  }
  return { calls, from };
}

test('1. successful update: >=1 row confirmed by .select() -> SUCCESS, no re-read', async () => {
  const c = makeClient({ updateResult: { data: [{ id: 'a1' }], error: null } });
  const r = await verifiedFieldUpdate(c, { table: 'activities', id: 'a1', patch: { name: 'x' } });
  assert.equal(r.outcome, OUTCOME.SUCCESS);
  assert.equal(r.rows, 1);
  assert.equal(isSuccess(r), true);
  assert.ok(!c.calls.some((call) => call.op === 'read.select'), 'a confirmed write must not trigger a re-read');
});

test('2. error=null + zero rows is never blind SUCCESS (the Batch #1 shape)', async () => {
  const c = makeClient({
    updateResult: { data: [], error: null },
    readResult: { data: { id: 'a1', name: 'unchanged' }, error: null },
  });
  const r = await verifiedFieldUpdate(c, { table: 'activities', id: 'a1', patch: { name: 'x' }, guardStillHolds: () => true });
  assert.notEqual(r.outcome, OUTCOME.SUCCESS);
  assert.equal(isSuccess(r), false);
});

test('3. target missing on re-read -> ROW_NOT_FOUND', async () => {
  const c = makeClient({ updateResult: { data: [], error: null }, readResult: { data: null, error: null } });
  const r = await verifiedFieldUpdate(c, { table: 'activities', id: 'gone', patch: { name: 'x' } });
  assert.equal(r.outcome, OUTCOME.ROW_NOT_FOUND);
});

test('4. RLS denial: row exists, guard still holds, 0 rows written -> WRITE_DENIED', async () => {
  const c = makeClient({
    updateResult: { data: [], error: null },
    readResult: { data: { id: 'a1', created_by: 'someone-else' }, error: null },
  });
  const r = await verifiedConditionalUpdate(c, { table: 'activities', id: 'a1', patch: { name: 'x' }, expectedOld: {} });
  // no expectedOld guard supplied at all here -> caller must pass its own guardStillHolds via
  // verifiedFieldUpdate directly to assert RLS; verifiedConditionalUpdate with expectedOld={} always
  // finds the (vacuous) guard true, matching the pattern used for /api/manage/update.
  assert.equal(r.outcome, OUTCOME.WRITE_DENIED);
});

test('5. precondition changed: row exists, neither the old nor the desired value -> PRECONDITION_CHANGED', async () => {
  const c = makeClient({
    updateResult: { data: [], error: null },
    readResult: { data: { id: 'a1', category: 'משהו-אחר-לגמרי' }, error: null },
  });
  const r = await verifiedConditionalUpdate(c, { table: 'activities', id: 'a1', patch: { category: 'ספורט' }, expectedOld: { category: 'תרבות' } });
  assert.equal(r.outcome, OUTCOME.PRECONDITION_CHANGED);
});

test('6. desired value already present -> NO_CHANGE_ALREADY_SATISFIED, not a failure', async () => {
  const c = makeClient({
    updateResult: { data: [], error: null },
    readResult: { data: { id: 'a1', category: 'ספורט' }, error: null },
  });
  const r = await verifiedConditionalUpdate(c, { table: 'activities', id: 'a1', patch: { category: 'ספורט' }, expectedOld: { category: 'תרבות' } });
  assert.equal(r.outcome, OUTCOME.NO_CHANGE_ALREADY_SATISFIED);
  assert.equal(isNoopOk(r), true);
  assert.equal(isSuccess(r), false, 'already-satisfied is a benign no-op, not a confirmed write');
});

test('7. transport error thrown by the update itself -> classified, never silently swallowed', async () => {
  const c = makeClient({ updateThrows: Object.assign(new Error('fetch failed'), { code: undefined }) });
  const r = await verifiedFieldUpdate(c, { table: 'activities', id: 'a1', patch: { name: 'x' } });
  assert.equal(r.outcome, OUTCOME.OTHER_FAILURE);
  assert.match(r.error, /fetch failed/);
});

test('7b. an RLS-shaped thrown error is WRITE_DENIED, not OTHER_FAILURE', async () => {
  const c = makeClient({ updateThrows: { code: '42501', message: 'permission denied for table activities' } });
  const r = await verifiedFieldUpdate(c, { table: 'activities', id: 'a1', patch: { name: 'x' } });
  assert.equal(r.outcome, OUTCOME.WRITE_DENIED);
});

test('8. malformed DB response (data undefined, no error) -> re-read path, never a thrown exception', async () => {
  const c = makeClient({ updateResult: { error: null }, readResult: { data: { id: 'a1' }, error: null } });
  const r = await verifiedFieldUpdate(c, { table: 'activities', id: 'a1', patch: { name: 'x' }, guardStillHolds: () => true });
  assert.equal(r.outcome, OUTCOME.WRITE_DENIED);
});

test('missing required arguments never reach the network', async () => {
  const c = makeClient({});
  for (const bad of [
    { table: '', id: 'a1', patch: { x: 1 } },
    { table: 'activities', id: '', patch: { x: 1 } },
    { table: 'activities', id: 'a1', patch: {} },
  ]) {
    const r = await verifiedFieldUpdate(c, bad);
    assert.equal(r.outcome, OUTCOME.OTHER_FAILURE);
  }
  assert.equal(c.calls.length, 0);
});

test('fieldGuard/fieldsMatch: null-safe, matches .is(k, null) semantics', () => {
  const guardCalls = [];
  const q = { eq: (k, v) => { guardCalls.push(['eq', k, v]); return q; }, is: (k, v) => { guardCalls.push(['is', k, v]); return q; } };
  fieldGuard({ venue_id: null, status: 'approved' })(q);
  assert.deepEqual(guardCalls, [['is', 'venue_id', null], ['eq', 'status', 'approved']]);
  assert.equal(fieldsMatch({ venue_id: null, status: 'approved' }, { venue_id: null, status: 'approved' }), true);
  assert.equal(fieldsMatch({ venue_id: 'v1', status: 'approved' }, { venue_id: null, status: 'approved' }), false);
});

test('describe() names the outcome and never claims success for a non-SUCCESS result', async () => {
  const c = makeClient({ updateResult: { data: [], error: null }, readResult: { data: null, error: null } });
  const r = await verifiedFieldUpdate(c, { table: 'activities', id: 'gone', patch: { x: 1 } });
  assert.match(describe(r), /^NOT written: ROW_NOT_FOUND/);
});
