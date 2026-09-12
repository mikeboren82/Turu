// TuRu - regression tests for the three-zone matching model (2026-09-12, post-Batch-6 "פארק
// עירוני 76" case: 32.0m from an existing activity, 0% name similarity, fell 2m past the old flat
// 30m STRONG_MATCH cutoff and was auto-approved as new). A hard cliff at one distance meant 30.0m
// and 30.1m had wildly different consequences. Fix: a genuine third zone - (30m, 50m] ->
// POSSIBLE_DUPLICATE, a "look before approving" flag that is NOT a duplicate confirmation and
// NEVER auto-merges, kept conceptually distinct from STRONG_MATCH. Mirrors
// tools/playground-discovery/test_distance_bias_fix.py's three-zone regression tests exactly -
// both runtimes must agree. Run with `deno test supabase/functions/_shared/`.

import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { matchAgainstExisting, type ExistingForMatch } from "./placesDiscovery.ts";

const BASE = { lat: 32.100000, lon: 34.900000 };
const EARTH_RADIUS_KM = 6371;

// Exact great-circle distance for a pure due-north offset (a meridian is a great circle) - not
// an approximation. Verified against the actual haversineKm formula to sub-millimeter precision
// during development (see the Python test file's identical derivation).
function latOffsetForDistanceM(targetM: number): number {
  return (targetM / 1000 / EARTH_RADIUS_KM) * (180 / Math.PI);
}

function makePair(targetM: number, nameA = "גן קיים", nameB = "מקום אחר לגמרי") {
  const existing: ExistingForMatch[] = [{ id: "e1", name: nameA, google_place_id: "existing_pid", lat: BASE.lat, lon: BASE.lon }];
  const discovered = { place_id: "new_pid", name: nameB, lat: BASE.lat + latOffsetForDistanceM(targetM), lon: BASE.lon };
  return { discovered, existing };
}

Deno.test("29m, 0% name similarity -> STRONG_MATCH", () => {
  const { discovered, existing } = makePair(29);
  const { outcome } = matchAgainstExisting(discovered, existing);
  assertEquals(outcome, "STRONG_MATCH");
});

Deno.test("exactly 30m, 0% name similarity -> STRONG_MATCH (inclusive boundary)", () => {
  const { discovered, existing } = makePair(30);
  const { outcome } = matchAgainstExisting(discovered, existing);
  assertEquals(outcome, "STRONG_MATCH");
});

Deno.test("31m, 0% name similarity -> POSSIBLE_DUPLICATE", () => {
  const { discovered, existing } = makePair(31);
  const { outcome } = matchAgainstExisting(discovered, existing);
  assertEquals(outcome, "POSSIBLE_DUPLICATE");
});

Deno.test("32m, 0% name similarity -> POSSIBLE_DUPLICATE (the actual Batch 6 case)", () => {
  // Reproduces the real "פארק עירוני 76" vs "גן שעשועים – נחל דן, כרמיאל" case that triggered
  // this fix - not synthetic.
  const { discovered, existing } = makePair(32, "גן שעשועים – נחל דן, כרמיאל", "פארק עירוני 76");
  const result = matchAgainstExisting(discovered, existing);
  assertEquals(result.outcome, "POSSIBLE_DUPLICATE");
  assertEquals(result.nameScore, 0);
});

Deno.test("49m, 0% name similarity -> POSSIBLE_DUPLICATE", () => {
  const { discovered, existing } = makePair(49);
  const { outcome } = matchAgainstExisting(discovered, existing);
  assertEquals(outcome, "POSSIBLE_DUPLICATE");
});

Deno.test("exactly 50m, 0% name similarity -> POSSIBLE_DUPLICATE (inclusive boundary)", () => {
  const { discovered, existing } = makePair(50);
  const { outcome } = matchAgainstExisting(discovered, existing);
  assertEquals(outcome, "POSSIBLE_DUPLICATE");
});

Deno.test("51m, 0% name similarity -> falls through to zone 3 (unchanged), resolves NEW_CANDIDATE", () => {
  const { discovered, existing } = makePair(51);
  const { outcome } = matchAgainstExisting(discovered, existing);
  assertEquals(outcome, "NEW_CANDIDATE");
});

Deno.test("~35.6m genuinely distinct playgrounds -> POSSIBLE_DUPLICATE, never auto-merged", () => {
  const existing: ExistingForMatch[] = [{ id: "e1", name: "גן הדקל", google_place_id: "existing_place_id_2", lat: 32.100000, lon: 34.900000 }];
  const discovered = { place_id: "some_other_place_id", name: "גן הארז", lat: 32.100000 + latOffsetForDistanceM(35.6), lon: 34.900000 };
  const { outcome } = matchAgainstExisting(discovered, existing);
  assertEquals(outcome, "POSSIBLE_DUPLICATE");
  assertNotEquals(outcome, "MATCH_CONFIRMED");
});

Deno.test("zone 1 (<=30m) never resolves to MATCH_CONFIRMED (no auto-merge from the distance heuristic)", () => {
  for (const m of [29, 30]) {
    const { discovered, existing } = makePair(m);
    const { outcome } = matchAgainstExisting(discovered, existing);
    assertNotEquals(outcome, "MATCH_CONFIRMED", `${m}m must never resolve to MATCH_CONFIRMED`);
  }
});

Deno.test("zone 2 (30-50m) never resolves to MATCH_CONFIRMED or STRONG_MATCH, even with matching names", () => {
  for (const m of [31, 32, 50]) {
    const { discovered, existing } = makePair(m);
    const { outcome } = matchAgainstExisting(discovered, existing);
    assertNotEquals(outcome, "MATCH_CONFIRMED", `${m}m must never resolve to MATCH_CONFIRMED`);
    assertNotEquals(outcome, "STRONG_MATCH", `${m}m must never escalate to STRONG_MATCH`);
  }
});

Deno.test("45m + highly similar (identical) name still stays POSSIBLE_DUPLICATE, not STRONG_MATCH", () => {
  // Explicit design requirement: zone 2 does NOT escalate on name evidence alone.
  const { discovered, existing } = makePair(45, "גן שעשועים הדקל המרכזי", "גן שעשועים הדקל המרכזי");
  const result = matchAgainstExisting(discovered, existing);
  assertEquals(result.outcome, "POSSIBLE_DUPLICATE");
  assertEquals(result.nameScore, 1);
});
