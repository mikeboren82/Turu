// TuRu - the general "did this UPDATE actually happen?" primitive (2026-09-21). App-side twin of
// tools/import-tool/lib/verifiedWrite.js - same deliberate-duplication convention as
// lib/i18n vs the Deno _shared copies: two separate runtimes (this file runs in the RN app, under the
// signed-in admin's own Supabase session; the tools/import-tool copy runs in Node, under the bot's
// session) cannot share one module, so the pair is kept intentionally identical and changed together.
// See the Node twin for the full rationale and outcome-vocabulary documentation - not repeated here.
const OUTCOME = Object.freeze({
  SUCCESS: 'SUCCESS',
  ROW_NOT_FOUND: 'ROW_NOT_FOUND',
  WRITE_DENIED: 'WRITE_DENIED',
  PRECONDITION_CHANGED: 'PRECONDITION_CHANGED',
  NO_CHANGE_ALREADY_SATISFIED: 'NO_CHANGE_ALREADY_SATISFIED',
  OTHER_FAILURE: 'OTHER_FAILURE',
});

function classifyThrown(e) {
  const msg = `${e?.message || ''} ${e?.details || ''} ${e?.hint || ''}`.toLowerCase();
  if (e?.code === '42501' || msg.includes('permission denied') || msg.includes('row-level security')) {
    return { outcome: OUTCOME.WRITE_DENIED, error: e.message || 'permission denied' };
  }
  return { outcome: OUTCOME.OTHER_FAILURE, error: e?.message || String(e) };
}

export async function verifiedFieldUpdate(client, { table, id, patch, applyGuard, guardStillHolds, alreadySatisfied }) {
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

export function fieldsMatch(row, fields) {
  return Object.entries(fields).every(([k, v]) => row[k] === v);
}
export function fieldGuard(fields) {
  return (q) => Object.entries(fields).reduce((acc, [k, v]) => (v === null ? acc.is(k, null) : acc.eq(k, v)), q);
}

export async function verifiedConditionalUpdate(client, { table, id, patch, expectedOld = {} }) {
  return verifiedFieldUpdate(client, {
    table, id, patch,
    applyGuard: fieldGuard(expectedOld),
    guardStillHolds: (row) => fieldsMatch(row, expectedOld),
    alreadySatisfied: (row) => fieldsMatch(row, patch),
  });
}

export const isSuccess = (r) => r.outcome === OUTCOME.SUCCESS;
export const isNoopOk = (r) => r.outcome === OUTCOME.SUCCESS || r.outcome === OUTCOME.NO_CHANGE_ALREADY_SATISFIED;
export const describe = (r) => (isSuccess(r)
  ? `updated (${r.rows} row${r.rows === 1 ? '' : 's'})`
  : `NOT written: ${r.outcome}${r.error ? ' - ' + r.error : ''}`);

export { OUTCOME };
