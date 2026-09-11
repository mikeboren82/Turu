"""
TuRu - cheap, settlement-driven playground coverage spot-check.

Not a geometric grid (see playground_discovery.py) - uses TuRu's own 400+
distinct known settlements (real towns/cities/kibbutzim, already in the DB
from all scraped activities, not just playgrounds) as search centers. For
each one, asks Google "roughly how many playgrounds are near here" using an
IDs-only field mask (Google's cheapest "Essentials" SKU - see
google_places.py's IDS_ONLY_FIELD_MASK) and compares that to what TuRu
already has for that settlement. A settlement where Google's count clearly
exceeds TuRu's is flagged as a likely gap worth a real (Pro-tier) follow-up
search - most settlements won't be.

This exists because a real spot-check (user manually searching Google Maps)
found a playground OSM's nationwide import missed inside an otherwise
well-covered town (Tzoran/Yanuv) - individual scattered misses inside
"covered" areas, not just whole unmapped towns.

Read-only against Supabase - only ever writes a CSV report, never inserts
anything. Importing confirmed gaps is a deliberate separate step.

Usage:
    py settlement_gap_check.py                 # all settlements
    py settlement_gap_check.py --limit 20       # smoke test
"""
import argparse
import asyncio
import csv
import logging
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

from google_places import GooglePlacesClient
from supabase_client import SupabaseBotClient, load_import_tool_env

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("settlement_gap_check")

THIS_DIR = Path(__file__).resolve().parent
SEARCH_RADIUS_M = 3000  # covers a small-to-mid settlement's built-up area in one call
GAP_THRESHOLD = 3  # google_count - db_count must be at least this to flag (noise floor)


def load_api_key() -> str:
    load_dotenv(THIS_DIR / ".env")
    import os
    key = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not key:
        raise SystemExit("GOOGLE_MAPS_API_KEY is not set (see .env.example).")
    return key


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="TuRu settlement-level playground coverage spot-check (IDs-only, cheap)")
    p.add_argument("--limit", type=int, default=None, help="only check this many settlements")
    p.add_argument("--max-concurrency", type=int, default=5)
    p.add_argument("--requests-per-second", type=float, default=5.0)
    return p.parse_args()


async def run(args: argparse.Namespace) -> None:
    api_key = load_api_key()
    load_import_tool_env()

    places = GooglePlacesClient(api_key, max_concurrency=args.max_concurrency, requests_per_second=args.requests_per_second)
    supabase = SupabaseBotClient()

    settlements = await supabase.fetch_settlement_centroids()
    if args.limit is not None:
        settlements = settlements[: args.limit]
    logger.info("Checking %d settlements (IDs-only Nearby Search, ~$0 cost tier)", len(settlements))

    flagged = []
    checked = 0
    errors = 0

    async def check(s: dict) -> None:
        nonlocal checked, errors
        try:
            google_count = await places.count_nearby_ids(
                lat=s["lat"], lon=s["lng"], radius_m=SEARCH_RADIUS_M, included_types=["playground"],
            )
        except Exception as exc:
            errors += 1
            logger.error("[ERROR] %s: %s", s["city"], exc)
            return
        checked += 1
        gap = google_count - s["playground_count"]
        if gap >= GAP_THRESHOLD:
            flagged.append({
                "city": s["city"], "lat": s["lat"], "lng": s["lng"],
                "turu_count": s["playground_count"], "google_count": google_count, "gap": gap,
            })
            logger.info("[GAP] %s: TuRu=%d Google~%d (gap=%d)", s["city"], s["playground_count"], google_count, gap)

    await asyncio.gather(*(check(s) for s in settlements))

    flagged.sort(key=lambda r: r["gap"], reverse=True)
    if flagged:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        out_path = THIS_DIR / f"settlement_gap_report_{timestamp}.csv"
        with open(out_path, "w", newline="", encoding="utf-8-sig") as fh:
            writer = csv.DictWriter(fh, fieldnames=["city", "lat", "lng", "turu_count", "google_count", "gap"])
            writer.writeheader()
            writer.writerows(flagged)
        logger.info("Wrote %d flagged settlements -> %s", len(flagged), out_path)

    logger.info(
        "Done. settlements=%d checked=%d errors=%d flagged=%d api_requests=%d",
        len(settlements), checked, errors, len(flagged), places.stats.total_requests,
    )


if __name__ == "__main__":
    asyncio.run(run(parse_args()))
