// TuRu - event deduplication behaviour (2026-09-13): the same children's event published by a
// venue site and by a municipality/Facebook-style page must resolve to ONE activity; a time change
// must surface as an UPDATE diff on the existing activity, not a new row; city spelling variants
// must not defeat matching. Run with `npx deno test supabase/functions/_shared/`.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeConfidence, computeEventFingerprint, computeFieldDiff, getConfidenceThresholds, type ExistingActivity } from "./matching.ts";

const thresholds = getConfidenceThresholds({});
const existingBase: ExistingActivity = {
  id: "e1", name: "הצגת ילדים: הקוסם מארץ עוץ", name_source: null, description: "הצגה", category: "הצגה",
  min_age: 3, max_age: 8, price_type: "free", price_amount: null, booking_requirement: "none",
  source_url: "https://venue.example/events", location_name: "קניון רננים", city: "רעננה", lat: 32.18, lng: 34.87,
  venue_id: "venue-renanim", event_fingerprint: null, schedule_type: "one_time", one_time_date: "2026-09-27",
  start_time: "17:00", end_time: "18:00", recurring_days: [], has_image: false,
};

Deno.test("same event from venue site + second publisher (different wording) => duplicate via venue+date", () => {
  const candidate = {
    name: "הקוסם מארץ עוץ - מופע לכל המשפחה", city: "רעננה", venue_id: "venue-renanim", pageUrl: "https://city.example/calendar",
    one_time_date: "2026-09-27", start_time: "17:00", recurring_days: [],
  };
  const c = computeConfidence(candidate, existingBase, thresholds);
  assert(c.score >= thresholds.duplicate, `score ${c.score} should reach duplicate threshold`);
  assertEquals(c.breakdown.venue_match, 1);
});

Deno.test("identical fingerprint => near-certain match regardless of other signals", () => {
  const fp = computeEventFingerprint({ name: "הצגת ילדים: הקוסם מארץ עוץ", venueId: "venue-renanim", scheduleType: "one_time", oneTimeDate: "2026-09-27", startTime: "17:00" });
  const existing = { ...existingBase, event_fingerprint: fp };
  const c = computeConfidence({ name: "משהו", city: "רעננה", event_fingerprint: fp, pageUrl: "x" }, existing, thresholds);
  assertEquals(c.score, 0.95);
});

Deno.test("fingerprint is stable across city spelling, day order, time precision; null for places", () => {
  const a = computeEventFingerprint({ name: "שעת סיפור", city: "תל אביב-יפו", scheduleType: "recurring", recurringDays: ["שלישי", "ראשון"], startTime: "10:30:00" });
  const b = computeEventFingerprint({ name: "שעת סיפור", city: "תל אביב יפו", scheduleType: "recurring", recurringDays: ["ראשון", "שלישי"], startTime: "10:30" });
  assertEquals(a, b);
  assertEquals(computeEventFingerprint({ name: "גן שעשועים", city: "חולון", scheduleType: "fixed_hours" }), null);
  assertEquals(computeEventFingerprint({ name: "אירוע", city: "חולון", scheduleType: "one_time", oneTimeDate: null }), null);
});

Deno.test("city spelling variant no longer breaks city_match", () => {
  const candidate = { name: "הצגת ילדים: הקוסם מארץ עוץ", city: "רעננה ", pageUrl: "x", recurring_days: [], one_time_date: "2026-09-27" };
  const c = computeConfidence(candidate, { ...existingBase, venue_id: null }, thresholds);
  assertEquals(c.breakdown.city_match, 1);
  assert(c.score >= thresholds.needsReview);
});

Deno.test("time change on the same event => UPDATE diff (start_time), not a new activity", () => {
  const candidate = { name: "הצגת ילדים: הקוסם מארץ עוץ", city: "רעננה", venue_id: "venue-renanim", pageUrl: "x", one_time_date: "2026-09-27", start_time: "18:00", end_time: "19:00", recurring_days: [], image_urls: [] };
  const c = computeConfidence(candidate, existingBase, thresholds);
  assert(c.score >= thresholds.duplicate);
  const diff = computeFieldDiff(candidate, existingBase);
  assertEquals(Object.keys(diff).sort(), ["end_time", "start_time"]);
  assertEquals(diff.start_time.after, "18:00");
});

Deno.test("a less-detailed page never proposes erasing known fields", () => {
  const candidate = { name: "הצגת ילדים: הקוסם מארץ עוץ", city: "רעננה", pageUrl: "x", one_time_date: "2026-09-27", recurring_days: [], image_urls: [] };
  const diff = computeFieldDiff(candidate, existingBase); // candidate has no price/ages/time
  assertEquals(Object.keys(diff), []);
});

Deno.test("different event at the same venue on another date is NOT a duplicate", () => {
  const candidate = { name: "סדנת יצירה לסוכות", city: "רעננה", venue_id: "venue-renanim", pageUrl: "x", one_time_date: "2026-10-05", recurring_days: [] };
  const c = computeConfidence(candidate, existingBase, thresholds);
  assert(c.score < thresholds.duplicate, `score ${c.score}`);
});

Deno.test("missing price stays unknown in the diff (never invented)", () => {
  const candidate = { name: "הצגת ילדים: הקוסם מארץ עוץ", city: "רעננה", pageUrl: "x", price_type: null, price_amount: null, one_time_date: "2026-09-27", start_time: "17:00", end_time: "18:00", recurring_days: [], image_urls: [] };
  const diff = computeFieldDiff(candidate, { ...existingBase, price_type: null });
  assertEquals("price_type" in diff, false);
  assertEquals("price_amount" in diff, false);
});

Deno.test("shared LISTING page url is not identity: different event from the same listing page stays below review threshold", () => {
  // every activity created from a listing page carries that page as source_url; the next candidate
  // from the same page must not become an "update" of it (2026-09-13: 226 false updates in the queue)
  const candidate = {
    name: "סדנת גיבורי על - איור לילדים", city: "רעננה", venue_id: null, pageUrl: "https://venue.example/events",
    one_time_date: "2026-10-05", start_time: "10:00", recurring_days: [],
  };
  const c = computeConfidence(candidate, { ...existingBase, venue_id: null }, thresholds);
  assertEquals(c.breakdown.exact_url_match, 1);
  assert(c.score < thresholds.needsReview, `score ${c.score} must stay below needsReview ${thresholds.needsReview}`);
});

Deno.test("same page url + same date => still identity (per-item page or genuine re-detection)", () => {
  const candidate = {
    name: "הקוסם מארץ עוץ", city: "רעננה", venue_id: null, pageUrl: "https://venue.example/events",
    one_time_date: "2026-09-27", start_time: "17:00", recurring_days: [],
  };
  const c = computeConfidence(candidate, { ...existingBase, venue_id: null }, thresholds);
  assertEquals(c.score, 0.95);
});
