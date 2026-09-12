// TuRu - post-Batch-10 tests (user's explicit instruction, 2026-09-12): "שוהם" vs "שהם" is the
// same real settlement (Batch 10 found city_match=false for this pair - a genuine spelling
// variant, not a formatting difference normalizeCityName already handles). Fix: cityMatchFlag
// prefers comparing canonical settlement IDs (via an injected resolver - placesDiscovery.ts
// itself stays DB-free) over raw string equality when both sides resolve confidently. These
// tests use a tiny mock resolver (not the real DB) to prove the *logic* - both "genuinely
// resolves to the same ID" and "genuinely different IDs must never match" cases.
// Run with `deno test supabase/functions/_shared/`.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { matchAgainstExisting, type ExistingForMatch } from "./placesDiscovery.ts";

const BASE = { lat: 32.100000, lon: 34.900000 };
const EARTH_RADIUS_KM = 6371;
function latOffsetForDistanceM(targetM: number): number {
  return (targetM / 1000 / EARTH_RADIUS_KM) * (180 / Math.PI);
}

// Mimics index.ts's resolver: canonical settlement names map to a real ID; a well-known
// misspelling ("שהם") maps to the SAME id as its canonical form ("שוהם") via an explicit alias -
// not fuzzy matching, an exact lookup table entry (mirrors public.settlement_aliases, 0072).
// Two entirely different real settlements ("כרמיאל", "עפולה") get their own distinct IDs and are
// never conflated - this is the "must NOT incorrectly merge different settlements" guard.
const MOCK_SETTLEMENT_IDS: Record<string, string> = {
  "שוהם": "1304",
  "שהם": "1304", // alias, not a distinct settlement
  "כרמיאל": "0942",
  "עפולה": "0665",
};
const mockResolve = (city: string) => MOCK_SETTLEMENT_IDS[city] ?? null;

function makePairAt35m(cityA: string, cityB: string) {
  // 35m -> zone 2 (POSSIBLE_DUPLICATE), the only zone that computes/returns cityMatch at all.
  const existing: ExistingForMatch[] = [{
    id: "e1", name: "גן קיים", google_place_id: "existing_pid", lat: BASE.lat, lon: BASE.lon,
    address: `הרצל 1, ${cityA}`,
  }];
  const discovered = {
    place_id: "new_pid", name: "מקום אחר", lat: BASE.lat + latOffsetForDistanceM(35), lon: BASE.lon,
    address: `הרצל 2, ${cityB}`,
  };
  return { discovered, existing };
}

Deno.test("שוהם / שהם -> city_match=true after canonical resolution", () => {
  const { discovered, existing } = makePairAt35m("שוהם", "שהם");
  const result = matchAgainstExisting(discovered, existing, { resolveSettlement: mockResolve });
  assertEquals(result.outcome, "POSSIBLE_DUPLICATE");
  assertEquals(result.cityMatch, true);
});

Deno.test("two genuinely different settlements (כרמיאל / עפולה) -> city_match=false, never conflated", () => {
  const { discovered, existing } = makePairAt35m("כרמיאל", "עפולה");
  const result = matchAgainstExisting(discovered, existing, { resolveSettlement: mockResolve });
  assertEquals(result.outcome, "POSSIBLE_DUPLICATE");
  assertEquals(result.cityMatch, false);
});

Deno.test("without a resolver, falls back to plain string comparison (no regression)", () => {
  // שוהם/שהם are different strings - without resolveSettlement injected at all, the old
  // (pre-Batch-10) behavior must be unchanged: false, not a silent guess.
  const { discovered, existing } = makePairAt35m("שוהם", "שהם");
  const result = matchAgainstExisting(discovered, existing);
  assertEquals(result.cityMatch, false);
});

Deno.test("resolver present but one side unresolvable -> falls back to string comparison, not null-guessed true", () => {
  const { discovered, existing } = makePairAt35m("שוהם", "יישוב לא ידוע לגמרי");
  const result = matchAgainstExisting(discovered, existing, { resolveSettlement: mockResolve });
  assertEquals(result.cityMatch, false); // "שוהם" !== "יישוב לא ידוע לגמרי" as strings either
});
