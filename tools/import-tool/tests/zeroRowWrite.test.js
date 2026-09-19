// ZERO-ROW WRITE PROTECTION (2026-09-19): a conditional UPDATE that touches 0 rows is either honest
// (`already_filled` - the guard no longer holds) or DENIED (the row is invisible to the UPDATE under RLS
// while the field still needs the write). The Cleaner must report the second as an explicit failure and
// must not resolve the case. Regression for the 54 published rows with created_by NULL (importer bot
// could not update them; cases resolved as already_filled).
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifiedUpdate, classifyZeroRowWrite, applyAddressToActivity, applyCityToActivity, applyImageToActivity, applyActivityPatch, enrichExistingFromCandidate } = require('../cleaner/apply');
const { archiveCase } = require('../cleaner/lifecycle');

// stub: `hit` decides whether an UPDATE returns rows; `rows` is what a re-read (maybeSingle) returns per table
function stub({ hit = false, rows = {}, count = 0 } = {}) {
  const updates = [], inserts = [];
  const from = (table) => {
    const st = { op: null, payload: null, filters: [] };
    const chain = new Proxy({}, { get(_o, k) {
      if (k === 'update') return (p) => { st.op = 'update'; st.payload = p; return chain; };
      if (k === 'insert') return (p) => { st.op = 'insert'; inserts.push({ table, payload: p }); return chain; };
      if (k === 'select') return (_s, opts) => { if (opts && opts.head) st.op = 'count'; else st.op = st.op || 'select'; return chain; };
      if (k === 'maybeSingle') return () => Promise.resolve({ data: typeof rows[table] === 'function' ? rows[table](st.filters) : (rows[table] ?? null), error: null });
      if (k === 'then') return (res) => { if (st.op === 'update') { updates.push({ table, payload: st.payload, filters: st.filters }); return res({ data: hit ? [{ id: 'x' }] : [], error: null }); } if (st.op === 'count') return res({ count, error: null }); if (st.op === 'insert') return res({ data: null, error: null }); return res({ data: null, error: null }); };
      return (...a) => { st.filters.push([k, ...a]); return chain; };
    } });
    return chain;
  };
  return { from, updates, inserts };
}

test('classifyZeroRowWrite: guard still true -> write_denied; guard false -> already_filled; no row -> row_gone', async () => {
  const c1 = stub({ rows: { locations: { id: 'l1', address: null } } });
  assert.equal(await classifyZeroRowWrite(c1, 'locations', 'l1', (r) => r.address == null), 'write_denied');
  const c2 = stub({ rows: { locations: { id: 'l1', address: 'הרצל 5' } } });
  assert.equal(await classifyZeroRowWrite(c2, 'locations', 'l1', (r) => r.address == null), 'already_filled');
  const c3 = stub({ rows: {} });
  assert.equal(await classifyZeroRowWrite(c3, 'locations', 'l1', (r) => r.address == null), 'row_gone');
});

test('verifiedUpdate: a hit writes; a 0-row write is classified by re-reading the row', async () => {
  const ok = stub({ hit: true });
  assert.deepEqual(await verifiedUpdate(ok, 'activities', 'a1', { venue_id: 'v' }, (q) => q.is('venue_id', null), (r) => r.venue_id == null), { wrote: true });
  const denied = stub({ hit: false, rows: { activities: { id: 'a1', venue_id: null, created_by: null } } });
  assert.deepEqual(await verifiedUpdate(denied, 'activities', 'a1', { venue_id: 'v' }, (q) => q.is('venue_id', null), (r) => r.venue_id == null), { wrote: false, why: 'write_denied' });
  const filled = stub({ hit: false, rows: { activities: { id: 'a1', venue_id: 'other' } } });
  assert.deepEqual(await verifiedUpdate(filled, 'activities', 'a1', { venue_id: 'v' }, (q) => q.is('venue_id', null), (r) => r.venue_id == null), { wrote: false, why: 'already_filled' });
});

test('venue link on an activity the bot cannot update is reported as DENIED, not as venuesLinked / already_filled', async () => {
  // locations write also denied (0 rows, venue_id still null) - the historical 4 missing_venue "already_filled" cases
  const client = stub({ hit: false, rows: { locations: { id: 'l1', venue_id: null }, activities: { id: 'a1', venue_id: null, created_by: null } } });
  const r = await applyAddressToActivity(client, { id: 'a1', location_id: 'l1', locations: { id: 'l1', lat: 1, lng: 1, address: 'x', city: 'y' } }, { venue_id: 'v1', method: 'existing_venue', confidence: 'HIGH' });
  assert.deepEqual(r.wrote, []); assert.deepEqual(r.denied, ['venue']); assert.deepEqual(r.skipped, []);
  // venue link genuinely filled meanwhile -> skipped (honest already_filled), not denied
  const filled = stub({ hit: false, rows: { locations: { id: 'l1', venue_id: 'v9' }, activities: { id: 'a1', venue_id: 'v9' } } });
  const r2 = await applyAddressToActivity(filled, { id: 'a1', location_id: 'l1', locations: { id: 'l1', lat: 1, lng: 1, address: 'x', city: 'y' } }, { venue_id: 'v1', method: 'existing_venue', confidence: 'HIGH' });
  assert.deepEqual(r2.skipped, ['venue']); assert.deepEqual(r2.denied, []);
});

test('address / coordinates: denied vs already filled are distinguished field by field', async () => {
  const client = stub({ hit: false, rows: { locations: { id: 'l1', lat: null, lng: null, address: 'כבר יש' } } });
  const r = await applyAddressToActivity(client, { id: 'a1', location_id: 'l1', locations: { id: 'l1', lat: null, lng: null, address: null, city: 'y' } }, { lat: 32.1, lng: 34.8, address: 'הרצל 5', method: 'source_page', confidence: 'HIGH' });
  assert.deepEqual(r.denied, ['coords']); assert.deepEqual(r.skipped, ['address']); assert.deepEqual(r.wrote, []);
});

test('city write: guard on the seen value; a denied 0-row write returns write_denied with an explicit error, never already_fixed', async () => {
  const denied = stub({ hit: false, rows: { locations: { id: 'l1', city: 'מועצה אזורית גולן', region: 'הצפון והגליל' } } });
  const r = await applyCityToActivity(denied, { id: 'a1', location_id: 'l1' }, { city: 'קצרין', region: 'הצפון והגליל', settlement_id: '4100', previous_city: 'מועצה אזורית גולן' });
  assert.equal(r.why, 'write_denied'); assert.match(r.error, /write_denied/); assert.deepEqual(r.wrote, []);
  assert.ok(denied.updates[0].filters.some((f) => f[0] === 'eq' && f[1] === 'city' && f[2] === 'מועצה אזורית גולן'), 'the stored value is the guard');
  // the same call when a person changed the city meanwhile -> already_fixed, no update issued
  const changed = stub({ hit: false, rows: { locations: { id: 'l1', city: 'קצרין', region: null } } });
  const r2 = await applyCityToActivity(changed, { id: 'a1', location_id: 'l1' }, { city: 'קצרין', previous_city: 'מועצה אזורית גולן' });
  assert.equal(r2.why, 'already_fixed'); assert.equal(changed.updates.length, 0);
  // a replacement proposal never touches a row whose city is already canonical and different from the guard value
  const r3 = await applyCityToActivity(stub({ rows: { locations: { id: 'l1', city: 'חיפה' } } }), { id: 'a1', location_id: 'l1' }, { city: 'קצרין', previous_city: 'מועצה אזורית גולן' });
  assert.equal(r3.why, 'already_fixed');
});

test('image attached but the placeholder flag could not be cleared -> wrote with denied noted (never silent)', async () => {
  const client = stub({ hit: false, count: 0, rows: { activities: { id: 'a1', placeholder_group: 'g', created_by: null } } });
  const r = await applyImageToActivity(client, { id: 'a1', placeholder_group: 'g' }, { url: 'https://x/y.jpg', kind: 'event_specific', image_source_type: 'ORIGINAL_SOURCE', needs_rights_review: false }, 'u');
  assert.equal(r.wrote, true); assert.deepEqual(r.denied, ['placeholder_group']); assert.match(r.error, /write_denied/);
  assert.equal(client.inserts.length, 1);
});

test('status / category patches (misclassified, outside service area) are verified the same way', async () => {
  const denied = stub({ hit: false, rows: { activities: { id: 'a1', status: 'approved', category: 'גן שעשועים' } } });
  const r = await applyActivityPatch(denied, 'a1', { category: 'משחקייה' }, (q) => q.eq('category', 'גן שעשועים'), (row) => row.category === 'גן שעשועים');
  assert.deepEqual(r, { wrote: false, why: 'write_denied' });
  const fixed = stub({ hit: false, rows: { activities: { id: 'a1', status: 'approved', category: 'משחקייה' } } });
  assert.deepEqual(await applyActivityPatch(fixed, 'a1', { category: 'משחקייה' }, (q) => q.eq('category', 'גן שעשועים'), (row) => row.category === 'גן שעשועים'), { wrote: false, why: 'already_filled' });
});

test('enrichExistingFromCandidate separates gained fields from denied ones', async () => {
  const client = stub({ hit: false, rows: { activities: { id: 'a1', venue_id: null, description: null, min_age: null, max_age: null, price_type: null, location_id: null } } });
  const r = await enrichExistingFromCandidate(client, 'a1', { venue_id: 'v1', description: 'תיאור', min_age: 3 });
  assert.deepEqual(r.gained, []); assert.deepEqual(r.denied, ['venue_id', 'description', 'min_age']);
});

test('archiving an unlocatable activity: a denied subject write throws instead of archiving the case', async () => {
  const client = stub({ hit: false, rows: { activities: { id: 'a1', status: 'approved', created_by: null } } });
  await assert.rejects(() => archiveCase(client, { id: 'c1', subject_kind: 'activity', subject_id: 'a1', issue: 'missing_coordinates', attempts: 3, methods_tried: [] }, { reason: 'missing_address_unresolved' }), /write_denied/);
  assert.ok(!client.updates.some((u) => u.table === 'cleaner_cases'), 'the case row was not archived');
});
