// Regression for the Batch C provenance-downgrade risk (2026-09-22): a blind
// `.upsert(..., { onConflict: 'activity_id,page_url' })` with a fixed relation can replace an
// existing keeper row's stronger relation/url_role with the loser's weaker one whenever both sides
// share a page_url. lib/activitySourceMerge.js fixes this; these tests pin the exact failure shape
// Batch C hit plus the general safety properties the task asks for.
const test = require('node:test');
const assert = require('node:assert/strict');
const { OUTCOME, upsertProvenanceSafe, mergeActivitySources } = require('../lib/activitySourceMerge');

// A minimal in-memory fake of the one activity_sources shape this module touches: select-by-
// (activity_id,page_url), select-by-activity_id, insert, update-by-id. Good enough to exercise the
// real branching logic without a live database.
function fakeClient(initialRows = []) {
  let rows = initialRows.map((r, i) => ({ id: r.id || `row${i}`, source_id: null, incoming_activity_id: null, url_role: null, first_seen_at: null, last_seen_at: null, ...r }));
  const inserts = [];
  const updates = [];
  function from(table) {
    if (table !== 'activity_sources') throw new Error(`unexpected table ${table}`);
    const filters = {};
    const chain = {
      select() { return chain; },
      eq(col, val) { filters[col] = val; return chain; },
      maybeSingle() {
        const match = rows.find((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
        return Promise.resolve({ data: match || null, error: null });
      },
      insert(payload) {
        if (rows.some((r) => r.activity_id === payload.activity_id && r.page_url === payload.page_url)) {
          return Promise.resolve({ data: null, error: { message: 'duplicate key value violates unique constraint' } });
        }
        const row = { id: `row${rows.length}`, ...payload };
        rows.push(row); inserts.push(payload);
        return Promise.resolve({ data: [row], error: null });
      },
      update(patch) {
        updates.push(patch);
        return { eq: (col, val) => { const r = rows.find((x) => x[col] === val); if (r) Object.assign(r, patch); return Promise.resolve({ data: r ? [r] : [], error: null }); } };
      },
      then(res) { // list query: .select(...).eq('activity_id', loserId) with no maybeSingle
        const match = rows.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
        return res({ data: match, error: null });
      },
    };
    return chain;
  }
  return { from, get rows() { return rows; }, inserts, updates };
}

test('THE BATCH C SHAPE: keeper has a stronger relation/url_role for a shared page_url - the loser must never downgrade it', async () => {
  const client = fakeClient([
    { activity_id: 'keeper', page_url: 'https://x.example/', relation: 'created', url_role: 'listing', first_seen_at: '2026-01-01T00:00:00Z', last_seen_at: '2026-01-05T00:00:00Z' },
  ]);
  const r = await upsertProvenanceSafe(client, 'keeper', { pageUrl: 'https://x.example/', relation: 'seen', urlRole: null, firstSeenAt: '2026-01-10T00:00:00Z', lastSeenAt: '2026-01-10T00:00:00Z' });
  assert.equal(r.outcome, OUTCOME.PRESERVED_EXISTING);
  const row = client.rows.find((x) => x.page_url === 'https://x.example/');
  assert.equal(row.relation, 'created', 'relation must stay created, never downgraded to seen');
  assert.equal(row.url_role, 'listing', 'url_role must stay listing, never wiped by the loser\'s null');
  // last_seen_at is allowed to widen (purely additive, matches 0078's greatest() precedent) - relation/url_role are the identity fields that must never move backward
  assert.equal(row.last_seen_at, '2026-01-10T00:00:00Z');
});

test('loser has a genuinely NEW page_url - it is added to the keeper', async () => {
  const client = fakeClient([{ activity_id: 'keeper', page_url: 'https://a.example/', relation: 'created' }]);
  const r = await upsertProvenanceSafe(client, 'keeper', { pageUrl: 'https://b.example/', relation: 'seen', sourceId: 's1' });
  assert.equal(r.outcome, OUTCOME.ADDED);
  assert.equal(client.rows.length, 2);
  assert.ok(client.rows.some((x) => x.page_url === 'https://b.example/' && x.relation === 'seen'));
});

test('exact duplicate (identical page_url, nothing new) - no duplicate row, reported as ALREADY_PRESENT', async () => {
  const client = fakeClient([{ activity_id: 'keeper', page_url: 'https://a.example/', relation: 'seen', url_role: 'detail', last_seen_at: '2026-01-05T00:00:00Z' }]);
  const r = await upsertProvenanceSafe(client, 'keeper', { pageUrl: 'https://a.example/', relation: 'seen', urlRole: 'detail', lastSeenAt: '2026-01-01T00:00:00Z' });
  assert.equal(r.outcome, OUTCOME.ALREADY_PRESENT);
  assert.equal(client.rows.length, 1);
});

test('repeated merge is idempotent: second run makes no further changes and creates no duplicates', async () => {
  // keeper's shared URL is genuinely richer (url_role set) than the loser's copy of it, so the first
  // merge has something real to preserve; the second run should then find nothing left to change.
  const client = fakeClient([{ activity_id: 'keeper', page_url: 'https://a.example/', relation: 'created', url_role: 'detail' }]);
  const loserRows = [
    { activity_id: 'loser', page_url: 'https://a.example/', relation: 'seen', url_role: null },
    { activity_id: 'loser', page_url: 'https://b.example/', relation: 'seen', url_role: 'listing' },
  ];
  for (const r of loserRows) client.rows.push({ id: `l-${r.page_url}`, source_id: null, incoming_activity_id: null, url_role: null, first_seen_at: null, last_seen_at: null, ...r });

  const first = await mergeActivitySources(client, { keeperActivityId: 'keeper', loserActivityId: 'loser' });
  assert.deepEqual(first.counts, { ADDED: 1, ALREADY_PRESENT: 1, PRESERVED_EXISTING: 0, FAILED: 0 });
  const afterFirst = client.rows.filter((r) => r.activity_id === 'keeper');
  assert.equal(afterFirst.length, 2);
  assert.equal(afterFirst.find((r) => r.page_url === 'https://a.example/').url_role, 'detail', 'keeper role untouched');

  const second = await mergeActivitySources(client, { keeperActivityId: 'keeper', loserActivityId: 'loser' });
  assert.deepEqual(second.counts, { ADDED: 0, ALREADY_PRESENT: 2, PRESERVED_EXISTING: 0, FAILED: 0 });
  const afterSecond = client.rows.filter((r) => r.activity_id === 'keeper');
  assert.equal(afterSecond.length, 2, 'no duplicate rows after a repeated merge');
});

test('multiple loser provenance rows: every genuinely unique URL is preserved on the keeper', async () => {
  const client = fakeClient();
  client.rows.push(
    { id: 'l1', activity_id: 'loser', page_url: 'https://a.example/', relation: 'created', url_role: null, source_id: null, incoming_activity_id: null, first_seen_at: null, last_seen_at: null },
    { id: 'l2', activity_id: 'loser', page_url: 'https://b.example/', relation: 'seen', url_role: 'booking', source_id: null, incoming_activity_id: null, first_seen_at: null, last_seen_at: null },
    { id: 'l3', activity_id: 'loser', page_url: 'https://c.example/', relation: 'updated', url_role: null, source_id: null, incoming_activity_id: null, first_seen_at: null, last_seen_at: null },
  );
  const result = await mergeActivitySources(client, { keeperActivityId: 'keeper', loserActivityId: 'loser' });
  assert.deepEqual(result.counts, { ADDED: 3, ALREADY_PRESENT: 0, PRESERVED_EXISTING: 0, FAILED: 0 });
  const keeperUrls = client.rows.filter((r) => r.activity_id === 'keeper').map((r) => r.page_url).sort();
  assert.deepEqual(keeperUrls, ['https://a.example/', 'https://b.example/', 'https://c.example/']);
});

test('a DB error on the write path is reported as FAILED, never silent success', async () => {
  const client = fakeClient();
  client.from = (table) => {
    const real = fakeClient().from(table);
    return { ...real, maybeSingle: () => Promise.resolve({ data: null, error: null }), insert: () => Promise.resolve({ data: null, error: { message: 'connection reset' } }) };
  };
  const r = await upsertProvenanceSafe(client, 'keeper', { pageUrl: 'https://a.example/' });
  assert.equal(r.outcome, OUTCOME.FAILED);
  assert.match(r.error, /connection reset/);
});

test('missing keeper/loser id is FAILED, not a silent no-op', async () => {
  const client = fakeClient();
  const r = await mergeActivitySources(client, { keeperActivityId: null, loserActivityId: 'loser' });
  assert.equal(r.counts.FAILED, 1);
});

test('no rule ranks "seen" vs "updated" - neither downgrades the other when neither side is "created"', async () => {
  const client = fakeClient([{ activity_id: 'keeper', page_url: 'https://a.example/', relation: 'updated' }]);
  const r = await upsertProvenanceSafe(client, 'keeper', { pageUrl: 'https://a.example/', relation: 'seen' });
  assert.equal(r.outcome, OUTCOME.ALREADY_PRESENT);
  assert.equal(client.rows.find((x) => x.page_url === 'https://a.example/').relation, 'updated', 'relation is preserved, not overwritten by the incoming "seen"');
});

test('"created" proven by the loser upgrades a non-created keeper row - not a downgrade, the documented rule applied both ways', async () => {
  const client = fakeClient([{ activity_id: 'keeper', page_url: 'https://a.example/', relation: 'seen' }]);
  const r = await upsertProvenanceSafe(client, 'keeper', { pageUrl: 'https://a.example/', relation: 'created' });
  assert.equal(r.outcome, OUTCOME.PRESERVED_EXISTING);
  assert.ok(r.changed.includes('relation'));
  assert.equal(client.rows.find((x) => x.page_url === 'https://a.example/').relation, 'created');
});
