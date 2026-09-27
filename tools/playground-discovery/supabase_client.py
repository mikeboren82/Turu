"""
TuRu - Playground/park discovery: minimal Supabase REST client.

Deliberately NOT the `supabase-py` package - this project's Node tooling
(tools/import-tool/supabase.js) already talks to Supabase with nothing more
than @supabase/supabase-js's auth+PostgREST calls, and the equivalent here is
a handful of plain HTTP calls. Reuses the SAME bot-account credentials already
sitting in tools/import-tool/.env (SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY,
SUPABASE_BOT_EMAIL, SUPABASE_BOT_PASSWORD) instead of asking for a second,
parallel credentials file - one source of truth for "who is this script" as
the existing Node scripts (section 18/30: reuse existing credentials).

Read-only by default. insert_new_playground() is only ever called from
playground_discovery.py behind --import-supabase, and only for a "master"
row (classify_and_bucket) that ALSO resolves to NEW_CANDIDATE against the
existing TuRu catalog (matching.py) - i.e. legit source + has an address +
genuinely not already in TuRu. Everything else that isn't a clear reject
(STRONG_MATCH/NEEDS_REVIEW against an existing activity, or classify_and_bucket's
own review_rows: missing address, uncertain type, possible in-batch duplicate,
park-without-clear-playground) goes to insert_incoming_activity() instead -
a real review queue a human can act on, not a CSV nobody in the app sees.
"""
import os
import re
from pathlib import Path
from urllib.parse import unquote

import httpx

IMPORT_TOOL_ENV_PATH = Path(__file__).resolve().parent.parent / "import-tool" / ".env"


# ---- Places image automation: what counts as a TRUSTWORTHY image (2026-09-26, identity rule 2026-09-27) --------
# Only these block the places_photos job (candidate selection, pre-insert race re-check, ledger pruning):
#   A. a place-photo proxy row FOR THIS ACTIVITY'S PLACE - the URL's embedded place id (.../place-photo/<id>) equals
#      the activity's current google_place_id - whatever its status or legacy metadata (a rejected same-place proxy is
#      an admin decision the job must not undo; a second same-place proxy is a duplicate). URL identity is
#      authoritative: a proxy embedding ANOTHER place id (copied across a merge - production row ee34196d) or a
#      PROVIDER label on a wrong-id URL never blocks, whatever its status; the job adds the correct proxy beside it
#      and never modifies or deletes the wrong row.
#   B. an approved ORIGINAL_SOURCE non-proxy image whose rights are not under review
# Everything else - pending, rejected, EXTERNAL_SOURCE, UNKNOWN, null provenance, needs_rights_review=true,
# a non-proxy PROVIDER url, a wrong-place proxy - never blocks one proxy insert (and is never changed by the job).
# Server side (TRUSTED_IMAGE_OR) PostgREST can only express B: an embedded filter cannot compare a URL with the parent
# row's google_place_id. So the server anti-join removes B rows and the job removes A rows itself with
# is_trusted_image(img, place_id) - the same function the race re-check and the ledger prune use. Paging is on raw
# pages, so rows the job drops never end the walk early.
PLACE_PHOTO_PROXY_RE = re.compile(r"/functions/v1/place-photo/([^/?#]+)")
TRUSTED_IMAGE_OR = ('(and(status.eq.approved,image_source_type.eq.ORIGINAL_SOURCE,needs_rights_review.not.is.true,'
                    'url.not.like."*/functions/v1/place-photo/_*"))')
IMAGE_META = "id,url,status,image_source_type,needs_rights_review"


def is_place_photo_proxy(url) -> bool:
    return isinstance(url, str) and bool(PLACE_PHOTO_PROXY_RE.search(url))


def proxy_place_id(url) -> str | None:
    """The place id a proxy URL embeds (last path segment after place-photo/), or None for a non-proxy URL."""
    if not isinstance(url, str):
        return None
    m = PLACE_PHOTO_PROXY_RE.search(url)
    return unquote(m.group(1)) if m else None


def is_trusted_image(img: dict, place_id: str | None) -> bool:
    embedded = proxy_place_id(img.get("url"))
    if embedded is not None:
        return bool(place_id) and embedded == place_id
    return (img.get("status") == "approved" and img.get("image_source_type") == "ORIGINAL_SOURCE"
            and img.get("needs_rights_review") is not True)


def image_state(row: dict) -> dict:
    """Race-guard / prune view of one activity row selected with activity_images(IMAGE_META). Trust is judged
    against the row's CURRENT google_place_id."""
    images = row.get("activity_images") or []
    pid = row.get("google_place_id")
    return {"id": row["id"], "status": row.get("status"), "google_place_id": pid,
            "has_trusted_image": any(is_trusted_image(i, pid) for i in images), "image_count": len(images)}

# Python port of tools/import-tool/playgroundNaming.js's GENERIC_NAME_PATTERNS/
# TECHNICAL_VALUE_PATTERNS (also ported separately to supabase/functions/_shared/
# playgroundNaming.ts for Deno) - three runtimes, one file each can't share, kept
# behaviorally identical on purpose. Used here only to decide whether a Google
# Places displayName is trustworthy enough to store as-is (see insert_new_playground).
_GENERIC_NAME_PATTERNS = [
    re.compile(r"^גן שעשועים\s*-\s*"), re.compile(r"^גן שעשועים ציבורי\s*-\s*"),
    re.compile(r"^גן שעשועים\s*$"), re.compile(r"^playground\s*$", re.IGNORECASE),
]
_TECHNICAL_VALUE_PATTERNS = [
    re.compile(r"^(null|undefined|nan|n/a|none|-|—|\.)$", re.IGNORECASE),
    re.compile(r"^https?://", re.IGNORECASE),
    re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE),
]


# Python port of tools/import-tool/cityNaming.js (also ported to supabase/functions/_shared/
# cityNaming.ts for Deno) - same "one canonical spelling per settlement" principle, kept
# behaviorally identical across all three runtimes on purpose.
_HYPHEN_LIKE_RE = re.compile(r"[-־–—]")
_KRIAT_RE = re.compile(r"(^|\s)קרית(\s|$)")


def normalizeCityName(city: str | None) -> str | None:
    if not city:
        return city
    s = str(city).strip()
    if not s:
        return s
    s = s.split("|")[0].strip()
    s = _HYPHEN_LIKE_RE.sub(" ", s)
    s = _KRIAT_RE.sub(r"\1קריית\2", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def extract_city_from_address(address: str | None) -> str | None:
    """Google's formatted_address ends with the locality (e.g. "עזר וייצמן 7,
    הוד השרון" or a bare "נהריה" with no comma at all) - last comma-segment is
    a reliable-enough heuristic, same idea as the Node migration's address
    parsing. Used because insert_new_playground previously stored `address`
    but never derived `city` from it at all (found in practice: all 80 rows
    from the 2026-09-11 settlement_gap_fill.py run had city=NULL)."""
    if not address:
        return None
    parts = [p.strip() for p in address.split(",") if p.strip()]
    if not parts:
        return None
    return normalizeCityName(parts[-1])


def isGenericPlaygroundName(name: str | None) -> bool:
    trimmed = (name or "").strip()
    if not trimmed:
        return True
    if any(p.search(trimmed) for p in _TECHNICAL_VALUE_PATTERNS):
        return True
    return any(p.search(trimmed) for p in _GENERIC_NAME_PATTERNS)


def load_import_tool_env() -> None:
    """Loads tools/import-tool/.env into os.environ (without overwriting values
    already set, e.g. by this script's own .env) - `python-dotenv` handles the
    parsing; we just point it at the existing file instead of duplicating it."""
    from dotenv import load_dotenv
    if IMPORT_TOOL_ENV_PATH.exists():
        load_dotenv(IMPORT_TOOL_ENV_PATH, override=False)


class SupabaseBotClient:
    def __init__(self, *, transport: httpx.AsyncBaseTransport | None = None):
        self.url = os.environ.get("SUPABASE_URL")
        self.anon_key = os.environ.get("SUPABASE_PUBLISHABLE_KEY")
        self.bot_email = os.environ.get("SUPABASE_BOT_EMAIL")
        self.bot_password = os.environ.get("SUPABASE_BOT_PASSWORD")
        missing = [
            name for name, val in [
                ("SUPABASE_URL", self.url), ("SUPABASE_PUBLISHABLE_KEY", self.anon_key),
                ("SUPABASE_BOT_EMAIL", self.bot_email), ("SUPABASE_BOT_PASSWORD", self.bot_password),
            ] if not val
        ]
        if missing:
            raise RuntimeError(
                f"Missing Supabase credentials: {', '.join(missing)} "
                f"(expected in {IMPORT_TOOL_ENV_PATH})"
            )
        self._access_token = None
        self._bot_user_id = None
        self._transport = transport  # tests only (httpx.MockTransport); None = the real network

    def _http(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=30.0, transport=self._transport)

    async def _headers(self, client: httpx.AsyncClient, **extra) -> dict:
        token = await self._ensure_session(client)
        return {"apikey": self.anon_key, "Authorization": f"Bearer {token}", **extra}

    async def _ensure_session(self, client: httpx.AsyncClient) -> str:
        if self._access_token:
            return self._access_token
        resp = await client.post(
            f"{self.url}/auth/v1/token?grant_type=password",
            headers={"apikey": self.anon_key, "Content-Type": "application/json"},
            json={"email": self.bot_email, "password": self.bot_password},
        )
        resp.raise_for_status()
        data = resp.json()
        self._access_token = data["access_token"]
        self._bot_user_id = data["user"]["id"]
        return self._access_token

    async def fetch_activities_for_matching(self) -> list[dict]:
        """Only the fields matching.py needs - id/name/google_place_id/lat/lng/
        address, via the locations join, paginated past PostgREST's 1000-row
        default cap (the exact same silent-truncation gotcha already documented
        in tools/import-tool/import-playgrounds-osm.js - handled the same way
        here, not re-discovered the hard way twice)."""
        async with httpx.AsyncClient(timeout=30.0) as client:
            token = await self._ensure_session(client)
            headers = {"apikey": self.anon_key, "Authorization": f"Bearer {token}"}
            rows: list[dict] = []
            page_size = 1000
            offset = 0
            while True:
                resp = await client.get(
                    f"{self.url}/rest/v1/activities",
                    headers={**headers, "Range": f"{offset}-{offset + page_size - 1}"},
                    params={"select": "id,name,google_place_id,location:locations(lat,lng,address)"},
                )
                resp.raise_for_status()
                page = resp.json()
                for row in page:
                    loc = row.get("location") or {}
                    rows.append({
                        "id": row["id"],
                        "name": row.get("name"),
                        "google_place_id": row.get("google_place_id"),
                        "lat": loc.get("lat"),
                        "lon": loc.get("lng"),
                        "address": loc.get("address"),
                    })
                if len(page) < page_size:
                    break
                offset += page_size
            return rows

    async def fetch_settlement_centroids(self) -> list[dict]:
        """One row per distinct city name, with an approximate center (average
        lat/lng across ALL of TuRu's activities in that city - not just
        playgrounds, so cities with zero playgrounds today still get a usable
        center point) and the playground count already on record there.
        Used by settlement_gap_check.py to decide where a real-world Google
        Nearby Search count meaningfully exceeds what's already in TuRu -
        real settlement locations from data we already have, not an arbitrary
        geometric grid (see the 2026-09-11 gap-analysis discussion)."""
        async with httpx.AsyncClient(timeout=30.0) as client:
            token = await self._ensure_session(client)
            headers = {"apikey": self.anon_key, "Authorization": f"Bearer {token}"}
            rows: list[dict] = []
            page_size = 1000
            offset = 0
            while True:
                resp = await client.get(
                    f"{self.url}/rest/v1/activities",
                    headers={**headers, "Range": f"{offset}-{offset + page_size - 1}"},
                    params={"select": "category,location:locations(city,lat,lng)"},
                )
                resp.raise_for_status()
                page = resp.json()
                rows.extend(page)
                if len(page) < page_size:
                    break
                offset += page_size

        by_city: dict[str, dict] = {}
        for row in rows:
            loc = row.get("location") or {}
            city = (loc.get("city") or "").strip()
            if not city or loc.get("lat") is None or loc.get("lng") is None:
                continue
            bucket = by_city.setdefault(city, {"lat_sum": 0.0, "lng_sum": 0.0, "n": 0, "playground_count": 0})
            bucket["lat_sum"] += loc["lat"]
            bucket["lng_sum"] += loc["lng"]
            bucket["n"] += 1
            if row.get("category") == "גן שעשועים":
                bucket["playground_count"] += 1

        return [
            {
                "city": city,
                "lat": b["lat_sum"] / b["n"],
                "lng": b["lng_sum"] / b["n"],
                "playground_count": b["playground_count"],
            }
            for city, b in by_city.items()
        ]

    async def fetch_activities_needing_images(self) -> list[dict]:
        """Activities with a known google_place_id but no activity_images row
        yet - candidates for image enrichment. PostgREST embedded-resource
        select (activity_images(id)) lets us filter client-side instead of a
        raw NOT EXISTS query, same pagination handling as
        fetch_activities_for_matching (1000-row page cap)."""
        async with httpx.AsyncClient(timeout=30.0) as client:
            token = await self._ensure_session(client)
            headers = {"apikey": self.anon_key, "Authorization": f"Bearer {token}"}
            rows: list[dict] = []
            page_size = 1000
            offset = 0
            while True:
                resp = await client.get(
                    f"{self.url}/rest/v1/activities",
                    headers={**headers, "Range": f"{offset}-{offset + page_size - 1}"},
                    params={
                        "select": "id,name,google_place_id,source_url,activity_images(id)",
                        "google_place_id": "not.is.null",
                    },
                )
                resp.raise_for_status()
                page = resp.json()
                rows.extend(row for row in page if not row.get("activity_images"))
                if len(page) < page_size:
                    break
                offset += page_size
            return rows

    # ---- Places image automation (2026-09-26, enrich_images.py / Monster job places_photos) ----------------
    # The scheduled cohort is selected SERVER-SIDE: approved only (never archived / pending / rejected), a
    # google_place_id, no approved rights-clear ORIGINAL_SOURCE image (anti-join on the `trusted` embed filtered by
    # TRUSTED_IMAGE_OR - the bot is a trusted uploader, so images_read shows it pending/rejected images of approved
    # rows too; a same-place proxy is dropped by the job itself, see TRUSTED_IMAGE_OR above), created
    # before the grace instant, oldest first (created_at, id) with keyset paging and a server-side limit. The
    # unfiltered `images` embed carries the minimal metadata for the job's own re-evaluation and the list report.
    CANDIDATE_SELECT = (f"id,name,google_place_id,source_url,status,created_at,"
                        f"trusted:activity_images(id),images:activity_images({IMAGE_META})")

    @staticmethod
    def places_photo_candidate_params(*, created_before: str, created_after: str | None = None,
                                      activity_ids: list[str] | None = None, after: tuple[str, str] | None = None,
                                      limit: int = 100) -> list[tuple[str, str]]:
        params = [
            ("select", SupabaseBotClient.CANDIDATE_SELECT),
            ("status", "eq.approved"),
            ("google_place_id", "not.is.null"),
            ("trusted.or", TRUSTED_IMAGE_OR),
            ("trusted", "is.null"),
            ("created_at", f"lt.{created_before}"),
        ]
        if created_after:
            params.append(("created_at", f"gt.{created_after}"))
        if activity_ids:
            params.append(("id", f"in.({','.join(activity_ids)})"))
        if after:
            ts, last_id = after
            params.append(("or", f'(created_at.gt."{ts}",and(created_at.eq."{ts}",id.gt.{last_id}))'))
        params.append(("order", "created_at.asc,id.asc"))
        params.append(("limit", str(int(limit))))
        return params

    async def fetch_places_photo_candidates_page(self, **kwargs) -> list[dict]:
        """One raw keyset page, exactly as the server ordered and limited it - the caller pages on its length and
        re-checks every row with candidate_rejection() (belt and braces), so a dropped row never ends paging."""
        async with self._http() as client:
            headers = await self._headers(client)
            resp = await client.get(f"{self.url}/rest/v1/activities", headers=headers,
                                    params=self.places_photo_candidate_params(**kwargs))
            resp.raise_for_status()
            return resp.json()

    # candidate_rejection() reason for the one rule the server cannot express (A: a same-place proxy) - an expected
    # client-side drop, not a server mismatch
    SAME_PLACE_PROXY = "same_place_proxy"

    @staticmethod
    def candidate_rejection(row: dict) -> str | None:
        """None = a valid candidate; otherwise why a row the server returned must not be used."""
        if row.get("status") != "approved":
            return "not_approved"
        pid = row.get("google_place_id")
        if not pid:
            return "no_place_id"
        images = row.get("images") or []
        if any(proxy_place_id(i.get("url")) == pid for i in images):
            return SupabaseBotClient.SAME_PLACE_PROXY
        if row.get("trusted") or any(is_trusted_image(i, pid) for i in images):
            return "trusted_image"
        return None

    async def fetch_activity_image_state(self, activity_id: str) -> dict | None:
        """Fresh per-activity state right before an insert (race guard): status, google_place_id and whether a
        TRUSTWORTHY image exists now. None = the row is no longer visible to the bot."""
        async with self._http() as client:
            headers = await self._headers(client)
            resp = await client.get(f"{self.url}/rest/v1/activities", headers=headers, params={
                "select": f"id,status,google_place_id,activity_images({IMAGE_META})", "id": f"eq.{activity_id}"})
            resp.raise_for_status()
            rows = resp.json()
            return image_state(rows[0]) if rows else None

    async def fetch_activity_image_states(self, activity_ids: list[str]) -> dict[str, dict]:
        """Same as fetch_activity_image_state for many ids (ledger pruning), 100 ids per request."""
        out: dict[str, dict] = {}
        async with self._http() as client:
            headers = await self._headers(client)
            for i in range(0, len(activity_ids), 100):
                chunk = activity_ids[i:i + 100]
                resp = await client.get(f"{self.url}/rest/v1/activities", headers=headers, params={
                    "select": f"id,status,google_place_id,activity_images({IMAGE_META})",
                    "id": f"in.({','.join(chunk)})"})
                resp.raise_for_status()
                for row in resp.json():
                    out[row["id"]] = image_state(row)
        return out

    async def read_setting(self, key: str, default=None):
        async with self._http() as client:
            headers = await self._headers(client)
            resp = await client.get(f"{self.url}/rest/v1/automation_settings", headers=headers,
                                    params={"select": "value", "key": f"eq.{key}"})
            resp.raise_for_status()
            rows = resp.json()
            return rows[0]["value"] if rows else default

    async def write_setting(self, key: str, value) -> None:
        async with self._http() as client:
            headers = await self._headers(client, **{"Content-Type": "application/json",
                                                     "Prefer": "resolution=merge-duplicates,return=minimal"})
            resp = await client.post(f"{self.url}/rest/v1/automation_settings", headers=headers,
                                     params={"on_conflict": "key"}, json={"key": key, "value": value})
            resp.raise_for_status()

    async def set_activity_google_place_id(self, *, activity_id: str, place_id: str) -> None:
        """UPDATEs a single existing activity's google_place_id - the backfill
        counterpart to insert_new_playground (which only ever INSERTs brand-new
        rows for NEW_CANDIDATE matches). Only ever called from
        backfill_place_ids.py, and only after a STRONG_MATCH-grade confidence
        check (distance + name similarity) - never for a NEEDS_REVIEW-grade
        guess. supabase/0055's unique index on google_place_id (where not null)
        means a second activity matching the same real-world place raises a
        23505 conflict here - the caller is expected to catch and skip it
        rather than silently overwrite the first activity's link."""
        async with httpx.AsyncClient(timeout=30.0) as client:
            token = await self._ensure_session(client)
            headers = {
                "apikey": self.anon_key, "Authorization": f"Bearer {token}",
                "Content-Type": "application/json", "Prefer": "return=minimal",
            }
            resp = await client.patch(
                f"{self.url}/rest/v1/activities", headers=headers,
                params={"id": f"eq.{activity_id}"},
                json={"google_place_id": place_id},
            )
            resp.raise_for_status()

    async def insert_place_photo_reference(self, *, activity_id: str, photo_url: str, google_maps_uri: str | None) -> None:
        """Adds an activity_images row pointing at the ToS-compliant proxy URL
        (supabase/functions/place-photo) - never a raw Google-hosted photo URL,
        see fetch_activities_needing_images docstring. image_source_type
        'PROVIDER' + image_source_url (supabase/0047) records where this came
        from without implying rights review is needed - Google's own listing
        photos, not scraped from a third-party site."""
        async with self._http() as client:
            token = await self._ensure_session(client)
            headers = {
                "apikey": self.anon_key, "Authorization": f"Bearer {token}",
                "Content-Type": "application/json", "Prefer": "return=minimal",
            }
            resp = await client.post(
                f"{self.url}/rest/v1/activity_images", headers=headers,
                json={
                    "activity_id": activity_id,
                    "url": photo_url,
                    "uploaded_by": self._bot_user_id,
                    "image_source_type": "PROVIDER",
                    "image_source_url": google_maps_uri,
                    "needs_rights_review": False,
                },
            )
            resp.raise_for_status()

    async def insert_new_playground(self, *, name: str, address: str | None, lat: float, lon: float,
                                     place_id: str, google_maps_uri: str | None, created_by: str | None = None) -> str:
        """Creates ONE new location + activity row, mirroring the exact shape
        saveNewActivity (server.js) already writes for scraped content - same
        status='approved'/source='scraped' convention, not a new workflow.
        Returns the new activity id. Never called for anything but NEW_CANDIDATE.

        created_by is always the bot's own auth id regardless of what's passed in -
        activities_insert RLS (supabase/schema.sql) requires `created_by = auth.uid()`,
        so a null/other value 403s (found in practice: 123/123 discovery imports failed
        silently-ish this way before this fix, same root cause as the activity_images
        uploaded_by RLS bug fixed earlier - "who is actually making this request" has
        to be the authenticated bot, not whatever the caller happens to pass)."""
        async with httpx.AsyncClient(timeout=30.0) as client:
            token = await self._ensure_session(client)
            headers = {
                "apikey": self.anon_key, "Authorization": f"Bearer {token}",
                "Content-Type": "application/json", "Prefer": "return=representation",
            }
            # Google לפעמים מחזיר displayName גנרי/ריק-מתוכן (למשל "גן שעשועים" בלי שום פרט
            # מבדיל - נצפה בפועל ב-12/123 מהייבוא הראשון) - לא שונה במהותו מ"גן שעשועים ציבורי -
            # X" הישן שכל הפרויקט הזה קיים כדי לתקן, אז לא סביר להתייחס אליו כ-name_source='official'
            # סתם כי המקור הוא Google. formatted_address של Google גם לא בפורמט הנקי "רחוב[
            # מספר], עיר" שהמיגרציה/playgroundNaming.js מצפים לו (משתנה בפורמט/שפה/פרטיות -
            # ראו דוגמאות אמיתיות: "2RR8+C7, חוות שלם" plus-code, "Israel, Limonit 21, Omer"
            # אנגלית-הפוכה) - אז לא ממציאים שם מה-address הגולמי הזה כאן. במקום זה: address
            # נשאר null במקרה הזה בכוונה, כדי שהרשומה תיכנס לתור הקיים של enrich-playground-
            # addresses.js (reverse-geocode נקי דרך Nominatim) + migrate-playground-names.js
            # שכבר יודעים לתת שם מבוסס-כתובת אמין - "לא לשכפל לוגיקה" (סעיף 14, אותו עיקרון
            # שכבר חל על import-playgrounds-osm.js).
            is_generic_name = isGenericPlaygroundName(name)
            clean_address = None if is_generic_name else address
            loc_resp = await client.post(
                f"{self.url}/rest/v1/locations", headers=headers,
                json={
                    "name": name, "address": clean_address, "city": extract_city_from_address(clean_address),
                    "lat": lat, "lng": lon,
                },
            )
            loc_resp.raise_for_status()
            location_id = loc_resp.json()[0]["id"]

            act_resp = await client.post(
                f"{self.url}/rest/v1/activities", headers=headers,
                json={
                    "name": name,
                    "entity_type": "מקום_קבוע",
                    "location_id": location_id,
                    "category": "גן שעשועים",
                    "placeholder_group": "PLAY_AND_FUN",
                    "price_type": "free",
                    "price_amount": 0,
                    "indoor_outdoor": "outdoor",
                    "booking_requirement": "none",
                    "status": "approved",
                    "source": "scraped",
                    "source_url": google_maps_uri,
                    "google_place_id": place_id,
                    "created_by": self._bot_user_id,
                    # שם מגיע ישירות מ-Google Places (displayName) - שם אמיתי, לא fallback
                    # מבוסס-כתובת שTuRu יצר בעצמו (tools/import-tool/playgroundNaming.js) -
                    # חוץ מהמקרה הגנרי למעלה, ששם name_source נשאר null בכוונה (לא 'official',
                    # עדיין לא name טוב) עד שיטופל דרך התור הקיים.
                    "name_source": None if is_generic_name else "official",
                },
            )
            act_resp.raise_for_status()
            return act_resp.json()[0]["id"]

    async def insert_incoming_activity(
        self, *, page_url: str | None, match_type: str, status: str,
        confidence_score: float | None, extracted_data: dict, validation_issues: list[str],
        existing_activity_id: str | None = None,
    ) -> None:
        """Writes ONE row to public.incoming_activities (supabase/0045_incoming_activities.sql) -
        the SAME review-queue table the site-scanning pipeline (scan-source) already uses,
        instead of a CSV nobody in the app can see. Added 2026-09-11 to close a real gap:
        run_import_supabase's NEEDS_REVIEW/STRONG_MATCH outcomes and classify_and_bucket's
        review_rows were previously silently dropped (STRONG_MATCH/NEEDS_REVIEW) or written
        only to a local CSV (review_rows) - a human could never actually act on them. The
        "legit source + has an address" master/DISCOVERED rows keep auto-approving exactly
        as before via insert_new_playground - this method is only for the rows that path
        deliberately does NOT auto-approve.
        source_id/scan_log_id are left null (this candidate came from Google Places, not a
        registered `sources` row) - the column is nullable (on delete set null) precisely
        for provenance outside that system."""
        async with httpx.AsyncClient(timeout=30.0) as client:
            token = await self._ensure_session(client)
            headers = {
                "apikey": self.anon_key, "Authorization": f"Bearer {token}",
                "Content-Type": "application/json", "Prefer": "return=minimal",
            }
            resp = await client.post(
                f"{self.url}/rest/v1/incoming_activities", headers=headers,
                json={
                    "page_url": page_url or "https://www.google.com/maps",
                    "match_type": match_type,
                    "existing_activity_id": existing_activity_id,
                    "confidence_score": confidence_score,
                    "extracted_data": extracted_data,
                    "validation_issues": validation_issues,
                    "status": status,
                },
            )
            resp.raise_for_status()
