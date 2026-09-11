"""
TuRu - imports playgrounds already found by playground_discovery.py's checkpoint into
Supabase, WITHOUT making any new Google Places API calls. Reuses classify_and_bucket()/
run_import_supabase() from playground_discovery.py - "don't duplicate logic".

Why this exists separately from `playground_discovery.py --import-supabase`: that flag
only runs the import step *after* its own scan loop, and the scan loop always processes
at least one more not-yet-completed grid point (costing real API requests/money) even
with --resume, unless the whole grid happens to already be complete. This script instead
loads the checkpoint as-is and imports exactly what's already there - zero API calls.

Usage:
    py import_discovered.py --dry-run   (report only, no Supabase writes)
    py import_discovered.py             (writes new playgrounds to Supabase)
"""
import argparse
import asyncio
import logging

import matching
import playground_discovery as pd

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("import_discovered")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Import already-discovered playgrounds (from checkpoint.json) into Supabase")
    p.add_argument("--dry-run", action="store_true", help="report counts only, no Supabase writes")
    return p.parse_args()


async def main() -> None:
    args = parse_args()
    state = pd.load_checkpoint()
    places_by_id = {
        pid: matching.DiscoveredPlace(
            place_id=pid, name=d.get("name"), formatted_address=d.get("formatted_address"),
            lat=d.get("lat"), lon=d.get("lon"), types=d.get("types", []), primary_type=d.get("primary_type"),
            google_maps_uri=d.get("google_maps_uri"), discovered_by_queries=set(d.get("discovered_by_queries", [])),
            discovered_by_grid_points=set(d.get("discovered_by_grid_points", [])),
            discovery_methods=set(d.get("discovery_methods", [])), occurrence_count=d.get("occurrence_count", 0),
        )
        for pid, d in state["places_by_id"].items()
    }
    logger.info("Loaded %d discovered places from checkpoint.json (0 new API calls)", len(places_by_id))

    master_rows, review_rows, rejected_rows = pd.classify_and_bucket(places_by_id, pd.israel_geo.DEFAULT_ISRAEL_BOUNDS)
    logger.info("master=%d review=%d rejected=%d", len(master_rows), len(review_rows), len(rejected_rows))

    if args.dry_run:
        logger.info("(dry run) not matching/importing against Supabase.")
        return

    stats = {}
    await pd.run_import_supabase(master_rows, stats)
    logger.info(
        "Match counts against existing TuRu activities: %s",
        stats["supabase_match_counts"],
    )
    logger.info("Imported as brand-new playgrounds (with a real address): %d", stats["supabase_imported"])


if __name__ == "__main__":
    asyncio.run(main())
