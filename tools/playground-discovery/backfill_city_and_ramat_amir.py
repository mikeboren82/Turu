"""One-off fix, 2026-09-11: (1) backfill locations.city for the 80 playgrounds
settlement_gap_fill.py just inserted with city=NULL (bug now fixed in
supabase_client.insert_new_playground - this repairs the already-written
rows), (2) add "גן שעשועים רמת אמיר צורן" specifically - the exact example
the user reported, found via a targeted Text Search but not in the generic
per-settlement query's top-20 results."""
import asyncio
import logging

from dotenv import load_dotenv

import matching
import playground_discovery as pd
from google_places import GooglePlacesClient
from supabase_client import SupabaseBotClient, extract_city_from_address, load_import_tool_env

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("backfill_city_and_ramat_amir")


def load_api_key() -> str:
    import os
    from pathlib import Path
    load_dotenv(Path(__file__).resolve().parent / ".env")
    return os.environ["GOOGLE_MAPS_API_KEY"]


async def backfill_city(supabase: SupabaseBotClient) -> int:
    import httpx
    async with httpx.AsyncClient(timeout=30.0) as client:
        token = await supabase._ensure_session(client)
        headers = {"apikey": supabase.anon_key, "Authorization": f"Bearer {token}"}
        resp = await client.get(
            f"{supabase.url}/rest/v1/activities",
            headers=headers,
            params={
                "select": "created_at,location:locations(id,city,address)",
                "created_at": "gt.2026-09-11T05:00:00",
            },
        )
        resp.raise_for_status()
        rows = resp.json()
        targets = [r["location"] for r in rows if r.get("location") and not r["location"].get("city")]
        logger.info("Found %d locations needing a backfilled city", len(targets))
        updated = 0
        for loc in targets:
            city = extract_city_from_address(loc.get("address"))
            if not city:
                continue
            patch_resp = await client.patch(
                f"{supabase.url}/rest/v1/locations", headers={**headers, "Content-Type": "application/json"},
                params={"id": f"eq.{loc['id']}"}, json={"city": city},
            )
            patch_resp.raise_for_status()
            updated += 1
        return updated


async def add_ramat_amir(places: GooglePlacesClient, supabase: SupabaseBotClient) -> None:
    results = await places.search_text(
        query="גן שעשועים ינוב", lat=32.3070383, lon=34.9507557, radius_m=5000, max_results=20,
    )
    match = next((r for r in results if "רמת אמיר" in (r.get("displayName") or {}).get("text", "")), None)
    if not match:
        logger.warning("Could not re-find 'רמת אמיר' - skipping")
        return
    loc = match.get("location") or {}
    place = matching.DiscoveredPlace(
        place_id=match["id"], name=(match.get("displayName") or {}).get("text"),
        formatted_address=match.get("formattedAddress"), lat=loc.get("latitude"), lon=loc.get("longitude"),
        types=match.get("types", []), primary_type=match.get("primaryType"), google_maps_uri=match.get("googleMapsUri"),
        discovered_by_queries={"רמת אמיר fix"}, discovered_by_grid_points=set(),
        discovery_methods={"manual_fix"}, occurrence_count=1,
    )
    master_rows, _, _ = pd.classify_and_bucket({place.place_id: place}, pd.israel_geo.DEFAULT_ISRAEL_BOUNDS)
    if not master_rows:
        logger.warning("רמת אמיר was classified as review/rejected, not master - not auto-inserting")
        return
    stats = {}
    await pd.run_import_supabase(master_rows, stats)
    logger.info("רמת אמיר: %s", stats)


async def main() -> None:
    load_import_tool_env()
    supabase = SupabaseBotClient()
    updated = await backfill_city(supabase)
    logger.info("Backfilled city on %d locations", updated)

    places = GooglePlacesClient(load_api_key(), max_concurrency=1, requests_per_second=1.0)
    await add_ramat_amir(places, supabase)


if __name__ == "__main__":
    asyncio.run(main())
