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

# Places-origin incoming by explicit provenance: a Maps page_url, a google_maps_uri, or the Places-writer PAIR
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


def is_places_origin_candidate(extracted_data, page_url=None) -> bool:
    if is_google_maps_url(page_url):
        return True
    if not isinstance(extracted_data, dict):
        return False
    return (any(k in extracted_data for k in PLACES_EXPLICIT_KEYS)
            or all(k in extracted_data for k in PLACES_SIGNATURE_KEYS))


def assert_google_content_persistence_allowed(what: str) -> None:
    if not GOOGLE_PLACES_CONTENT_PERSISTENCE:
        raise GooglePlacesPersistenceDisabled(what)
