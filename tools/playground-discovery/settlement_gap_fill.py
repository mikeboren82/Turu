"""
TuRu - real (Pro-tier) follow-up for settlements confirmed as genuine
playground-coverage gaps in the 2026-09-11 settlement_gap_check.py pass
(explicitly approved by the user - not a blind sweep, this exact hardcoded
list only). Pulls real place details (name/address/coordinates) via Text
Search - ~$0.03/call - and reuses playground_discovery.py's existing
classify_and_bucket/run_import_supabase so matching/dedup/naming logic
isn't duplicated a third time.

Uses search_text rather than search_nearby on purpose: the 2026-09-11 session
exhausted Google's *daily* SearchNearbyRequest quota (separate from billing -
a hard per-day cap that resets at Google's boundary, not something --apply
can bypass) after the settlement_gap_check.py run; Text Search draws from a
different quota bucket, so this can very likely still run the same day
instead of waiting on the Nearby quota to reset.

Two rounds of approval, both 2026-09-11: ROUND1 was the first 16 confirmed
gaps (already run - see settlement_gap_fill_20260911.log, 80 imported).
ROUND2 is the rest of that same 86-row report (settlement_gap_report_
20260911_041445.csv) after the user asked to fill everything still pending -
minus "Qalqilya" (a West Bank Palestinian city, out of scope for TuRu, not a
spelling artifact - deliberately excluded, not just missed). Known spelling-
variant pairs of an already-covered city (e.g. "קדימה - צורן" vs the already-
done "קדימה צורן", "קרית אונו"/"קריית אונו", "קרית מוצקין"/"קריית מוצקין")
are intentionally left IN ROUND2 rather than hand-resolved: run_import_supabase's
existing place_id/proximity matching (plus the within-run staleness fix below)
already prevents them from becoming duplicate activities - worst case is a
few redundant Text Search calls (~$0.03 each), not bad data.

Usage:
    py settlement_gap_fill.py --dry-run   # report only, no Supabase writes
    py settlement_gap_fill.py             # writes new playgrounds to Supabase
"""
import argparse
import asyncio
import logging
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

import matching
import playground_discovery as pd
from google_places import GooglePlacesClient
from supabase_client import SupabaseBotClient, load_import_tool_env

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("settlement_gap_fill")

THIS_DIR = Path(__file__).resolve().parent

ROUND1_SETTLEMENTS = [
    "שילת", "חוטר", "נוה ימין", "קריית ים", "קריית ביאליק", "סביון", "כפר שמריהו",
    "קדימה צורן", "נורדיה", "טירת הכרמל", "פרדס חנה כרכור", "טירת כרמל",
    "גבעת שמואל", "הוד השרון", "ינוב", "נהריה",
]
# כל שאר הדוח מ-2026-09-11 (86 שורות) שעדיין לא טופל, חוץ מ-Qalqilya (ראו למעלה) - אושר
# במפורש ע"י המשתמש (סעיף "מלא את כל ה-73") אחרי שהתגלה ש"פארק ניצן" בפרדסיה חסר.
ROUND2_SETTLEMENTS = [
    "תל אביב", "קרית מוצקין", "קרית ים", "קרית ביאליק", "ירושלים", "קדימה - צורן",
    "מעוז ציון", "אזור", "קריית אונו", "גבעת הרקפות", "רמות השבים", "אלישמע",
    "בני ברק", "פרדס חנה-כרכור", "קרית אונו", "מודיעין מכבים רעות", "גני תקווה",
    "حي الملعب", "סתריה", "גן שורק", "כפר ביל\"ו ב׳", "שדה ורבורג",
    "מועצה אזורית דרום השרון", "כפר קאסם", "גבעת משה", "שדי חמד", "בני דרור",
    "צובה", "בן שמן", "פרדסיה", "المزرعة", "בית חנן", "רמת הדסה", "صور",
    "גינתון", "العقبة", "גבעתיים", "אור יהודה", "נחלים", "חגור", "רשפון",
    "עין יעקב", "מעיליא", "גדרה", "גני מודיעין", "יציץ", "ישרש", "חדיד",
    "רינתיה", "אלעד", "מזור", "עין ורד", "עין שריד", "צוקי ים", "בורגתה",
    "נצרת", "קריית מוצקין", "כפר ברא", "משמר איילון", "ג'וליס", "טירה",
    "כפר האורנים", "בית נחמיה", "שער חפר", "מועצה אזורית מנשה", "אלישיב",
    "כפר הרא\"ה", "כפר ידידיה", "טבריה", "חבצלת השרון", "אליכין", "ברקת",
]
APPROVED_SETTLEMENTS = ROUND1_SETTLEMENTS + ROUND2_SETTLEMENTS
SEARCH_RADIUS_M = 3000


def load_api_key() -> str:
    import os
    from pathlib import Path
    load_dotenv(Path(__file__).resolve().parent / ".env")
    key = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not key:
        raise SystemExit("GOOGLE_MAPS_API_KEY is not set (see .env.example).")
    return key


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="TuRu real follow-up for approved settlement gaps (Text Search, Pro-tier)")
    p.add_argument("--dry-run", action="store_true", help="classify + report only, no Supabase writes")
    return p.parse_args()


async def main() -> None:
    args = parse_args()
    api_key = load_api_key()
    load_import_tool_env()

    places = GooglePlacesClient(api_key, max_concurrency=3, requests_per_second=3.0)
    supabase = SupabaseBotClient()

    # ROUND1 already ran (see settlement_gap_fill_20260911.log) - only ROUND2 needs real API
    # calls now; APPROVED_SETTLEMENTS (both rounds combined) stays as the full historical record.
    settlements_to_run = ROUND2_SETTLEMENTS
    centroids = {s["city"]: s for s in await supabase.fetch_settlement_centroids()}
    missing = [c for c in settlements_to_run if c not in centroids]
    if missing:
        logger.warning("No centroid found for: %s (skipping)", missing)

    places_by_id: dict[str, matching.DiscoveredPlace] = {}
    for city in settlements_to_run:
        s = centroids.get(city)
        if not s:
            continue
        try:
            results = await places.search_text(
                query="גן שעשועים", lat=s["lat"], lon=s["lng"], radius_m=SEARCH_RADIUS_M, max_results=20,
            )
        except Exception as exc:
            logger.error("[ERROR] %s: %s", city, exc)
            continue
        logger.info("%s: %d raw results", city, len(results))
        for r in results:
            place_id = r.get("id")
            if not place_id or place_id in places_by_id:
                continue
            loc = r.get("location") or {}
            places_by_id[place_id] = matching.DiscoveredPlace(
                place_id=place_id, name=(r.get("displayName") or {}).get("text"),
                formatted_address=r.get("formattedAddress"), lat=loc.get("latitude"), lon=loc.get("longitude"),
                types=r.get("types", []), primary_type=r.get("primaryType"), google_maps_uri=r.get("googleMapsUri"),
                discovered_by_queries={f"settlement:{city}"}, discovered_by_grid_points=set(),
                discovery_methods={"settlement_gap_fill"}, occurrence_count=1,
            )

    logger.info("Total unique places found across %d settlements: %d", len(settlements_to_run), len(places_by_id))

    master_rows, review_rows, rejected_rows = pd.classify_and_bucket(places_by_id, pd.israel_geo.DEFAULT_ISRAEL_BOUNDS)
    logger.info("master=%d review=%d rejected=%d", len(master_rows), len(review_rows), len(rejected_rows))

    # review_rows/rejected_rows לא נכתבו לשום מקום קודם בסקריפט הזה (בניגוד ל-playground_
    # discovery.py הרגיל) - היו נעלמים בלי עקבות אחרי כל ריצה. review כולל בדיוק את המקומות
    # שה-AI/geocoding לא היו בטוחים לגביהם (למשל "אולי כפילות" או "בלי כתובת ברורה") - בדיוק
    # סוג המידע שהמשתמש ביקש למצוא ("אילו גנים פוספסו"), אז שומרים אותו ל-CSV, לא מוחקים בשקט.
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    pd.write_csv(THIS_DIR / f"settlement_gap_fill_review_{timestamp}.csv", review_rows)
    pd.write_csv(THIS_DIR / f"settlement_gap_fill_rejected_{timestamp}.csv", rejected_rows)

    if args.dry_run:
        for row in master_rows:
            logger.info("  [MASTER] %s - %s", row["name"], row["formatted_address"])
        logger.info("(dry run) not matching/importing against Supabase.")
        return

    stats = {}
    await pd.run_import_supabase(master_rows, stats)
    logger.info("Match counts: %s", stats["supabase_match_counts"])
    logger.info("Imported as brand-new playgrounds: %d", stats["supabase_imported"])
    logger.info("api_requests=%d", places.stats.total_requests)
    pd.write_csv(THIS_DIR / f"settlement_gap_fill_master_{timestamp}.csv", master_rows)  # rewrite with match/import outcome


if __name__ == "__main__":
    asyncio.run(main())
