"""
Places image automation (Monster job places_photos) - enrich_images.py + google_places retry policy +
supabase_client cohort query. No network: Supabase is an in-memory PostgREST fake that interprets exactly the
filters the client sends (an unknown filter fails the test), Google Places is an httpx.MockTransport.

FROZEN 2026-09-27: while GOOGLE_PLACES_CONTENT_PERSISTENCE is False the job refuses --apply / --dry-run
(PolicyFreezeTests). The behaviour tests below exercise the job logic for the day the policy is re-opened by a code
change: run() patches the module constant to True for exactly that call - there is no runtime override to patch.

Run with:  py -m unittest test_enrich_images -v
"""
import asyncio
import contextlib
import io
import json
import re
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock
from urllib.parse import parse_qsl, urlsplit

import httpx

import enrich_images as ei
from google_places import CallBudget, GooglePlacesClient
from supabase_client import SupabaseBotClient, image_state, is_trusted_image

# the exact PostgREST trust predicate the client must send (restated here, not imported: the fake is an oracle).
# 2026-09-27: server side it is rule B only - PostgREST cannot compare a proxy URL's embedded place id with the parent
# row's google_place_id, so the same-place proxy rule (A) is the job's own client-side check.
TRUST_OR = ('(and(status.eq.approved,image_source_type.eq.ORIGINAL_SOURCE,needs_rights_review.not.is.true,'
            'url.not.like."*/functions/v1/place-photo/_*"))')
PROXY_MARK = "/functions/v1/place-photo/"


def fake_trusted(img: dict) -> bool:
    """SQL semantics of TRUST_OR: approved AND ORIGINAL_SOURCE AND needs_rights_review IS NOT TRUE AND url NOT LIKE
    '%/functions/v1/place-photo/_%'."""
    url = img.get("url") or ""
    k = url.find(PROXY_MARK)
    if k >= 0 and len(url) > k + len(PROXY_MARK):
        return False
    return (img.get("status") == "approved" and img.get("image_source_type") == "ORIGINAL_SOURCE"
            and img.get("needs_rights_review") is not True)

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
        self.ignore_trust_filter = False  # simulate a server that does not honour the trust anti-join

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
            self.add_image(a, id=f"img-{n}-{i}", status=image_status)
        return a

    def add_image(self, a, *, url="https://x/y.jpg", status="approved", source_type=None, rights=False, **extra):
        """Column defaults as in the DB: status approved, image_source_type null, needs_rights_review false."""
        img = {"id": extra.pop("id", f"img-{len(self.images)}"), "activity_id": a["id"], "url": url, "status": status,
               "image_source_type": source_type, "needs_rights_review": rights, **extra}
        self.images.append(img)
        return img

    def trusted_of(self, activity_id):
        return [i for i in self.images_of(activity_id) if fake_trusted(i)]

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
            self.images.append({"status": "approved", **body, "id": f"new-{len(self.images)}"})
            self.writes.append(("insert", "activity_images", body["activity_id"]))
            return httpx.Response(201)
        raise AssertionError(f"unmodelled request {request.method} {path} {params}")

    def _select_activities(self, params):
        rows = [a for a in self.activities.values() if self.visible(a)]
        order, limit, select, trust_or = None, None, None, False
        for key, val in params:
            if key == "select":
                select = val
            elif key == "status":
                assert val.startswith("eq."), val
                rows = [a for a in rows if a["status"] == val[3:]]
            elif key == "google_place_id":
                assert val == "not.is.null", val
                rows = [a for a in rows if a["google_place_id"]]
            elif key == "trusted.or":
                assert val == TRUST_OR, val
                trust_or = True
            elif key == "trusted":
                assert val == "is.null" and trust_or, (val, "anti-join needs the embedded trust filter")
                if not self.ignore_trust_filter:
                    rows = [a for a in rows if not self.trusted_of(a["id"])]
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
            for alias, cols in re.findall(r"(?:(\w+):)?activity_images\(([^)]*)\)", select or ""):
                alias, cols = alias or "activity_images", cols.split(",")
                assert set(cols) <= {"id", "url", "status", "image_source_type", "needs_rights_review"}, cols
                imgs = self.images_of(a["id"])
                if alias == "trusted":
                    assert trust_or, "the trusted embed is only ever selected with its filter"
                    imgs = [] if self.ignore_trust_filter else [i for i in imgs if fake_trusted(i)]
                r[alias] = [{c: i.get(c) for c in cols} for i in imgs]
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

    with mock.patch.object(ei, "GOOGLE_PLACES_CONTENT_PERSISTENCE", True):  # the re-opened policy (see module doc)
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
        # Google Places release policy (2026-09-27): never the activity's Maps source_url; the proxy URL's embedded place
        # id is the only provenance kept
        self.assertIsNone(img["image_source_url"])
        self.assertNotIn("maps.google", json.dumps(img))
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

    async def test_E_only_a_trustworthy_image_excludes(self):
        db, gp = FakeSupabase(), FakePlaces()
        db.add_image(db.add(1), url=f"{PROXY}/PLACE1", source_type="PROVIDER")
        db.add_image(db.add(2), source_type="ORIGINAL_SOURCE")
        db.add(3, images=1, image_status="approved")
        db.add(4, images=1, image_status="pending")
        db.add(5, images=1, image_status="rejected")
        db.add(6)
        code, s = await run(db, gp, "--apply")
        self.assertEqual(sorted(gp.calls), ["PLACE3", "PLACE4", "PLACE5", "PLACE6"])
        self.assertEqual(s["added"], 4)

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
        a = db.add(1); db.add_image(a, url=f"{PROXY}/PLACE1")  # a proxy appeared elsewhere
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

    async def test_L_proxy_appearing_between_select_and_insert_is_raced(self):
        db, gp = FakeSupabase(), FakePlaces()
        a = db.add(1)
        gp.on_call = lambda place: db.add_image(a, id="inline", url=f"{PROXY}/PLACE1", source_type="PROVIDER")
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


def proxies(db, activity_id):
    return [i for i in db.images_of(activity_id) if PROXY_MARK in (i.get("url") or "")]


class TrustworthyImageTests(unittest.IsolatedAsyncioTestCase):
    """2026-09-26 safety follow-up: only a sanctioned proxy or an approved, rights-clear ORIGINAL_SOURCE image blocks
    the job; every other image leaves the activity a candidate (and is never modified)."""

    async def cohort_of(self, db):
        code, s = await run(db, FakePlaces(), "--list-only")
        self.assertEqual((code, s["api_attempts"], db.writes), (0, 0, []))
        return s

    async def assertCandidate(self, expected: bool, **image):
        db = FakeSupabase()
        a = db.add(1)
        db.add_image(a, **image)
        s = await self.cohort_of(db)
        self.assertEqual(s["candidates"], 1 if expected else 0, image)
        img = {"url": image.get("url", "https://x/y.jpg"), "status": image.get("status", "approved"),
               "image_source_type": image.get("source_type"), "needs_rights_review": image.get("rights", False)}
        self.assertEqual(is_trusted_image(img, a["google_place_id"]), not expected, "job predicate == cohort outcome")

    async def test_A_pending_external_image_only_is_a_candidate(self):
        await self.assertCandidate(True, status="pending", source_type="EXTERNAL_SOURCE", rights=True)
        await self.assertCandidate(True, status="pending", url="https://serp.example/a.jpg")  # the 09-13 shape

    async def test_B_approved_null_provenance_image_is_a_candidate(self):
        await self.assertCandidate(True, status="approved", source_type=None, rights=False)

    async def test_C_approved_external_source_is_a_candidate(self):
        await self.assertCandidate(True, source_type="EXTERNAL_SOURCE", rights=True)

    async def test_D_approved_external_source_without_rights_review_is_still_a_candidate(self):
        await self.assertCandidate(True, source_type="EXTERNAL_SOURCE", rights=False)

    async def test_E_approved_original_source_not_under_review_is_not_a_candidate(self):
        await self.assertCandidate(False, source_type="ORIGINAL_SOURCE", rights=False)
        # ...but only approved and rights-clear
        await self.assertCandidate(True, source_type="ORIGINAL_SOURCE", rights=True)
        await self.assertCandidate(True, source_type="ORIGINAL_SOURCE", status="pending")
        await self.assertCandidate(True, source_type="ORIGINAL_SOURCE", status="rejected")

    async def test_F_provider_proxy_is_not_a_candidate_whatever_its_metadata_or_host(self):
        await self.assertCandidate(False, url=f"{PROXY}/PLACE1", source_type="PROVIDER")
        await self.assertCandidate(False, url=f"{PROXY}/PLACE1", source_type=None)         # legacy metadata
        await self.assertCandidate(False, url="https://other-host.test/functions/v1/place-photo/PLACE1")
        await self.assertCandidate(False, url=f"{PROXY}/PLACE1", status="rejected")      # admin said no
        await self.assertCandidate(False, url=f"{PROXY}/PLACE1", status="pending")       # never a 2nd proxy
        # a PROVIDER label without the proxy url (raw Google url) or an empty proxy path is not a proxy
        await self.assertCandidate(True, url="https://lh3.googleusercontent.com/p/x", source_type="PROVIDER")
        await self.assertCandidate(True, url=f"{PROXY}/", source_type="PROVIDER")
        await self.assertCandidate(True, source_type="UNKNOWN")

    async def test_G_rejected_image_only_is_a_candidate(self):
        await self.assertCandidate(True, status="rejected")
        await self.assertCandidate(True, status="rejected", source_type="EXTERNAL_SOURCE", rights=True)

    async def test_untrusted_images_get_one_proxy_and_are_never_modified(self):
        db, gp = FakeSupabase(), FakePlaces()
        a = db.add(1)
        pend = db.add_image(a, status="pending", url="https://serp.example/a.jpg")
        legacy = db.add_image(a, status="approved", url="https://cdn.example/b.jpg")
        before = json.loads(json.dumps([pend, legacy]))
        code, s = await run(db, gp, "--apply")
        self.assertEqual(s["added"], 1)
        self.assertEqual(len(proxies(db, a["id"])), 1)
        self.assertEqual(db.images_of(a["id"])[:2], before, "existing rows untouched")
        self.assertEqual({(w[0], w[1]) for w in db.writes},
                         {("insert", "activity_images"), ("upsert", "automation_settings")},
                         "images: only the proxy insert; the rest is the ledger's call counter")

    async def test_H1_untrusted_image_appearing_before_insert_still_gets_the_proxy(self):
        for image in ({"status": "pending", "source_type": "EXTERNAL_SOURCE", "rights": True},
                      {"status": "approved"}, {"status": "rejected"},
                      {"status": "approved", "source_type": "ORIGINAL_SOURCE", "rights": True}):
            db, gp = FakeSupabase(), FakePlaces()
            a = db.add(1)
            gp.on_call = lambda place, a=a, image=image: db.add_image(a, id="raced-in", **image)
            code, s = await run(db, gp, "--apply")
            self.assertEqual((s["raced"], s["added"]), (0, 1), image)
            self.assertEqual(len(proxies(db, a["id"])), 1, image)
            self.assertEqual(len(db.images_of(a["id"])), 2, image)

    async def test_H2_trusted_image_appearing_before_insert_is_raced(self):
        for image in ({"url": f"{PROXY}/PLACE1", "source_type": "PROVIDER"},
                      {"url": f"{PROXY}/PLACE1", "status": "pending"},
                      {"source_type": "ORIGINAL_SOURCE", "rights": False}):
            db, gp = FakeSupabase(), FakePlaces()
            a = db.add(1)
            db.add_image(a, status="pending", url="https://serp.example/a.jpg")  # untrusted, from the start
            gp.on_call = lambda place, a=a, image=image: db.add_image(a, id="raced-in", **image)
            code, s = await run(db, gp, "--apply")
            self.assertEqual((s["raced"], s["added"]), (1, 0), image)
            self.assertEqual([w for w in db.writes if w[1] == "activity_images"], [], image)
            self.assertLessEqual(len(proxies(db, a["id"])), 1, image)

    async def test_I_second_run_after_proxy_insert_adds_nothing(self):
        db, gp = FakeSupabase(), FakePlaces()
        a = db.add(1); db.add_image(a, status="pending", url="https://serp.example/a.jpg")
        b = db.add(2); db.add_image(b, status="approved")
        c = db.add(3)
        code, s = await run(db, gp, "--apply")
        self.assertEqual(s["added"], 3)
        gp.calls.clear(); before = len(db.images)
        for later in (timedelta(hours=1), timedelta(days=40)):
            code, s = await run(db, gp, "--apply", now=NOW + later)
            self.assertEqual((s["candidates"], s["added"], len(db.images) - before, gp.calls), (0, 0, 0, []))
        for x in (a, b, c):
            self.assertEqual(len(proxies(db, x["id"])), 1)

    async def test_prune_keeps_an_entry_whose_activity_only_has_untrusted_images(self):
        db, gp = FakeSupabase(), FakePlaces()
        a = db.add(1); db.add_image(a, status="pending", url="https://serp.example/a.jpg")
        db.settings[ei.LEDGER_KEY] = {"version": 1, "entries": {a["id"]: {
            "place_id": "PLACE1", "status": "no_photo", "attempt_count": 1, "last_checked_at": ts(NOW),
            "next_check_at": ts(NOW + timedelta(days=10))}}}
        db.add(2)  # something to process, so the run writes the ledger
        await run(db, gp, "--apply")
        self.assertIn(a["id"], ledger(db), "still a candidate - the no_photo backoff must survive")
        self.assertEqual(proxies(db, a["id"]), [], "and not due, so untouched")

    async def test_limit_50_over_a_mixed_cohort_takes_the_oldest_50_eligible(self):
        db, gp = FakeSupabase(), FakePlaces()
        for n in range(1, 121):
            a = db.add(n, created=NOW - timedelta(days=200) + timedelta(hours=n))
            if n % 3 == 0:
                db.add_image(a, url=f"{PROXY}/PLACE{n}", source_type="PROVIDER")   # 40 excluded
            elif n % 3 == 1:
                db.add_image(a, status="pending", url="https://serp.example/x.jpg")  # 40 untrusted
        eligible = [n for n in range(1, 121) if n % 3 != 0]
        code, s = await run(db, gp, "--apply", "--limit=50")
        self.assertEqual(sorted(gp.calls), sorted(f"PLACE{n}" for n in eligible[:50]))
        self.assertEqual(len([w for w in db.writes if w[1] == "activity_images"]), 50)

    async def test_server_ignoring_the_trust_filter_is_caught_and_paging_continues(self):
        db, gp = FakeSupabase(), FakePlaces()
        db.ignore_trust_filter = True
        for n in range(1, 131):
            a = db.add(n, created=NOW - timedelta(days=200) + timedelta(hours=n))
            if n <= 105:
                db.add_image(a, source_type="ORIGINAL_SOURCE", rights=False)
        code, s = await run(db, gp, "--apply", "--limit=50")
        self.assertEqual(sorted(gp.calls), sorted(f"PLACE{n}" for n in range(106, 131)),
                         "no trusted row processed; a full first page of rejects did not end the walk")
        self.assertEqual((s["server_mismatch"], s["same_place_proxy"]), (105, 0))

    async def test_same_place_proxies_are_dropped_by_the_job_and_paging_continues(self):
        # the server cannot drop them (URL vs parent place id), so they arrive; a full page of them never ends the walk
        db, gp = FakeSupabase(), FakePlaces()
        for n in range(1, 131):
            a = db.add(n, created=NOW - timedelta(days=200) + timedelta(hours=n))
            if n <= 105:
                db.add_image(a, url=f"{PROXY}/PLACE{n}", source_type="PROVIDER")
        code, s = await run(db, gp, "--apply", "--limit=50")
        self.assertEqual(sorted(gp.calls), sorted(f"PLACE{n}" for n in range(106, 131)))
        self.assertEqual((s["server_mismatch"], s["same_place_proxy"]), (0, 105), "an expected drop, not a mismatch")

    async def test_list_only_reports_each_candidates_existing_images(self):
        db = FakeSupabase()
        a = db.add(1); db.add_image(a, status="pending", source_type="EXTERNAL_SOURCE", rights=True)
        db.add(2)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            await self.cohort_of(db)
        out = buf.getvalue()
        self.assertIn("images=[pending/EXTERNAL_SOURCE/rr=true]", out)
        self.assertIn("images=none", out)


class ProxyIdentityTests(unittest.IsolatedAsyncioTestCase):
    """2026-09-27: a proxy is trustworthy only for the place it embeds. URL identity is authoritative - a proxy copied
    from another activity (production ee34196d: keeper גן בולטימור אשקלון holding HaShayetet Playground's proxy) or a
    PROVIDER label on a wrong-id URL never blocks the job, whatever its status; a same-place proxy blocks at any status."""

    async def candidates(self, db):
        code, s = await run(db, FakePlaces(), "--list-only")
        self.assertEqual((code, s["api_attempts"], db.writes), (0, 0, []))
        return s["candidates"]

    async def one(self, **image):
        db = FakeSupabase()
        a = db.add(1)  # google_place_id PLACE1
        db.add_image(a, **image)
        return await self.candidates(db), is_trusted_image(
            {"url": image.get("url"), "status": image.get("status", "approved"), "image_source_type": image.get("source_type"),
             "needs_rights_review": image.get("rights", False)}, "PLACE1")

    async def test_A_correct_id_proxy_is_trusted_not_a_candidate(self):
        self.assertEqual(await self.one(url=f"{PROXY}/PLACE1", source_type="PROVIDER"), (0, True))
        self.assertEqual(await self.one(url=f"{PROXY}/PLACE1?maxwidth=1200", source_type="PROVIDER"), (0, True))

    async def test_B_wrong_id_proxy_is_untrusted_a_candidate(self):
        self.assertEqual(await self.one(url=f"{PROXY}/PLACE999"), (1, False))

    async def test_C_wrong_id_provider_row_is_a_candidate(self):
        self.assertEqual(await self.one(url=f"{PROXY}/PLACE999", source_type="PROVIDER"), (1, False))
        # URL identity beats any label - even ORIGINAL_SOURCE on a wrong-id proxy URL
        self.assertEqual(await self.one(url=f"{PROXY}/PLACE999", source_type="ORIGINAL_SOURCE"), (1, False))

    async def test_D_proxy_shaped_null_source_type_with_correct_id_is_trusted(self):
        self.assertEqual(await self.one(url=f"{PROXY}/PLACE1", source_type=None), (0, True))
        self.assertEqual(await self.one(url="https://other-host.test/functions/v1/place-photo/PLACE1"), (0, True))

    async def test_E_rejected_correct_id_proxy_still_blocks(self):
        self.assertEqual(await self.one(url=f"{PROXY}/PLACE1", source_type="PROVIDER", status="rejected"), (0, True))
        self.assertEqual(await self.one(url=f"{PROXY}/PLACE1", source_type="PROVIDER", status="pending"), (0, True))

    async def test_F_rejected_wrong_id_proxy_does_not_block(self):
        for status in ("rejected", "pending", "approved"):
            self.assertEqual(await self.one(url=f"{PROXY}/PLACE999", source_type="PROVIDER", status=status), (1, False), status)

    async def test_no_place_id_means_no_proxy_is_trusted(self):
        self.assertFalse(is_trusted_image({"url": f"{PROXY}/PLACE1", "status": "approved"}, None))

    def test_G_race_state_uses_the_identical_rule(self):
        row = lambda url: {"id": uid(1), "status": "approved", "google_place_id": "PLACE1",
                           "activity_images": [{"url": url, "status": "rejected", "image_source_type": "PROVIDER"}]}
        self.assertTrue(image_state(row(f"{PROXY}/PLACE1"))["has_trusted_image"])
        self.assertFalse(image_state(row(f"{PROXY}/PLACE999"))["has_trusted_image"])

    async def test_G_race_wrong_id_proxy_appearing_is_not_a_race_correct_id_is(self):
        db, gp = FakeSupabase(), FakePlaces()
        a = db.add(1)
        gp.on_call = lambda place: db.add_image(a, id="raced-wrong", url=f"{PROXY}/PLACE999", source_type="PROVIDER")
        code, s = await run(db, gp, "--apply")
        self.assertEqual((s["raced"], s["added"]), (0, 1), "the current activity's correct proxy is still inserted")
        self.assertEqual(sorted(i["url"] for i in proxies(db, a["id"])), [f"{PROXY}/PLACE1", f"{PROXY}/PLACE999"])

        db, gp = FakeSupabase(), FakePlaces()
        a = db.add(1); db.add_image(a, url=f"{PROXY}/PLACE999", source_type="PROVIDER")  # the Baltimore shape
        gp.on_call = lambda place: db.add_image(a, id="raced-right", url=f"{PROXY}/PLACE1", source_type="PROVIDER", status="rejected")
        code, s = await run(db, gp, "--apply")
        self.assertEqual((s["raced"], s["added"]), (1, 0), "a correct-id proxy (any status) appearing is a race")
        self.assertEqual([w for w in db.writes if w[1] == "activity_images"], [])

    async def test_H_wrong_id_keeper_gets_its_proxy_once_and_the_wrong_row_is_never_touched(self):
        db, gp = FakeSupabase(), FakePlaces()
        a = db.add(1)
        wrong = db.add_image(a, id="ee34196d", url=f"{PROXY}/PLACE999", source_type="PROVIDER", image_source_url=None)
        before = json.loads(json.dumps(wrong))
        code, s = await run(db, gp, "--apply")
        self.assertEqual((code, s["added"], gp.calls), (0, 1, ["PLACE1"]))
        new = [i for i in db.images_of(a["id"]) if i["id"] != "ee34196d"]
        self.assertEqual([(i["url"], i["image_source_type"]) for i in new], [(f"{PROXY}/PLACE1", "PROVIDER")])
        self.assertEqual(next(i for i in db.images if i["id"] == "ee34196d"), before, "wrong row not modified/deleted")
        gp.calls.clear(); n = len(db.images)
        for later in (timedelta(hours=1), timedelta(days=40)):
            code, s = await run(db, gp, "--apply", now=NOW + later)
            self.assertEqual((s["candidates"], s["added"], len(db.images) - n, gp.calls, s["same_place_proxy"]),
                             (0, 0, 0, [], 1), later)

    async def test_prune_keeps_the_ledger_entry_of_a_wrong_id_proxy_activity(self):
        db, gp = FakeSupabase(), FakePlaces()
        a = db.add(1); db.add_image(a, url=f"{PROXY}/PLACE999", source_type="PROVIDER")
        db.settings[ei.LEDGER_KEY] = {"version": 1, "entries": {a["id"]: {
            "place_id": "PLACE1", "status": "no_photo", "attempt_count": 1, "last_checked_at": ts(NOW),
            "next_check_at": ts(NOW + timedelta(days=10))}}}
        db.add(2)
        await run(db, gp, "--apply")
        self.assertIn(a["id"], ledger(db), "a wrong-id proxy is not trustworthy - the backoff survives")

    async def test_list_only_marks_a_wrong_place_proxy(self):
        db = FakeSupabase()
        a = db.add(1); db.add_image(a, url=f"{PROXY}/PLACE999", source_type="PROVIDER")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(await self.candidates(db), 1)
        self.assertIn("images=[approved/PROVIDER/rr=false/proxy_other_place]", buf.getvalue())


class CliTests(unittest.TestCase):
    def test_modes_and_defaults(self):
        a = ei.parse_args([])
        self.assertEqual((a.mode, a.limit, a.daily_max_calls, a.max_concurrency, a.requests_per_second),
                         ("list", 50, 300, 2, 2.0), "no mode = list-only (0 Places calls, 0 writes)")
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
        self.assertIn(("trusted.or", TRUST_OR), p)
        self.assertIn(("trusted", "is.null"), p)
        self.assertNotIn(("activity_images", "is.null"), p, "no longer 'any image row of any status'")
        self.assertIn(("created_at", "lt.T0"), p)
        self.assertIn(("created_at", "gt.T1"), p)
        self.assertIn(("order", "created_at.asc,id.asc"), p)
        self.assertIn(("limit", "7"), p)

    def test_monster_command_parses(self):
        a = ei.parse_args("--apply --limit=50 --max-concurrency=2 --requests-per-second=2 --daily-max-calls=300".split())
        self.assertEqual((a.mode, a.limit, a.max_concurrency, a.requests_per_second, a.daily_max_calls),
                         ("apply", 50, 2, 2.0, 300))


class PolicyFreezeTests(unittest.IsolatedAsyncioTestCase):
    """GOOGLE_PLACES_CONTENT_PERSISTENCE = False: every mode that would call Places or persist a Places photo reference
    fails closed before the Places key, a Places client, any Supabase request or any write."""

    async def test_apply_and_dry_run_refuse_with_zero_requests_and_zero_places_calls(self):
        self.assertIs(ei.GOOGLE_PLACES_CONTENT_PERSISTENCE, False)
        for argv in (["--apply", "--limit=5"], ["--dry-run"], ["--apply", "--activity-id", uid(1)]):
            db, gp = FakeSupabase(), FakePlaces()
            db.add(1)
            store = SupabaseBotClient.__new__(SupabaseBotClient)
            store.url, store.anon_key, store.bot_email, store.bot_password = SUPA, "anon", "x", "x"
            store._access_token = store._bot_user_id = None
            store._transport = httpx.MockTransport(db.handler)

            def boom(_budget):
                raise AssertionError("no Places client while frozen")
            with self.assertLogs("enrich_images", "ERROR") as logs:
                code, s = await ei.run_job(make_args(*argv), store=store, places_factory=boom, now=NOW, photo_proxy_base=PROXY)
            self.assertEqual((code, s["outcome"], s["api_attempts"]), (ei.EXIT_POLICY, "google_places_persistence_disabled", 0), argv)
            self.assertEqual((db.requests, db.writes, gp.calls), ([], [], []), argv)
            self.assertTrue(any("REFUSED" in m for m in logs.output))

    async def test_list_only_still_runs_while_frozen(self):
        db = FakeSupabase()
        db.add(1)
        store = SupabaseBotClient.__new__(SupabaseBotClient)
        store.url, store.anon_key, store.bot_email, store.bot_password = SUPA, "anon", "x", "x"
        store._access_token = store._bot_user_id = None
        store._transport = httpx.MockTransport(db.handler)
        code, s = await ei.run_job(make_args("--list-only"), store=store, places_factory=None, now=NOW, photo_proxy_base=PROXY)
        self.assertEqual((code, s["candidates"], s["api_attempts"]), (0, 1, 0))
        self.assertEqual(db.writes, [])

    def test_main_refuses_before_env_key_or_client(self):
        monster = "--apply --limit=50 --max-concurrency=2 --requests-per-second=2 --daily-max-calls=300".split()
        for argv in (["--apply"], ["--dry-run"], monster):
            with mock.patch.object(ei, "load_import_tool_env", side_effect=AssertionError("no env before the gate")), \
                    mock.patch.object(ei, "load_api_key", side_effect=AssertionError("no Places key before the gate")), \
                    mock.patch.object(ei, "SupabaseBotClient", side_effect=AssertionError("no Supabase client")), \
                    mock.patch.object(ei, "GooglePlacesClient", side_effect=AssertionError("no Places client")):
                with self.assertLogs("enrich_images", "ERROR"):
                    self.assertEqual(asyncio.run(ei.main(argv)), ei.EXIT_POLICY, argv)

    def test_no_override_flag_or_environment_switch(self):
        src = open(ei.__file__, encoding="utf-8").read()
        self.assertNotIn("os.environ.get(\"GOOGLE_PLACES", src)
        self.assertNotRegex(src, r"add_argument\(\"--(force|override|allow-google|persist)")
        with self.assertRaises(SystemExit):
            ei.parse_args(["--force"])


if __name__ == "__main__":
    unittest.main()
