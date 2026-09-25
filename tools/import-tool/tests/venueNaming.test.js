// Run: node --test tests/   (from tools/import-tool). Pins the Node mirror to the same cases as
// supabase/functions/_shared/venues.test.ts / extraction.test.ts so the two runtimes can't drift.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeVenueAlias, repairHebrewGershayim, repairUnescapedQuotes, repairModelJson } = require('../venueNaming');

test('repairUnescapedQuotes / repairModelJson mirror the Deno repair', () => {
  const broken = '[{"name": "סדנה", "description": "הסדנה "מדע לילדים" מתאימה", "city": "חיפה"}]';
  assert.equal(JSON.parse(repairUnescapedQuotes(broken))[0].description, 'הסדנה "מדע לילדים" מתאימה');
  const valid = '[{"a":"ב, ג","c":["ד","ה"],"f":"x\\"y"}]';
  assert.equal(repairUnescapedQuotes(valid), valid);
  assert.equal(JSON.parse(repairModelJson('[{"name":"גן החיות התנ"כי - "הגן הגדול""}]'))[0].name, 'גן החיות התנ״כי - "הגן הגדול"');
});

test('normalizeVenueAlias mirrors the Deno normalizer', () => {
  assert.equal(normalizeVenueAlias('קניון רננים'), 'רננים');
  assert.equal(normalizeVenueAlias('רננים'), 'רננים');
  assert.equal(normalizeVenueAlias('מרכז מסחרי רוטשטיין'), 'רוטשטיין');
  assert.equal(normalizeVenueAlias('מרכז רוטשטיין'), 'רוטשטיין');
  assert.equal(normalizeVenueAlias("רוטשטיינ'ס - קדימה צורן"), 'רוטשטיינס קדימה צורן');
  assert.equal(normalizeVenueAlias('מתנ"ס גן יבנה'), 'מתנס גן יבנה');
  assert.equal(normalizeVenueAlias('הספרייה העירונית'), 'ספרייה העירונית');
  assert.equal(normalizeVenueAlias(null), '');
});

test('repairHebrewGershayim mirrors the Deno repair', () => {
  assert.equal(repairHebrewGershayim('"name": "גן החיות התנ"כי"'), '"name": "גן החיות התנ״כי"');
  assert.equal(repairHebrewGershayim('{"a":"ב","c":"ד"}'), '{"a":"ב","c":"ד"}');
  assert.equal(JSON.parse(repairHebrewGershayim('[{"name":"מתנ"ס ע"ש רבין"}]'))[0].name, 'מתנ״ס ע״ש רבין');
});

// R2/R3 generic venue labels (Phase 1 libraries golden cases L-A..L-C, 2026-09-25): the SAME table as the
// Deno twin (_shared/venues.test.ts). R3 = explicit generic-alias attestation only. The in-memory client
// honours eq/in/is and the venue_aliases -> venues!inner join, and serves ONLY the table asked for, so a
// missing is_active / merged_into / venue_type / city check or a venues-table query fails here.
const fs = require('fs');
const path = require('path');
const { resolveVenue, GENERIC_VENUE_LABEL_TYPES, genericVenueType, sameCityStrict, cityMatches } = require('../venueNaming');

const table = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'supabase', 'functions', '_shared', 'venues.cases.json'), 'utf8'));
function worldOf(name) {
  const w = table.worlds[name];
  if (!w.extends) return { venues: w.venues, aliases: w.aliases };
  const base = worldOf(w.extends);
  const drop = new Set(w.drop_aliases || []);
  return { venues: [...base.venues, ...w.venues], aliases: [...base.aliases.filter((a) => !drop.has(a.alias_normalized)), ...w.aliases] };
}
function memClient(world) {
  const calls = [];
  const byId = new Map(world.venues.map((v) => [v.id, v]));
  return {
    calls,
    from(tableName) {
      const filters = [];
      const q = {
        select() { return q; },
        eq(col, val) { filters.push((r) => r[col] === val); return q; },
        in(col, vals) { filters.push((r) => vals.includes(r[col])); return q; },
        is(col, val) { filters.push((r) => (r[col] ?? null) === val); return q; },
        then(resolve, reject) {
          calls.push(tableName);
          const data = tableName === 'venue_aliases'
            ? world.aliases.filter((a) => filters.every((f) => f(a))).map((a) => ({ alias_normalized: a.alias_normalized, venue: byId.get(a.venue_id) })).filter((r) => r.venue)
            : tableName === 'venues' ? world.venues.filter((v) => filters.every((f) => f(v))) : [];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}

test('generic labels: the key set is the shared table\'s and every key is already normalizeVenueAlias output', () => {
  assert.deepEqual([...GENERIC_VENUE_LABEL_TYPES.keys()].sort(), [...table.generic_label_keys].sort());
  for (const k of GENERIC_VENUE_LABEL_TYPES.keys()) assert.equal(normalizeVenueAlias(k), k);
});

test('shared table: genericVenueType / sameCityStrict / cityMatches (unchanged)', () => {
  for (const k of table.classify) assert.equal(genericVenueType(k.label), k.expect, k.id);
  for (const k of table.city_strict) assert.equal(sameCityStrict(k.a, k.b), k.expect, k.id);
  for (const k of table.city_matches) assert.equal(cityMatches(k.a, k.b), k.expect, k.id);
});

test('shared table: resolveVenue golden cases (R2 no-city null, R3 explicit attestation, monotonicity, regressions)', async () => {
  for (const k of table.resolve) {
    const world = worldOf(k.world);
    if (k.expect) assert.ok(world.venues.some((v) => v.id === k.expect), `${k.id}: fixture venue exists`);
    const c = memClient(world);
    const r = await resolveVenue(c, { locationName: k.label, city: k.city });
    assert.equal(r?.id ?? null, k.expect, k.id);
    if (k.no_query) assert.deepEqual(c.calls, [], `${k.id}: no DB query`);
  }
});

test('RECURRENCE: a new story hour "ספרייה"/רמת השרון binds only while a human attestation exists; Haifa never guesses', async () => {
  const story = (world, city) => resolveVenue(memClient(worldOf(world)), { locationName: 'ספרייה', city });
  assert.equal((await story('rh_attested', 'רמת השרון'))?.id, 'rh_lib');
  const after = worldOf('rh_unattested');
  assert.equal(after.aliases.some((a) => genericVenueType(a.alias_normalized)), false);
  assert.equal(await story('rh_unattested', 'רמת השרון'), null); // E-1 without re-attestation => unbound, never guessed
  assert.equal(await story('haifa_three', 'חיפה'), null);
  assert.equal(await story('rh_attested', null), null);
});
