"""
Google Places persistence policy (2026-09-27, google_policy.py) - the Python writers. No network: Supabase is an
httpx.MockTransport that records every request, Google Places is a fake object.

  A  discovery / dry-run / list still work (the gate never blocks them)
  B  an apply that would create a Google-origin activity / location / incoming row is refused - before any request
  C  place-id-only reconciliation of an independent row (backfill_place_ids.py) still works and writes only the id
  D  no Maps URI is persisted by any writer
  E  the enrich_images PROVIDER insert does not write googleMapsUri into image_source_url
  F  the places_photos Monster gate stays OFF by default

Run with:  py -m unittest test_google_policy -v
"""
import asyncio
import json
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

import httpx

import backfill_city_and_ramat_amir
import backfill_place_ids
import google_policy
import import_discovered
import playground_discovery as pd
import settlement_gap_fill
import supabase_client
from google_policy import POLICY_REASON, GooglePlacesPersistenceDisabled
from supabase_client import SupabaseBotClient

THIS_DIR = Path(__file__).resolve().parent
CASES = json.loads((THIS_DIR.parent.parent / "supabase" / "functions" / "_shared" / "googlePlacesPolicy.cases.json")
                   .read_text(encoding="utf-8"))
MAPS = "https://maps.google.com/?cid=4412345678901234567"
BOT = "b0000000-0000-4000-8000-000000000000"


class Recorder:
    """A PostgREST stand-in: records (method, path, json body) for every request."""

    def __init__(self):
        self.requests: list[tuple[str, str, object]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        self.requests.append((request.method, request.url.path, body))
        if request.url.path == "/auth/v1/token":
            return httpx.Response(200, json={"access_token": "tok", "user": {"id": BOT}})
        return httpx.Response(201, json=[{"id": "new-row"}])

    def writes(self):
        return [r for r in self.requests if r[1] != "/auth/v1/token" and r[0] != "GET"]


def bot_client(rec: Recorder) -> SupabaseBotClient:
    c = SupabaseBotClient.__new__(SupabaseBotClient)
    c.url, c.anon_key, c.bot_email, c.bot_password = "https://proj.supabase.test", "anon", "x", "x"
    c._access_token, c._bot_user_id = None, None
    c._transport = httpx.MockTransport(rec.handler)
    return c


def patched_httpx(rec: Recorder):
    """The legacy writers build httpx.AsyncClient(timeout=...) directly - route those through the recorder too."""
    real = httpx.AsyncClient
    return mock.patch.object(supabase_client.httpx, "AsyncClient",
                             lambda *a, **kw: real(*a, **{**kw, "transport": httpx.MockTransport(rec.handler)}))


class Sentinel(Exception):
    pass


def run(coro):
    return asyncio.run(coro)


class PolicyTwinTests(unittest.TestCase):
    def test_shared_case_table(self):
        self.assertIs(google_policy.GOOGLE_PLACES_CONTENT_PERSISTENCE, CASES["persistence"])
        self.assertEqual(POLICY_REASON, CASES["policyReason"])
        for url, want in CASES["mapsUrls"]:
            self.assertEqual(google_policy.is_google_maps_url(url), want, url)
        for ed, page_url, want in CASES["placesOrigin"]:
            self.assertEqual(google_policy.is_places_origin_candidate(ed, page_url), want, (ed, page_url))

    def test_no_override_switch(self):
        src = (THIS_DIR / "google_policy.py").read_text(encoding="utf-8")
        self.assertNotIn("os.environ", src)
        self.assertNotIn("getenv", src)


class A_DiscoveryStillRuns(unittest.TestCase):
    def test_playground_discovery_dry_run_and_plain_discovery_pass_the_gate(self):
        for argv in (["--dry-run"], ["--dry-run", "--import-supabase"], []):
            with mock.patch.object(sys, "argv", ["playground_discovery.py", *argv]), \
                    mock.patch.object(pd, "load_api_key", side_effect=Sentinel):
                with self.assertRaises(Sentinel, msg=argv):  # got past the gate to the discovery itself
                    run(pd.main_async())

    def test_settlement_gap_fill_dry_run_passes_the_gate(self):
        with mock.patch.object(sys, "argv", ["settlement_gap_fill.py", "--dry-run"]), \
                mock.patch.object(settlement_gap_fill, "load_api_key", side_effect=Sentinel):
            with self.assertRaises(Sentinel):
                run(settlement_gap_fill.main())

    def test_import_discovered_dry_run_classifies_and_writes_nothing(self):
        state = {"places_by_id": {"P1": {"name": "גן שעשועים הדקל", "formatted_address": "הדקל 5, רעננה", "lat": 32.18,
                                         "lon": 34.87, "types": ["playground"], "primary_type": "playground"}}}
        with mock.patch.object(sys, "argv", ["import_discovered.py", "--dry-run"]), \
                mock.patch.object(pd, "load_checkpoint", return_value=state), \
                mock.patch.object(pd, "run_import_supabase", side_effect=AssertionError("must not write")):
            run(import_discovered.main())

    def test_classify_and_bucket_still_uses_primary_type_transiently(self):
        import matching
        place = matching.DiscoveredPlace(
            place_id="P1", name="גן שעשועים הדקל", formatted_address="הדקל 5, רעננה", lat=32.18, lon=34.87,
            types=["playground"], primary_type="playground", google_maps_uri=MAPS, discovered_by_queries={"q"},
            discovered_by_grid_points=set(), discovery_methods={"grid"}, occurrence_count=1)
        master, review, rejected = pd.classify_and_bucket({"P1": place}, pd.israel_geo.DEFAULT_ISRAEL_BOUNDS)
        self.assertEqual(len(master) + len(review) + len(rejected), 1)


class B_ApplyIsRefused(unittest.TestCase):
    def test_cli_apply_modes_refuse_before_any_places_call(self):
        cases = [
            (pd, "main_async", ["playground_discovery.py", "--import-supabase"]),
            (settlement_gap_fill, "main", ["settlement_gap_fill.py"]),
            (import_discovered, "main", ["import_discovered.py"]),
            (backfill_city_and_ramat_amir, "main", ["backfill_city_and_ramat_amir.py"]),
        ]
        for module, fn, argv in cases:
            with mock.patch.object(sys, "argv", argv), \
                    mock.patch.object(module, "load_api_key", side_effect=AssertionError("no Places key before the gate"), create=True), \
                    mock.patch.object(pd, "load_checkpoint", side_effect=AssertionError("no work before the gate")), \
                    mock.patch.object(supabase_client, "load_import_tool_env", side_effect=AssertionError("no Supabase")):
                with self.assertRaises(GooglePlacesPersistenceDisabled, msg=argv) as ctx:
                    run(getattr(module, fn)())
                self.assertIn(POLICY_REASON, str(ctx.exception))

    def test_cli_refusal_exits_2_with_a_clear_message(self):
        with mock.patch.object(sys, "argv", ["playground_discovery.py", "--import-supabase"]), \
                mock.patch.object(pd, "load_api_key", side_effect=AssertionError("gate first")):
            with self.assertLogs("playground_discovery", "ERROR") as logs, self.assertRaises(SystemExit) as ex:
                pd.main()
        self.assertEqual(ex.exception.code, 2)
        self.assertTrue(any("REFUSED" in m and POLICY_REASON in m for m in logs.output))

    def test_shared_import_helpers_refuse_before_building_a_client(self):
        with mock.patch.object(supabase_client, "SupabaseBotClient", side_effect=AssertionError("no client")):
            with self.assertRaises(GooglePlacesPersistenceDisabled):
                run(pd.run_import_supabase([{"google_place_id": "P1"}], {}))
            with self.assertRaises(GooglePlacesPersistenceDisabled):
                run(pd.push_review_rows_to_incoming([{"google_place_id": "P1"}]))

    def test_writers_refuse_with_zero_requests(self):
        rec = Recorder()
        c = bot_client(rec)
        with patched_httpx(rec):
            with self.assertRaises(GooglePlacesPersistenceDisabled):
                run(c.insert_new_playground(name="גן שעשועים הדקל", address="הדקל 5, רעננה", lat=32.18, lon=34.87, place_id="P1"))
            for page_url in (MAPS, None):
                with self.assertRaises(GooglePlacesPersistenceDisabled):
                    run(c.insert_incoming_activity(page_url=page_url, match_type="new", status="needs_review", confidence_score=0.8,
                                                   extracted_data=pd._row_extracted_data({"name": "x", "formatted_address": "y",
                                                                                          "latitude": 1, "longitude": 2}),
                                                   validation_issues=[]))
        self.assertEqual(rec.requests, [])


class FakePlacesSearch:
    """A transient Places text-search answer carrying every field a writer must NOT copy."""

    def __init__(self, *_a, **_kw):
        self.stats = mock.Mock(total_requests=1)

    async def search_text(self, **_kw):
        return [{"id": "ChIJgoogle", "displayName": {"text": "Google Name For The Park"}, "formattedAddress": "Google Street 9, רעננה",
                 "location": {"latitude": 32.18011, "longitude": 34.87021}, "googleMapsUri": MAPS,
                 "primaryType": "playground", "types": ["playground", "park"], "websiteUri": "https://example.org"}]


class C_PlaceIdReconciliationSurvives(unittest.TestCase):
    def test_backfill_place_ids_stores_only_the_place_id_on_the_independent_row(self):
        independent = {"id": "act-osm", "name": "Google Name For The Park", "google_place_id": None, "lat": 32.18, "lon": 34.87,
                       "address": None}
        calls = []

        class FakeStore:
            def __init__(self, *_a, **_kw):
                pass

            async def fetch_activities_for_matching(self):
                return [dict(independent)]

            async def set_activity_google_place_id(self, *, activity_id, place_id):
                calls.append((activity_id, place_id))

        with mock.patch.object(sys, "argv", ["backfill_place_ids.py"]):
            args = backfill_place_ids.parse_args()
        with mock.patch.object(backfill_place_ids, "load_api_key", return_value="k"), \
                mock.patch.object(backfill_place_ids, "load_import_tool_env"), \
                mock.patch.object(backfill_place_ids, "GooglePlacesClient", FakePlacesSearch), \
                mock.patch.object(backfill_place_ids, "SupabaseBotClient", FakeStore):
            run(backfill_place_ids.run(args))
        self.assertEqual(calls, [("act-osm", "ChIJgoogle")])

    def test_set_activity_google_place_id_patches_exactly_one_column(self):
        rec = Recorder()
        c = bot_client(rec)
        with patched_httpx(rec):
            run(c.set_activity_google_place_id(activity_id="act-osm", place_id="ChIJgoogle"))
        self.assertEqual(rec.writes(), [("PATCH", "/rest/v1/activities", {"google_place_id": "ChIJgoogle"})])


class D_E_NoMapsUriPersisted(unittest.TestCase):
    def test_provider_proxy_insert_has_null_image_source_url(self):
        rec = Recorder()
        c = bot_client(rec)
        run(c.insert_place_photo_reference(activity_id="act-1", photo_url="https://proj.supabase.test/functions/v1/place-photo/P1"))
        (method, path, body), = rec.writes()
        self.assertEqual((method, path), ("POST", "/rest/v1/activity_images"))
        self.assertEqual(body["image_source_type"], "PROVIDER")
        self.assertIsNone(body["image_source_url"])
        self.assertEqual(body["url"], "https://proj.supabase.test/functions/v1/place-photo/P1")
        self.assertNotIn("maps.google", json.dumps(body))

    def test_no_writer_maps_a_places_uri_or_website_into_a_row(self):
        src = (THIS_DIR / "supabase_client.py").read_text(encoding="utf-8")
        self.assertNotIn('"source_url": google_maps_uri', src)
        self.assertNotIn('"image_source_url": google_maps_uri', src)
        self.assertNotRegex(src, r"google_maps_uri\s*[:,)]")
        enrich = (THIS_DIR / "enrich_images.py").read_text(encoding="utf-8")
        self.assertNotIn("google_maps_uri", enrich)
        # websiteUri is never requested (field masks) nor written
        for f in ("google_places.py", "supabase_client.py", "backfill_place_ids.py", "playground_discovery.py"):
            self.assertNotIn("websiteUri", (THIS_DIR / f).read_text(encoding="utf-8"), f)


class F_PlacesPhotosGateOff(unittest.TestCase):
    def test_monster_job_is_gated_by_places_photos_enabled_exactly_true(self):
        jobs = (THIS_DIR.parent / "import-tool" / "lib" / "monsterJobs.js").read_text(encoding="utf-8")
        line = next(l for l in jobs.splitlines() if "id: 'places_photos'" in l)
        self.assertIn("enabledSetting: 'places_photos_enabled'", line)
        self.assertRegex(jobs, re.compile(r"function isGatedOff\(job, gates = \{\}\) \{ return !!job\.enabledSetting && gates\[job\.enabledSetting\] !== true; \}"))


if __name__ == "__main__":
    unittest.main()
