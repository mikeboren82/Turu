"""
TuRu - google_place_id backfill for existing activities.

tools/playground-discovery's matching/enrichment only ever write
google_place_id onto BRAND-NEW activities it inserts (NEW_CANDIDATE) - nothing
backfills it onto the activities already in TuRu from before the Places
integration existed, so enrich_images.py has nothing to enrich until this
runs. For each existing activity with coordinates but no google_place_id yet,
searches Google Places by name near its known location and, only on a
STRONG_MATCH-grade confidence (same distance/name-similarity thresholds
matching.py already uses for discovery), UPDATEs that one activity's
google_place_id. Anything less confident is left alone and written to a CSV
for manual review - never guessed.

Usage:
    py backfill_place_ids.py --dry-run --limit 20
    py backfill_place_ids.py
"""
import argparse
import asyncio
import csv
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

import matching
from google_places import GooglePlacesClient
from israel_geo import haversine_km
from supabase_client import SupabaseBotClient, load_import_tool_env

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("backfill_place_ids")

THIS_DIR = Path(__file__).resolve().parent
SEARCH_RADIUS_M = 300  # tight bias - we already know the activity's approximate coordinates


def load_api_key() -> str:
    load_dotenv(THIS_DIR / ".env")
    key = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not key:
        raise SystemExit("GOOGLE_MAPS_API_KEY is not set (see .env.example).")
    return key


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="TuRu google_place_id backfill for existing activities")
    p.add_argument("--limit", type=int, default=None, help="only process this many activities")
    p.add_argument("--max-concurrency", type=int, default=5)
    p.add_argument("--requests-per-second", type=float, default=5.0)
    p.add_argument("--dry-run", action="store_true", help="report what would be updated, but never write to Supabase")
    return p.parse_args()


async def find_best_match(places: GooglePlacesClient, activity: dict) -> tuple[dict | None, float, float]:
    """Returns (best_result_or_None, distance_m, name_score) - the top Places
    text-search hit near the activity's own coordinates, scored the exact same
    way matching.py scores STRONG_MATCH (word_overlap_score with stopwords
    dropped, haversine distance) - not a new metric invented for this script."""
    results = await places.search_text(
        query=activity["name"], lat=activity["lat"], lon=activity["lon"],
        radius_m=SEARCH_RADIUS_M, max_results=3,
    )
    best = None
    best_dist = float("inf")
    best_name_score = 0.0
    for r in results:
        loc = r.get("location") or {}
        r_lat, r_lon = loc.get("latitude"), loc.get("longitude")
        if r_lat is None:
            continue
        dist_m = haversine_km(activity["lat"], activity["lon"], r_lat, r_lon) * 1000
        name_score = matching.word_overlap_score(
            activity.get("name"), (r.get("displayName") or {}).get("text"), drop_stopwords=True,
        )
        # Prefer the closer result when names are comparably confident - distance
        # is the stronger signal once we already searched by name near a known point.
        if best is None or dist_m < best_dist:
            best, best_dist, best_name_score = r, dist_m, name_score
    return best, best_dist, best_name_score


async def run(args: argparse.Namespace) -> None:
    api_key = load_api_key()
    load_import_tool_env()

    places = GooglePlacesClient(api_key, max_concurrency=args.max_concurrency, requests_per_second=args.requests_per_second)
    supabase = SupabaseBotClient()

    all_activities = await supabase.fetch_activities_for_matching()
    candidates = [a for a in all_activities if not a.get("google_place_id") and a.get("lat") is not None and a.get("name")]
    if args.limit is not None:
        candidates = candidates[: args.limit]
    logger.info("Found %d activities with coordinates and no google_place_id yet", len(candidates))

    matched = 0
    conflict = 0
    review_rows: list[dict] = []
    lock = asyncio.Lock()

    async def process(activity: dict) -> None:
        nonlocal matched, conflict
        try:
            best, dist_m, name_score = await find_best_match(places, activity)
        except Exception as exc:
            logger.error("[ERROR] search failed for %s: %s", activity["name"], exc)
            return

        if best is None:
            return

        is_strong_match = (
            dist_m <= matching.STRONG_MATCH_DISTANCE_METERS and name_score >= matching.STRONG_MATCH_NAME_SIMILARITY
        )
        place_id = best["id"]
        place_name = (best.get("displayName") or {}).get("text")

        if not is_strong_match:
            async with lock:
                review_rows.append({
                    "activity_id": activity["id"], "activity_name": activity["name"],
                    "candidate_place_id": place_id, "candidate_name": place_name,
                    "distance_m": round(dist_m, 1), "name_score": round(name_score, 2),
                })
            return

        if args.dry_run:
            logger.info("[DRY RUN] would link %s -> %s (dist=%.0fm name_score=%.2f)", activity["name"], place_id, dist_m, name_score)
            matched += 1
            return

        try:
            await supabase.set_activity_google_place_id(activity_id=activity["id"], place_id=place_id)
            matched += 1
            logger.info("[LINKED] %s -> %s (dist=%.0fm name_score=%.2f)", activity["name"], place_id, dist_m, name_score)
        except Exception as exc:
            # Most likely the unique index (supabase/0055) rejecting a place_id
            # already claimed by a different activity - never overwrite that link.
            conflict += 1
            logger.warning("[CONFLICT] could not link %s -> %s: %s", activity["name"], place_id, exc)

    await asyncio.gather(*(process(a) for a in candidates))

    if review_rows:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        review_path = THIS_DIR / f"place_id_backfill_review_{timestamp}.csv"
        with open(review_path, "w", newline="", encoding="utf-8-sig") as fh:
            writer = csv.DictWriter(fh, fieldnames=list(review_rows[0].keys()))
            writer.writeheader()
            writer.writerows(review_rows)
        logger.info("Wrote %d below-confidence candidates for manual review -> %s", len(review_rows), review_path)

    logger.info(
        "Done. candidates=%d matched=%d conflicts=%d needs_review=%d api_requests=%d",
        len(candidates), matched, conflict, len(review_rows), places.stats.total_requests,
    )


if __name__ == "__main__":
    asyncio.run(run(parse_args()))
