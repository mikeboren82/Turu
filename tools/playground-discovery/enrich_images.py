"""
TuRu - playground/park image enrichment.

For every activity with a google_place_id (supabase/0055) but no
trustworthy image (supabase_client.is_trusted_image), checks whether Google Places has a photo for that
place, and if so inserts an activity_images row pointing at the
place-photo Edge Function (supabase/functions/place-photo) - never a raw
Google-hosted photo URL. See that function's header comment and
supabase_client.fetch_activities_needing_images for why (Google's terms only
allow indefinite storage of place_id, not the photo/photo-name).

Only ever INSERTs new activity_images rows - never touches an existing one.

Places image automation (2026-09-26): this is also the Monster job `places_photos`
(tools/import-tool/lib/monsterJobs.js - hourly, before the Cleaner, gated by
automation_settings.places_photos_enabled). Every run, scheduled or by hand:
  - selects SERVER-SIDE: status approved, google_place_id set, no TRUSTWORTHY image (a place-photo proxy row of
    any status, or an approved ORIGINAL_SOURCE image not under rights review - pending / rejected / external /
    unknown / null-provenance images never block one proxy and are never touched), created more than 10 minutes ago (the scan-settlement-gaps inline insert wins), oldest first
    (created_at, id); --limit is applied to that ordered cohort, never to an unordered list
  - skips a place the ledger says is not due: automation_settings.places_photo_checks holds only
    non-success outcomes per activity (no_photo -> 30 days, invalid 400/404 -> 90 days, error ->
    6h * 2^(n-1) capped at 7 days, parked 30 days after 6 failures); an entry recorded for a different
    google_place_id is ignored; a success removes the entry (activity_images is the source of truth)
  - re-checks the activity right before inserting (raced: a trustworthy image appeared, or it is no longer approved)
  - stops on 401/403 (exit 2, configuration - nothing recorded per row) and on persistent 429 (exit 3,
    circuit breaker - the remaining rows stay untouched); counts every Places attempt against
    --daily-max-calls (UTC day, stored in the same ledger)
  - requests only the `photos` field (existence) - never websiteUri / phone / hours / ratings

Usage:
    py enrich_images.py --list-only --limit 50           # the exact cohort; 0 Places calls, 0 writes
    py enrich_images.py --dry-run --limit 20             # Places calls, 0 writes
    py enrich_images.py --apply --activity-id <uuid> --limit 1
    py enrich_images.py --apply --limit=50 --max-concurrency=2 --requests-per-second=2 --daily-max-calls=300
"""
import argparse
import asyncio
import logging
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv

from google_places import (
    CallBudget, GooglePlacesClient, PlacesApiError, PlacesAuthError, PlacesCallBudgetExhausted,
    PlacesInvalidPlace, PlacesRateLimited,
)
from supabase_client import SupabaseBotClient, is_place_photo_proxy, load_import_tool_env

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("enrich_images")

THIS_DIR = Path(__file__).resolve().parent

LEDGER_KEY = "places_photo_checks"
GRACE = timedelta(minutes=10)
NO_PHOTO_RECHECK = timedelta(days=30)
INVALID_RECHECK = timedelta(days=90)
ERROR_BACKOFF_BASE = timedelta(hours=6)
ERROR_BACKOFF_CAP = timedelta(days=7)
ERROR_PARK_AFTER = 6
ERROR_PARK = timedelta(days=30)
PAGE_SIZE = 100
MAX_PAGES = 50  # 5,000 rows scanned at most per run - far above today's cohort, a guard against a runaway loop

EXIT_OK, EXIT_AUTH, EXIT_RATE_LIMITED = 0, 2, 3
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


def load_api_key() -> str:
    load_dotenv(THIS_DIR / ".env")
    key = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not key:
        raise SystemExit("GOOGLE_MAPS_API_KEY is not set (see .env.example).")
    return key


def _uuid(value: str) -> str:
    if not UUID_RE.match(value or ""):
        raise argparse.ArgumentTypeError(f"not an activity uuid: {value!r}")
    return value.lower()


def _timestamp(value: str) -> str:
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"not an ISO timestamp: {value!r}") from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return iso(dt)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="microseconds")


def parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="TuRu Places photo enrichment (Monster job places_photos)")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true", help="write images + ledger (also the default when no mode is given)")
    mode.add_argument("--dry-run", action="store_true", help="call Places, report what would be added, never write to Supabase")
    mode.add_argument("--list-only", action="store_true", help="print the exact scheduled cohort; 0 Places calls, 0 writes")
    p.add_argument("--limit", type=int, default=50, help="due candidates to process, oldest first (default 50)")
    p.add_argument("--activity-id", dest="activity_ids", action="append", type=_uuid, default=None,
                   help="restrict to this activity (repeatable); every other rule still applies")
    p.add_argument("--created-after", type=_timestamp, default=None, help="only activities created after this instant")
    p.add_argument("--daily-max-calls", type=int, default=300, help="Places attempts per UTC day across runs (default 300)")
    p.add_argument("--max-concurrency", type=int, default=2)
    p.add_argument("--requests-per-second", type=float, default=2.0)
    args = p.parse_args(argv)
    if args.limit < 1:
        p.error("--limit must be >= 1")
    args.mode = "list" if args.list_only else "dry" if args.dry_run else "apply"
    return args


# ---- ledger (automation_settings.places_photo_checks) -------------------------------------------------------
# { "version": 1, "calls": {"date": "YYYY-MM-DD", "count": n},
#   "entries": { activity_id: { place_id, status: no_photo|error|invalid, attempt_count, last_checked_at,
#                               next_check_at, last_error_class? } } }

def empty_ledger() -> dict:
    return {"version": 1, "calls": {"date": None, "count": 0}, "entries": {}}


def normalize_ledger(value) -> dict:
    led = empty_ledger()
    if isinstance(value, dict):
        if isinstance(value.get("entries"), dict):
            led["entries"] = {k: v for k, v in value["entries"].items() if isinstance(v, dict)}
        if isinstance(value.get("calls"), dict):
            led["calls"] = {"date": value["calls"].get("date"), "count": int(value["calls"].get("count") or 0)}
    return led


def ledger_blocks(entry: dict | None, place_id: str, now: datetime) -> bool:
    """True when the ledger says this (activity, place) is not due yet. An entry for a different place id never
    suppresses the current one."""
    if not entry or entry.get("place_id") != place_id:
        return False
    nxt = parse_ts(entry.get("next_check_at"))
    return nxt is not None and nxt > now


def error_backoff(attempt_count: int) -> timedelta:
    if attempt_count >= ERROR_PARK_AFTER:
        return ERROR_PARK
    return min(ERROR_BACKOFF_CAP, ERROR_BACKOFF_BASE * (2 ** max(0, attempt_count - 1)))


def ledger_record(ledger: dict, activity_id: str, place_id: str, status: str, now: datetime,
                  error_class: str | None = None) -> dict:
    prev = ledger["entries"].get(activity_id)
    same = prev if prev and prev.get("place_id") == place_id else None
    # attempt_count counts consecutive outcomes of the same kind for this place (errors drive the backoff)
    attempts = (int(same.get("attempt_count") or 0) + 1) if same and same.get("status") == status else 1
    delay = NO_PHOTO_RECHECK if status == "no_photo" else INVALID_RECHECK if status == "invalid" else error_backoff(attempts)
    entry = {"place_id": place_id, "status": status, "attempt_count": attempts,
             "last_checked_at": iso(now), "next_check_at": iso(now + delay)}
    if error_class:
        entry["last_error_class"] = error_class
    ledger["entries"][activity_id] = entry
    return entry


def daily_remaining(ledger: dict, today: str, daily_max: int) -> int:
    used = ledger["calls"]["count"] if ledger["calls"].get("date") == today else 0
    return max(0, daily_max - used)


# ---- cohort -------------------------------------------------------------------------------------------------

async def select_cohort(store, ledger: dict, *, now: datetime, limit: int, activity_ids: list[str] | None,
                        created_after: str | None, want_total: bool = False) -> dict:
    """Walk the server-ordered cohort (keyset pages) and take the first `limit` rows the ledger lets through.
    want_total keeps walking to count the whole eligible cohort (list-only report)."""
    created_before = iso(now - GRACE)
    due, not_due, rejected, total = [], [], [], 0
    after = None
    for _ in range(MAX_PAGES):
        page = await store.fetch_places_photo_candidates_page(
            created_before=created_before, created_after=created_after, activity_ids=activity_ids,
            after=after, limit=PAGE_SIZE)
        for row in page:
            # belt and braces: the server already filtered; never use a row that says otherwise (paging stays on
            # the raw page, so a dropped row never ends the walk early)
            why = SupabaseBotClient.candidate_rejection(row)
            if why:
                rejected.append((row, why))
                logger.warning("server returned a non-candidate %s (%s) - skipped", row.get("id"), why)
                continue
            total += 1
            if ledger_blocks(ledger["entries"].get(row["id"]), row["google_place_id"], now):
                not_due.append(row)
            elif len(due) < limit:
                due.append(row)
        if len(page) < PAGE_SIZE or (len(due) >= limit and not want_total):
            break
        after = (page[-1]["created_at"], page[-1]["id"])
    return {"due": due, "not_due": not_due, "rejected": rejected, "total_scanned": total,
            "created_before": created_before}


def image_summary(row: dict) -> str:
    """List-report view of the (untrusted) images a candidate already carries: status/source_type/rights[/proxy]."""
    tags = []
    for img in row.get("images") or []:
        tag = f"{img.get('status')}/{img.get('image_source_type') or 'null'}/rr={str(img.get('needs_rights_review')).lower()}"
        tags.append(tag + ("/proxy" if is_place_photo_proxy(img.get("url")) else ""))
    return "images=[" + ",".join(sorted(tags)) + "]" if tags else "images=none"


def describe(row: dict, ledger: dict) -> str:
    entry = ledger["entries"].get(row["id"])
    if not entry:
        state = "never_checked"
    elif entry.get("place_id") != row["google_place_id"]:
        state = f"ledger_{entry.get('status')}_for_other_place"
    else:
        state = f"ledger_{entry.get('status')}_due(x{entry.get('attempt_count')})"
    return (f"{row['id']} created={row['created_at']} place={row['google_place_id']} status={row['status']} {state} "
            f"{image_summary(row)}")


# ---- the job ------------------------------------------------------------------------------------------------

async def run_job(args: argparse.Namespace, *, store, places_factory=None, now: datetime | None = None,
                  photo_proxy_base: str | None = None) -> tuple[int, dict]:
    now = now or datetime.now(timezone.utc)
    mode = args.mode
    ledger = normalize_ledger(await store.read_setting(LEDGER_KEY, None))
    cohort = await select_cohort(store, ledger, now=now, limit=args.limit, activity_ids=args.activity_ids,
                                 created_after=args.created_after, want_total=(mode == "list"))
    candidates = cohort["due"]
    summary = {"mode": mode, "candidates": len(candidates), "scanned": cohort["total_scanned"],
               "skipped_not_due": len(cohort["not_due"]), "server_mismatch": len(cohort["rejected"]), "added": 0, "no_photo": 0, "invalid": 0, "errors": 0,
               "raced": 0, "untouched": 0, "api_attempts": 0, "outcome": "ok"}
    logger.info("cohort: approved + google_place_id + no trustworthy image + created < %s%s%s | scanned %d, ledger-not-due %d, "
                "due taken %d (limit %d)", cohort["created_before"],
                f" + created > {args.created_after}" if args.created_after else "",
                f" + ids {args.activity_ids}" if args.activity_ids else "",
                cohort["total_scanned"], len(cohort["not_due"]), len(candidates), args.limit)

    if mode == "list":
        for row in candidates:
            print("CANDIDATE " + describe(row, ledger))
        for row in cohort["not_due"]:
            entry = ledger["entries"][row["id"]]
            print(f"NOT_DUE {row['id']} {entry.get('status')} next={entry.get('next_check_at')}")
        logger.info("Done (list-only). %s", _fmt(summary))
        return EXIT_OK, summary

    today = now.date().isoformat()
    budget = CallBudget(daily_remaining(ledger, today, args.daily_max_calls))
    places = places_factory(budget)
    ledger_dirty = False
    stop = {"reason": None}
    queue: asyncio.Queue = asyncio.Queue()
    for row in candidates:
        queue.put_nowait(row)

    def record(row, status, error_class=None):
        nonlocal ledger_dirty
        ledger_record(ledger, row["id"], row["google_place_id"], status, now, error_class)
        ledger_dirty = True

    def forget(activity_id):
        nonlocal ledger_dirty
        if ledger["entries"].pop(activity_id, None) is not None:
            ledger_dirty = True

    async def process(row: dict) -> None:
        name, place_id = row.get("name"), row["google_place_id"]
        try:
            has = await places.has_photos(place_id)
        except PlacesAuthError as exc:
            stop["reason"] = stop["reason"] or "auth"
            summary["untouched"] += 1
            logger.error("[ABORT] Places auth/config failure (HTTP %s) - nothing recorded for this row", exc.status_code)
            return
        except PlacesRateLimited:
            stop["reason"] = stop["reason"] or "rate_limited"
            summary["untouched"] += 1
            logger.error("[CIRCUIT BREAKER] persistent 429 at %s - stopping this run", row["id"])
            return
        except PlacesCallBudgetExhausted:
            stop["reason"] = stop["reason"] or "daily_budget"
            summary["untouched"] += 1
            return
        except PlacesInvalidPlace as exc:
            summary["invalid"] += 1
            if mode == "apply":
                record(row, "invalid", f"http_{exc.status_code}")
            logger.warning("[INVALID] %s (%s): HTTP %s", name, place_id, exc.status_code)
            return
        except PlacesApiError as exc:
            summary["errors"] += 1
            if mode == "apply":
                record(row, "error", exc.error_class)
            logger.error("[ERROR] %s (%s): %s", name, place_id, exc.error_class)
            return
        except Exception as exc:  # never let one row kill the run
            summary["errors"] += 1
            if mode == "apply":
                record(row, "error", "unexpected")
            logger.error("[ERROR] %s (%s): unexpected %s", name, place_id, type(exc).__name__)
            return

        if not has:
            summary["no_photo"] += 1
            if mode == "apply":
                record(row, "no_photo")
            logger.info("[NO PHOTO] %s (%s)", name, place_id)
            return

        photo_url = f"{photo_proxy_base}/{place_id}"
        if mode == "dry":
            summary["added"] += 1
            logger.info("[DRY RUN] would add image for %s -> %s", name, photo_url)
            return

        # race guard: the row may have gained a TRUSTWORTHY image (inline proxy insert, another run, an approved
        # original-source image) or left `approved` since the SELECT. A new untrusted image (pending / external /
        # null provenance) does not block the one sanctioned proxy.
        try:
            fresh = await store.fetch_activity_image_state(row["id"])
        except Exception as exc:
            summary["errors"] += 1
            record(row, "error", "recheck_failed")
            logger.error("[ERROR] re-check failed for %s: %s", row["id"], type(exc).__name__)
            return
        if fresh is None or fresh["has_trusted_image"] or fresh["status"] != "approved" or fresh["google_place_id"] != place_id:
            summary["raced"] += 1
            forget(row["id"])
            logger.info("[RACED] %s - state changed since selection (%s); not inserting", row["id"],
                        "gone" if fresh is None else "trustworthy image present" if fresh["has_trusted_image"] else
                        f"status {fresh['status']}" if fresh["status"] != "approved" else "place id changed")
            return
        try:
            await store.insert_place_photo_reference(activity_id=row["id"], photo_url=photo_url,
                                                     google_maps_uri=row.get("source_url"))
        except httpx.HTTPStatusError as exc:
            code = exc.response.status_code
            if code == 409:  # a duplicate-equivalent answer: the image is already there
                summary["raced"] += 1
                forget(row["id"])
                logger.info("[RACED] %s - insert answered 409 (already present)", row["id"])
                return
            if code in (401, 403):
                stop["reason"] = stop["reason"] or "auth"
                summary["untouched"] += 1
                logger.error("[ABORT] Supabase refused the insert (HTTP %s) - bot session/RLS problem", code)
                return
            summary["errors"] += 1
            record(row, "error", f"insert_http_{code}")
            logger.error("[ERROR] insert failed for %s: HTTP %s", row["id"], code)
            return
        except Exception as exc:
            summary["errors"] += 1
            record(row, "error", "insert_failed")
            logger.error("[ERROR] insert failed for %s: %s", row["id"], type(exc).__name__)
            return
        summary["added"] += 1
        forget(row["id"])
        logger.info("[ADDED] %s -> %s", name, photo_url)

    async def worker() -> None:
        while True:
            try:
                row = queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            if stop["reason"]:
                summary["untouched"] += 1
                continue
            await process(row)

    await asyncio.gather(*(worker() for _ in range(max(1, args.max_concurrency))))

    summary["api_attempts"] = budget.used
    if mode == "apply":
        if budget.used:
            prior = ledger["calls"]["count"] if ledger["calls"].get("date") == today else 0
            ledger["calls"] = {"date": today, "count": prior + budget.used}
            ledger_dirty = True
        if stop["reason"] != "auth":
            ledger_dirty = await prune_ledger(store, ledger, candidates) or ledger_dirty
        if ledger_dirty:
            await store.write_setting(LEDGER_KEY, ledger)
    summary["ledger_entries"] = len(ledger["entries"])

    code = EXIT_OK
    if stop["reason"] == "auth":
        summary["outcome"], code = "aborted_auth", EXIT_AUTH
    elif stop["reason"] == "rate_limited":
        summary["outcome"], code = "circuit_breaker_429", EXIT_RATE_LIMITED
    elif stop["reason"] == "daily_budget":
        summary["outcome"] = "daily_budget_exhausted"
    logger.info("Done. %s", _fmt(summary))
    return code, summary


async def prune_ledger(store, ledger: dict, processed: list[dict]) -> bool:
    """Keep the ledger compact: drop entries whose activity is no longer a candidate (trustworthy image, not approved /
    not visible, or the place id changed). Rows handled this run are already current. Failure never blocks."""
    seen = {r["id"] for r in processed}
    ids = [k for k in ledger["entries"] if k not in seen]
    if not ids:
        return False
    try:
        states = await store.fetch_activity_image_states(ids)
    except Exception as exc:
        logger.warning("ledger prune skipped: %s", type(exc).__name__)
        return False
    dropped = 0
    for activity_id in ids:
        st = states.get(activity_id)
        entry = ledger["entries"][activity_id]
        if st is None or st["has_trusted_image"] or st["status"] != "approved" or st["google_place_id"] != entry.get("place_id"):
            del ledger["entries"][activity_id]
            dropped += 1
    if dropped:
        logger.info("ledger pruned %d entr%s no longer eligible", dropped, "y" if dropped == 1 else "ies")
    return dropped > 0


def _fmt(summary: dict) -> str:
    return " ".join(f"{k}={v}" for k, v in summary.items())


async def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    load_import_tool_env()
    supabase_url = os.environ.get("SUPABASE_URL")
    if not supabase_url:
        raise SystemExit("SUPABASE_URL is not set (expected in tools/import-tool/.env).")
    store = SupabaseBotClient()
    places_factory = None
    if args.mode != "list":  # list-only never needs (or reads) the Places key and never builds a Places client
        api_key = load_api_key()

        def places_factory(budget):
            return GooglePlacesClient(api_key, max_concurrency=args.max_concurrency,
                                      requests_per_second=args.requests_per_second, max_retries=2, call_budget=budget)
    code, _ = await run_job(args, store=store, places_factory=places_factory,
                            photo_proxy_base=f"{supabase_url}/functions/v1/place-photo")
    return code


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
