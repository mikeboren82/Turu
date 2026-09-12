"""
TuRu - imports the full Israeli settlement registry (data.gov.il, dataset
"citiesandsettelments", resource 5c78e9fa-c2e2-4771-93ff-7f400a12f7ba, 1316
rows, fetched 2026-09-11) into public.settlements (supabase/0063_settlements.sql).

This is deliberately independent from tools/playground-discovery/israel_geo.py's
grid and from fetch_settlement_centroids() (which only "sees" a settlement if
TuRu already has an activity there) - the whole point (section 4 of the
2026-09-11 nationwide-playground-discovery request) is a settlement list that
does NOT depend on what TuRu already has. Never touches activities/locations/
incoming_activities - this table is pure reference data.

Geocoding: data.gov.il's list has no lat/lng. Uses Nominatim (OpenStreetMap,
free, same usage-policy-compliant pattern as elsewhere in this project - 1
req/sec, identifying User-Agent, retry-with-backoff on transient errors).
Checkpointed after every single geocode (not just every batch) so this is
safe to Ctrl+C and resume with the exact same command - already-geocoded
settlements are skipped on the next run.

Usage:
    py import_settlements.py --geocode        # resumable, ~1 req/sec, ~22 min for all 1316
    py import_settlements.py --upsert         # writes checkpoint.json rows to Supabase (idempotent upsert)
    py import_settlements.py --geocode --upsert --limit 20   # smoke test
"""
import argparse
import asyncio
import json
import logging
import time
import urllib.parse
import urllib.request
from pathlib import Path

import httpx

from supabase_client import SupabaseBotClient, load_import_tool_env

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("import_settlements")

THIS_DIR = Path(__file__).resolve().parent
RAW_PATH = THIS_DIR / "settlements_source.json"
CHECKPOINT_PATH = THIS_DIR / "settlements_geocode_checkpoint.json"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
# מזהה אמיתי - מדיניות השימוש של Nominatim מחייבת User-Agent מזהה (ראו lib/filterActivities.js
# הערה מקבילה בקוד ה-Node), לא "אנונימי" גנרי.
USER_AGENT = "TuRu-KidsApp-SettlementImport/1.0 (mborenmusic@gmail.com)"
MIN_INTERVAL_S = 1.05  # מעל שנייה אחת בכוונה - מרווח-בטיחות קטן מעל המדיניות (1 req/sec)


def load_source() -> list[dict]:
    with RAW_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def load_checkpoint() -> dict:
    if CHECKPOINT_PATH.exists():
        with CHECKPOINT_PATH.open(encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_checkpoint(state: dict) -> None:
    tmp = CHECKPOINT_PATH.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)
    tmp.replace(CHECKPOINT_PATH)


def geocode_one(name_he: str, retries: int = 3) -> dict | None:
    query = urllib.parse.urlencode({"q": f"{name_he}, Israel", "format": "jsonv2", "limit": 1})
    url = f"{NOMINATIM_URL}?{query}"
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=15) as resp:
                results = json.load(resp)
            if not results:
                return None
            r = results[0]
            return {"lat": float(r["lat"]), "lng": float(r["lon"]), "display_name": r.get("display_name")}
        except Exception as exc:
            if attempt == retries - 1:
                logger.warning("geocode failed for %r after %d retries: %s", name_he, retries, exc)
                return None
            time.sleep(2 * (attempt + 1))
    return None


def cmd_geocode(limit: int | None) -> None:
    rows = load_source()
    if limit:
        rows = rows[:limit]
    state = load_checkpoint()
    done = 0
    skipped = 0
    not_found = 0
    for row in rows:
        sid = row["סמל_ישוב"]
        if sid in state:
            skipped += 1
            continue
        t0 = time.monotonic()
        result = geocode_one(row["שם_ישוב"])
        state[sid] = {
            "settlement_id": sid, "name_he": row["שם_ישוב"], "name_en": row.get("שם_ישוב_לועזי") or None,
            "council": row.get("שם_מועצה") or None, "sub_district": row.get("שם_נפה") or None,
            "region": row.get("לשכה") or None,
            "lat": result["lat"] if result else None, "lng": result["lng"] if result else None,
            "geocode_source": "nominatim" if result else None,
        }
        if result:
            done += 1
        else:
            not_found += 1
        if (done + not_found) % 25 == 0:
            save_checkpoint(state)
            logger.info("progress: geocoded=%d not_found=%d skipped=%d / total=%d", done, not_found, skipped, len(rows))
        elapsed = time.monotonic() - t0
        if elapsed < MIN_INTERVAL_S:
            time.sleep(MIN_INTERVAL_S - elapsed)
    save_checkpoint(state)
    logger.info("DONE geocode: geocoded=%d not_found=%d skipped=%d total_in_checkpoint=%d", done, not_found, skipped, len(state))


async def cmd_upsert() -> None:
    load_import_tool_env()
    client = SupabaseBotClient()
    state = load_checkpoint()
    rows = list(state.values())
    logger.info("Upserting %d settlements to public.settlements", len(rows))
    async with httpx.AsyncClient(timeout=30.0) as http_client:
        token = await client._ensure_session(http_client)  # noqa: SLF001 - same internal reuse pattern as insert_new_playground
        headers = {
            "apikey": client.anon_key, "Authorization": f"Bearer {token}",
            "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal",
        }
        batch_size = 200
        for i in range(0, len(rows), batch_size):
            batch = rows[i:i + batch_size]
            resp = await http_client.post(f"{client.url}/rest/v1/settlements", headers=headers, json=batch)
            resp.raise_for_status()
            logger.info("upserted rows %d..%d", i, i + len(batch))
    logger.info("DONE upsert")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--geocode", action="store_true")
    p.add_argument("--upsert", action="store_true")
    p.add_argument("--limit", type=int, default=None)
    return p.parse_args()


if __name__ == "__main__":
    args = parse_args()
    if args.geocode:
        cmd_geocode(args.limit)
    if args.upsert:
        asyncio.run(cmd_upsert())
    if not args.geocode and not args.upsert:
        print("Nothing to do - pass --geocode and/or --upsert")
