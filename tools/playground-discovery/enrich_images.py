"""
TuRu - playground/park image enrichment.

For every activity with a google_place_id (supabase/0055) but no
activity_images row yet, checks whether Google Places has a photo for that
place, and if so inserts an activity_images row pointing at the
place-photo Edge Function (supabase/functions/place-photo) - never a raw
Google-hosted photo URL. See that function's header comment and
supabase_client.fetch_activities_needing_images for why (Google's terms only
allow indefinite storage of place_id, not the photo/photo-name).

Only ever INSERTs new activity_images rows - never touches an existing one.

Usage:
    py enrich_images.py --dry-run --limit 20
    py enrich_images.py
"""
import argparse
import asyncio
import logging
import os

from dotenv import load_dotenv

from google_places import GooglePlacesClient
from supabase_client import SupabaseBotClient, load_import_tool_env
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("enrich_images")

THIS_DIR = Path(__file__).resolve().parent


def load_api_key() -> str:
    load_dotenv(THIS_DIR / ".env")
    key = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not key:
        raise SystemExit("GOOGLE_MAPS_API_KEY is not set (see .env.example).")
    return key


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="TuRu playground/park image enrichment via Google Places")
    p.add_argument("--limit", type=int, default=None, help="only process this many candidates")
    p.add_argument("--max-concurrency", type=int, default=5)
    p.add_argument("--requests-per-second", type=float, default=5.0)
    p.add_argument("--dry-run", action="store_true", help="report what would be added, but never write to Supabase")
    return p.parse_args()


async def run(args: argparse.Namespace) -> None:
    api_key = load_api_key()
    load_import_tool_env()
    supabase_url = os.environ.get("SUPABASE_URL")
    if not supabase_url:
        raise SystemExit("SUPABASE_URL is not set (expected in tools/import-tool/.env).")
    photo_proxy_base = f"{supabase_url}/functions/v1/place-photo"

    places = GooglePlacesClient(api_key, max_concurrency=args.max_concurrency, requests_per_second=args.requests_per_second)
    supabase = SupabaseBotClient()

    candidates = await supabase.fetch_activities_needing_images()
    if args.limit is not None:
        candidates = candidates[: args.limit]
    logger.info("Found %d activities with a google_place_id and no image yet", len(candidates))

    added = 0
    no_photo = 0
    failed = 0

    async def process(activity: dict) -> None:
        nonlocal added, no_photo, failed
        place_id = activity["google_place_id"]
        try:
            if not await places.has_photos(place_id):
                no_photo += 1
                logger.info("[NO PHOTO] %s (%s)", activity["name"], place_id)
                return
        except Exception as exc:
            failed += 1
            logger.error("[ERROR] %s (%s): %s", activity["name"], place_id, exc)
            return

        photo_url = f"{photo_proxy_base}/{place_id}"
        if args.dry_run:
            logger.info("[DRY RUN] would add image for %s -> %s", activity["name"], photo_url)
            added += 1
            return
        try:
            await supabase.insert_place_photo_reference(
                activity_id=activity["id"], photo_url=photo_url, google_maps_uri=activity.get("source_url"),
            )
            added += 1
            logger.info("[ADDED] %s -> %s", activity["name"], photo_url)
        except Exception as exc:
            failed += 1
            logger.error("[ERROR] insert failed for %s: %s", activity["name"], exc)

    await asyncio.gather(*(process(a) for a in candidates))

    logger.info(
        "Done. candidates=%d added=%d no_photo=%d failed=%d api_requests=%d",
        len(candidates), added, no_photo, failed, places.stats.total_requests,
    )


if __name__ == "__main__":
    asyncio.run(run(parse_args()))
