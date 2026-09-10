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
from pathlib import Path

import httpx

IMPORT_TOOL_ENV_PATH = Path(__file__).resolve().parent.parent / "import-tool" / ".env"


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

    async def _ensure_session(self, client: httpx.AsyncClient) -> str:
        if self._access_token:
            return self._access_token
        resp = await client.post(
            f"{self.url}/auth/v1/token?grant_type=password",
            headers={"apikey": self.anon_key, "Content-Type": "application/json"},
            json={"email": self.bot_email, "password": self.bot_password},
        )
        resp.raise_for_status()
        self._access_token = resp.json()["access_token"]
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

    async def insert_new_playground(self, *, name: str, address: str | None, lat: float, lon: float,
                                     place_id: str, google_maps_uri: str | None, created_by: str) -> str:
        """Creates ONE new location + activity row, mirroring the exact shape
        saveNewActivity (server.js) already writes for scraped content - same
        status='approved'/source='scraped' convention, not a new workflow.
        Returns the new activity id. Never called for anything but NEW_CANDIDATE."""
        async with httpx.AsyncClient(timeout=30.0) as client:
            token = await self._ensure_session(client)
            headers = {
                "apikey": self.anon_key, "Authorization": f"Bearer {token}",
                "Content-Type": "application/json", "Prefer": "return=representation",
            }
            loc_resp = await client.post(
                f"{self.url}/rest/v1/locations", headers=headers,
                json={"name": name, "address": address, "lat": lat, "lng": lon},
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
                    "price_type": "free",
                    "price_amount": 0,
                    "indoor_outdoor": "outdoor",
                    "booking_requirement": "none",
                    "status": "approved",
                    "source": "scraped",
                    "source_url": google_maps_uri,
                    "google_place_id": place_id,
                    "created_by": created_by,
                },
            )
            act_resp.raise_for_status()
            return act_resp.json()[0]["id"]
