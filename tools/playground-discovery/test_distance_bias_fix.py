"""
TuRu - regression tests for the distance-bias bug found in Batch 1 (2026-09-12).

Bug: places:searchText's `locationBias` is a soft preference to Google, not a
hard geographic restriction - so despite settlement_scan_radius_m=3000 (3km),
Google returned real places up to 41km away (e.g. Netanya's "פארק איינשטיין"
matched to "אבירים", a Western Galilee village 40km+ distant).

Fix: an explicit post-search haversine distance check, rejecting any result
farther than 2x the search radius from the settlement's own coordinates.
Implemented identically in:
  - supabase/functions/scan-settlement-gaps/index.ts (haversineKm(...) > (radiusM/1000)*2)
  - tools/playground-discovery/settlement_gap_fill.py (line ~144, same formula)

This script exercises the same formula + the existing match_against_existing()
duplicate logic (matching.py) against the 4 scenarios the user asked to see
verified before Batch 2:
  (a) a nearby garden is NOT wrongly rejected
  (b) a far garden is NOT wrongly identified as the same place
  (c) two different gardens in the same settlement are NOT merged
  (d) the same garden appearing in different sources IS correctly flagged as a duplicate
"""
import sys

sys.stdout.reconfigure(encoding="utf-8")

from israel_geo import haversine_km
from matching import match_against_existing, MATCH_CONFIRMED, STRONG_MATCH, POSSIBLE_DUPLICATE, NEEDS_REVIEW, NEW_CANDIDATE

SEARCH_RADIUS_M = 3000  # settlement_scan_radius_m, matches production default
DISTANCE_REJECT_KM = (SEARCH_RADIUS_M / 1000) * 2  # 6km - the fix's actual threshold

failures = []


def check(label, condition, detail):
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {label}: {detail}")
    if not condition:
        failures.append(label)


# Settlement anchor: Netanya city center (real coords used in the Batch 1 bug report)
NETANYA = (32.3215, 34.8532)
# The real Batch 1 false-positive victim: Avirim, a Western Galilee village ~40km away
AVIRIM = (33.0122, 35.2447)

print("=== Scenario (a): a nearby garden is NOT wrongly rejected ===")
# A real playground 1.2km from the settlement center - well within the 6km reject line.
nearby_garden = (32.3300, 34.8600)
dist_km = haversine_km(*NETANYA, *nearby_garden)
check(
    "nearby garden accepted",
    dist_km <= DISTANCE_REJECT_KM,
    f"{dist_km:.2f}km from settlement, reject-threshold={DISTANCE_REJECT_KM}km -> "
    f"{'kept' if dist_km <= DISTANCE_REJECT_KM else 'WOULD BE REJECTED'}",
)

print("\n=== Scenario (b): a far garden IS correctly rejected (the actual Batch 1 bug) ===")
dist_km = haversine_km(*NETANYA, *AVIRIM)
check(
    "far garden (Avirim, ~40km) rejected",
    dist_km > DISTANCE_REJECT_KM,
    f"{dist_km:.2f}km from settlement, reject-threshold={DISTANCE_REJECT_KM}km -> "
    f"{'WOULD WRONGLY BE KEPT' if dist_km <= DISTANCE_REJECT_KM else 'correctly rejected'}",
)
# Also confirm this is the literal case from the bug report (Google returned it despite
# locationBias + radius_m=3000) - the fix must catch it even though Google itself did not.
check(
    "far garden exceeds Google's own claimed search radius by a wide margin",
    dist_km > (SEARCH_RADIUS_M / 1000) * 10,
    f"{dist_km:.2f}km vs configured radius {SEARCH_RADIUS_M/1000}km - confirms locationBias "
    f"was not enforcing a hard bound (this is why the post-search check is necessary)",
)

print("\n=== Scenario (c): two different real gardens in the same settlement are NOT merged ===")
# Two distinct playgrounds ~800m apart in the same settlement, different names.
garden_a = {"place_id": "place_A", "name": "גן שעשועים הפרחים", "lat": 32.3215, "lon": 34.8532}
garden_b = {"place_id": "place_B", "name": "גן שעשועים האורנים", "lat": 32.3280, "lon": 34.8610}
existing_activities = [
    {"id": 1, "name": "גן שעשועים הפרחים", "google_place_id": "place_A", "lat": 32.3215, "lon": 34.8532},
]
outcome, matched, _score = match_against_existing(garden_b, existing_activities)
dist_m = haversine_km(garden_a["lat"], garden_a["lon"], garden_b["lat"], garden_b["lon"]) * 1000
check(
    "distinct same-settlement gardens not merged",
    outcome == NEW_CANDIDATE,
    f"garden_b vs existing garden_a ({dist_m:.0f}m apart, different names) -> outcome={outcome} "
    f"(expected {NEW_CANDIDATE})",
)

print("\n=== Scenario (d): the same garden from a different source IS flagged as a duplicate ===")
# Same real-world place, re-discovered via a different source/search with a slightly
# different name string and a small GPS jitter (~15m) - should MATCH_CONFIRMED via place_id
# if place_id survived, or STRONG_MATCH via name+distance if it's a different provider's ID.
same_garden_same_place_id = {"place_id": "place_A", "name": "גן שעשועים הפרחים - מתקנים חדשים", "lat": 32.32161, "lon": 34.85325}
outcome1, matched1, _score1 = match_against_existing(same_garden_same_place_id, existing_activities)
check(
    "same place_id -> MATCH_CONFIRMED",
    outcome1 == MATCH_CONFIRMED,
    f"outcome={outcome1} (expected {MATCH_CONFIRMED})",
)

same_garden_diff_place_id = {"place_id": "place_C_different_source", "name": "גן שעשועים הפרחים", "lat": 32.32155, "lon": 34.85328}
outcome2, matched2, _score2 = match_against_existing(same_garden_diff_place_id, existing_activities)
dist_m2 = haversine_km(existing_activities[0]["lat"], existing_activities[0]["lon"],
                        same_garden_diff_place_id["lat"], same_garden_diff_place_id["lon"]) * 1000
check(
    "same garden, different source place_id, ~7m apart, same name -> STRONG_MATCH",
    outcome2 == STRONG_MATCH,
    f"{dist_m2:.1f}m apart, outcome={outcome2} (expected {STRONG_MATCH})",
)

print("\n=== Regression: the actual Batch 1 missed-duplicate case (64.4m, identical name) ===")
# This is not a synthetic example - it's "פארק יהורם גאון" (קריית מוצקין), which the OLD 60m
# threshold missed (64.4m > 60m) and got auto-approved as a live duplicate activity. Confirms
# the 100m threshold now catches it.
yehoram_gaon_existing = [{"id": 1, "name": "פארק יהורם גאון", "google_place_id": "existing_place_id", "lat": 32.8492109, "lon": 35.0879074}]
yehoram_gaon_new = {"place_id": "ChIJO68L6AW3HRURXFEqS9OwAQk", "name": "פארק יהורם גאון", "lat": 32.849744, "lon": 35.088313}
dist_m3 = haversine_km(yehoram_gaon_existing[0]["lat"], yehoram_gaon_existing[0]["lon"],
                        yehoram_gaon_new["lat"], yehoram_gaon_new["lon"]) * 1000
outcome3, matched3, _score3 = match_against_existing(yehoram_gaon_new, yehoram_gaon_existing)
check(
    "Batch 1's 64.4m יהורם גאון duplicate now caught as STRONG_MATCH",
    outcome3 == STRONG_MATCH,
    f"{dist_m3:.1f}m apart, identical name, outcome={outcome3} (expected {STRONG_MATCH} - "
    f"was {NEW_CANDIDATE} under the old 60m threshold, which is how the duplicate was created)",
)

print("\n=== Regression: the Batch 3 missed-duplicate case (11.8m, 0% name overlap) ===")
# The actual Batch 3 case: "גן לוטם" (a real official name) vs "גן שעשועים – לילך, עפולה" (a
# generic address-based placeholder for the SAME physical place, from a different source) - zero
# word overlap, so the old distance+name AND logic missed it entirely despite being only 11.8m
# apart. Confirms the very-close-distance guard now catches it regardless of name.
lotem_existing = [{"id": 1, "name": "גן שעשועים – לילך, עפולה", "google_place_id": "existing_place_id", "lat": 32.6173182, "lon": 35.2824047}]
lotem_new = {"place_id": "ChIJD8_6OkJTHBURPLkO6jVZ-RU", "name": "גן לוטם", "lat": 32.61741, "lon": 35.28243}
dist_m4 = haversine_km(lotem_existing[0]["lat"], lotem_existing[0]["lon"], lotem_new["lat"], lotem_new["lon"]) * 1000
outcome4, matched4, _score4 = match_against_existing(lotem_new, lotem_existing)
check(
    "Batch 3's 11.8m גן לוטם duplicate (0% name overlap) now caught as STRONG_MATCH",
    outcome4 == STRONG_MATCH,
    f"{dist_m4:.1f}m apart, 0% name overlap, outcome={outcome4} (expected {STRONG_MATCH} - "
    f"was {NEW_CANDIDATE} before the very-close-distance guard)",
)

print("\n=== Over-merge guard: two genuinely distinct playgrounds ~35.6m apart must NOT be auto-merged ===")
# 2026-09-12 UPDATED (three-zone model, post-Batch-6): 35.6m now falls in the new (30m,50m]
# POSSIBLE_DUPLICATE zone, which is distance-only-triggered regardless of name score - this test's
# expectation changed from NEW_CANDIDATE to POSSIBLE_DUPLICATE (zone 2 always fires in this range,
# by design - see BORDERLINE_MAX_METERS in matching.py). The guarantee this test actually proves
# did NOT change: nothing here is auto-merged or auto-approved - POSSIBLE_DUPLICATE only ever
# queues for human review, exactly like STRONG_MATCH does. A genuinely distinct playground in this
# zone gets flagged for a human to look at, not silently kept OR silently merged either way.
distinct_existing = [{"id": 1, "name": "גן הדקל", "google_place_id": "existing_place_id_2", "lat": 32.100000, "lon": 34.900000}]
distinct_new = {"place_id": "some_other_place_id", "name": "גן הארז", "lat": 32.10032016, "lon": 34.900000}  # exactly 35.6m north
dist_m5 = haversine_km(distinct_existing[0]["lat"], distinct_existing[0]["lon"], distinct_new["lat"], distinct_new["lon"]) * 1000
outcome5, matched5, score5 = match_against_existing(distinct_new, distinct_existing)
check(
    "distinct playground ~35.6m away, 0% name overlap -> POSSIBLE_DUPLICATE (flagged, not merged)",
    outcome5 == POSSIBLE_DUPLICATE,
    f"{dist_m5:.1f}m apart, 0% name overlap, outcome={outcome5} (expected {POSSIBLE_DUPLICATE} - "
    f"the zone-2 safety net always fires here regardless of name, it just never auto-merges)",
)
check(
    "that same case is NEVER auto-merged (not MATCH_CONFIRMED)",
    outcome5 != MATCH_CONFIRMED,
    f"outcome={outcome5} - MATCH_CONFIRMED would mean silent suppression with no review, "
    f"which must never happen from distance/name heuristics alone (only exact place_id equality)",
)

# ============================================================================================
# Three-zone model regression tests (2026-09-12, post-Batch-6 "פארק עירוני 76" case: 32.0m,
# 0% name similarity, fell 2m past the old flat 30m cutoff and was auto-approved as new). A hard
# cliff at one distance means 30.0m and 30.1m have wildly different consequences. Fix: a genuine
# third zone - (30m, 50m] -> POSSIBLE_DUPLICATE, a "look before approving" flag that is NOT a
# duplicate confirmation and NEVER auto-merges, distinct from STRONG_MATCH. All coordinate deltas
# below are exact (computed via the same haversine_km function, pure due-north offsets, which are
# exact great-circle distances, not approximations) - verified to the sub-millimeter before use.
# ============================================================================================
BASE = {"lat": 32.100000, "lon": 34.900000}
_EARTH_RADIUS_KM = 6371.0


def _lat_offset_for_distance_m(target_m):
    # Full-precision inline computation (not a truncated lookup table) - a pure due-north offset
    # is an exact great-circle distance (a meridian is a great circle), so this is exact, not
    # approximate, given full float precision. Boundary tests (exactly 30m/50m) need this
    # precision - a truncated table value was found to drift by ~0.4mm during test development,
    # enough to push an exactly-30m case 0.0004m over the <= 30 boundary into the wrong zone.
    import math
    return (target_m / 1000 / _EARTH_RADIUS_KM) * (180 / math.pi)


def make_pair(target_m, name_a="גן קיים", name_b="מקום אחר לגמרי"):
    existing = [{"id": "e1", "name": name_a, "google_place_id": "existing_pid", "lat": BASE["lat"], "lon": BASE["lon"]}]
    discovered = {"place_id": "new_pid", "name": name_b, "lat": BASE["lat"] + _lat_offset_for_distance_m(target_m), "lon": BASE["lon"]}
    actual_dist = haversine_km(BASE["lat"], BASE["lon"], discovered["lat"], discovered["lon"]) * 1000
    return discovered, existing, actual_dist


print("\n=== Three-zone regression 1: 29m, 0% name similarity -> STRONG_MATCH ===")
d, e, dist = make_pair(29)
outcome, match, score = match_against_existing(d, e)
check("29m -> STRONG_MATCH", outcome == STRONG_MATCH, f"{dist:.4f}m, outcome={outcome} (expected {STRONG_MATCH})")

print("\n=== Three-zone regression 2: exactly 30m, 0% name similarity -> STRONG_MATCH (inclusive boundary) ===")
d, e, dist = make_pair(30)
outcome, match, score = match_against_existing(d, e)
check("30m (boundary, inclusive) -> STRONG_MATCH", outcome == STRONG_MATCH, f"{dist:.4f}m, outcome={outcome} (expected {STRONG_MATCH})")

print("\n=== Three-zone regression 3: 31m, 0% name similarity -> POSSIBLE_DUPLICATE ===")
d, e, dist = make_pair(31)
outcome, match, score = match_against_existing(d, e)
check("31m -> POSSIBLE_DUPLICATE", outcome == POSSIBLE_DUPLICATE, f"{dist:.4f}m, outcome={outcome} (expected {POSSIBLE_DUPLICATE})")

print("\n=== Three-zone regression 4: 32m, 0% name similarity -> POSSIBLE_DUPLICATE (the actual Batch 6 case) ===")
# This is not synthetic - it reproduces the real "פארק עירוני 76" vs "גן שעשועים – נחל דן, כרמיאל"
# case (32.0m, 0% name similarity) that triggered this whole fix.
d, e, dist = make_pair(32, name_a="גן שעשועים – נחל דן, כרמיאל", name_b="פארק עירוני 76")
outcome, match, score = match_against_existing(d, e)
check(
    "32m, the actual פארק עירוני 76 case -> POSSIBLE_DUPLICATE (was silently NEW_CANDIDATE before this fix)",
    outcome == POSSIBLE_DUPLICATE,
    f"{dist:.4f}m, name_score={score}, outcome={outcome} (expected {POSSIBLE_DUPLICATE})",
)

print("\n=== Three-zone regression 5: exactly 50m, 0% name similarity -> POSSIBLE_DUPLICATE (inclusive boundary) ===")
d, e, dist = make_pair(50)
outcome, match, score = match_against_existing(d, e)
check("50m (boundary, inclusive) -> POSSIBLE_DUPLICATE", outcome == POSSIBLE_DUPLICATE, f"{dist:.4f}m, outcome={outcome} (expected {POSSIBLE_DUPLICATE})")

print("\n=== Three-zone regression 6: 51m, 0% name similarity -> falls through to existing (zone 3) logic ===")
# Beyond BORDERLINE_MAX_METERS, the pre-existing distance+name logic applies unchanged. With 0%
# name similarity (below even the 0.3 NEEDS_REVIEW floor) and no other candidate, this must reach
# genuine NEW_CANDIDATE - proving zone 3 was NOT touched by this change.
d, e, dist = make_pair(51)
outcome, match, score = match_against_existing(d, e)
check("51m, 0% name -> NEW_CANDIDATE (zone 3, unchanged)", outcome == NEW_CANDIDATE, f"{dist:.4f}m, outcome={outcome} (expected {NEW_CANDIDATE})")

print("\n=== Three-zone regression 8: <=30m (zone 1) never resolves to MATCH_CONFIRMED (no auto-merge) ===")
all_zone1_safe = True
for m in (29, 30):
    d, e, dist = make_pair(m)
    outcome, _, _ = match_against_existing(d, e)
    if outcome == MATCH_CONFIRMED:
        all_zone1_safe = False
check("zone 1 (<=30m) never auto-merges via the distance heuristic", all_zone1_safe, "29m and 30m cases both resolve to STRONG_MATCH (review), never MATCH_CONFIRMED")

print("\n=== Three-zone regression 9: 30-50m (zone 2) never resolves to MATCH_CONFIRMED or STRONG_MATCH ===")
all_zone2_safe = True
zone2_outcomes = []
for m in (31, 32, 50):
    d, e, dist = make_pair(m)
    outcome, _, _ = match_against_existing(d, e)
    zone2_outcomes.append((m, outcome))
    if outcome in (MATCH_CONFIRMED, STRONG_MATCH):
        all_zone2_safe = False
check(
    "zone 2 (30-50m) never auto-merges and never escalates to STRONG_MATCH even with matching names",
    all_zone2_safe,
    f"outcomes: {zone2_outcomes} (all expected {POSSIBLE_DUPLICATE}, never {MATCH_CONFIRMED}/{STRONG_MATCH})",
)

print("\n=== Three-zone regression 9b: 45m + HIGHLY similar name still stays POSSIBLE_DUPLICATE, not STRONG_MATCH ===")
# Explicit design requirement: zone 2 does NOT escalate to STRONG_MATCH even with strong name
# evidence (example C in the spec: "45m + highly similar name -> POSSIBLE_DUPLICATE").
d45, e45, dist45 = make_pair(45, name_a="גן שעשועים הדקל המרכזי", name_b="גן שעשועים הדקל המרכזי")
outcome, match, score = match_against_existing(d45, e45)
check(
    "45m + identical name still POSSIBLE_DUPLICATE, not STRONG_MATCH",
    outcome == POSSIBLE_DUPLICATE,
    f"{dist45:.2f}m, name_score={score} (should be 1.0, identical names), outcome={outcome} "
    f"(expected {POSSIBLE_DUPLICATE} - zone 2 never escalates on name alone)",
)

print("\n" + "=" * 60)
if failures:
    print(f"{len(failures)} FAILURE(S): {failures}")
    sys.exit(1)
else:
    print("ALL SCENARIOS PASSED")
    sys.exit(0)
