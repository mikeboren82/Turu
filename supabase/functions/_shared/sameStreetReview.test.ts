// TuRu - post-Batch-10 tests (user's explicit instruction, 2026-09-12): SAME_STREET_REVIEW is a
// purely advisory signal for a NEW_CANDIDATE that sits on the same street/settlement as an
// existing activity but OUTSIDE the 0-50m duplicate zones (the real Batch 10 case: two new
// activities in צור הדסה, 135.7m/152.9m from an existing one on the same street, no house number
// on the existing side). "This must NOT mean DUPLICATE" - findSameStreetReviewMatch never
// changes matchAgainstExisting's own routing decision; it's called separately, after
// matchAgainstExisting already returned NEW_CANDIDATE, and only ever produces evidence for a
// human reviewer, never a merge/delete/overwrite of anything.
// Run with `deno test supabase/functions/_shared/`.

import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { findSameStreetReviewMatch, matchAgainstExisting, type ExistingForMatch } from "./placesDiscovery.ts";

const BASE = { lat: 32.100000, lon: 34.900000 };
const EARTH_RADIUS_KM = 6371;
function latOffsetForDistanceM(targetM: number): number {
  return (targetM / 1000 / EARTH_RADIUS_KM) * (180 / Math.PI);
}

function existingAt(address: string): ExistingForMatch {
  return { id: "existing-activity-uuid", name: "גן שעשועים – דוכיפת, צור הדסה", google_place_id: "existing_pid", lat: BASE.lat, lon: BASE.lon, address };
}

function candidateAt(distanceM: number, address: string, name = "גן מים") {
  return { name, lat: BASE.lat + latOffsetForDistanceM(distanceM), lon: BASE.lon, address };
}

Deno.test("same street + same settlement + 100m -> SAME_STREET_REVIEW (a match is found)", () => {
  const existing = [existingAt("דוכיפת, צור הדסה")];
  const candidate = candidateAt(100, "דוכיפת 2, צור הדסה");
  const result = findSameStreetReviewMatch(candidate, existing, { ceilingMeters: 200 });
  assertNotEquals(result, null);
  assertEquals(result?.street, "דוכיפת");
});

Deno.test("same street + same settlement + exactly at the configured ceiling (200m) -> SAME_STREET_REVIEW", () => {
  const existing = [existingAt("דוכיפת, צור הדסה")];
  const candidate = candidateAt(200, "דוכיפת 2, צור הדסה");
  const result = findSameStreetReviewMatch(candidate, existing, { ceilingMeters: 200 });
  assertNotEquals(result, null);
});

Deno.test("same street + same settlement + beyond the configured ceiling -> no SAME_STREET_REVIEW", () => {
  const existing = [existingAt("דוכיפת, צור הדסה")];
  const candidate = candidateAt(201, "דוכיפת 2, צור הדסה");
  const result = findSameStreetReviewMatch(candidate, existing, { ceilingMeters: 200 });
  assertEquals(result, null);
});

Deno.test("different street + same settlement -> no SAME_STREET_REVIEW even within the ceiling", () => {
  const existing = [existingAt("דוכיפת, צור הדסה")];
  const candidate = candidateAt(100, "נחליאלי 21, צור הדסה");
  const result = findSameStreetReviewMatch(candidate, existing, { ceilingMeters: 200 });
  assertEquals(result, null);
});

Deno.test("same street but different settlement -> no SAME_STREET_REVIEW (street name coincidence, not the same place)", () => {
  const existing = [existingAt("דוכיפת, צור הדסה")];
  const candidate = candidateAt(100, "דוכיפת 2, מקום אחר לגמרי");
  const result = findSameStreetReviewMatch(candidate, existing, { ceilingMeters: 200 });
  assertEquals(result, null);
});

Deno.test("SAME_STREET_REVIEW never changes matchAgainstExisting's own routing decision (advisory only)", () => {
  // The real Batch 10 case reproduced: 135.7m, same street, no house number on the existing
  // side, completely different names ("גן הפיראטים" vs "גן שעשועים – נחליאלי, צור הדסה" -> 0%
  // name overlap). matchAgainstExisting must independently still return NEW_CANDIDATE (it has no
  // knowledge of SAME_STREET_REVIEW at all - two fully decoupled functions) - proving that
  // finding a same-street match cannot, even accidentally, escalate to STRONG_MATCH/
  // POSSIBLE_DUPLICATE/MATCH_CONFIRMED, let alone trigger an auto-merge.
  const existing: ExistingForMatch[] = [{
    id: "existing-activity-uuid", name: "גן שעשועים – נחליאלי, צור הדסה", google_place_id: "existing_pid",
    lat: BASE.lat, lon: BASE.lon, address: "נחליאלי, צור הדסה",
  }];
  const discovered = {
    place_id: "new_pid", name: "גן הפיראטים",
    lat: BASE.lat + latOffsetForDistanceM(135.7), lon: BASE.lon, address: "נחליאלי 21, צור הדסה",
  };

  const routingResult = matchAgainstExisting(discovered, existing);
  assertEquals(routingResult.outcome, "NEW_CANDIDATE");
  assertNotEquals(routingResult.outcome, "MATCH_CONFIRMED");
  assertNotEquals(routingResult.outcome, "STRONG_MATCH");
  assertNotEquals(routingResult.outcome, "POSSIBLE_DUPLICATE");

  const sameStreetResult = findSameStreetReviewMatch(discovered, existing, { ceilingMeters: 200 });
  assertNotEquals(sameStreetResult, null); // the advisory signal DOES fire...
  assertEquals(routingResult.outcome, "NEW_CANDIDATE"); // ...but routing is completely unaffected by it.
});
