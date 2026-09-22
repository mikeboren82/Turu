// Hebrew diacritic / quote-variant normalization ("Normalize Hebrew City Names for Stable
// Fingerprints", 2026-09-22). Deno twin of tools/import-tool/tests/cityNaming.test.js - see that
// file's header for the full rationale. Run with `deno test supabase/functions/_shared/`.
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normalizeCityName } from "./cityNaming.ts";

Deno.test("niqqud/teamim are stripped without touching the base letters", () => {
  assertEquals(normalizeCityName("בְּאֵר שֶׁבַע"), "באר שבע");
  assertEquals(normalizeCityName("בֵּית שֶׁמֶשׁ"), "בית שמש");
  assertEquals(normalizeCityName("באר שבע"), "באר שבע");
});

Deno.test("gershayim (Hebrew) and ASCII double-quote fold to the same value", () => {
  assertEquals(normalizeCityName("כפר ביל״ו"), normalizeCityName('כפר ביל"ו'));
  assertEquals(normalizeCityName("כפר ביל״ו"), "כפר בילו");
});

Deno.test("geresh (Hebrew) and ASCII apostrophe fold to the same value", () => {
  assertEquals(normalizeCityName("ג'לג'וליה"), normalizeCityName("ג׳לג׳וליה"));
  assertEquals(normalizeCityName("ג׳לג׳וליה"), "גלגוליה");
});

Deno.test("hyphen / maqaf regression: existing equivalence is unchanged", () => {
  assertEquals(normalizeCityName("באר-שבע"), "באר שבע");
  assertEquals(normalizeCityName("באר־שבע"), "באר שבע"); // maqaf (U+05BE)
  assertEquals(normalizeCityName("באר שבע"), "באר שבע");
  assertEquals(normalizeCityName("תל אביב-יפו"), "תל אביב יפו");
});

Deno.test("plain Hebrew with no diacritics/quotes is unchanged", () => {
  assertEquals(normalizeCityName("חולון"), "חולון");
  assertEquals(normalizeCityName("קריית מוצקין"), "קריית מוצקין");
  assertEquals(normalizeCityName("קרית מוצקין"), "קריית מוצקין"); // pre-existing קרית->קריית behavior, untouched
});

Deno.test("Latin city names are unchanged (apostrophe folding is script-agnostic, same as Hebrew)", () => {
  assertEquals(normalizeCityName("Tel Aviv"), "Tel Aviv");
  assertEquals(normalizeCityName("Ma'ale Adumim"), "Maale Adumim");
});

Deno.test("digits and internal spacing are preserved", () => {
  assertEquals(normalizeCityName("רמת גן 2"), "רמת גן 2");
  assertEquals(normalizeCityName("  חולון  "), "חולון");
});

Deno.test("CANONICAL ALIAS: תל אביב short form canonicalizes to the official תל אביב יפו, in every punctuation variant", () => {
  assertEquals(normalizeCityName("תל אביב"), "תל אביב יפו");
  assertEquals(normalizeCityName("תל אביב יפו"), "תל אביב יפו");
  assertEquals(normalizeCityName("תל אביב-יפו"), "תל אביב יפו");
  assertEquals(normalizeCityName("תל אביב־יפו"), "תל אביב יפו");
});

Deno.test("CANONICAL ALIAS: מודיעין and קדימה short forms canonicalize to their official merged-municipality names", () => {
  assertEquals(normalizeCityName("מודיעין"), "מודיעין מכבים רעות");
  assertEquals(normalizeCityName("קדימה"), "קדימה צורן");
});

Deno.test("CANONICAL ALIAS: unrelated/distinct localities never collapse into the aliased forms", () => {
  assertNotEquals(normalizeCityName("תל אביב"), normalizeCityName("רמת גן"));
  assertNotEquals(normalizeCityName("תל אביב"), normalizeCityName("יפו העתיקה"));
  assertEquals(normalizeCityName("יפו העתיקה"), "יפו העתיקה");
  assertNotEquals(normalizeCityName("מודיעין עילית"), normalizeCityName("מודיעין"));
});

Deno.test("distinct cities never collapse into each other after the fix", () => {
  assertNotEquals(normalizeCityName("בְּאֵר שֶׁבַע"), normalizeCityName("בֵּית שֶׁמֶשׁ"));
  assertNotEquals(normalizeCityName("באר שבע"), normalizeCityName("בית שמש"));
});
