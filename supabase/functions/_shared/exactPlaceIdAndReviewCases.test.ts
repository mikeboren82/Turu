// TuRu - post-Batch-11 required-fix tests (user's explicit instruction, 2026-09-12).
//
// checkExactPlaceIdDuplicate: Batch 11 hit "duplicate key value violates unique constraint
// idx_activities_google_place_id" - matchAgainstExisting's own exact-place_id check only sees
// the `existing` snapshot loaded once per batch, which can be stale/incomplete. index.ts now
// does a FRESH lookup right before the INSERT; this is the pure decision on top of that lookup's
// result (the DB round trip itself stays an untested thin caller, same split as every other
// DB-touching piece of this pipeline - see the pagination/matching functions above).
//
// nextReviewCaseState: "פארק החורשות" vs "...לבון, ת"א-יפו" was independently re-logged as a
// disconnected item across Batch 9 and Batch 11 - this is the pure counting decision behind the
// settlement_scan_review_cases rollup (index.ts's recordReviewCase).
//
// Run with `deno test supabase/functions/_shared/`.

import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { checkExactPlaceIdDuplicate, nextReviewCaseState, matchAgainstExisting, type ExistingForMatch } from "./placesDiscovery.ts";

// --- 1. Existing google_place_id + candidate -> DUPLICATE_EXACT_PLACE_ID, no INSERT attempted ---
Deno.test("exact place_id match found -> isDuplicate=true, carries the existing activity's real ID", () => {
  const result = checkExactPlaceIdDuplicate("ChIJsome_place_id", { id: "existing-activity-uuid", google_place_id: "ChIJsome_place_id" });
  assertEquals(result.isDuplicate, true);
  assertEquals(result.existingActivityId, "existing-activity-uuid");
  // index.ts only calls locations.insert()/activities.insert() when isDuplicate is false - this
  // return value is exactly the flag index.ts's `if (exactMatchId) { ...; continue; }` uses to
  // skip the insert entirely (see the code right after this check).
});

// --- 2. New google_place_id -> normal matching flow continues ---
Deno.test("no matching row in the DB (fresh place_id) -> isDuplicate=false, normal insert flow continues", () => {
  const result = checkExactPlaceIdDuplicate("ChIJbrand_new_place_id", null);
  assertEquals(result.isDuplicate, false);
  assertEquals(result.existingActivityId, null);
});

Deno.test("a DB row exists but its google_place_id is actually different (defensive - should never happen from an exact `.eq()` lookup, but the pure function must not just trust row presence) -> isDuplicate=false", () => {
  const result = checkExactPlaceIdDuplicate("ChIJcandidate", { id: "some-uuid", google_place_id: "ChIJ_different_entirely" });
  assertEquals(result.isDuplicate, false);
});

// --- 3. Exact google_place_id match must override distance/name ambiguity - exact ID is authoritative ---
Deno.test("exact place_id check is authoritative even when matchAgainstExisting (stale snapshot) said NEW_CANDIDATE", () => {
  // Reproduces the real Batch 11 shape: the in-memory `existing` snapshot does NOT contain this
  // place_id at all (simulating the staleness/gap) - matchAgainstExisting has no way to know
  // about it and correctly (from its own point of view) returns NEW_CANDIDATE based on distance/
  // name alone. The FRESH exact lookup (simulated here as a directly-constructed row, standing in
  // for what index.ts's live SELECT would return) still catches it - proving the exact-ID check
  // is a second, independent, authoritative layer that does not depend on matchAgainstExisting's
  // verdict at all.
  const existingSnapshot: ExistingForMatch[] = []; // empty - place_id genuinely absent from the stale snapshot
  const discovered = { place_id: "ChIJactually_exists_in_db", name: "משהו לגמרי אחר", lat: 32.0, lon: 34.9 };
  const routing = matchAgainstExisting(discovered, existingSnapshot);
  assertEquals(routing.outcome, "NEW_CANDIDATE"); // matchAgainstExisting alone would proceed to insert

  const freshLookupResult = { id: "existing-activity-uuid", google_place_id: "ChIJactually_exists_in_db" };
  const exactCheck = checkExactPlaceIdDuplicate(discovered.place_id, freshLookupResult);
  assertEquals(exactCheck.isDuplicate, true); // ...but the fresh exact-ID check overrides that and blocks the insert.
  assertEquals(exactCheck.existingActivityId, "existing-activity-uuid");
});

// --- 4. DB unique constraint remains as final safety net ---
// Not a Deno unit test (it's a live-database invariant, not application logic) - verified
// separately by querying pg_indexes for idx_activities_google_place_id and confirming its
// definition is byte-for-byte unchanged from before this fix (still `CREATE UNIQUE INDEX
// idx_activities_google_place_id ON public.activities USING btree (google_place_id) WHERE
// (google_place_id IS NOT NULL)`). This fix only adds an earlier, application-level check - the
// index itself was never touched, and index.ts's own error handling around the pre-check
// (`exactMatchErr`) deliberately falls through to the normal insert attempt rather than skipping
// it, so a failed pre-check still lets the constraint catch a real duplicate.

// --- 5/6. Repeated detection: 1st -> count=1, 2nd -> count=2, 3rd -> count=3; history preserved ---
Deno.test("first detection (no prior row) -> detectionCount=1, isFirstDetection=true", () => {
  const state = nextReviewCaseState(null);
  assertEquals(state.detectionCount, 1);
  assertEquals(state.isFirstDetection, true);
});

Deno.test("second detection (prior count=1) -> detectionCount=2, isFirstDetection=false", () => {
  const state = nextReviewCaseState(1);
  assertEquals(state.detectionCount, 2);
  assertEquals(state.isFirstDetection, false);
});

Deno.test("third detection (prior count=2) -> detectionCount=3, isFirstDetection=false", () => {
  const state = nextReviewCaseState(2);
  assertEquals(state.detectionCount, 3);
  assertEquals(state.isFirstDetection, false);
});

Deno.test("a full first->second->third sequence never resets or loses the running count", () => {
  let count: number | null = null;
  const seen: number[] = [];
  for (let i = 0; i < 3; i++) {
    const state = nextReviewCaseState(count);
    seen.push(state.detectionCount);
    count = state.detectionCount;
  }
  assertEquals(seen, [1, 2, 3]);
  // index.ts's recordReviewCase mirrors this exactly: on a repeat detection, its UPDATE payload
  // never includes first_seen_at/first_batch_id/status (only last_seen_at/detection_count/
  // case_type/latest_* are written) - so the original detection's timestamp and any admin-set
  // status are structurally impossible for this code path to overwrite, not just "usually" kept.
});

// --- 7. Repeated review detection does not trigger auto-merge ---
Deno.test("nextReviewCaseState is a pure counter with no way to reference/merge/delete an activity", () => {
  // It doesn't even accept an activity, a client, or any DB handle as input - only a number - so
  // by construction it cannot be the thing that performs a merge. Confirmed by signature: calling
  // it can never do anything but return {detectionCount, isFirstDetection}.
  const state = nextReviewCaseState(5);
  assertEquals(Object.keys(state).sort(), ["detectionCount", "isFirstDetection"]);
});

// --- 8. Existing 30m/50m boundary tests remain unchanged (29/30/31/49/50/51m) ---
// Covered by matching.test.ts (extended in the post-Batch-10 fix with the 49m case) - untouched
// by this fix. VERY_CLOSE_DISTANCE_METERS/BORDERLINE_MAX_METERS/STRONG_MATCH_* constants in
// placesDiscovery.ts were not edited as part of this change; re-asserted here as a guard so a
// future refactor that accidentally touches them fails this file too, not just matching.test.ts.
Deno.test("threshold boundaries untouched by this fix - 29/30/31/49/50/51m spot-check", () => {
  const BASE = { lat: 32.100000, lon: 34.900000 };
  const EARTH_RADIUS_KM = 6371;
  const latOffsetForDistanceM = (m: number) => (m / 1000 / EARTH_RADIUS_KM) * (180 / Math.PI);
  const existing: ExistingForMatch[] = [{ id: "e1", name: "גן קיים", google_place_id: "existing_pid", lat: BASE.lat, lon: BASE.lon }];
  const outcomeAt = (m: number) => matchAgainstExisting(
    { place_id: "new_pid", name: "מקום אחר", lat: BASE.lat + latOffsetForDistanceM(m), lon: BASE.lon }, existing,
  ).outcome;
  assertEquals(outcomeAt(29), "STRONG_MATCH");
  assertEquals(outcomeAt(30), "STRONG_MATCH");
  assertEquals(outcomeAt(31), "POSSIBLE_DUPLICATE");
  assertEquals(outcomeAt(49), "POSSIBLE_DUPLICATE");
  assertEquals(outcomeAt(50), "POSSIBLE_DUPLICATE");
  assertEquals(outcomeAt(51), "NEW_CANDIDATE");
});
