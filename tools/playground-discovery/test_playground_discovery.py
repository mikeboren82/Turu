"""
Unit tests for the pure-logic pieces of the playground discovery tool - no
network calls, no real Supabase/Google credentials needed to run these.

Run with:  python -m unittest test_playground_discovery -v
"""
import csv
import io
import unittest

import israel_geo
import matching
import playground_discovery as pd


class IsraelGeoTests(unittest.TestCase):
    def test_generate_grid_covers_bounds_and_spacing(self):
        bounds = {"min_lat": 31.0, "max_lat": 31.2, "min_lon": 34.0, "max_lon": 34.2}
        grid = israel_geo.generate_grid(bounds, step_deg=0.1, radius_m=1000)
        # 0.1 step over a 0.2-wide range -> 3 points per axis (0.0, 0.1, 0.2) = 9 points
        self.assertEqual(len(grid), 9)
        self.assertTrue(all(bounds["min_lat"] <= p.lat <= bounds["max_lat"] for p in grid))
        self.assertTrue(all(bounds["min_lon"] <= p.lon <= bounds["max_lon"] for p in grid))

    def test_generate_grid_rejects_zero_step(self):
        with self.assertRaises(ValueError):
            israel_geo.generate_grid(israel_geo.DEFAULT_ISRAEL_BOUNDS, step_deg=0, radius_m=1000)

    def test_is_in_bounds(self):
        self.assertTrue(israel_geo.is_in_bounds(32.08, 34.78))  # Tel Aviv
        self.assertFalse(israel_geo.is_in_bounds(48.85, 2.35))  # Paris
        self.assertFalse(israel_geo.is_in_bounds(None, 34.78))

    def test_haversine_known_distance(self):
        # Tel Aviv <-> Jerusalem is ~54km in a straight line.
        km = israel_geo.haversine_km(32.0853, 34.7818, 31.7683, 35.2137)
        self.assertAlmostEqual(km, 54, delta=5)

    def test_refine_grid_point_respects_max_level(self):
        point = israel_geo.GridPoint(grid_id="g0-0", lat=32.0, lon=34.8, radius_m=1000, refinement_level=0)
        children = israel_geo.refine_grid_point(point, max_level=1)
        self.assertEqual(len(children), 4)
        self.assertTrue(all(c.refinement_level == 1 for c in children))
        # Level-1 children can't be refined again when max_level=1.
        grandchildren = israel_geo.refine_grid_point(children[0], max_level=1)
        self.assertEqual(grandchildren, [])


class MatchingTests(unittest.TestCase):
    def test_normalize_for_match_strips_punctuation_and_case(self):
        self.assertEqual(matching.normalize_for_match('גן-שעשועים "הרצל"!'), "גן שעשועים הרצל")

    def test_word_overlap_score_identical_and_disjoint(self):
        self.assertEqual(matching.word_overlap_score("גן שעשועים הרצל", "גן שעשועים הרצל"), 1.0)
        self.assertEqual(matching.word_overlap_score("גן שעשועים הרצל", "פארק ויצמן"), 0.0)

    def test_classify_place_playground(self):
        self.assertEqual(
            matching.classify_place(primary_type="playground", types=["playground"], name="גן שעשועים הרצל"),
            "PLAYGROUND",
        )

    def test_classify_place_park_with_playground(self):
        self.assertEqual(
            matching.classify_place(primary_type="park", types=["park", "playground"], name="פארק העצמאות"),
            "PARK_WITH_PLAYGROUND",
        )

    def test_classify_place_park_without_playground_signal(self):
        self.assertEqual(matching.classify_place(primary_type="park", types=["park"], name="פארק הירקון"), "PARK")

    def test_classify_place_not_relevant(self):
        self.assertEqual(
            matching.classify_place(primary_type="toy_store", types=["toy_store", "store"], name="חנות צעצועים"),
            "NOT_RELEVANT",
        )

    def test_classify_place_uncertain_when_no_signal(self):
        self.assertEqual(matching.classify_place(primary_type="point_of_interest", types=["point_of_interest"], name="מקום כלשהו"), "UNCERTAIN")

    def test_data_quality_score_tiers(self):
        self.assertEqual(matching.data_quality_score(has_place_id=True, has_name=True, has_address=True, has_coords=True, place_kind="PLAYGROUND"), 100)
        self.assertEqual(matching.data_quality_score(has_place_id=True, has_name=True, has_address=False, has_coords=True, place_kind="PLAYGROUND"), 90)
        self.assertEqual(matching.data_quality_score(has_place_id=True, has_name=False, has_address=False, has_coords=True, place_kind="PARK"), 70)
        self.assertEqual(matching.data_quality_score(has_place_id=False, has_name=False, has_address=False, has_coords=False, place_kind="UNCERTAIN"), 40)

    def test_is_possible_duplicate_close_and_similar(self):
        a = {"lat": 32.0, "lon": 34.8, "name": "גן שעשועים הרצל"}
        b = {"lat": 32.00015, "lon": 34.8, "name": "גן שעשועים הרצל 2"}  # ~17m apart
        self.assertTrue(matching.is_possible_duplicate(a, b))

    def test_is_possible_duplicate_far_apart(self):
        a = {"lat": 32.0, "lon": 34.8, "name": "גן שעשועים הרצל"}
        b = {"lat": 32.05, "lon": 34.9, "name": "גן שעשועים הרצל"}
        self.assertFalse(matching.is_possible_duplicate(a, b))

    def test_match_against_existing_place_id_confirmed(self):
        discovered = {"place_id": "abc123", "name": "גן שעשועים חדש", "lat": 32.0, "lon": 34.8}
        existing = [{"id": "1", "name": "גן שעשועים ישן", "google_place_id": "abc123", "lat": 32.0, "lon": 34.8}]
        outcome, match, _score = matching.match_against_existing(discovered, existing)
        self.assertEqual(outcome, matching.MATCH_CONFIRMED)
        self.assertEqual(match["id"], "1")

    def test_match_against_existing_strong_match_by_distance_and_name(self):
        # ~72m apart - zone 3 (>50m), so this exercises the pre-existing distance+name path
        # unchanged, not the new zone-1/zone-2 logic (moved from ~44m, which now lands in the
        # new POSSIBLE_DUPLICATE zone regardless of name similarity - see the zone-2 tests below).
        discovered = {"place_id": "xyz", "name": "גן שעשועים תל חי", "lat": 32.0, "lon": 34.8}
        existing = [{"id": "2", "name": "גן שעשועים תל חי", "google_place_id": None, "lat": 32.00065, "lon": 34.8}]
        outcome, match, _score = matching.match_against_existing(discovered, existing)
        self.assertEqual(outcome, matching.STRONG_MATCH)

    def test_match_against_existing_new_candidate(self):
        discovered = {"place_id": "new1", "name": "גן שעשועים חדש לגמרי", "lat": 33.0, "lon": 35.5}
        existing = [{"id": "3", "name": "גן שעשועים אחר", "google_place_id": None, "lat": 31.0, "lon": 34.0}]
        outcome, match, _score = matching.match_against_existing(discovered, existing)
        self.assertEqual(outcome, matching.NEW_CANDIDATE)
        self.assertIsNone(match)

    def test_discovered_place_merge_occurrence_tracks_sources(self):
        place = matching.DiscoveredPlace(place_id="p1")
        place.merge_occurrence(query="גן שעשועים", grid_point_id="g0-0", method="text_search")
        place.merge_occurrence(query="Playground", grid_point_id="g0-1", method="text_search")
        place.merge_occurrence(query=None, grid_point_id="g0-0", method="nearby_search")
        self.assertEqual(place.occurrence_count, 3)
        self.assertEqual(place.discovered_by_queries, {"גן שעשועים", "Playground"})
        self.assertEqual(place.discovered_by_grid_points, {"g0-0", "g0-1"})
        self.assertEqual(place.discovery_methods, {"text_search", "nearby_search"})


class ClassifyAndBucketTests(unittest.TestCase):
    def _place(self, place_id, name, lat, lon, types=None, primary_type=None, address="כתובת כלשהי 1"):
        p = matching.DiscoveredPlace(
            place_id=place_id, name=name, formatted_address=address, lat=lat, lon=lon,
            types=types or [], primary_type=primary_type,
        )
        p.discovery_methods.add("nearby_search")
        return p

    def test_valid_playground_goes_to_master(self):
        places = {"p1": self._place("p1", "גן שעשועים הרצל", 32.08, 34.78, ["playground"], "playground")}
        master, review, rejected = pd.classify_and_bucket(places, israel_geo.DEFAULT_ISRAEL_BOUNDS)
        self.assertEqual(len(master), 1)
        self.assertEqual(master[0]["place_kind"], "PLAYGROUND")

    def test_out_of_bounds_goes_to_rejected(self):
        places = {"p1": self._place("p1", "Somewhere in Paris", 48.85, 2.35, ["playground"], "playground")}
        master, review, rejected = pd.classify_and_bucket(places, israel_geo.DEFAULT_ISRAEL_BOUNDS)
        self.assertEqual(len(master), 0)
        self.assertEqual(rejected[0]["status"], "OUT_OF_BOUNDS")

    def test_not_relevant_type_goes_to_rejected(self):
        places = {"p1": self._place("p1", "חנות צעצועים", 32.08, 34.78, ["toy_store"], "toy_store")}
        _, _, rejected = pd.classify_and_bucket(places, israel_geo.DEFAULT_ISRAEL_BOUNDS)
        self.assertEqual(rejected[0]["status"], "NOT_RELEVANT")

    def test_missing_address_goes_to_review_not_rejected(self):
        places = {"p1": self._place("p1", "גן שעשועים", 32.08, 34.78, ["playground"], "playground", address=None)}
        master, review, rejected = pd.classify_and_bucket(places, israel_geo.DEFAULT_ISRAEL_BOUNDS)
        self.assertEqual(len(master), 0)
        self.assertEqual(len(rejected), 0)
        self.assertEqual(review[0]["status"], "MISSING_ADDRESS")

    def test_possible_duplicate_pair_goes_to_review(self):
        places = {
            "p1": self._place("p1", "גן שעשועים הרצל", 32.0800, 34.7800, ["playground"], "playground"),
            "p2": self._place("p2", "גן שעשועים הרצל", 32.08002, 34.78002, ["playground"], "playground"),
        }
        master, review, rejected = pd.classify_and_bucket(places, israel_geo.DEFAULT_ISRAEL_BOUNDS)
        self.assertEqual(len(master), 0)
        statuses = {r["status"] for r in review}
        self.assertEqual(statuses, {"POSSIBLE_DUPLICATE"})

    def test_park_without_playground_signal_goes_to_review(self):
        places = {"p1": self._place("p1", "פארק הירקון", 32.08, 34.78, ["park"], "park")}
        master, review, rejected = pd.classify_and_bucket(places, israel_geo.DEFAULT_ISRAEL_BOUNDS)
        self.assertEqual(len(master), 0)
        self.assertEqual(review[0]["status"], "PARK_WITHOUT_CLEAR_PLAYGROUND")


class CsvUtf8Tests(unittest.TestCase):
    def test_hebrew_round_trips_through_csv(self):
        rows = [{"google_place_id": "p1", "name": "גן שעשועים ברחוב תל חי, ירושלים", "status": "DISCOVERED"}]
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=pd.CSV_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        writer.writerow(rows[0])
        buf.seek(0)
        read_back = list(csv.DictReader(buf))
        self.assertEqual(read_back[0]["name"], "גן שעשועים ברחוב תל חי, ירושלים")


if __name__ == "__main__":
    unittest.main()
