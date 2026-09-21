// TuRu - duplicate-candidate queue: Node signal port, drift corpus, bucketed generator, single-row
// detection, idempotent upsert policy, and the recurrence simulation (2026-09-21).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { coordinateDuplicateSignal, PLACE_ENTITY_TYPE, COMPARISON_ONLY_STOPWORDS } = require('../lib/duplicateSignal');
const gen = require('../lib/duplicateCandidates');

const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/duplicateSignalCorpus.json'), 'utf8'));
const kindsOf = (s) => s.identityEvidence.map((e) => e.split(':')[0]);

// --- DRIFT: the Node port must satisfy the shared corpus (Deno runs the same file) ----------------
test('DRIFT CORPUS: every shared fixture case passes on the Node port', () => {
  for (const c of corpus.cases) {
    const s = coordinateDuplicateSignal(c.a, c.b);
    assert.equal(s.isCandidate, c.expect.isCandidate, c.id + ' isCandidate');
    assert.equal(s.relationship, c.expect.relationship, c.id + ' relationship');
    assert.deepEqual([...new Set(kindsOf(s))].sort(), [...c.expect.identityKinds].sort(), c.id + ' identity kinds');
  }
  assert.ok(corpus.cases.length >= 14, 'corpus must keep its full coverage');
});

test('DRIFT: constants the port must share with the Deno original', () => {
  const deno = fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/placesDiscovery.ts'), 'utf8');
  assert.match(deno, new RegExp(`export const PLACE_ENTITY_TYPE = '${PLACE_ENTITY_TYPE}'`));
  const m = deno.match(/const COMPARISON_ONLY_STOPWORDS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m);
  const denoWords = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]).sort();
  assert.deepEqual([...COMPARISON_ONLY_STOPWORDS].sort(), denoWords, 'stopword sets diverged');
  const ext = fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/extraction.ts'), 'utf8');
  assert.ok(ext.includes(`'${PLACE_ENTITY_TYPE}'`), 'place entity type must remain a declared ENTITY_TYPE_VALUES member');
});

// --- generator fixtures -----------------------------------------------------------------------------
const P = PLACE_ENTITY_TYPE, E = 'אירוע_קבוע';
const S = { lat: 32.0461112, lng: 34.8195887, address: 'רמת גן' };
const row = (id, name, extra) => ({ id, name, status: 'approved', entity_type: P, venue_id: null, source_url: null, lat: null, lng: null, address: null, ...extra });
const safari = () => [
  row('a-parent', 'ספארי רמת גן', { ...S, source_url: 'https://www.safari.co.il/', venue_id: 'v1' }),
  row('b-aggr', 'ספארי - חוויה מרתקת לכל המשפחה', { ...S, source_url: 'https://www.karamel.co.il/x.asp', venue_id: 'v1' }),
  row('c-midnight', 'ספארי חצות', { ...S, entity_type: E, source_url: 'https://www.safari.co.il/', venue_id: 'v1' }),
  row('d-morning', 'סיור ספארי על הבוקר', { ...S, entity_type: E, source_url: 'https://www.safari.co.il/', venue_id: 'v1' }),
  row('e-bday', 'יום הולדת בספארי', { ...S, entity_type: E, source_url: 'https://www.safari.co.il/', venue_id: 'v1' }),
];

test('SWEEP (Safari corpus): exactly ONE candidate, the cross-source destination pair', () => {
  const { candidates, stats } = gen.sweep(safari());
  assert.equal(candidates.length, 1);
  assert.deepEqual([candidates[0].activity_id_a, candidates[0].activity_id_b], ['a-parent', 'b-aggr']);
  assert.ok(candidates[0].identity_evidence.some((e) => e.startsWith('independent_sources_agree')));
  assert.equal(stats.indexed, 5);
  assert.equal(stats.pairComparisons, 10, '5 rows in one neighbourhood = 10 unordered pairs');
});

test('SWEEP: same-source true duplicate is still generated (Midbarium)', () => {
  const M = { lat: 30.6119687, lng: 34.8012169 };
  const rows = [
    row('m1', 'מדבריום', { ...M, source_url: 'https://midbarium.co.il/news/x' }),
    row('m2', 'מדבריום - פארק החיות', { ...M, source_url: 'https://midbarium.co.il/' }),
    row('m3', 'חאן - אזור בעלי חיים', { ...M, source_url: 'https://midbarium.co.il/' }),
    row('m4', 'נווה מדבר - אזור מעיינות ובעלי חיים', { ...M, source_url: 'https://midbarium.co.il/' }),
  ];
  const { candidates } = gen.sweep(rows);
  assert.equal(candidates.length, 1);
  assert.deepEqual([candidates[0].activity_id_a, candidates[0].activity_id_b], ['m1', 'm2']);
});

// --- EVENT/EVENT ROUTING (2026-09-21): the destination queue is not the occurrence-reconciliation
// surface. Excluded here at the GENERATOR layer only - the underlying signal keeps the capability.
test('ROUTING: two occurrences of the SAME event do not enter the 0104 queue, even though the signal calls them a duplicate', () => {
  const { coordinateDuplicateSignal } = require('../lib/duplicateSignal');
  const occ = (id) => row(id, 'הפנינג סוכות', { lat: 32.08, lng: 34.78, entity_type: 'אירוע', source_url: 'https://muni.example/' });
  const [o1, o2] = [occ('occ1'), occ('occ2')];
  // the semantic signal is untouched and still says duplicate - proving the capability is preserved
  const raw = coordinateDuplicateSignal(gen.toSide(o1), gen.toSide(o2));
  assert.equal(raw.isCandidate, true, 'the raw signal must still recognise this as a duplicate (future occurrence reconciliation)');
  // but the GENERATOR must not carry it into the destination-duplicate queue
  const { candidates, stats } = gen.sweep([o1, o2]);
  assert.equal(candidates.length, 0);
  assert.equal(stats.excludedOfferingOfferingPairs, 1);
});

test('ROUTING: two DISTINCT events at one venue are excluded from the queue for the ordinary reason (no identity), not just the routing rule', () => {
  const rows = [
    row('e1', 'הפנינג סוכות', { lat: 32.08, lng: 34.78, entity_type: 'אירוע', source_url: 'https://muni.example/' }),
    row('e2', 'פסטיבל חנוכה', { lat: 32.08, lng: 34.78, entity_type: 'אירוע', source_url: 'https://muni.example/' }),
  ];
  const { candidates, stats } = gen.sweep(rows);
  assert.equal(candidates.length, 0);
  assert.equal(stats.excludedOfferingOfferingPairs, 0, 'no identity evidence in the first place - the routing rule never had to act');
});

test('ROUTING: a PLACE vs a PLACE is unaffected by the offering-offering rule (it is not an offering-offering pair)', () => {
  assert.equal(gen.isOfferingOfferingPair({ entity_type: 'מקום_קבוע' }, { entity_type: 'מקום_קבוע' }), false);
  assert.equal(gen.isOfferingOfferingPair({ entity_type: 'מקום_קבוע' }, { entity_type: 'אירוע' }), false, 'place+offering is the hard gate\'s job, not this rule\'s');
  assert.equal(gen.isOfferingOfferingPair({ entity_type: 'אירוע_קבוע' }, { entity_type: 'פעילות' }), true, 'two non-place kinds, regardless of which specific offering type');
});

test('SWEEP: unrelated businesses at one address and place-vs-programme are never generated', () => {
  const rows = [
    row('x1', 'מוזיאון הילדים', { lat: 32.08, lng: 34.78, address: 'הרצל 1', source_url: 'https://museum.example/' }),
    row('x2', 'קפה שכונתי', { lat: 32.08, lng: 34.78, address: 'הרצל 1', source_url: 'https://cafe.example/' }),
    row('x3', 'מוזיאון הילדים - סדנת חנוכה', { lat: 32.08, lng: 34.78, entity_type: E, source_url: 'https://museum.example/' }),
  ];
  assert.equal(gen.sweep(rows).candidates.length, 0);
});

test('BUCKET BOUNDARY: two rows 20m apart on opposite sides of a cell edge ARE compared', () => {
  // cell edge at lat = 32.001000; 32.000990 and 32.001010 fall in different cells, ~2.2m apart
  const rows = [
    row('edge-a', 'מוזיאון המדע', { lat: 32.000990, lng: 34.780000, source_url: 'https://a.example/' }),
    row('edge-b', 'מוזיאון המדע', { lat: 32.001010, lng: 34.780000, source_url: 'https://b.example/' }),
  ];
  assert.notEqual(gen.cellKey(rows[0].lat, rows[0].lng), gen.cellKey(rows[1].lat, rows[1].lng), 'fixture must straddle a cell edge');
  const { candidates } = gen.sweep(rows);
  assert.equal(candidates.length, 1, 'neighbour-cell sweep must not have a blind spot at the edge');
  // and the diagonal corner case: both lat and lng edges crossed
  const diag = [
    row('diag-a', 'מוזיאון המדע', { lat: 32.000990, lng: 34.779990, source_url: 'https://a.example/' }),
    row('diag-b', 'מוזיאון המדע', { lat: 32.001010, lng: 34.780010, source_url: 'https://b.example/' }),
  ];
  assert.equal(gen.sweep(diag).candidates.length, 1);
});

test('BUCKET BOUNDARY: rows beyond the radius are NOT compared just because they share a cell', () => {
  // ~100m apart inside one ~111m cell: same cell, but outside the 60m radius
  const rows = [
    row('far-a', 'מוזיאון המדע', { lat: 32.000100, lng: 34.780000, source_url: 'https://a.example/' }),
    row('far-b', 'מוזיאון המדע', { lat: 32.000990, lng: 34.780000, source_url: 'https://b.example/' }),
  ];
  assert.equal(gen.cellKey(rows[0].lat, rows[0].lng), gen.cellKey(rows[1].lat, rows[1].lng));
  assert.equal(gen.sweep(rows).candidates.length, 0);
});

test('PAIR IDENTITY: each pair emitted exactly once, canonically ordered, regardless of input order', () => {
  const a = gen.sweep(safari()).candidates;
  const b = gen.sweep(safari().reverse()).candidates;
  assert.deepEqual(a.map((c) => [c.activity_id_a, c.activity_id_b]), b.map((c) => [c.activity_id_a, c.activity_id_b]));
  assert.ok(a.every((c) => c.activity_id_a < c.activity_id_b));
  assert.equal(gen.pairKey('z', 'a'), gen.pairKey('a', 'z'));
});

test('ELIGIBILITY: archived rows do not generate NEW pairs; rows without coordinates are skipped', () => {
  const rows = safari();
  rows[1].status = 'archived'; // the aggregator copy is archived -> its pair must not be proposed
  const { candidates, stats } = gen.sweep(rows);
  assert.equal(candidates.length, 0);
  assert.equal(stats.skippedIneligible, 1);
  const noCoords = [row('nc', 'x', {}), row('nc2', 'x', {})];
  assert.equal(gen.sweep(noCoords).stats.skippedNoCoords, 2);
});

test('BOUND: a neighbourhood over the cap is skipped and reported, never scanned', () => {
  const rows = [];
  for (let i = 0; i < gen.MAX_NEIGHBOURHOOD_ROWS + 5; i++) rows.push(row('big-' + i, 'שם ' + i, { lat: 32.08, lng: 34.78, source_url: 'https://x.example/' }));
  const { candidates, skippedNeighbourhoods } = gen.sweep(rows);
  assert.equal(candidates.length, 0);
  assert.equal(skippedNeighbourhoods.length, rows.length);
});

test('SINGLE-ROW DETECTION: a newly arriving aggregator copy yields a candidate, never a suppression', () => {
  const existing = safari().filter((r) => r.id !== 'b-aggr');
  const index = gen.buildIndex(existing);
  const arriving = safari().find((r) => r.id === 'b-aggr');
  const { candidates } = gen.candidatesForActivity(arriving, index);
  assert.equal(candidates.length, 1);
  assert.deepEqual([candidates[0].activity_id_a, candidates[0].activity_id_b], ['a-parent', 'b-aggr']);
  assert.ok(!('suppress' in candidates[0]) && !('status' in candidates[0]), 'output is a queue row, not a verdict on creation');
});

test('SINGLE-ROW DETECTION: a newly arriving legitimate tour yields NO candidate against parent or siblings', () => {
  const existing = safari().filter((r) => r.id !== 'd-morning');
  const index = gen.buildIndex(existing);
  const arriving = safari().find((r) => r.id === 'd-morning');
  assert.equal(gen.candidatesForActivity(arriving, index).candidates.length, 0);
});

// --- upsert / rediscovery policy against an in-memory fake of the 0104 table ----------------------
function fakeClient(seed = []) {
  const table = seed.map((r) => ({ ...r }));
  let nextId = 1;
  const api = {
    table,
    from(name) {
      assert.equal(name, 'duplicate_candidates', 'the generator may only write to its own queue');
      const q = { _f: {}, _op: null, _payload: null, _single: false };
      q.select = () => q; q.maybeSingle = () => { q._single = true; return exec(); };
      q.eq = (k, v) => { q._f[k] = v; return q; };
      q.insert = (p) => { q._op = 'insert'; q._payload = p; return exec(); };
      q.update = (p) => { q._op = 'update'; q._payload = p; return q; };
      q.then = (res) => res(exec());
      function exec() {
        const match = (r) => Object.entries(q._f).every(([k, v]) => r[k] === v);
        if (q._op === 'insert') {
          // emulate the DB constraints of 0104
          const p = q._payload;
          if (p.activity_id_a >= p.activity_id_b) return { data: null, error: { message: 'duplicate_candidates_ordered' } };
          if (table.some((r) => r.activity_id_a === p.activity_id_a && r.activity_id_b === p.activity_id_b)) return { data: null, error: { message: 'duplicate_candidates_pair' } };
          table.push({ id: 'dc-' + nextId++, detection_count: 1, ...p }); return { data: null, error: null };
        }
        if (q._op === 'update') { for (const r of table) if (match(r)) Object.assign(r, q._payload); return { data: null, error: null }; }
        const rows = table.filter(match);
        return { data: q._single ? (rows[0] || null) : rows, error: null };
      }
      return q;
    },
  };
  return api;
}

test('UPSERT: dry run by default - writes nothing, reports what it would do', async () => {
  const c = fakeClient();
  const r = await gen.upsertCandidates(c, gen.sweep(safari()).candidates);
  assert.equal(r.dryRun, true); assert.equal(r.wouldInsertOrRefresh, 1); assert.equal(c.table.length, 0);
});

test('UPSERT: repeated runs are idempotent - one pair, one row, detection_count grows, status untouched', async () => {
  const c = fakeClient();
  const cands = gen.sweep(safari()).candidates;
  const r1 = await gen.upsertCandidates(c, cands, { apply: true });
  const r2 = await gen.upsertCandidates(c, cands, { apply: true });
  assert.deepEqual([r1.inserted, r2.inserted, r2.refreshed], [1, 0, 1]);
  assert.equal(c.table.length, 1);
  assert.equal(c.table[0].status, 'needs_review');
  assert.equal(c.table[0].detection_count, 2);
});

test('UPSERT: the reversed pair cannot create a second row (DB ordering constraint is honoured)', async () => {
  const c = fakeClient();
  const cands = gen.sweep(safari()).candidates;
  await gen.upsertCandidates(c, cands, { apply: true });
  // a caller that ignored canonical ordering would be rejected by the fake DB exactly as by 0104
  const reversed = { ...cands[0], activity_id_a: cands[0].activity_id_b, activity_id_b: cands[0].activity_id_a };
  await assert.rejects(gen.upsertCandidates(c, [reversed], { apply: true }), /duplicate_candidates_ordered/);
  assert.equal(c.table.length, 1);
});

test('UPSERT: a resolved pair is NOT reopened on ordinary rediscovery; verdict and keeper are untouched', async () => {
  const cands = gen.sweep(safari()).candidates;
  const c = fakeClient([{ id: 'dc-x', activity_id_a: 'a-parent', activity_id_b: 'b-aggr', status: 'approved_distinct',
    evidence_fingerprint: cands[0].evidence_fingerprint, detection_count: 3, resolved_at: 't0', resolution_note: 'human said no' }]);
  const r = await gen.upsertCandidates(c, cands, { apply: true });
  assert.deepEqual([r.inserted, r.refreshed, r.seenResolved, r.evidenceChanged], [0, 0, 1, 0]);
  assert.equal(c.table[0].status, 'approved_distinct');
  assert.equal(c.table[0].resolution_note, 'human said no');
  assert.equal(c.table[0].detection_count, 4);
  assert.equal(c.table[0].evidence_changed_at, undefined);
});

test('UPSERT: a resolved pair whose evidence MOVED gets evidence_changed_at stamped, still not reopened', async () => {
  const cands = gen.sweep(safari()).candidates;
  const c = fakeClient([{ id: 'dc-x', activity_id_a: 'a-parent', activity_id_b: 'b-aggr', status: 'approved_distinct', evidence_fingerprint: 'OLD', detection_count: 1 }]);
  const r = await gen.upsertCandidates(c, cands, { apply: true });
  assert.equal(r.evidenceChanged, 1);
  assert.equal(c.table[0].status, 'approved_distinct');
  assert.ok(c.table[0].evidence_changed_at);
});

test('REVIEW: "A is not a duplicate of B" does not block A/C - one activity, many pairs', async () => {
  const rows = safari();
  rows.push(row('f-second-aggr', 'ספארי רמת גן - הספארי', { ...S, source_url: 'https://www.tiuli.example/', venue_id: 'v1' }));
  const cands = gen.sweep(rows).candidates;
  const pairs = cands.map((c) => `${c.activity_id_a}|${c.activity_id_b}`).sort();
  assert.ok(pairs.includes('a-parent|b-aggr') && pairs.includes('a-parent|f-second-aggr'), 'the parent must be in two independent pairs');
  const c = fakeClient([{ id: 'dc-1', activity_id_a: 'a-parent', activity_id_b: 'b-aggr', status: 'approved_distinct', evidence_fingerprint: 'x', detection_count: 1 }]);
  const r = await gen.upsertCandidates(c, cands, { apply: true });
  assert.ok(r.inserted >= 1, 'A/C (and any other new pair) is inserted even though A/B was judged distinct');
  assert.equal(c.table.find((t) => t.activity_id_b === 'b-aggr').status, 'approved_distinct');
});

test('EXPLAINABILITY: every candidate carries both axes as structured evidence, never only a score', () => {
  const { candidates } = gen.sweep(safari());
  const c = candidates[0];
  assert.ok(Array.isArray(c.venue_relatedness) && c.venue_relatedness.includes('coordinates_within_radius'));
  assert.ok(c.venue_relatedness.includes('same_venue') && c.venue_relatedness.includes('same_address'));
  assert.ok(Array.isArray(c.identity_evidence) && c.identity_evidence.length > 0);
  assert.equal(typeof c.evidence_fingerprint, 'string');
  assert.ok(!('score' in c), 'a bare score is not persisted');
});

// --- RECURRENCE: a brand-new venue ecosystem arriving tomorrow ------------------------------------
test('RECURRENCE (new venue): destination + 5 programmes + birthday page + aggregator copy', () => {
  const L = { lat: 31.9, lng: 34.8, address: 'הדקל 5' };
  const own = 'https://newvenue.example/';
  const rows = [
    row('dest', 'פארק החי הצפוני', { ...L, source_url: own, venue_id: 'vn' }),
    ...['סיור בוקר בפארק החי', 'סיור לילה בפארק החי', 'האכלת החיות', 'סדנת חוקרים צעירים', 'מפגש עם המטפלים'].map((n, i) =>
      row('prog' + i, n, { ...L, entity_type: E, source_url: own, venue_id: 'vn' })),
    row('bday', 'ימי הולדת בפארק החי', { ...L, entity_type: E, source_url: own, venue_id: 'vn' }),
    row('aggr', 'פארק החי הצפוני - חוויה לכל המשפחה', { ...L, source_url: 'https://aggregator.example/list', venue_id: 'vn' }),
  ];
  const { candidates } = gen.sweep(rows);
  const pairs = candidates.map((c) => [c.activity_id_a, c.activity_id_b].sort().join('|'));
  assert.deepEqual(pairs, ['aggr|dest'], 'ONLY the aggregator destination copy is surfaced');
  // the birthday page and every programme remain untouched by this layer: eligibility is not its job
  assert.ok(!pairs.some((p) => p.includes('bday')), 'birthday page is not a duplicate merely because it belongs to the venue');
  assert.ok(!pairs.some((p) => p.includes('prog')), 'sibling programmes are not duplicates');
});
