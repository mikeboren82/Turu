// Run: node --test tests/   (from tools/import-tool). Generic venue attestation (R3, 2026-09-25): a venue_aliases
// row whose key is a generic label ("ספרייה") is a HUMAN attestation that the label means that venue in its
// city. No automated / derived alias writer may create one: the venue learner (propose-venues, the Cleaner's
// venue clusters, escalate-venue's created venue), a venue merge carrying the loser's name/aliases, a manifest
// re-seed. Explicit admin alias entry stays possible. Every generic spelling comes from the shared resolver table.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isLearnableLabel, createVenueWithAlias, withoutGenericAliases } = require('../venueLearning');
const { normalizeVenueAlias, genericVenueType, GENERIC_VENUE_LABEL_TYPES, resolveVenue } = require('../venueNaming');

const table = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'supabase', 'functions', '_shared', 'venues.cases.json'), 'utf8'));
// every spelling the resolver treats as generic: the map keys, their article forms, and the shared classify vectors
const GENERIC_SPELLINGS = [...new Set([
  ...GENERIC_VENUE_LABEL_TYPES.keys(),
  ...[...GENERIC_VENUE_LABEL_TYPES.keys()].map((k) => 'ה' + k),
  ...table.classify.filter((k) => k.expect).map((k) => k.label),
])];

test('every generic spelling the resolver recognises is generic (sanity of the probe list)', () => {
  assert.ok(GENERIC_SPELLINGS.length >= 12);
  for (const l of GENERIC_SPELLINGS) assert.equal(genericVenueType(l), 'library', l);
});

test('LEARNER: isLearnableLabel says NO to every generic spelling; specific library names stay learnable', () => {
  for (const l of GENERIC_SPELLINGS) assert.equal(isLearnableLabel(l), false, l);
  for (const l of ['ספריית פבזנר', 'ספריית הילדים והנוער כפר סבא', 'בית אריאלה', 'ספריית רעות', 'הספרייה העירונית רמת השרון']) assert.equal(isLearnableLabel(l), true, l);
});

// records every table touched; any write would show up as a call
function recordingClient() {
  const calls = [];
  const q = (table) => ({ select() { calls.push(['select', table]); return this; }, eq() { return this; }, in() { return this; }, is() { return this; },
    insert() { calls.push(['insert', table]); return this; }, upsert() { calls.push(['upsert', table]); return Promise.resolve({ error: null }); },
    single() { return Promise.resolve({ data: null, error: null }); }, then(r) { return Promise.resolve({ data: [], error: null }).then(r); } });
  return { calls, from(t) { return q(t); } };
}

test('LEARNER: createVenueWithAlias refuses every generic spelling before touching the DB (no venue, no alias)', async () => {
  for (const l of GENERIC_SPELLINGS) {
    const c = recordingClient();
    const r = await createVenueWithAlias(c, { label: l, city: 'רמת השרון', type: 'library', lat: 32.14, lng: 34.84 });
    assert.ok(r.error && !r.venue, l);
    assert.deepEqual(c.calls, [], l);
  }
});

test('DERIVED WRITERS: withoutGenericAliases drops every generic spelling, keeps specific aliases untouched', () => {
  const rows = [...GENERIC_SPELLINGS, 'ספריית רמת השרון', 'הספרייה העירונית רמת השרון', 'ספרייה עירונית קרית אתא']
    .map((a) => ({ alias: a, alias_normalized: normalizeVenueAlias(a), venue_id: 'v' }));
  const { rows: kept, dropped } = withoutGenericAliases(rows);
  assert.deepEqual(kept.map((r) => r.alias), ['ספריית רמת השרון', 'הספרייה העירונית רמת השרון', 'ספרייה עירונית קרית אתא']);
  assert.equal(dropped.length, GENERIC_SPELLINGS.length);
  // a row whose stored key is generic even though the display alias is odd is still dropped
  assert.equal(withoutGenericAliases([{ alias: 'x', alias_normalized: 'ספרייה' }]).rows.length, 0);
});

test('MANIFEST RE-SEED: the Ramat HaSharon manifest entry can no longer re-create its generic attestation', () => {
  const manifest = require('../source-manifest.json');
  for (const v of manifest.venues) {
    const { rows } = withoutGenericAliases([v.name_he, ...(v.aliases || [])].map((a) => ({ alias: a, alias_normalized: normalizeVenueAlias(a) })));
    assert.equal(rows.some((r) => genericVenueType(r.alias_normalized)), false, v.name_he);
  }
  const rh = manifest.venues.find((v) => v.key === 'ramat_hasharon_library');
  assert.ok(rh && rh.aliases.some((a) => genericVenueType(a)), 'fixture: the manifest still lists the generic RH aliases (data decision, not repaired here)');
});

// MONOTONICITY D through the actual merge row derivation (server.js /api/venues/merge): two unattested
// library venues, the loser NAMED generically ("הספרייה העירונית") - its name must not become the keeper's
// attestation. Without the guard the keeper would resolve; with it the city stays unresolved.
function memClient(world) {
  const byId = new Map(world.venues.map((v) => [v.id, v]));
  return { from(t) { const f = []; const q = { select() { return q; }, eq(c, v) { f.push((r) => r[c] === v); return q; }, in(c, vs) { f.push((r) => vs.includes(r[c])); return q; }, is(c, v) { f.push((r) => (r[c] ?? null) === v); return q; },
    then(res, rej) { const data = t === 'venue_aliases' ? world.aliases.filter((a) => f.every((x) => x(a))).map((a) => ({ alias_normalized: a.alias_normalized, venue: byId.get(a.venue_id) })).filter((r) => r.venue) : t === 'venues' ? world.venues.filter((v) => f.every((x) => x(v))) : []; return Promise.resolve({ data, error: null }).then(res, rej); } }; return q; } };
}
test('MERGE: merging a generically-NAMED loser never manufactures a generic resolution for the keeper', async () => {
  const loser = { id: 'nz_a', name_he: 'הספרייה העירונית', city: 'נס ציונה', venue_type: 'library', is_active: true, merged_into: null };
  const keeper = { id: 'nz_b', name_he: 'ספריית נס ציונה', city: 'נס ציונה', venue_type: 'library', is_active: true, merged_into: null };
  const loserAliases = [];
  const derived = [...loserAliases, { alias: loser.name_he, alias_normalized: normalizeVenueAlias(loser.name_he) }];
  const merged = (carried) => ({ venues: [{ ...loser, is_active: false, merged_into: keeper.id }, keeper], aliases: [{ alias_normalized: 'ספריית נס ציונה', venue_id: 'nz_b' }, ...carried.map((a) => ({ alias_normalized: a.alias_normalized, venue_id: keeper.id }))] });
  const ask = (world) => resolveVenue(memClient(world), { locationName: 'ספרייה', city: 'נס ציונה' });
  assert.equal(await ask({ venues: [loser, keeper], aliases: [{ alias_normalized: 'ספריית נס ציונה', venue_id: 'nz_b' }] }), null); // before
  assert.equal((await ask(merged(derived)))?.id, 'nz_b', 'without the guard the merge WOULD manufacture an attestation');
  const { rows, dropped } = withoutGenericAliases(derived);
  assert.deepEqual(dropped.map((r) => r.alias), ['הספרייה העירונית']);
  assert.equal(await ask(merged(rows)), null); // after, with the guard
});

test('merge / seed code paths actually use the guard; the explicit admin alias endpoint does not', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const merge = server.slice(server.indexOf("app.post('/api/venues/merge'"), server.indexOf("app.post('/api/venues/merge'") + 2500);
  assert.match(merge, /withoutGenericAliases\(/);
  const aliasEp = server.slice(server.indexOf("app.post('/api/venues/:id/alias'"), server.indexOf("app.post('/api/venues/merge'"));
  assert.doesNotMatch(aliasEp, /withoutGenericAliases|isLearnableLabel|genericVenueType/); // explicit human attestation stays possible
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'seed-venues-and-sources.js'), 'utf8'), /withoutGenericAliases\(/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'propose-venues.js'), 'utf8'), /genericVenueType\(label\)/);
  assert.ok(normalizeVenueAlias('ספרייה')); // the admin endpoint's only validation (non-empty normalized alias) accepts it
});
