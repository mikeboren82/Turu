// TuRu - venue alias normalization + conservative resolution. Run with `npx deno test supabase/functions/_shared/`.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { cityMatches, GENERIC_VENUE_LABEL_TYPES, genericVenueType, normalizeVenueAlias, resolveVenue, sameCityStrict } from "./venues.ts";

Deno.test("normalizeVenueAlias: generic prefixes, quotes, punctuation, article", () => {
  assertEquals(normalizeVenueAlias("קניון רננים"), "רננים");
  assertEquals(normalizeVenueAlias("רננים"), "רננים");
  assertEquals(normalizeVenueAlias("מרכז מסחרי רוטשטיין"), "רוטשטיין");
  assertEquals(normalizeVenueAlias("מרכז רוטשטיין"), "רוטשטיין");
  assertEquals(normalizeVenueAlias("רוטשטיינ'ס - קדימה צורן"), "רוטשטיינס קדימה צורן");
  assertEquals(normalizeVenueAlias("מתנ\"ס גן יבנה"), "מתנס גן יבנה");
  assertEquals(normalizeVenueAlias("הספרייה העירונית"), "ספרייה העירונית");
  assertEquals(normalizeVenueAlias(null), "");
});

// Fake client with the exact query shape resolveVenue issues.
function fakeClient(rows: { venue: Record<string, unknown> }[]) {
  return {
    from() { return this; },
    select() { return this; },
    eq() { return Promise.resolve({ data: rows, error: null }); },
  };
}
const v = (id: string, city: string | null, extra: Record<string, unknown> = {}) => ({ venue: { id, name_he: id, city, venue_type: "mall", lat: 32, lng: 34.8, is_active: true, ...extra } });

Deno.test("resolveVenue links alias variants of one venue in the same city", async () => {
  const c = fakeClient([v("rot", "קדימה צורן")]);
  const r = await resolveVenue(c, { locationName: "מרכז רוטשטיין", city: "קדימה-צורן" });
  assertEquals(r?.id, "rot");
});

Deno.test("resolveVenue tolerates canonical city variants (תל אביב / תל אביב יפו)", async () => {
  const c = fakeClient([v("ariela", "תל אביב יפו")]);
  assertEquals((await resolveVenue(c, { locationName: "בית אריאלה", city: "תל אביב" }))?.id, "ariela");
  assertEquals((await resolveVenue(fakeClient([v("m", "מודיעין מכבים רעות")]), { locationName: "פארק ענבה", city: "מודיעין" }))?.id, "m");
  assertEquals(await resolveVenue(fakeClient([v("x", "תל אביב יפו")]), { locationName: "בית אריאלה", city: "תל מונד" }), null);
});

Deno.test("resolveVenue refuses ambiguous alias across cities when no city hint", async () => {
  const c = fakeClient([v("a", "חיפה"), v("b", "ירושלים")]);
  assertEquals(await resolveVenue(c, { locationName: "גרנד קניון", city: null }), null);
  assertEquals((await resolveVenue(c, { locationName: "גרנד קניון", city: "חיפה" }))?.id, "a");
});

Deno.test("resolveVenue: alias in another city is not this venue; inactive venues ignored", async () => {
  assertEquals(await resolveVenue(fakeClient([v("a", "חיפה")]), { locationName: "גרנד קניון", city: "באר שבע" }), null);
  assertEquals(await resolveVenue(fakeClient([v("a", "חיפה", { is_active: false })]), { locationName: "גרנד קניון", city: "חיפה" }), null);
  assertEquals(await resolveVenue(fakeClient([]), { locationName: "מקום לא ידוע", city: "חיפה" }), null);
});

// R2/R3 generic venue labels (Phase 1 libraries golden cases L-A..L-C, 2026-09-25): the SAME table as the
// Node twin (tools/import-tool/tests/venueNaming.test.js). R3 = explicit generic-alias attestation only. The
// in-memory client honours eq/in/is and the venue_aliases -> venues!inner join, and serves ONLY the table
// asked for, so a missing is_active / merged_into / venue_type / city check or a venues-table query fails here.
const table = JSON.parse(await Deno.readTextFile(new URL("./venues.cases.json", import.meta.url)));
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
function worldOf(name: string): { venues: Row[]; aliases: Row[] } {
  const w = table.worlds[name];
  if (!w.extends) return { venues: w.venues, aliases: w.aliases };
  const base = worldOf(w.extends);
  const drop = new Set(w.drop_aliases || []);
  return { venues: [...base.venues, ...w.venues], aliases: [...base.aliases.filter((a) => !drop.has(a.alias_normalized)), ...w.aliases] };
}
function memClient(world: { venues: Row[]; aliases: Row[] }) {
  const calls: string[] = [];
  const byId = new Map(world.venues.map((v) => [v.id, v]));
  return {
    calls,
    from(tableName: string) {
      const filters: ((r: Row) => boolean)[] = [];
      const q = {
        select() { return q; },
        eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return q; },
        in(col: string, vals: unknown[]) { filters.push((r) => vals.includes(r[col])); return q; },
        is(col: string, val: unknown) { filters.push((r) => (r[col] ?? null) === val); return q; },
        then(resolve: (x: unknown) => unknown, reject?: (e: unknown) => unknown) {
          calls.push(tableName);
          const data = tableName === "venue_aliases"
            ? world.aliases.filter((a) => filters.every((f) => f(a))).map((a) => ({ alias_normalized: a.alias_normalized, venue: byId.get(a.venue_id) })).filter((r) => r.venue)
            : tableName === "venues" ? world.venues.filter((v) => filters.every((f) => f(v))) : [];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}

Deno.test("generic labels: the key set is the shared table's and every key is already normalizeVenueAlias output", () => {
  assertEquals([...GENERIC_VENUE_LABEL_TYPES.keys()].sort(), [...table.generic_label_keys].sort());
  for (const k of GENERIC_VENUE_LABEL_TYPES.keys()) assertEquals(normalizeVenueAlias(k), k);
});
// deno-lint-ignore no-explicit-any
for (const k of table.classify as any[]) Deno.test(`genericVenueType: ${k.id}`, () => assertEquals(genericVenueType(k.label), k.expect));
// deno-lint-ignore no-explicit-any
for (const k of table.city_strict as any[]) Deno.test(`sameCityStrict: ${k.id}`, () => assertEquals(sameCityStrict(k.a, k.b), k.expect));
// deno-lint-ignore no-explicit-any
for (const k of table.city_matches as any[]) Deno.test(`cityMatches (unchanged): ${k.id}`, () => assertEquals(cityMatches(k.a, k.b), k.expect));
// deno-lint-ignore no-explicit-any
for (const k of table.resolve as any[]) {
  Deno.test(`resolveVenue: ${k.id}`, async () => {
    const world = worldOf(k.world);
    if (k.expect) assertEquals(world.venues.some((v) => v.id === k.expect), true, "fixture: expected venue exists");
    const c = memClient(world);
    const r = await resolveVenue(c, { locationName: k.label, city: k.city });
    assertEquals(r?.id ?? null, k.expect);
    if (k.no_query) assertEquals(c.calls, []);
  });
}
