// TuRu - future (live-ingestion) duplicate-candidate detection: the bounded neighbourhood query,
// failure isolation, the material-change gate, and the recurrence scenarios from the 2026-09-21
// activation, now proven against an ARRIVING activity rather than only the historical backfill.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const fdd = require('../lib/futureDuplicateDetection');
const { PLACE_ENTITY_TYPE } = require('../lib/duplicateSignal');

// --- a small general-purpose in-memory Supabase-shaped fake covering the exact call patterns this
// module uses (select/eq/neq/not/gte/lte/in/maybeSingle, insert, update) ---------------------------
function fakeSupabase({ activities = [], locations = [], duplicate_candidates = [] } = {}) {
  const state = {
    activities: activities.map((a) => ({ ...a })),
    locations: locations.map((l) => ({ ...l })),
    duplicate_candidates: duplicate_candidates.map((d) => ({ ...d })),
  };
  let nextDcId = 1;
  const failing = new Set(); // table names to fail on select, for failure-isolation tests

  function builder(table) {
    const filters = [];
    let selectCols = null, single = false, op = null, payload = null;
    const api = {
      select(cols) { selectCols = cols; return api; },
      eq(k, v) { filters.push(['eq', k, v]); return api; },
      neq(k, v) { filters.push(['neq', k, v]); return api; },
      not(k, _cmp, v) { filters.push(['not', k, v]); return api; },
      gte(k, v) { filters.push(['gte', k, v]); return api; },
      lte(k, v) { filters.push(['lte', k, v]); return api; },
      in(k, list) { filters.push(['in', k, list]); return api; },
      maybeSingle() { single = true; return exec(); },
      insert(p) { op = 'insert'; payload = p; return exec(); },
      update(p) { op = 'update'; payload = p; return api; },
      then(resolve, reject) { return exec().then(resolve, reject); },
    };
    function applyFilters(rows) {
      return rows.filter((r) => filters.every(([type, k, v]) => {
        if (type === 'eq') return r[k] === v;
        if (type === 'neq') return r[k] !== v;
        if (type === 'not') return v === null ? r[k] != null : r[k] !== v;
        if (type === 'gte') return r[k] != null && r[k] >= v;
        if (type === 'lte') return r[k] != null && r[k] <= v;
        if (type === 'in') return v.includes(r[k]);
        return true;
      }));
    }
    async function exec() {
      if (failing.has(table)) return { data: null, error: { message: `simulated failure on ${table}` } };
      if (op === 'insert') {
        const row = { ...payload };
        if (table === 'duplicate_candidates') {
          if (row.activity_id_a >= row.activity_id_b) return { data: null, error: { message: 'duplicate_candidates_ordered' } };
          if (state.duplicate_candidates.some((r) => r.activity_id_a === row.activity_id_a && r.activity_id_b === row.activity_id_b)) {
            return { data: null, error: { message: 'duplicate_candidates_pair' } };
          }
          row.id = 'dc-' + nextDcId++; row.detection_count = row.detection_count ?? 1;
        }
        state[table].push(row);
        return { data: row, error: null };
      }
      if (op === 'update') {
        const rows = applyFilters(state[table]);
        for (const r of rows) Object.assign(r, payload);
        return { data: rows, error: null };
      }
      let rows = applyFilters(state[table]);
      if (table === 'activities' && typeof selectCols === 'string' && selectCols.includes('locations(')) {
        rows = rows.map((r) => ({ ...r, locations: state.locations.find((l) => l.id === r.location_id) || null }));
      }
      if (single) return { data: rows[0] || null, error: null };
      return { data: rows, error: null };
    }
    return api;
  }
  return { from: (t) => builder(t), _state: state, _failOn: (t) => failing.add(t) };
}

// --- fixtures: the Safari corpus, reshaped into activities+locations rows ---------------------------
const S = { lat: 32.0461112, lng: 34.8195887, address: 'רמת גן', city: 'רמת גן' };
function place(id, name, extra = {}) {
  return { id, locId: 'loc-' + id, name, status: 'approved', entity_type: PLACE_ENTITY_TYPE, venue_id: null, source_url: null, ...extra };
}
function seedSafari(extraRows = []) {
  const rows = [
    place('a-parent', 'ספארי רמת גן', { ...S, source_url: 'https://www.safari.co.il/', venue_id: 'v1' }),
    place('b-aggr', 'ספארי - חוויה מרתקת לכל המשפחה', { ...S, source_url: 'https://www.karamel.co.il/x.asp', venue_id: 'v1' }),
    place('d-morning', 'סיור ספארי על הבוקר', { ...S, entity_type: 'אירוע_קבוע', source_url: 'https://www.safari.co.il/', venue_id: 'v1' }),
    ...extraRows,
  ];
  const activities = rows.map((r) => ({ id: r.id, name: r.name, status: r.status, entity_type: r.entity_type, venue_id: r.venue_id, source_url: r.source_url, location_id: r.locId }));
  const locations = rows.map((r) => ({ id: r.locId, lat: r.lat, lng: r.lng, address: r.address, city: r.city }));
  return { activities, locations };
}

test('NEW ACTIVITY: an arriving aggregator copy is detected against the existing canonical Safari row', async () => {
  const { activities, locations } = seedSafari();
  const client = fakeSupabase({ activities, locations });
  const r = await fdd.detectFutureDuplicates(client, 'b-aggr', { reason: 'new-activity' });
  assert.equal(r.error, null);
  assert.equal(r.skippedReason, null);
  assert.equal(r.candidatesFound, 1);
  assert.equal(r.inserted, 1);
  assert.equal(client._state.duplicate_candidates.length, 1);
  const row = client._state.duplicate_candidates[0];
  assert.deepEqual([row.activity_id_a, row.activity_id_b], ['a-parent', 'b-aggr']);
  assert.equal(row.status, 'needs_review');
});

test('LEGITIMATE SIBLING: an arriving tour at the same venue produces no candidate against the parent', async () => {
  const { activities, locations } = seedSafari();
  const client = fakeSupabase({ activities, locations });
  const r = await fdd.detectFutureDuplicates(client, 'd-morning', { reason: 'new-activity' });
  assert.equal(r.error, null);
  assert.equal(r.candidatesFound, 0);
  assert.equal(client._state.duplicate_candidates.length, 0);
});

test('CROSS-SOURCE: independent publishers agreeing on a place are detected as arriving activities, not only in a full sweep', async () => {
  const L = { lat: 31.9, lng: 34.8, address: 'הדקל 5', city: 'עיר X' };
  const { activities, locations } = (() => {
    const rows = [
      { id: 'p1', locId: 'l1', name: 'פארק הפיראטים', status: 'approved', entity_type: PLACE_ENTITY_TYPE, venue_id: null, source_url: 'https://www.openstreetmap.org/way/77', ...L },
      { id: 'p2', locId: 'l2', name: 'פארק הפיראטים', status: 'approved', entity_type: PLACE_ENTITY_TYPE, venue_id: null, source_url: 'https://visit.example.muni.il/y', ...L },
    ];
    return {
      activities: rows.map((r) => ({ id: r.id, name: r.name, status: r.status, entity_type: r.entity_type, venue_id: r.venue_id, source_url: r.source_url, location_id: r.locId })),
      locations: rows.map((r) => ({ id: r.locId, lat: r.lat, lng: r.lng, address: r.address, city: r.city })),
    };
  })();
  const client = fakeSupabase({ activities, locations });
  const r = await fdd.detectFutureDuplicates(client, 'p2', { reason: 'new-activity' });
  assert.equal(r.candidatesFound, 1);
  assert.ok(client._state.duplicate_candidates[0].identity_evidence.some((e) => e.startsWith('independent_sources_agree')));
});

test('EVENT/OFFERING EXCLUSION: two offering-kind rows at one venue never enter the queue, even though the signal would call them a duplicate', async () => {
  const L = { lat: 32.08, lng: 34.78, address: null, city: null };
  const rows = [
    { id: 'o1', locId: 'lo1', name: 'הפנינג סוכות', status: 'approved', entity_type: 'אירוע', venue_id: null, source_url: 'https://muni.example/', ...L },
    { id: 'o2', locId: 'lo2', name: 'הפנינג סוכות', status: 'approved', entity_type: 'אירוע', venue_id: null, source_url: 'https://muni.example/', ...L },
  ];
  const activities = rows.map((r) => ({ id: r.id, name: r.name, status: r.status, entity_type: r.entity_type, venue_id: r.venue_id, source_url: r.source_url, location_id: r.locId }));
  const locations = rows.map((r) => ({ id: r.locId, lat: r.lat, lng: r.lng, address: r.address, city: r.city }));
  const client = fakeSupabase({ activities, locations });
  const r = await fdd.detectFutureDuplicates(client, 'o2', { reason: 'new-activity' });
  assert.equal(r.candidatesFound, 0);
  assert.equal(client._state.duplicate_candidates.length, 0);
});

test('ELIGIBILITY: a not-yet-approved arriving row is skipped, never compared', async () => {
  const { activities, locations } = seedSafari();
  activities.find((a) => a.id === 'b-aggr').status = 'needs_review';
  const client = fakeSupabase({ activities, locations });
  const r = await fdd.detectFutureDuplicates(client, 'b-aggr', { reason: 'new-activity' });
  assert.equal(r.skippedReason, 'status:needs_review');
  assert.equal(r.candidatesFound, 0);
  assert.equal(client._state.duplicate_candidates.length, 0);
});

test('ELIGIBILITY: a coordinate-less arriving row is skipped, never compared', async () => {
  const { activities, locations } = seedSafari();
  const loc = locations.find((l) => l.id === 'loc-b-aggr');
  loc.lat = null; loc.lng = null;
  const client = fakeSupabase({ activities, locations });
  const r = await fdd.detectFutureDuplicates(client, 'b-aggr', { reason: 'new-activity' });
  assert.equal(r.skippedReason, 'no_coordinates');
});

test('RESOLVED-PAIR REGRESSION: a previously approved_distinct pair is not reopened when its side is re-detected', async () => {
  const { activities, locations } = seedSafari();
  const duplicate_candidates = [{ activity_id_a: 'a-parent', activity_id_b: 'b-aggr', status: 'approved_distinct',
    keeper_activity_id: null, evidence_fingerprint: 'STALE', detection_count: 1, resolution_note: 'human said distinct' }];
  const client = fakeSupabase({ activities, locations, duplicate_candidates });
  const r = await fdd.detectFutureDuplicates(client, 'b-aggr', { reason: 'material-update' });
  assert.equal(r.inserted, 0);
  assert.equal(r.refreshed, 0);
  const row = client._state.duplicate_candidates[0];
  assert.equal(row.status, 'approved_distinct');
  assert.equal(row.resolution_note, 'human said distinct');
  assert.ok(row.evidence_changed_at, 'evidence fingerprint moved (STALE -> real), so evidence_changed_at is stamped');
});

test('RESOLVED-PAIR REGRESSION: A/B resolved does not block A/C from being detected later', async () => {
  const { activities, locations } = seedSafari([
    place('f-aggr2', 'ספארי רמת גן - הכרטיס המשפחתי', { ...S, source_url: 'https://www.tiuli.example/', venue_id: 'v1' }),
  ]);
  const duplicate_candidates = [{ activity_id_a: 'a-parent', activity_id_b: 'b-aggr', status: 'approved_distinct', evidence_fingerprint: 'x', detection_count: 1 }];
  const client = fakeSupabase({ activities, locations, duplicate_candidates });
  const r = await fdd.detectFutureDuplicates(client, 'f-aggr2', { reason: 'new-activity' });
  // f-aggr2 independently corroborates against BOTH existing rows (cross-source name agreement) -
  // the point of this test is that neither new pair is blocked by A/B's resolved status.
  assert.equal(r.candidatesFound, 2);
  assert.equal(r.inserted, 2);
  const newPairs = client._state.duplicate_candidates
    .filter((c) => c.activity_id_a === 'f-aggr2' || c.activity_id_b === 'f-aggr2')
    .map((c) => [c.activity_id_a, c.activity_id_b].sort().join('|'));
  assert.ok(newPairs.includes(['a-parent', 'f-aggr2'].sort().join('|')), 'A/C is created even though A/B is resolved');
  assert.ok(newPairs.includes(['b-aggr', 'f-aggr2'].sort().join('|')), 'B/C is created too - a resolved A/B never blocks either side\'s other pairs');
  assert.equal(client._state.duplicate_candidates.find((c) => c.activity_id_a === 'a-parent' && c.activity_id_b === 'b-aggr').status, 'approved_distinct', 'A/B itself remains untouched');
});

test('IDEMPOTENCY: detecting the same arrival twice inserts once, then refreshes', async () => {
  const { activities, locations } = seedSafari();
  const client = fakeSupabase({ activities, locations });
  const r1 = await fdd.detectFutureDuplicates(client, 'b-aggr', { reason: 'new-activity' });
  const r2 = await fdd.detectFutureDuplicates(client, 'b-aggr', { reason: 'new-activity' });
  assert.deepEqual([r1.inserted, r1.refreshed, r2.inserted, r2.refreshed], [1, 0, 0, 1]);
  assert.equal(client._state.duplicate_candidates.length, 1);
  assert.equal(client._state.duplicate_candidates[0].detection_count, 2);
});

test('BUCKET-BOUNDARY: a duplicate straddling a cell edge is still found (padding covers the worst case)', async () => {
  // these two latitudes land in ADJACENT floor(lat/CELL_DEG) cells (verified below) while staying
  // ~22m apart - well within the 60m signal radius.
  const CELL = 0.001;
  const lat1 = 32.0499, lat2 = 32.0501;
  assert.equal(Math.floor(lat1 / CELL) + 1, Math.floor(lat2 / CELL), 'test setup: the two latitudes must land in adjacent cells');
  const L1 = { lat: lat1, lng: 34.8, address: 'כתובת א', city: 'עיר' };
  const L2 = { lat: lat2, lng: 34.8, address: 'כתובת א', city: 'עיר' };
  const rows = [
    { id: 'b1', locId: 'lb1', name: 'גן שעשועים הגבול', status: 'approved', entity_type: PLACE_ENTITY_TYPE, venue_id: null, source_url: 'https://maps.google.com/a', ...L1 },
    { id: 'b2', locId: 'lb2', name: 'גן שעשועים הגבול', status: 'approved', entity_type: PLACE_ENTITY_TYPE, venue_id: null, source_url: 'https://maps.google.com/a', ...L2 },
  ];
  const activities = rows.map((r) => ({ id: r.id, name: r.name, status: r.status, entity_type: r.entity_type, venue_id: r.venue_id, source_url: r.source_url, location_id: r.locId }));
  const locations = rows.map((r) => ({ id: r.locId, lat: r.lat, lng: r.lng, address: r.address, city: r.city }));
  const client = fakeSupabase({ activities, locations });
  const r = await fdd.detectFutureDuplicates(client, 'b2', { reason: 'new-activity' });
  assert.equal(r.candidatesFound, 1, 'the boundary-straddling pair must still be found');
});

test('FAILURE ISOLATION: a detector failure returns an error result and never throws', async () => {
  const { activities, locations } = seedSafari();
  const client = fakeSupabase({ activities, locations });
  client._failOn('locations');
  await assert.doesNotReject(async () => {
    const r = await fdd.detectFutureDuplicates(client, 'b-aggr', { reason: 'new-activity' });
    assert.ok(r.error, 'the failure is captured in the result, not thrown');
    assert.equal(r.inserted, 0);
  });
});

test('FAILURE ISOLATION: an unknown activity id is a clean no-op, not a throw', async () => {
  const client = fakeSupabase({});
  const r = await fdd.detectFutureDuplicates(client, 'nope', { reason: 'new-activity' });
  assert.equal(r.skippedReason, 'activity_not_found');
});

// --- MATERIAL-CHANGE GATE (server.js's applyIncomingUpdate uses this to decide whether to call
// detectFutureDuplicates at all - "do not rerun detection on every trivial update") ------------------
test('MATERIAL CHANGE GATE: name/location/city/address/entity_type trigger re-evaluation', () => {
  for (const key of ['name', 'location_name', 'city', 'address', 'entity_type']) {
    assert.equal(fdd.isMaterialIdentityChange({ [key]: { before: 'a', after: 'b' } }), true, key);
  }
});

test('MATERIAL CHANGE GATE: price/age/description/booking/occurrences/schedule are trivial - no re-evaluation', () => {
  for (const key of ['price_amount', 'price_type', 'min_age', 'max_age', 'booking_requirement', 'description', 'occurrences', 'schedule_type', 'start_time', 'end_time', 'event_key', 'has_image']) {
    assert.equal(fdd.isMaterialIdentityChange({ [key]: { before: null, after: 'x' } }), false, key);
  }
  assert.equal(fdd.isMaterialIdentityChange({}), false);
  assert.equal(fdd.isMaterialIdentityChange(null), false);
});

test('MATERIAL CHANGE GATE: a mixed diff with one material key still triggers', () => {
  assert.equal(fdd.isMaterialIdentityChange({ price_amount: { before: 10, after: 20 }, address: { before: null, after: 'הרצל 1' } }), true);
});

// --- server.js wiring: the route/save functions call detectFutureDuplicates - proven the way this
// repo already proves cross-runtime constant parity (reading source as text), since server.js is a
// long-running Express app with no test harness of its own for routes -------------------------------
test('WIRING: saveNewActivity calls detectFutureDuplicates after the activity commits', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/import-tool/server.js'), 'utf8');
  const fnBody = src.slice(src.indexOf('async function saveNewActivity'), src.indexOf('async function saveNewActivity') + 16000);
  const returnIdx = fnBody.indexOf('return { activityId: savedActivity.id, archived };');
  const callIdx = fnBody.indexOf('detectFutureDuplicates(client, savedActivity.id');
  assert.ok(callIdx > 0, 'saveNewActivity must call detectFutureDuplicates');
  assert.ok(callIdx < returnIdx, 'detection must run before the function returns, i.e. after the insert already committed');
});

test('WIRING: applyIncomingUpdate gates detectFutureDuplicates behind isMaterialIdentityChange', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/import-tool/server.js'), 'utf8');
  const start = src.indexOf('async function applyIncomingUpdate');
  const fnBody = src.slice(start, start + 16000);
  assert.match(fnBody, /isMaterialIdentityChange\(diff\)[\s\S]{0,80}detectFutureDuplicates/);
});

test('DRIFT: the Deno live-detection port shares this module\'s key constants', () => {
  const deno = fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/duplicateCandidates.ts'), 'utf8');
  assert.match(deno, /export const NEIGHBOURHOOD_PAD_DEG = CELL_DEG \* 2;/);
  assert.match(deno, /export const CELL_DEG = 0\.001;/);
  assert.match(deno, /export const ELIGIBLE_STATUS = 'approved';/);
  const { GENERATOR_VERSION } = require('../lib/duplicateCandidates');
  assert.match(deno, new RegExp(`export const GENERATOR_VERSION = '${GENERATOR_VERSION}';`));
});
