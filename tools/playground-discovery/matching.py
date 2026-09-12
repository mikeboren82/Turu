"""
TuRu - Playground/park discovery: normalization, classification, and matching.

Pure functions only - no network, no Supabase, no Google client. The word-overlap
similarity algorithm mirrors normalizeForMatch/wordOverlapScore already used twice
in the Node side of this project (tools/import-tool/server.js and
tools/import-tool/import-playgrounds-osm.js) - same approach, ported, not a new
invented metric living only here.
"""
import re
import unicodedata
from dataclasses import dataclass, field

from israel_geo import haversine_km

# ---- place classification (section 13/14) ----

PLAYGROUND_KEYWORDS = ["playground", "גן שעשועים", "גני שעשועים", "מתקני משחקים", "משחקייה"]
PARK_KEYWORDS = ["park", "פארק", "גן ציבורי", "גן לאומי"]
# Google Places (New) types relevant here - see
# https://developers.google.com/maps/documentation/places/web-service/place-types
PLAYGROUND_TYPES = {"playground"}
PARK_TYPES = {"park", "national_park", "state_park"}
# Types that should hard-disqualify a result even if it matched a keyword query
# (e.g. a toy shop showing up for the query "משחקייה") - section 13's explicit
# not-relevant examples.
NOT_RELEVANT_TYPES = {
    "school", "primary_school", "secondary_school", "store", "shopping_mall",
    "restaurant", "lodging", "hotel", "stadium", "gym", "toy_store",
}


def classify_place(*, primary_type: str | None, types: list[str] | None, name: str | None) -> str:
    """Returns one of PLAYGROUND / PARK_WITH_PLAYGROUND / PARK / UNCERTAIN / NOT_RELEVANT.
    Never guesses beyond what Google's own type/name data says - a park with no
    playground signal at all stays PARK (section 14: don't auto-promote every
    park to "has a playground")."""
    types_set = set(types or [])
    if primary_type:
        types_set.add(primary_type)
    name_lower = (name or "").lower()

    if types_set & NOT_RELEVANT_TYPES:
        return "NOT_RELEVANT"

    has_playground_type = bool(types_set & PLAYGROUND_TYPES)
    has_park_type = bool(types_set & PARK_TYPES)
    has_playground_word = any(kw in name_lower for kw in PLAYGROUND_KEYWORDS)
    has_park_word = any(kw in name_lower for kw in PARK_KEYWORDS)

    if has_playground_type or has_playground_word:
        if has_park_type or has_park_word:
            return "PARK_WITH_PLAYGROUND"
        return "PLAYGROUND"
    if has_park_type or has_park_word:
        return "PARK"
    if types_set or name:
        return "UNCERTAIN"
    return "NOT_RELEVANT"


# ---- normalization (section 12) ----

_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)
_WS_RE = re.compile(r"\s+")
# Common suffix/prefix noise words that hurt name-similarity matching but must
# NEVER be written back to the stored/original name (comparison-only, per the
# explicit "never alter the original Google name" instruction).
_COMPARISON_ONLY_STOPWORDS = {"park", "playground", "פארק", "גן", "שעשועים", "ציבורי"}


def normalize_for_match(s: str | None) -> str:
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", s)
    s = s.lower()
    s = _PUNCT_RE.sub(" ", s)
    s = _WS_RE.sub(" ", s).strip()
    return s


def word_overlap_score(a: str | None, b: str | None, *, drop_stopwords: bool = False) -> float:
    wa = set(w for w in normalize_for_match(a).split(" ") if len(w) > 1)
    wb = set(w for w in normalize_for_match(b).split(" ") if len(w) > 1)
    if drop_stopwords:
        wa -= _COMPARISON_ONLY_STOPWORDS
        wb -= _COMPARISON_ONLY_STOPWORDS
    if not wa or not wb:
        return 0.0
    common = len(wa & wb)
    return common / max(len(wa), len(wb))


# ---- data quality score (section 32) ----

def data_quality_score(*, has_place_id: bool, has_name: bool, has_address: bool,
                        has_coords: bool, place_kind: str) -> int:
    if has_place_id and has_name and has_address and has_coords and place_kind in ("PLAYGROUND", "PARK_WITH_PLAYGROUND"):
        return 100
    if has_place_id and has_name and has_coords and place_kind in ("PLAYGROUND", "PARK_WITH_PLAYGROUND", "PARK"):
        return 90
    if has_place_id and has_coords and place_kind in ("PARK", "UNCERTAIN"):
        return 70
    return 40


# ---- possible-duplicate detection across different place_ids (section 11) ----

DUPLICATE_DISTANCE_METERS = 30
DUPLICATE_NAME_SIMILARITY_THRESHOLD = 0.6


def is_possible_duplicate(a: dict, b: dict) -> bool:
    """a/b: dicts with lat/lon/name/formatted_address. Only ever used to FLAG
    (POSSIBLE_DUPLICATE, section 11) - never to silently merge or drop a record."""
    if a.get("lat") is None or b.get("lat") is None:
        return False
    dist_m = haversine_km(a["lat"], a["lon"], b["lat"], b["lon"]) * 1000
    if dist_m >= DUPLICATE_DISTANCE_METERS:
        return False
    name_score = word_overlap_score(a.get("name"), b.get("name"), drop_stopwords=True)
    return name_score >= DUPLICATE_NAME_SIMILARITY_THRESHOLD


# ---- matching a discovered place against TuRu's existing activities (section 26) ----

MATCH_CONFIRMED = "MATCH_CONFIRMED"
STRONG_MATCH = "STRONG_MATCH"
POSSIBLE_DUPLICATE = "POSSIBLE_DUPLICATE"
NEEDS_REVIEW = "NEEDS_REVIEW"
NEW_CANDIDATE = "NEW_CANDIDATE"

# 60m -> 100m (2026-09-12): Batch 1 found two real duplicates that fell just outside the old
# 60m cutoff (64.4m and 26m cases) and got auto-approved as "new" instead of STRONG_MATCH - GPS/
# geocoding jitter between two sources describing the same physical playground easily exceeds
# 60m; 100m still comfortably excludes genuinely distinct nearby playgrounds (>150m apart in
# this dataset). Mirrored in supabase/functions/_shared/placesDiscovery.ts.
STRONG_MATCH_DISTANCE_METERS = 100
STRONG_MATCH_NAME_SIMILARITY = 0.5
# 2026-09-12 (batch-3 validation): structural gap found in practice - two real duplicates in
# Batch 3 ("גן לוטם" vs "גן שעשועים – לילך, עפולה", 11.8m; the אבן גבירול pair, 16.4m) had 0%
# word overlap (a real official name vs. a generic address-based placeholder name for the same
# physical place from a different source) - the AND between distance+name required both, so
# these fell through to NEW_CANDIDATE and got auto-approved as "new". Fix: very-close distance
# alone is enough for STRONG_MATCH, independent of name - but deliberately *not* MATCH_CONFIRMED
# (which would drop the record with no trace): STRONG_MATCH still routes to human review, never
# auto-merges/deletes anything. Over-merge guard: 30m is intentionally conservative - well under
# the general 100m STRONG_MATCH radius, since geocoding jitter between two sources describing the
# same physical place almost always falls far under 30m, while genuinely distinct nearby
# playgrounds observed in this dataset are consistently >150m apart. Mirrored in
# supabase/functions/_shared/placesDiscovery.ts.
VERY_CLOSE_DISTANCE_METERS = 30
# 2026-09-12 (post-Batch-6, "פארק עירוני 76" - 32.0m, 0% name similarity, fell 2m past
# VERY_CLOSE and got auto-approved): a hard 30m/not-30m cliff means 30.0m and 30.1m have totally
# different consequences. Per explicit instruction: do NOT just raise the cutoff (moves the cliff,
# doesn't remove it) - add a genuine third zone. (30m, 50m] is NOT a duplicate confirmation, it's
# a "look at this before approving as new" flag - deliberately does NOT escalate to STRONG_MATCH
# even with a strong name match (45m + near-identical name still routes here, not STRONG_MATCH),
# so POSSIBLE_DUPLICATE and STRONG_MATCH stay conceptually distinct for an admin reviewer. Beyond
# 50m, falls through to the pre-existing distance+name logic unchanged (zone 3). Mirrored in
# supabase/functions/_shared/placesDiscovery.ts.
BORDERLINE_MAX_METERS = 50


def match_against_existing(discovered: dict, existing_activities: list[dict]) -> tuple[str, dict | None, float | None]:
    """discovered: {place_id, name, formatted_address, lat, lon}.
    existing_activities: rows already fetched from Supabase - each with
    {id, name, google_place_id, lat, lon, address}. Never invents a match -
    only MATCH_CONFIRMED (place_id equality) is treated as certain; everything
    else that's merely plausible becomes STRONG_MATCH/POSSIBLE_DUPLICATE/NEEDS_REVIEW, never
    auto-applied as a duplicate (section 26: "never create a duplicate activity
    just because the place turned up again in search" - the flip side, never
    silently skip a genuinely new place either). Returns (outcome, matched_existing, name_score) -
    name_score is only meaningful for POSSIBLE_DUPLICATE (evidence for the reviewer), None
    otherwise."""
    for existing in existing_activities:
        if existing.get("google_place_id") and existing["google_place_id"] == discovered.get("place_id"):
            return MATCH_CONFIRMED, existing, None

    best_candidate = None
    best_score = 0.0
    closest_very_close: tuple[dict, float] | None = None
    closest_borderline: tuple[dict, float, float] | None = None
    for existing in existing_activities:
        if existing.get("lat") is None or discovered.get("lat") is None:
            continue
        dist_m = haversine_km(existing["lat"], existing["lon"], discovered["lat"], discovered["lon"]) * 1000
        if dist_m > STRONG_MATCH_DISTANCE_METERS * 3:
            continue

        if dist_m <= VERY_CLOSE_DISTANCE_METERS:
            if closest_very_close is None or dist_m < closest_very_close[1]:
                closest_very_close = (existing, dist_m)
            continue  # Zone 1 - distance alone decides, no need to weigh name evidence here.

        name_score = word_overlap_score(existing.get("name"), discovered.get("name"), drop_stopwords=True)
        if dist_m <= BORDERLINE_MAX_METERS:
            # Zone 2 - deliberately does NOT check name_score against a threshold to escalate to
            # STRONG_MATCH (45m + a highly similar name still stays POSSIBLE_DUPLICATE). name_score
            # is still captured as evidence for the reviewer, not used to change the routing.
            if closest_borderline is None or dist_m < closest_borderline[1]:
                closest_borderline = (existing, dist_m, name_score)
            continue

        # Zone 3 (>50m) - pre-existing logic, unchanged.
        if dist_m <= STRONG_MATCH_DISTANCE_METERS and name_score >= STRONG_MATCH_NAME_SIMILARITY:
            return STRONG_MATCH, existing, name_score
        if name_score > best_score:
            best_score = name_score
            best_candidate = existing

    # אחרי הלולאה, לא early-return בתוכה - כדי לבחור את הקרוב-ביותר אם כמה existing נופלים
    # בטווח, לא סתם את הראשון לפי סדר-שרירותי.
    if closest_very_close is not None:
        return STRONG_MATCH, closest_very_close[0], None
    if closest_borderline is not None:
        return POSSIBLE_DUPLICATE, closest_borderline[0], closest_borderline[2]

    if best_candidate is not None and best_score >= 0.3:
        return NEEDS_REVIEW, best_candidate, best_score
    return NEW_CANDIDATE, None, None


@dataclass
class DiscoveredPlace:
    """One row of the in-memory dedup map (places_by_id, section 9/10)."""
    place_id: str
    name: str | None = None
    formatted_address: str | None = None
    lat: float | None = None
    lon: float | None = None
    types: list[str] = field(default_factory=list)
    primary_type: str | None = None
    google_maps_uri: str | None = None
    discovered_by_queries: set[str] = field(default_factory=set)
    discovered_by_grid_points: set[str] = field(default_factory=set)
    discovery_methods: set[str] = field(default_factory=set)
    occurrence_count: int = 0

    def merge_occurrence(self, *, query: str | None, grid_point_id: str | None, method: str) -> None:
        if query:
            self.discovered_by_queries.add(query)
        if grid_point_id:
            self.discovered_by_grid_points.add(grid_point_id)
        self.discovery_methods.add(method)
        self.occurrence_count += 1
