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

GOOGLE PLACES RELEASE POLICY (2026-09-27, google_policy.py): storing a google_place_id on an INDEPENDENTLY sourced row
is allowed; nothing else from the Places answer is stored (not the name, address, coordinates, Maps URI - the review
CSV keeps the place id and the scores only). Because the tool calls Places, it runs only in the explicit safe mode
--place-id-only (refused before the Places key otherwise), and only on rows that prove independent provenance:
  approved, no google_place_id yet, NOT Google-origin (content_origin marker or Maps source_url - a scrubbed or held
  Google-origin row is never re-linked), and a positive independent source (a non-Maps http(s) source_url, or a
  manual / user_submitted row). The PATCH repeats the guards server-side (google_place_id is null, content_origin is
  null, status approved), so a row that changed after selection is not touched.

Usage:
    py backfill_place_ids.py --place-id-only --dry-run --limit 20
    py backfill_place_ids.py --place-id-only
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
from google_policy import is_google_maps_url, is_google_origin_activity, is_google_place_urn
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
    p.add_argument("--place-id-only", action="store_true",
                   help="REQUIRED safe mode: store only a google_place_id on independently sourced rows (see module doc)")
    return p.parse_args()


INDEPENDENT_SOURCES = ("manual", "user_submitted")


def backfill_rejection(activity: dict) -> str | None:
    """None = an eligible independent row; otherwise why it must not receive a place id from this tool."""
    if activity.get("status") != "approved":
        return "not_approved"  # archived = held / collapsed Google rows and everything else not live
    if activity.get("google_place_id"):
        return "has_place_id"
    if is_google_origin_activity(activity):
        return "google_origin"  # marker or Maps source_url: never re-linked, before or after the scrub
    src = activity.get("source_url")
    independent_url = (isinstance(src, str) and src.strip().lower().startswith(("http://", "https://"))
                       and not is_google_maps_url(src) and not is_google_place_urn(src))
    if not independent_url and activity.get("source") not in INDEPENDENT_SOURCES:
        return "no_independent_provenance"
    if activity.get("lat") is None or not activity.get("name"):
        return "no_name_or_coordinates"
    return None


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
    if not args.place_id_only:  # before the Places key, any client or request
        logger.error("REFUSED - backfill_place_ids calls Google Places; run it only in the explicit safe mode "
                     "--place-id-only (stores a google_place_id on independent rows, nothing else). Nothing was requested.")
        raise SystemExit(2)
    api_key = load_api_key()
    load_import_tool_env()

    places = GooglePlacesClient(api_key, max_concurrency=args.max_concurrency, requests_per_second=args.requests_per_second)
    supabase = SupabaseBotClient()

    all_activities = await supabase.fetch_place_id_backfill_candidates()
    skipped: dict[str, int] = {}
    candidates = []
    for a in all_activities:
        why = backfill_rejection(a)
        if why:
            skipped[why] = skipped.get(why, 0) + 1
        else:
            candidates.append(a)
    if args.limit is not None:
        candidates = candidates[: args.limit]
    logger.info("Found %d independent activities with coordinates and no google_place_id yet (skipped: %s)", len(candidates), skipped)

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

        if not is_strong_match:
            async with lock:
                # the place id and TURU's own name only - never the Places displayName / address (policy)
                review_rows.append({
                    "activity_id": activity["id"], "activity_name": activity["name"],
                    "candidate_place_id": place_id,
                    "distance_m": round(dist_m, 1), "name_score": round(name_score, 2),
                })
            return

        if args.dry_run:
            logger.info("[DRY RUN] would link %s -> %s (dist=%.0fm name_score=%.2f)", activity["name"], place_id, dist_m, name_score)
            matched += 1
            return

        try:
            if not await supabase.set_activity_google_place_id(activity_id=activity["id"], place_id=place_id):
                logger.info("[SKIPPED] %s changed since selection (no longer an eligible independent row)", activity["name"])
                return
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
