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
NEEDS_REVIEW = "NEEDS_REVIEW"
NEW_CANDIDATE = "NEW_CANDIDATE"

STRONG_MATCH_DISTANCE_METERS = 60
STRONG_MATCH_NAME_SIMILARITY = 0.5


def match_against_existing(discovered: dict, existing_activities: list[dict]) -> tuple[str, dict | None]:
    """discovered: {place_id, name, formatted_address, lat, lon}.
    existing_activities: rows already fetched from Supabase - each with
    {id, name, google_place_id, lat, lon, address}. Never invents a match -
    only MATCH_CONFIRMED (place_id equality) is treated as certain; everything
    else that's merely plausible becomes STRONG_MATCH or NEEDS_REVIEW, never
    auto-applied as a duplicate (section 26: "never create a duplicate activity
    just because the place turned up again in search" - the flip side, never
    silently skip a genuinely new place either)."""
    for existing in existing_activities:
        if existing.get("google_place_id") and existing["google_place_id"] == discovered.get("place_id"):
            return MATCH_CONFIRMED, existing

    best_candidate = None
    best_score = 0.0
    for existing in existing_activities:
        if existing.get("lat") is None or discovered.get("lat") is None:
            continue
        dist_m = haversine_km(existing["lat"], existing["lon"], discovered["lat"], discovered["lon"]) * 1000
        if dist_m > STRONG_MATCH_DISTANCE_METERS * 3:
            continue
        name_score = word_overlap_score(existing.get("name"), discovered.get("name"), drop_stopwords=True)
        if dist_m <= STRONG_MATCH_DISTANCE_METERS and name_score >= STRONG_MATCH_NAME_SIMILARITY:
            return STRONG_MATCH, existing
        if name_score > best_score:
            best_score = name_score
            best_candidate = existing

    if best_candidate is not None and best_score >= 0.3:
        return NEEDS_REVIEW, best_candidate
    return NEW_CANDIDATE, None


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
