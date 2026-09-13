// TuRu - venue alias normalization + conservative resolution. Run with `npx deno test supabase/functions/_shared/`.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normalizeVenueAlias, resolveVenue } from "./venues.ts";

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
