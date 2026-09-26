"""
Places image automation (Monster job places_photos) - enrich_images.py + google_places retry policy +
supabase_client cohort query. No network: Supabase is an in-memory PostgREST fake that interprets exactly the
filters the client sends (an unknown filter fails the test), Google Places is an httpx.MockTransport.

Run with:  py -m unittest test_enrich_images -v
"""
import json
import re
import unittest
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl, urlsplit

import httpx

import enrich_images as ei
from google_places import CallBudget, GooglePlacesClient
from supabase_client import SupabaseBotClient

BOT = "b0000000-0000-4000-8000-000000000000"
OTHER = "c0000000-0000-4000-8000-000000000000"
SUPA = "https://proj.supabase.test"
PROXY = f"{SUPA}/functions/v1/place-photo"
NOW = datetime(2026, 9, 26, 20, 0, 0, tzinfo=timezone.utc)


def uid(n: int) -> str:
    return f"00000000-0000-4000-8000-{n:012d}"


def ts(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="microseconds")


def pts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class FakeSupabase:
    """Just enough PostgREST: activities (+ embedded activity_images), activity_images, automation_settings.
    RLS: the bot sees approved activities and its own rows of any status (images_read / activities_select)."""

    def __init__(self):
        self.activities: dict[str, dict] = {}
        self.images: list[dict] = []
        self.settings: dict[str, object] = {}
        self.writes: list[tuple[str, str, object]] = []
        self.requests: list[str] = []
        self.on_state_check = None  # callback(activity_id) run before answering a race re-check
        self.insert_status = None   # force an HTTP status on activity_images insert

    def add(self, n: int, *, created: datetime | None = None, status="approved", place=None, created_by=OTHER,
            category="גן שעשועים", images=0, image_status="approved"):
        a = {"id": uid(n), "name": f"פארק {n}", "google_place_id": place if place is not None else f"PLACE{n}",
             "source_url": f"https://maps.google.com/?cid={n}", "status": status,
             "created_at": ts(created or (NOW - timedelta(days=10) + timedelta(minutes=n))),
             "created_by": created_by, "category": category}
        if place is False:
            a["google_place_id"] = None
        self.activities[a["id"]] = a
        for i in range(images):
            self.images.append({"id": f"img-{n}-{i}", "activity_id": a["id"], "url": "https://x/y.jpg",
                                "status": image_status})
        return a

    def images_of(self, activity_id):
        return [i for i in self.images if i["activity_id"] == activity_id]

    def visible(self, a):
        return a["status"] == "approved" or a["created_by"] == BOT

    # -- transport --
    def handler(self, request: httpx.Request) -> httpx.Response:
        url = urlsplit(str(request.url))
        path = url.path
        params = parse_qsl(url.query, keep_blank_values=True)
        self.requests.append(f"{request.method} {path}")
        if path == "/auth/v1/token":
            return httpx.Response(200, json={"access_token": "tok", "user": {"id": BOT}})
        if path == "/rest/v1/activities" and request.method == "GET":
            return httpx.Response(200, json=self._select_activities(params))
        if path == "/rest/v1/automation_settings" and request.method == "GET":
            key = dict(params)["key"].removeprefix("eq.")
            return httpx.Response(200, json=[{"value": self.settings[key]}] if key in self.settings else [])
        if path == "/rest/v1/automation_settings" and request.method == "POST":
            body = json.loads(request.content)
            assert dict(params).get("on_conflict") == "key"
            self.settings[body["key"]] = json.loads(json.dumps(body["value"]))
            self.writes.append(("upsert", "automation_settings", body["key"]))
            return httpx.Response(201)
        if path == "/rest/v1/activity_images" and request.method == "POST":
            body = json.loads(request.content)
            if self.insert_status:
                return httpx.Response(self.insert_status, json={"message": "forced"})
            self.images.append({**body, "id": f"new-{len(self.images)}", "status": "approved"})
            self.writes.append(("insert", "activity_images", body["activity_id"]))
            return httpx.Response(201)
        raise AssertionError(f"unmodelled request {request.method} {path} {params}")

    def _select_activities(self, params):
        rows = [a for a in self.activities.values() if self.visible(a)]
        order, limit, select = None, None, None
        for key, val in params:
            if key == "select":
                select = val
            elif key == "status":
                assert val.startswith("eq."), val
                rows = [a for a in rows if a["status"] == val[3:]]
            elif key == "google_place_id":
                assert val == "not.is.null", val
                rows = [a for a in rows if a["google_place_id"]]
            elif key == "activity_images":
                assert val == "is.null", val
                rows = [a for a in rows if not self.images_of(a["id"])]
            elif key == "created_at":
                op, t = val.split(".", 1)
                assert op in ("lt", "gt"), val
                rows = [a for a in rows if (pts(a["created_at"]) < pts(t) if op == "lt" else pts(a["created_at"]) > pts(t))]
            elif key == "id":
                if val.startswith("eq."):
                    if self.on_state_check:
                        self.on_state_check(val[3:])
                    rows = [a for a in rows if a["id"] == val[3:]]
                else:
                    m = re.fullmatch(r"in\.\((.*)\)", val)
                    assert m, val
                    ids = set(m.group(1).split(","))
                    rows = [a for a in rows if a["id"] in ids]
            elif key == "or":
                m = re.fullmatch(r'\(created_at\.gt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.gt\.([0-9a-f-]+)\)\)', val)
                assert m and m.group(1) == m.group(2), val
                t, last = pts(m.group(1)), m.group(3)
                rows = [a for a in rows if pts(a["created_at"]) > t or (pts(a["created_at"]) == t and a["id"] > last)]
            elif key == "order":
                assert val == "created_at.asc,id.asc", val
                order = True
            elif key == "limit":
                limit = int(val)
            else:
                raise AssertionError(f"unmodelled activities filter {key}={val}")
        if order:
            rows.sort(key=lambda a: (pts(a["created_at"]), a["id"]))
        if limit is not None:
            rows = rows[:limit]
        out = []
        for a in rows:
            r = {k: a[k] for k in ("id", "name", "google_place_id", "source_url", "status", "created_at")}
            if select and "activity_images(id)" in select:
                r["activity_images"] = [{"id": i["id"]} for i in self.images_of(a["id"])]
            out.append(r)
        return out


class FakePlaces:
    """Google Places Details (photos field). script[place_id] = list of steps consumed per attempt; a step is an int
    status, ('json', body), ('raw', text), ('429', retry_after) or an exception instance. Default: has a photo."""

    def __init__(self, default_has_photo=True):
        self.default_has_photo = default_has_photo
        self.script: dict[str, list] = {}
        self.no_photo: set[str] = set()
        self.calls: list[str] = []
        self.field_masks: set[str] = set()
        self.on_call = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        place = request.url.path.rsplit("/", 1)[-1]
        self.calls.append(place)
        self.field_masks.add(request.headers.get("X-Goog-FieldMask"))
        if self.on_call:
            self.on_call(place)
        steps = self.script.get(place)
        if steps:
            step = steps.pop(0) if len(steps) > 1 else steps[0]
            if isinstance(step, Exception):
                raise step
            if isinstance(step, int):
                return httpx.Response(step, json={"error": {"code": step}})
            kind, val = step
            if kind == "json":
                return httpx.Response(200, json=val)
            if kind == "raw":
                return httpx.Response(200, text=val)
            if kind == "429":
                return httpx.Response(429, headers={"Retry-After": str(val)} if val is not None else {}, json={})
        has = self.default_has_photo and place not in self.no_photo
        return httpx.Response(200, json={"photos": [{"name": f"places/{place}/photos/x"}]} if has else {})


async def _nosleep(_s):
    return None


def make_args(*argv):
    return ei.parse_args(list(argv))


async def run(db: FakeSupabase, places: FakePlaces, *argv, now=NOW, sleeps=None):
    args = make_args(*argv)
    store = SupabaseBotClient.__new__(SupabaseBotClient)
    store.url, store.anon_key = SUPA, "anon"
    store.bot_email = store.bot_password = "x"
    store._access_token = None
    store._bot_user_id = None
    store._transport = httpx.MockTransport(db.handler)
    built = []

    async def record_sleep(s):
        if sleeps is not None:
            sleeps.append(s)

    def factory(budget: CallBudget):
        c = GooglePlacesClient("test-key", max_concurrency=args.max_concurrency, requests_per_second=0,
                               max_retries=2, call_budget=budget, transport=httpx.MockTransport(places.handler),
                               sleep=record_sleep)
        built.append(c)
        return c

    code, summary = await ei.run_job(args, store=store, places_factory=factory, now=now, photo_proxy_base=PROXY)
    summary["_clients_built"] = len(built)
    return code, summary


def ledger(db):
    return db.settings.get(ei.LEDGER_KEY, {}).get("entries", {})


class CandidateScopingTests(unittest.IsolatedAsyncioTestCase):
    async def test_A_photo_gives_exactly_one_sanctioned_provider_proxy_image(self):
        db, gp = FakeSupabase(), FakePlaces()
        a = db.add(1)
        code, s = await run(db, gp, "--apply")
        self.assertEqual(code, 0)
        self.assertEqual(s["added"], 1)
        imgs = db.images_of(a["id"])
        self.assertEqual(len(imgs), 1)
        img = imgs[0]
        self.assertEqual(img["url"], f"{PROXY}/PLACE1")
        self.assertEqual(img["image_source_type"], "PROVIDER")
        self.assertEqual(img["image_source_url"], a["source_url"])
        self.assertIs(img["needs_rights_review"], False)
        self.assertEqual(img["uploaded_by"], BOT)
        self.assertNotIn("googleusercontent", json.dumps(img))
        self.assertNotIn("photos/", img["url"], "never a Google photo resource name")
        self.assertEqual(gp.field_masks, {"photos"}, "photo existence only - no websiteUri/phone/hours/ratings")
        self.assertEqual(ledger(db), {})

    async def test_C_archived_rows_excluded_even_when_bot_owned(self):
        db, gp = FakeSupabase(), FakePlaces()
        db.add(1, status="archived", created_by=BOT)
        db.add(2, status="archived")
        code, s = await run(db, gp, "--apply")
        self.assertEqual((s["candidates"], gp.calls, db.writes), (0, [], []))

    async def test_D_pending_and_rejected_excluded(self):
        db, gp = FakeSupabase(), FakePlaces()
        db.add(1, status="pending", created_by=BOT)
        db.add(2, status="rejected", created_by=BOT)
        db.add(3, place=False)
        code, s = await run(db, gp, "--apply")
        self.assertEqual((s["candidates"], gp.calls, db.writes), (0, [], []))

    async def test_E_existing_image_of_any_status_excluded(self):
        db, gp = FakeSupabase(), FakePlaces()
        db.add(1, images=1, image_status="approved")
        db.add(2, images=1, image_status="pending")
        db.add(3, images=1, image_status="rejected")
        db.add(4)
        code, s = await run(db, gp, "--apply")
        self.assertEqual(gp.calls, ["PLACE4"])
        self.assertEqual(s["added"], 1)

    async def test_M_playground_without_cleaner_case_processed(self):
        db, gp = FakeSupabase(), FakePlaces()
        db.add(1, category="גן שעשועים")
        code, s = await run(db, gp, "--apply")
        self.assertEqual(s["added"], 1)
        self.assertFalse(any("cleaner" in r for r in db.requests), "the job never reads or writes cleaner_cases")

    async def test_N_120_candidates_limit_50_takes_exactly_the_oldest_50(self):
        db, gp = FakeSupabase(), FakePlaces()
        order = list(range(1, 121))
        for n in reversed(order):  # insertion order != age order
            db.add(n, created=NOW - timedelta(days=200) + timedelta(hours=n))
        code, s = await run(db, gp, "--apply", "--limit=50")
        self.assertEqual(s["candidates"], 50)
        self.assertEqual(sorted(gp.calls), sorted(f"PLACE{n}" for n in range(1, 51)))
        self.assertEqual(len([w for w in db.writes if w[1] == "activity_images"]), 50)

    async def test_N2_ledger_blocked_old_rows_never_starve_newer_ones(self):
        db, gp = FakeSupabase(), FakePlaces()
        for n in range(1, 131):
            db.add(n, created=NOW - timedelta(days=200) + timedelta(hours=n))
        entries = {uid(n): {"place_id": f"PLACE{n}", "status": "no_photo", "attempt_count": 1,
                            "last_checked_at": ts(NOW - timedelta(days=1)),
                            "next_check_at": ts(NOW + timedelta(days=29))} for n in range(1, 111)}
        db.settings[ei.LEDGER_KEY] = {"version": 1, "calls": {"date": None, "count": 0}, "entries": entries}
        code, s = await run(db, gp, "--apply", "--limit=5")
        self.assertEqual(gp.calls, [f"PLACE{n}" for n in range(111, 116)], "keyset paging reaches past the parked rows")
        self.assertEqual(s["skipped_not_due"], 110)

    async def test_O_ten_minute_grace_window(self):
        db, gp = FakeSupabase(), FakePlaces()
        db.add(1, created=NOW - timedelta(minutes=5))
        db.add(2, created=NOW - timedelta(minutes=9, seconds=59))
        db.add(3, created=NOW - timedelta(minutes=11))
        code, s = await run(db, gp, "--apply")
        self.assertEqual(gp.calls, ["PLACE3"])

    async def test_Q_activity_id_scoping_keeps_every_other_rule(self):
        db, gp = FakeSupabase(), FakePlaces()
        db.add(1); db.add(2); db.add(3, status="archived", created_by=BOT)
        code, s = await run(db, gp, "--apply", "--activity-id", uid(2), "--activity-id", uid(3))
        self.assertEqual(gp.calls, ["PLACE2"])
        self.assertEqual([w[2] for w in db.writes if w[1] == "activity_images"], [uid(2)])

    async def test_R_created_after_scoping(self):
        db, gp = FakeSupabase(), FakePlaces()
        db.add(1, created=datetime(2026, 9, 7, tzinfo=timezone.utc))
        db.add(2, created=datetime(2026, 9, 13, tzinfo=timezone.utc))
        code, s = await run(db, gp, "--apply", "--created-after", "2026-09-12T00:00:00Z")
        self.assertEqual(gp.calls, ["PLACE2"])

    async def test_S_list_only_zero_places_calls_zero_writes(self):
        db, gp = FakeSupabase(), FakePlaces()
        for n in range(1, 6):
            db.add(n)
        args = make_args("--list-only", "--limit=3")

        def boom(_budget):
            raise AssertionError("list-only must never build a Places client")
        store = SupabaseBotClient.__new__(SupabaseBotClient)
        store.url, store.anon_key, store.bot_email, store.bot_password = SUPA, "anon", "x", "x"
        store._access_token = store._bot_user_id = None
        store._transport = httpx.MockTransport(db.handler)
        code, s = await ei.run_job(args, store=store, places_factory=boom, now=NOW, photo_proxy_base=PROXY)
        self.assertEqual(code, 0)
        self.assertEqual((s["candidates"], s["scanned"], s["api_attempts"]), (3, 5, 0))
        self.assertEqual(gp.calls, [])
        self.assertEqual(db.writes, [])
        self.assertTrue(all(r.startswith("GET ") or r == "POST /auth/v1/token" for r in db.requests), db.requests)


class LedgerTests(unittest.IsolatedAsyncioTestCase):
    async def test_B_no_photo_ledgered_then_silent_for_30_days(self):
        db, gp = FakeSupabase(), FakePlaces()
        a = db.add(1); gp.no_photo.add("PLACE1")
        await run(db, gp, "--apply")
        e = ledger(db)[a["id"]]
        self.assertEqual((e["status"], e["place_id"], e["attempt_count"]), ("no_photo", "PLACE1", 1))
        self.assertEqual(pts(e["next_check_at"]), NOW + timedelta(days=30))
        self.assertEqual(db.images_of(a["id"]), [])
        gp.calls.clear()
        for later in (timedelta(hours=1), timedelta(days=29, hours=23)):
            code, s = await run(db, gp, "--apply", now=NOW + later)
            self.assertEqual(gp.calls, [], f"no Places call {later} later")
            self.assertEqual(s["skipped_not_due"], 1)
        await run(db, gp, "--apply", now=NOW + timedelta(days=30, minutes=1))
        self.assertEqual(gp.calls, ["PLACE1"], "due again after 30 days")
        self.assertEqual(ledger(db)[a["id"]]["attempt_count"], 2)

    async def test_B2_photo_found_later_removes_the_ledger_entry(self):
        db, gp = FakeSupabase(), FakePlaces()
        a = db.add(1); gp.no_photo.add("PLACE1")
        await run(db, gp, "--apply")
        gp.no_photo.clear()
        await run(db, gp, "--apply", now=NOW + timedelta(days=31))
        self.assertEqual(len(db.images_of(a["id"])), 1)
        self.assertNotIn(a["id"], ledger(db))

    async def test_H_404_and_400_are_invalid_for_90_days(self):
        for status in (404, 400):
            db, gp = FakeSupabase(), FakePlaces()
            a = db.add(1); gp.script["PLACE1"] = [status]
            code, s = await run(db, gp, "--apply")
            self.assertEqual((code, s["invalid"]), (0, 1))
            self.assertEqual(len(gp.calls), 1, "never retried in-run")
            e = ledger(db)[a["id"]]
            self.assertEqual((e["status"], e["last_error_class"]), ("invalid", f"http_{status}"))
            self.assertEqual(pts(e["next_check_at"]), NOW + timedelta(days=90))
            gp.calls.clear()
            await run(db, gp, "--apply", now=NOW + timedelta(days=89))
            self.assertEqual(gp.calls, [])

    async def test_P_changed_google_place_id_ignores_old_ledger_entry(self):
        db, gp = FakeSupabase(), FakePlaces()
        a = db.add(1, place="NEWPLACE")
        db.settings[ei.LEDGER_KEY] = {"version": 1, "entries": {a["id"]: {
            "place_id": "OLDPLACE", "status": "no_photo", "attempt_count": 3,
            "last_checked_at": ts(NOW - timedelta(days=1)), "next_check_at": ts(NOW + timedelta(days=29))}}}
        code, s = await run(db, gp, "--apply")
        self.assertEqual(gp.calls, ["NEWPLACE"])
        self.assertEqual(db.images_of(a["id"])[0]["url"], f"{PROXY}/NEWPLACE")
        self.assertNotIn(a["id"], ledger(db))

    async def test_prune_drops_entries_that_are_no_longer_candidates(self):
        db, gp = FakeSupabase(), FakePlaces()
        a = db.add(1, images=1)             # an image appeared elsewhere
        b = db.add(2, status="archived")    # left the catalogue (invisible to the bot)
        c = db.add(3); gp.no_photo.add("PLACE3")
        future = ts(NOW + timedelta(days=10))
        db.settings[ei.LEDGER_KEY] = {"version": 1, "entries": {
            x: {"place_id": p, "status": "no_photo", "attempt_count": 1, "last_checked_at": ts(NOW), "next_check_at": future}
            for x, p in ((a["id"], "PLACE1"), (b["id"], "PLACE2"), (c["id"], "PLACE3"))}}
        code, s = await run(db, gp, "--apply")
        self.assertEqual(set(ledger(db)), {c["id"]})

    async def test_daily_max_calls_caps_attempts_across_runs(self):
        db, gp = FakeSupabase(), FakePlaces()
        for n in range(1, 6):
            db.add(n)
        code, s = await run(db, gp, "--apply", "--daily-max-calls=3", "--max-concurrency=1")
        self.assertEqual((code, s["added"], s["untouched"], s["outcome"]), (0, 3, 2, "daily_budget_exhausted"))
        self.assertEqual(db.settings[ei.LEDGER_KEY]["calls"], {"date": "2026-09-26", "count": 3})
        gp.calls.clear()
        code, s = await run(db, gp, "--apply", "--daily-max-calls=3", now=NOW + timedelta(minutes=30))
        self.assertEqual(gp.calls, [])
        self.assertEqual(ledger(db), {}, "budget-starved rows are untouched, not recorded")
        await run(db, gp, "--apply", "--daily-max-calls=3", now=NOW + timedelta(days=1))
        self.assertEqual(len(gp.calls), 2, "a new UTC day has a fresh budget")


class RetryAndFailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_F_read_error_or_empty_disconnect_then_success_retries_and_inserts_once(self):
        for exc in (httpx.ReadError("boom"), httpx.RemoteProtocolError(""), httpx.ConnectError("x"),
                    httpx.ReadTimeout("slow")):
            db, gp = FakeSupabase(), FakePlaces()
            a = db.add(1)
            gp.script["PLACE1"] = [exc, ("json", {"photos": [{"name": "p"}]})]
            sleeps = []
            code, s = await run(db, gp, "--apply", sleeps=sleeps)
            self.assertEqual((code, s["added"], s["errors"]), (0, 1, 0), type(exc).__name__)
            self.assertEqual(len(db.images_of(a["id"])), 1)
            self.assertEqual(len(gp.calls), 2)
            self.assertEqual(len(sleeps), 1)
            self.assertTrue(1.0 <= sleeps[0] <= 1.5, sleeps)

    async def test_G_repeated_transient_errors_back_off_then_park(self):
        db, gp = FakeSupabase(), FakePlaces()
        a = db.add(1)
        gp.script["PLACE1"] = [httpx.ReadError("x")]
        sleeps = []
        code, s = await run(db, gp, "--apply", sleeps=sleeps)
        self.assertEqual((code, s["errors"], len(gp.calls)), (0, 1, 3), "3 tries in-run")
        self.assertTrue(1.0 <= sleeps[0] <= 1.5 and 2.0 <= sleeps[1] <= 2.5, sleeps)
        e = ledger(db)[a["id"]]
        self.assertEqual((e["status"], e["attempt_count"], e["last_error_class"]), ("error", 1, "transport"))
        self.assertEqual(pts(e["next_check_at"]), NOW + timedelta(hours=6))
        now, expected = NOW, [6, 12, 24, 48, 96]
        for i in range(1, 6):
            gp.calls.clear()
            await run(db, gp, "--apply", now=now + timedelta(hours=expected[i - 1] - 1))
            self.assertEqual(gp.calls, [], "not due before the backoff")
            now = now + timedelta(hours=expected[i - 1], minutes=1)
            await run(db, gp, "--apply", now=now)
            e = ledger(db)[a["id"]]
            self.assertEqual(e["attempt_count"], i + 1)
            want = timedelta(days=30) if i + 1 >= 6 else timedelta(hours=expected[i])
            self.assertEqual(pts(e["next_check_at"]) - now, want)
        self.assertEqual(db.images_of(a["id"]), [])

    async def test_G2_5xx_is_transient(self):
        db, gp = FakeSupabase(), FakePlaces()
        a = db.add(1); gp.script["PLACE1"] = [503, 500, ("json", {"photos": [{}]})]
        code, s = await run(db, gp, "--apply")
        self.assertEqual((s["added"], len(gp.calls)), (1, 3))

    async def test_malformed_200_is_retried_once_then_error(self):
        db, gp = FakeSupabase(), FakePlaces()
        a = db.add(1); gp.script["PLACE1"] = [("raw", "<html>oops</html>")]
        code, s = await run(db, gp, "--apply")
        self.assertEqual((s["errors"], len(gp.calls)), (1, 2))
        self.assertEqual(ledger(db)[a["id"]]["last_error_class"], "malformed")
        db2, gp2 = FakeSupabase(), FakePlaces()
        db2.add(1); gp2.script["PLACE1"] = [("raw", "not json"), ("json", {"photos": [{}]})]
        code, s = await run(db2, gp2, "--apply")
        self.assertEqual(s["added"], 1)

    async def test_I_403_aborts_non_zero_without_per_row_records(self):
        for status in (403, 401):
            db, gp = FakeSupabase(), FakePlaces(default_has_photo=True)
            for n in range(1, 11):
                db.add(n); gp.script[f"PLACE{n}"] = [status]
            code, s = await run(db, gp, "--apply", "--max-concurrency=2")
            self.assertEqual(code, ei.EXIT_AUTH)
            self.assertEqual(s["outcome"], "aborted_auth")
            self.assertLessEqual(len(gp.calls), 2, "stops after the in-flight rows")
            self.assertEqual(ledger(db), {}, "no invalid/error entry per activity")
            self.assertEqual([w for w in db.writes if w[1] == "activity_images"], [])
            self.assertEqual(s["untouched"], 10)

    async def test_J_persistent_429_trips_the_circuit_breaker(self):
        db, gp = FakeSupabase(), FakePlaces()
        for n in range(1, 11):
            db.add(n); gp.script[f"PLACE{n}"] = [("429", 2)]
        sleeps = []
        code, s = await run(db, gp, "--apply", "--max-concurrency=1", sleeps=sleeps)
        self.assertEqual((code, s["outcome"]), (ei.EXIT_RATE_LIMITED, "circuit_breaker_429"))
        self.assertEqual(len(gp.calls), 3, "one row, bounded retries, then stop")
        self.assertEqual(sleeps, [2.0, 2.0], "Retry-After honoured")
        self.assertEqual(ledger(db), {}, "rows left untouched")
        self.assertEqual(s["untouched"], 10)

    async def test_429_then_success_recovers(self):
        db, gp = FakeSupabase(), FakePlaces()
        db.add(1); gp.script["PLACE1"] = [("429", None), ("json", {"photos": [{}]})]
        code, s = await run(db, gp, "--apply")
        self.assertEqual((code, s["added"]), (0, 1))

    async def test_K_second_successful_cycle_adds_nothing(self):
        db, gp = FakeSupabase(), FakePlaces()
        for n in range(1, 4):
            db.add(n)
        await run(db, gp, "--apply")
        gp.calls.clear(); before = len(db.images)
        code, s = await run(db, gp, "--apply", now=NOW + timedelta(hours=1))
        self.assertEqual((s["candidates"], s["added"], len(db.images) - before, gp.calls), (0, 0, 0, []))

    async def test_L_image_appearing_between_select_and_insert_is_raced(self):
        db, gp = FakeSupabase(), FakePlaces()
        a = db.add(1)
        gp.on_call = lambda place: db.images.append({"id": "inline", "activity_id": a["id"], "url": "u", "status": "approved"})
        code, s = await run(db, gp, "--apply")
        self.assertEqual((s["raced"], s["added"]), (1, 0))
        self.assertEqual(len(db.images_of(a["id"])), 1, "only the image that raced in")
        self.assertEqual([w for w in db.writes if w[1] == "activity_images"], [])

    async def test_L2_row_archived_between_select_and_insert_is_raced(self):
        db, gp = FakeSupabase(), FakePlaces()
        a = db.add(1)
        gp.on_call = lambda place: db.activities[a["id"]].update(status="archived")
        code, s = await run(db, gp, "--apply")
        self.assertEqual((s["raced"], s["added"]), (1, 0))

    async def test_L3_duplicate_equivalent_insert_answer_is_raced(self):
        db, gp = FakeSupabase(), FakePlaces()
        db.add(1); db.insert_status = 409
        code, s = await run(db, gp, "--apply")
        self.assertEqual((code, s["raced"], s["errors"]), (0, 1, 0))

    async def test_dry_run_calls_places_but_writes_nothing(self):
        db, gp = FakeSupabase(), FakePlaces()
        db.add(1); db.add(2); gp.no_photo.add("PLACE2")
        code, s = await run(db, gp, "--dry-run")
        self.assertEqual((s["added"], s["no_photo"], len(gp.calls)), (1, 1, 2))
        self.assertEqual(db.writes, [])


class CliTests(unittest.TestCase):
    def test_modes_and_defaults(self):
        a = ei.parse_args([])
        self.assertEqual((a.mode, a.limit, a.daily_max_calls, a.max_concurrency, a.requests_per_second),
                         ("apply", 50, 300, 2, 2.0))
        self.assertEqual(ei.parse_args(["--list-only"]).mode, "list")
        self.assertEqual(ei.parse_args(["--dry-run"]).mode, "dry")
        self.assertEqual(ei.parse_args(["--apply", "--limit=1"]).limit, 1)
        with self.assertRaises(SystemExit):
            ei.parse_args(["--apply", "--list-only"])
        with self.assertRaises(SystemExit):
            ei.parse_args(["--activity-id", "1; drop table"])
        with self.assertRaises(SystemExit):
            ei.parse_args(["--limit=0"])

    def test_candidate_params_are_server_side_and_ordered(self):
        p = SupabaseBotClient.places_photo_candidate_params(created_before="T0", created_after="T1",
                                                            activity_ids=[uid(1)], after=("T2", uid(2)), limit=7)
        self.assertIn(("status", "eq.approved"), p)
        self.assertIn(("google_place_id", "not.is.null"), p)
        self.assertIn(("activity_images", "is.null"), p)
        self.assertIn(("created_at", "lt.T0"), p)
        self.assertIn(("created_at", "gt.T1"), p)
        self.assertIn(("order", "created_at.asc,id.asc"), p)
        self.assertIn(("limit", "7"), p)

    def test_monster_command_parses(self):
        a = ei.parse_args("--apply --limit=50 --max-concurrency=2 --requests-per-second=2 --daily-max-calls=300".split())
        self.assertEqual((a.mode, a.limit, a.max_concurrency, a.requests_per_second, a.daily_max_calls),
                         ("apply", 50, 2, 2.0, 300))


if __name__ == "__main__":
    unittest.main()
