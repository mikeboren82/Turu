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

Read-only by default. insert_activity() is only ever called from
playground_discovery.py behind --import-supabase, and only for NEW_CANDIDATE
matches (see matching.py) - never for MATCH_CONFIRMED/STRONG_MATCH/NEEDS_REVIEW.
"""
import os
import re
from pathlib import Path

import httpx

IMPORT_TOOL_ENV_PATH = Path(__file__).resolve().parent.parent / "import-tool" / ".env"

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
    def __init__(self):
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
        async with httpx.AsyncClient(timeout=30.0) as client:
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
