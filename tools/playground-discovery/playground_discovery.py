"""
TuRu - Playground/park discovery via Google Places API (New) + grid search.

DISCOVERY ONLY by default: writes CSV/JSONL files. Never touches Supabase
unless --import-supabase is passed. Even then, never updates/deletes an
existing activity - only ever INSERTs. Two different tables, by design
(2026-09-11 fix - "if the source looks legit and there's an address, approve
it automatically; otherwise it needs review"):
  - public.activities (status='approved', live in the app immediately) -
    ONLY for a "master" row (classify_and_bucket already required: real
    playground-type place, has an address, quality>=70, no in-batch dup)
    that ALSO comes back NEW_CANDIDATE against TuRu's existing catalog.
  - public.incoming_activities (status='needs_review', same review queue
    the site-scanning pipeline already uses) - everything that did NOT
    clear that bar: STRONG_MATCH/NEEDS_REVIEW against an existing activity,
    or classify_and_bucket's own review_rows (missing address, uncertain
    type, possible duplicate, park-without-clear-playground). Never
    auto-approved. A human resolves these through the existing admin tools.

See README section in the chat report for exact run commands. Quick reference:
    python playground_discovery.py --dry-run --limit-grid-points 20
    python playground_discovery.py
    python playground_discovery.py --resume
    python playground_discovery.py --import-supabase
"""
import argparse
import asyncio
import csv
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

import israel_geo
import matching
from google_places import GooglePlacesClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("playground_discovery")

THIS_DIR = Path(__file__).resolve().parent
CHECKPOINT_PATH = THIS_DIR / "checkpoint.json"

# Section 4/38 - configuration, not hardcoded logic. Add more phrases here any
# time without touching the search loop itself.
SEARCH_QUERIES = [
    "גן שעשועים", "גני שעשועים", "גן משחקים", "מתקני משחקים", "פארק ילדים", "פארק שעשועים", "משחקייה בפארק",
    "Playground", "Playgrounds", "Kids Playground", "Children's Playground", "Play Area",
]
NEARBY_INCLUDED_TYPES = ["playground", "park"]
DEFAULT_MAX_REFINEMENT_LEVEL = 1


def load_api_key() -> str:
    load_dotenv(THIS_DIR / ".env")
    key = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not key:
        raise SystemExit(
            "GOOGLE_MAPS_API_KEY is not set. Copy .env.example to .env in this folder "
            "and fill it in, then re-run."
        )
    return key


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="TuRu playground/park discovery via Google Places API")
    p.add_argument("--grid-step", type=float, default=0.05, help="degrees between grid points (default 0.05 ~ 5.5km)")
    p.add_argument("--radius", type=int, default=1500, help="search radius per grid point, meters")
    p.add_argument("--min-lat", type=float, default=israel_geo.DEFAULT_ISRAEL_BOUNDS["min_lat"])
    p.add_argument("--max-lat", type=float, default=israel_geo.DEFAULT_ISRAEL_BOUNDS["max_lat"])
    p.add_argument("--min-lon", type=float, default=israel_geo.DEFAULT_ISRAEL_BOUNDS["min_lon"])
    p.add_argument("--max-lon", type=float, default=israel_geo.DEFAULT_ISRAEL_BOUNDS["max_lon"])
    p.add_argument("--max-refinement-level", type=int, default=DEFAULT_MAX_REFINEMENT_LEVEL)
    p.add_argument("--max-concurrency", type=int, default=5)
    p.add_argument("--requests-per-second", type=float, default=5.0)
    p.add_argument("--max-retries", type=int, default=4)
    p.add_argument("--max-results-per-query", type=int, default=20)
    p.add_argument("--limit-grid-points", type=int, default=None)
    p.add_argument("--max-requests", type=int, default=None, help="hard stop once this many API requests are made")
    p.add_argument("--dry-run", action="store_true", help="search + dedup + CSV/report, but never write to Supabase")
    p.add_argument("--resume", action="store_true", help="continue from checkpoint.json instead of starting over")
    p.add_argument("--import-supabase", action="store_true", help="after discovery, match against TuRu and insert NEW_CANDIDATE rows")
    return p.parse_args()


def load_checkpoint() -> dict:
    if CHECKPOINT_PATH.exists():
        return json.loads(CHECKPOINT_PATH.read_text(encoding="utf-8"))
    return {"completed_grid_point_ids": [], "places_by_id": {}}


def save_checkpoint(state: dict) -> None:
    CHECKPOINT_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def place_from_api_result(raw: dict) -> matching.DiscoveredPlace:
    loc = raw.get("location") or {}
    return matching.DiscoveredPlace(
        place_id=raw["id"],
        name=(raw.get("displayName") or {}).get("text"),
        formatted_address=raw.get("formattedAddress"),
        lat=loc.get("latitude"),
        lon=loc.get("longitude"),
        types=raw.get("types") or [],
        primary_type=raw.get("primaryType"),
        google_maps_uri=raw.get("googleMapsUri"),
    )


async def scan_grid_point(client: GooglePlacesClient, point: israel_geo.GridPoint, max_results: int,
                           raw_log_fh, places_by_id: dict[str, matching.DiscoveredPlace]) -> dict:
    """Runs Nearby Search + all configured Text Search queries for one grid
    point, merges results into the shared places_by_id map, and returns this
    point's own coverage stats (section 34)."""
    local_place_ids: set[str] = set()
    saturated = False

    try:
        nearby_results = await client.search_nearby(
            lat=point.lat, lon=point.lon, radius_m=point.radius_m,
            included_types=NEARBY_INCLUDED_TYPES, max_results=max_results, query_label="__nearby__",
        )
        saturated = len(nearby_results) >= max_results
        _absorb_results(nearby_results, "nearby_search", None, point, places_by_id, local_place_ids, raw_log_fh)
    except Exception as exc:
        logger.error("[ERROR] grid_point=%s query=nearby_search error=%s", point.grid_id, exc)
        nearby_results = []

    for query in SEARCH_QUERIES:
        try:
            results = await client.search_text(query=query, lat=point.lat, lon=point.lon, radius_m=point.radius_m,
                                                max_results=max_results)
            _absorb_results(results, "text_search", query, point, places_by_id, local_place_ids, raw_log_fh)
        except Exception as exc:
            logger.error("[ERROR] grid_point=%s query=%s error=%s", point.grid_id, query, exc)

    playgrounds_found = sum(
        1 for pid in local_place_ids
        if matching.classify_place(
            primary_type=places_by_id[pid].primary_type, types=places_by_id[pid].types, name=places_by_id[pid].name,
        ) in ("PLAYGROUND", "PARK_WITH_PLAYGROUND")
    )
    return {
        "grid_id": point.grid_id, "center_lat": point.lat, "center_lon": point.lon,
        "queries_run": 1 + len(SEARCH_QUERIES), "unique_places_found": len(local_place_ids),
        "playgrounds_found": playgrounds_found, "saturated": saturated,
        "zero_result": len(local_place_ids) == 0,
    }


def _absorb_results(results: list[dict], method: str, query: str | None, point: israel_geo.GridPoint,
                     places_by_id: dict, local_place_ids: set, raw_log_fh) -> None:
    for raw in results:
        place = place_from_api_result(raw)
        raw_log_fh.write(json.dumps({
            "grid_id": point.grid_id, "method": method, "query": query,
            "place_id": place.place_id, "raw": raw, "at": datetime.now(timezone.utc).isoformat(),
        }, ensure_ascii=False) + "\n")
        local_place_ids.add(place.place_id)
        existing = places_by_id.get(place.place_id)
        if existing is None:
            places_by_id[place.place_id] = place
            existing = place
        else:
            # keep the richer of the two on any field Google left blank in one call
            existing.name = existing.name or place.name
            existing.formatted_address = existing.formatted_address or place.formatted_address
            existing.google_maps_uri = existing.google_maps_uri or place.google_maps_uri
        existing.merge_occurrence(query=query, grid_point_id=point.grid_id, method=method)


def classify_and_bucket(places_by_id: dict[str, matching.DiscoveredPlace], bounds: dict):
    """Returns (master_rows, review_rows, rejected_rows) - section 19/20/21.
    Runs bounds/coords/place_kind/possible-duplicate checks once, over the
    final deduplicated map."""
    master, review, rejected = [], [], []
    all_places = list(places_by_id.values())

    for place in all_places:
        base = {
            "google_place_id": place.place_id,
            "name": place.name,
            "formatted_address": place.formatted_address,
            "latitude": place.lat,
            "longitude": place.lon,
            "primary_type": place.primary_type,
            "types": "|".join(place.types),
            "google_maps_uri": place.google_maps_uri,
            "discovery_methods": "|".join(sorted(place.discovery_methods)),
            "discovered_by_queries": "|".join(sorted(q for q in place.discovered_by_queries if q)),
            "occurrence_count": place.occurrence_count,
        }

        if not place.place_id:
            rejected.append({**base, "status": "MISSING_PLACE_ID", "reason": "no place_id returned"})
            continue
        if place.lat is None or place.lon is None or (place.lat == 0 and place.lon == 0):
            rejected.append({**base, "status": "INVALID_COORDINATES", "reason": "missing or 0,0 coordinates"})
            continue
        if not israel_geo.is_in_bounds(place.lat, place.lon, bounds):
            rejected.append({**base, "status": "OUT_OF_BOUNDS", "reason": "outside configured Israel bounds"})
            continue

        place_kind = matching.classify_place(primary_type=place.primary_type, types=place.types, name=place.name)
        if place_kind == "NOT_RELEVANT":
            rejected.append({**base, "status": "NOT_RELEVANT", "reason": f"types={place.types}"})
            continue

        possible_dup_of = None
        for other in all_places:
            if other.place_id != place.place_id and matching.is_possible_duplicate(
                {"lat": place.lat, "lon": place.lon, "name": place.name},
                {"lat": other.lat, "lon": other.lon, "name": other.name},
            ):
                possible_dup_of = other.place_id
                break

        has_address = bool(place.formatted_address)
        quality = matching.data_quality_score(
            has_place_id=True, has_name=bool(place.name), has_address=has_address,
            has_coords=True, place_kind=place_kind,
        )
        row = {**base, "place_kind": place_kind, "match_confidence": quality, "data_quality_score": quality}

        if possible_dup_of:
            review.append({**row, "status": "POSSIBLE_DUPLICATE", "reason": f"near+similar to {possible_dup_of}"})
        elif not has_address:
            review.append({**row, "status": "MISSING_ADDRESS", "reason": "no formatted_address from Google"})
        elif place_kind == "UNCERTAIN" or quality < 70:
            review.append({**row, "status": "UNCERTAIN" if place_kind == "UNCERTAIN" else "LOW_CONFIDENCE"})
        elif place_kind == "PARK":
            review.append({**row, "status": "PARK_WITHOUT_CLEAR_PLAYGROUND"})
        else:
            master.append({**row, "status": "DISCOVERED"})

    return master, review, rejected


CSV_COLUMNS = [
    "google_place_id", "name", "formatted_address", "latitude", "longitude",
    "place_kind", "primary_type", "types", "google_maps_uri", "discovery_methods",
    "discovered_by_queries", "occurrence_count", "match_confidence", "data_quality_score", "status", "reason",
]


def write_csv(path: Path, rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=CSV_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def _row_extracted_data(row: dict) -> dict:
    """Common jsonb payload for an incoming_activities row born from a Google
    Places candidate - the same fields a human reviewer needs to judge it."""
    return {
        "name": row.get("name"), "formatted_address": row.get("formatted_address"),
        "lat": row.get("latitude"), "lon": row.get("longitude"),
        "google_place_id": row.get("google_place_id"), "google_maps_uri": row.get("google_maps_uri"),
        "place_kind": row.get("place_kind"), "types": row.get("types"),
        "discovery_methods": row.get("discovery_methods"),
    }


async def run_import_supabase(master_rows: list[dict], stats: dict) -> None:
    from supabase_client import SupabaseBotClient, load_import_tool_env
    load_import_tool_env()
    client = SupabaseBotClient()
    existing = await client.fetch_activities_for_matching()
    logger.info("Loaded %d existing TuRu activities for matching", len(existing))

    match_counts = {matching.MATCH_CONFIRMED: 0, matching.STRONG_MATCH: 0, matching.POSSIBLE_DUPLICATE: 0, matching.NEEDS_REVIEW: 0, matching.NEW_CANDIDATE: 0}
    imported = 0
    queued_for_review = 0
    for row in master_rows:
        discovered = {
            "place_id": row["google_place_id"], "name": row["name"],
            "formatted_address": row["formatted_address"], "lat": row["latitude"], "lon": row["longitude"],
        }
        outcome, match, _match_name_score = matching.match_against_existing(discovered, existing)
        match_counts[outcome] += 1
        row["supabase_match"] = outcome
        if outcome == matching.NEW_CANDIDATE:
            # "אם המקור נראה לגיטימי ויש כתובת - לאשר אוטומטית" (בקשת המשתמש, 2026-09-11) -
            # master_rows כאן כבר עברו את כל הבדיקות האלה ב-classify_and_bucket (place_kind
            # תקין, כתובת קיימת, quality>=70, בלי כפילות-בתוך-האצווה) ועדיין NEW_CANDIDATE
            # אומר שגם לא נמצאה התאמה לפעילות קיימת ב-TuRu - זה בדיוק "לגיטימי + יש כתובת",
            # אז זה נכנס ישר כ-approved בדיוק כמו קודם. הפער האמיתי שתוקן היום הוא במה
            # שקורה ל-STRONG_MATCH/NEEDS_REVIEW למטה, ול-review_rows (push_review_rows_to_incoming) -
            # אלה בעבר נעלמו בשקט/רק ל-CSV, עכשיו הם נכנסים לתור בדיקה אמיתי (incoming_activities).
            try:
                new_id = await client.insert_new_playground(
                    name=row["name"] or "גן שעשועים", address=row["formatted_address"],
                    lat=row["latitude"], lon=row["longitude"], place_id=row["google_place_id"],
                    google_maps_uri=row["google_maps_uri"], created_by=None,
                )
                row["status"] = "IMPORTED"
                row["imported_activity_id"] = new_id
                imported += 1
                # מונע כפילויות תוך-ריצה (2026-09-11: אותו באג שנמצא ותוקן ב-scan-source/index.ts,
                # שם 80+ שורות כפולות נוצרו בפועל) - existing נטען פעם אחת בתחילת הפונקציה ולעולם
                # לא מתעדכן, כך שמועמד הבא ב-master_rows (למשל מהתאמה בין שתי יישובים סמוכים, או
                # שני place_id שונים לאותו מקום פיזי בפועל) נבדק רק מול מה שהיה במאגר *לפני* הריצה
                # הזו, לא מול מה שהריצה עצמה הספיקה ליצור שנייה קודם.
                existing.append({
                    "id": new_id, "name": row["name"], "google_place_id": row["google_place_id"],
                    "lat": row["latitude"], "lon": row["longitude"], "address": row["formatted_address"],
                })
            except Exception as exc:
                logger.error("Insert failed for %s: %s", row["google_place_id"], exc)
                row["status"] = "ERROR"
                row["reason"] = str(exc)[:200]
        elif outcome in (matching.STRONG_MATCH, matching.POSSIBLE_DUPLICATE, matching.NEEDS_REVIEW):
            # לא בטוחים מספיק שזו בדיוק אותה פעילות קיימת (בניגוד ל-MATCH_CONFIRMED, שם
            # place_id זהה - שם באמת אין מה לבדוק, ולכן לא נכתב לשום מקום) - לפני התיקון הזה
            # התוצאה הזו פשוט נעלמה (רק נספרה ב-match_counts). עכשיו: שורת incoming_activities
            # אמיתית, needs_review, עם existing_activity_id שמצביע על החשוד-שכבר-קיים.
            try:
                await client.insert_incoming_activity(
                    page_url=row.get("google_maps_uri"), match_type="duplicate", status="needs_review",
                    confidence_score=round((row.get("data_quality_score") or 0) / 100.0, 2),
                    extracted_data=_row_extracted_data(row),
                    validation_issues=[f"possible_duplicate_of_existing:{outcome}"],
                    existing_activity_id=(match or {}).get("id"),
                )
                queued_for_review += 1
            except Exception as exc:
                logger.error("incoming_activities insert failed (%s) for %s: %s", outcome, row["google_place_id"], exc)

    stats["supabase_match_counts"] = match_counts
    stats["supabase_imported"] = imported
    stats["supabase_queued_for_review"] = queued_for_review


async def push_review_rows_to_incoming(review_rows: list[dict]) -> int:
    """classify_and_bucket's review bucket (missing address / uncertain type /
    possible in-batch duplicate / park-without-clear-playground) - previously
    written ONLY to a local CSV nobody in the app could see. Now also queued
    into incoming_activities (status='needs_review') so an admin can actually
    resolve them through the review tooling that already exists for the
    site-scanning pipeline. Never auto-approved - by definition these rows
    did NOT pass the "legit source + has address" bar master_rows already
    cleared (see run_import_supabase)."""
    from supabase_client import SupabaseBotClient, load_import_tool_env
    load_import_tool_env()
    client = SupabaseBotClient()
    queued = 0
    for row in review_rows:
        try:
            await client.insert_incoming_activity(
                page_url=row.get("google_maps_uri"), match_type="new", status="needs_review",
                confidence_score=round((row.get("data_quality_score") or 0) / 100.0, 2),
                extracted_data=_row_extracted_data(row),
                validation_issues=[row.get("status") or "review", row.get("reason")] if row.get("reason") else [row.get("status") or "review"],
            )
            queued += 1
        except Exception as exc:
            logger.error("incoming_activities insert failed for review row %s: %s", row.get("google_place_id"), exc)
    return queued


async def main_async() -> None:
    args = parse_args()
    api_key = load_api_key()
    bounds = {"min_lat": args.min_lat, "max_lat": args.max_lat, "min_lon": args.min_lon, "max_lon": args.max_lon}

    grid = israel_geo.generate_grid(bounds, args.grid_step, args.radius)
    if args.limit_grid_points:
        grid = grid[: args.limit_grid_points]
    logger.info("Generated %d grid points (step=%s, radius=%sm)", len(grid), args.grid_step, args.radius)

    state = load_checkpoint() if args.resume else {"completed_grid_point_ids": [], "places_by_id": {}}
    completed_ids = set(state["completed_grid_point_ids"])
    places_by_id: dict[str, matching.DiscoveredPlace] = {
        pid: matching.DiscoveredPlace(
            place_id=pid, name=d.get("name"), formatted_address=d.get("formatted_address"),
            lat=d.get("lat"), lon=d.get("lon"), types=d.get("types", []), primary_type=d.get("primary_type"),
            google_maps_uri=d.get("google_maps_uri"), discovered_by_queries=set(d.get("discovered_by_queries", [])),
            discovered_by_grid_points=set(d.get("discovered_by_grid_points", [])),
            discovery_methods=set(d.get("discovery_methods", [])), occurrence_count=d.get("occurrence_count", 0),
        )
        for pid, d in state["places_by_id"].items()
    }
    if args.resume:
        logger.info("Resuming: %d grid points already completed, %d places already known",
                    len(completed_ids), len(places_by_id))

    client = GooglePlacesClient(
        api_key, max_concurrency=args.max_concurrency, requests_per_second=args.requests_per_second,
        max_retries=args.max_retries,
    )

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    raw_log_path = THIS_DIR / f"raw_discovery_{timestamp}.jsonl"
    grid_coverage: list[dict] = []
    pending: list[israel_geo.GridPoint] = [p for p in grid if p.grid_id not in completed_ids]

    with raw_log_path.open("w", encoding="utf-8") as raw_log_fh:
        i = 0
        while i < len(pending):
            point = pending[i]
            i += 1
            if args.max_requests and client.stats.total_requests >= args.max_requests:
                logger.warning("Hit --max-requests=%s, stopping grid scan early.", args.max_requests)
                break
            coverage = await scan_grid_point(client, point, args.max_results_per_query, raw_log_fh, places_by_id)
            grid_coverage.append(coverage)
            completed_ids.add(point.grid_id)
            logger.info(
                "[GRID %d/%d] %s -> unique=%d playgrounds=%d%s%s",
                i, len(pending), point.grid_id, coverage["unique_places_found"], coverage["playgrounds_found"],
                " SATURATED_GRID" if coverage["saturated"] else "",
                " ZERO_RESULT_GRID" if coverage["zero_result"] else "",
            )
            if coverage["saturated"]:
                for sub in israel_geo.refine_grid_point(point, args.max_refinement_level):
                    if sub.grid_id not in completed_ids:
                        pending.append(sub)

            # checkpoint after every grid point - resumable at any interruption point.
            save_checkpoint({
                "completed_grid_point_ids": sorted(completed_ids),
                "places_by_id": {
                    pid: {
                        "name": p.name, "formatted_address": p.formatted_address, "lat": p.lat, "lon": p.lon,
                        "types": p.types, "primary_type": p.primary_type, "google_maps_uri": p.google_maps_uri,
                        "discovered_by_queries": sorted(q for q in p.discovered_by_queries if q),
                        "discovered_by_grid_points": sorted(p.discovered_by_grid_points),
                        "discovery_methods": sorted(p.discovery_methods), "occurrence_count": p.occurrence_count,
                    }
                    for pid, p in places_by_id.items()
                },
            })

    master_rows, review_rows, rejected_rows = classify_and_bucket(places_by_id, bounds)

    write_csv(THIS_DIR / f"israel_playgrounds_discovery_{timestamp}.csv", master_rows)
    write_csv(THIS_DIR / f"israel_playgrounds_review_{timestamp}.csv", review_rows)
    write_csv(THIS_DIR / f"israel_playgrounds_rejected_{timestamp}.csv", rejected_rows)

    stats = {
        "total_grid_points": len(grid),
        "completed_grid_points": len(completed_ids),
        "zero_result_grids": sum(1 for c in grid_coverage if c["zero_result"]),
        "saturated_grids": sum(1 for c in grid_coverage if c["saturated"]),
        "queries_executed": sum(c["queries_run"] for c in grid_coverage),
        "api_requests": client.stats.total_requests,
        "requests_by_endpoint": client.stats.requests_by_endpoint,
        "raw_places_found": sum(c["unique_places_found"] for c in grid_coverage),
        "unique_place_ids": len(places_by_id),
        "master_count": len(master_rows),
        "review_count": len(review_rows),
        "rejected_count": len(rejected_rows),
        "playgrounds": sum(1 for r in master_rows if r["place_kind"] == "PLAYGROUND"),
        "parks_with_playground": sum(1 for r in master_rows if r["place_kind"] == "PARK_WITH_PLAYGROUND"),
        "parks": sum(1 for r in review_rows if r.get("place_kind") == "PARK"),
    }

    if args.import_supabase and not args.dry_run:
        await run_import_supabase(master_rows, stats)
        write_csv(THIS_DIR / f"israel_playgrounds_discovery_{timestamp}.csv", master_rows)  # rewrite with match/import outcome
        stats["review_queued_for_incoming"] = await push_review_rows_to_incoming(review_rows)
    elif args.import_supabase and args.dry_run:
        logger.warning("--import-supabase ignored because --dry-run was also passed - no Supabase writes happen in dry-run.")

    report_path = THIS_DIR / f"playground_discovery_report_{timestamp}.json"
    report_path.write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n" + "=" * 40)
    print("TuRu Playground Discovery")
    print("=" * 40)
    for key, value in stats.items():
        print(f"{key}: {value}")
    print("=" * 40)
    print(f"\nMaster CSV / Review CSV / Rejected CSV / raw JSONL / report JSON written to {THIS_DIR}")


def main():
    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        logger.warning("Interrupted - progress up to the last completed grid point is saved in checkpoint.json. Re-run with --resume.")
        sys.exit(1)


if __name__ == "__main__":
    main()
