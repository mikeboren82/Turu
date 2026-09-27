"""
TuRu - GOOGLE PLACES PERSISTENCE POLICY, Python twin (release safety, 2026-09-27). Rule, rationale and the other twins:
tools/import-tool/lib/googlePlacesPolicy.js (Node) and supabase/functions/_shared/googlePlacesPolicy.ts (Deno), all
pinned by supabase/functions/_shared/googlePlacesPolicy.cases.json.

TURU may store a google_place_id (backfill_place_ids.py: a place id on an independently sourced activity). It must not
create new persistent Places-returned content: displayName, formattedAddress, a city derived from it, Places
coordinates, googleMapsUri, primaryType/types, websiteUri, photo metadata. So every Supabase writer here that would
create a Google-origin location / activity / incoming row refuses (GooglePlacesPersistenceDisabled), while the
discovery tools' list / dry-run / CSV modes keep working and make no Supabase write.

The switch is a code constant - there is no environment variable or flag that re-enables it.
"""
import re

GOOGLE_PLACES_CONTENT_PERSISTENCE = False
POLICY_REASON = "google_places_persistence_disabled"

_URL_RE = re.compile(r"^(?:([a-z][a-z0-9+.-]*):)?//(?:[^/?#@]*@)?([^/?#:]+)(?::\d+)?([^?#]*)", re.IGNORECASE)
_GOOGLE_DOMAIN = r"google\.(?:com|com\.[a-z]{2}|co\.[a-z]{2}|[a-z]{2})"
_MAPS_HOST_RE = re.compile(rf"maps\.{_GOOGLE_DOMAIN}")
_GOOGLE_HOST_RE = re.compile(rf"(?:www\.)?{_GOOGLE_DOMAIN}")

# Places-origin incoming by explicit provenance: a Maps page_url (or place URN), a google_maps_uri, or the Places-writer PAIR
# formatted_address + place_kind. A generic key alone (lat/lon/lng, a lone formatted_address or place_kind,
# google_place_id) never counts - independent OSM / GIS / municipal rows carry those.
PLACES_EXPLICIT_KEYS = ("google_maps_uri",)
PLACES_SIGNATURE_KEYS = ("formatted_address", "place_kind")


class GooglePlacesPersistenceDisabled(RuntimeError):
    """Raised by every writer that would persist Google Places content while the release policy is OFF."""

    def __init__(self, what: str):
        super().__init__(f"{POLICY_REASON}: {what}")
        self.code = POLICY_REASON


def _parse_url(url):
    if not isinstance(url, str):
        return None
    m = _URL_RE.match(url.strip())
    if not m:
        return None
    host = m.group(2).lower()
    return (host[:-1] if host.endswith(".") else host), (m.group(3) or "/")


def is_google_maps_url(url) -> bool:
    """A Google Maps web page / place link (googleMapsUri) - never the Places API hosts."""
    parsed = _parse_url(url)
    if not parsed:
        return False
    host, path = parsed
    if _MAPS_HOST_RE.fullmatch(host):
        return True
    if _GOOGLE_HOST_RE.fullmatch(host):
        return path == "/maps" or path.startswith("/maps/")
    if host == "maps.app.goo.gl":
        return True
    if host == "goo.gl":
        return path == "/maps" or path.startswith("/maps/")
    return False


# PERMANENT GOOGLE-ORIGIN MARKER (supabase/0115): activities/locations.content_origin = 'google_places_legacy' -
# historical, sticky (DB trigger), set only by the frozen backfill; never inferred from google_place_id, coordinates,
# title, category, proximity or the current source_url. Rule + rationale: the Node twin.
GOOGLE_CONTENT_ORIGIN = "google_places_legacy"
_GOOGLE_PLACE_URN_RE = re.compile(r"urn:google-place(?:-cid-removed)?:\S+", re.IGNORECASE)


def is_google_place_urn(url) -> bool:
    """Side-table replacement for a Maps page_url (scrub phases P10/P11)."""
    return isinstance(url, str) and bool(_GOOGLE_PLACE_URN_RE.fullmatch(url.strip()))


def _get(row: dict, snake: str, camel: str):
    value = row.get(snake)
    return row.get(camel) if value is None else value


def has_google_content_origin(row) -> bool:
    return isinstance(row, dict) and _get(row, "content_origin", "contentOrigin") == GOOGLE_CONTENT_ORIGIN


def is_google_origin_activity(row) -> bool:
    """The permanent marker OR (migration window) a Maps source_url / place URN - never google_place_id."""
    if not isinstance(row, dict):
        return False
    source_url = _get(row, "source_url", "sourceUrl")
    return has_google_content_origin(row) or is_google_maps_url(source_url) or is_google_place_urn(source_url)


def is_google_origin_location(loc) -> bool:
    """Its own marker, OR (before the location backfill) an embedded Google-origin activity; an orphan only by its marker."""
    if not isinstance(loc, dict):
        return False
    if has_google_content_origin(loc):
        return True
    acts = loc.get("activities")
    return isinstance(acts, list) and any(is_google_origin_activity(a) for a in acts)


def is_places_origin_candidate(extracted_data, page_url=None) -> bool:
    if is_google_maps_url(page_url) or is_google_place_urn(page_url):
        return True
    if not isinstance(extracted_data, dict):
        return False
    return (any(k in extracted_data for k in PLACES_EXPLICIT_KEYS)
            or all(k in extracted_data for k in PLACES_SIGNATURE_KEYS))


def assert_google_content_persistence_allowed(what: str) -> None:
    if not GOOGLE_PLACES_CONTENT_PERSISTENCE:
        raise GooglePlacesPersistenceDisabled(what)
