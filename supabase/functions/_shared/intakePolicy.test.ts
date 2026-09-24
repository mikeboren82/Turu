// TuRu - Human Review Queue Phase A (2026-09-24): the intake rules and computeFieldDiff's representation /
// specificity handling. Same rule table as the Node twin (tools/import-tool/tests/intakePolicy.test.js).
// Run with `npx deno test supabase/functions/_shared/`.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  substantiveIssues, priceCompleteness, classifyUpdateDiff, isLessSpecific, pendingLifecycle, farFutureDeferUntil, addDays,
} from "./intakePolicy.ts";
import { computeFieldDiff, type ExistingActivity } from "./matching.ts";

const TODAY = "2026-09-24";
const ex: ExistingActivity = {
  id: "e1", name: "מופע ילדים", name_source: null, description: "תיאור קיים", category: "הצגה",
  min_age: 3, max_age: 8, price_type: "fixed", price_amount: 40, booking_requirement: "none",
  source_url: "https://venue.example/events", location_name: "היכל התרבות", city: "כרמיאל", lat: 32.9, lng: 35.3,
  venue_id: "v1", event_fingerprint: null, schedule_type: "one_time", one_time_date: "2026-09-29",
  start_time: "20:00", end_time: "21:00", recurring_days: [], has_image: true, event_key: "k1", source_id: "S",
  occurrences: [{ date: "2026-09-29", start_time: "20:00", end_time: "21:00" }],
};

Deno.test("PRICE: unknown is completeness, never substantive; free stays distinguishable", () => {
  assertEquals(priceCompleteness({ price_type: null }), "unknown");
  assertEquals(priceCompleteness({ price_type: "free" }), "known");
  assertEquals(substantiveIssues(["מחיר"]), []);
  assertEquals(substantiveIssues(["מחיר", "עיר"]), ["עיר"]);
});

Deno.test("DIFF CLASS parity table (same as the Node twin)", () => {
  assertEquals(classifyUpdateDiff({}).kind, "empty");
  assertEquals(classifyUpdateDiff({ start_time: { before: "17:00:00", after: "17:00" }, end_time: { before: "18:30:00", after: "18:30" } }).kind, "representation_only");
  assertEquals(classifyUpdateDiff({ booking_requirement: { before: "none", after: "walk_in" } }).kind, "representation_only");
  assertEquals(classifyUpdateDiff({ price_amount: { before: "15", after: 15 } }).kind, "representation_only");
  assertEquals(classifyUpdateDiff({ occurrences: { before: ["2026-09-29 20:00"], after: ["2026-09-29"] } }).kind, "less_specific");
  assertEquals(classifyUpdateDiff({ address: { before: "הרצל 5, חולון", after: "הרצל 5" } }).kind, "less_specific");
  assertEquals(classifyUpdateDiff({ description: { before: "a", after: "b" }, has_image: { before: "אין תמונה", after: "נמצאה תמונה" }, event_key: { before: null, after: "k" }, start_time: { before: "10:00:00", after: "10:00" } }).kind, "non_human");
  assertEquals(classifyUpdateDiff({ start_time: { before: "17:30:00", after: "19:00" } }).kind, "material");
  assertEquals(classifyUpdateDiff({ start_time: { before: null, after: "19:00" } }).kind, "material");
  assertEquals(classifyUpdateDiff({ booking_requirement: { before: "none", after: "advance_booking" } }).kind, "material");
  assertEquals(classifyUpdateDiff({ occurrences: { before: ["2026-09-28 17:30"], after: ["2026-09-28 19:00"] } }).kind, "material");
  assertEquals(classifyUpdateDiff({ occurrences: { before: ["2026-09-28 17:00"], after: ["2026-09-29 17:00"] } }).kind, "material");
  assertEquals(classifyUpdateDiff({ one_time_date: { before: "2026-09-29", after: "2026-09-30" } }).kind, "material");
  assertEquals(classifyUpdateDiff({ description: { before: "a", after: "b" }, price_type: { before: null, after: "fixed" } }).kind, "material");
  assertEquals(isLessSpecific("2026-09-29 20:00", "2026-09-29"), true);
  assertEquals(isLessSpecific("רחוב הרצל 15", "רחוב הרצל 1"), false);
});

Deno.test("computeFieldDiff: 17:00 vs 17:00:00 is no diff, single and multi-occurrence paths", () => {
  assertEquals(computeFieldDiff({ one_time_date: "2026-09-29", start_time: "20:00:00", end_time: "21:00:00" }, ex), {});
  const multi = { ...ex, occurrences: [{ date: "2026-09-29", start_time: "20:00", end_time: null }, { date: "2026-10-06", start_time: "20:00", end_time: null }] };
  assertEquals(computeFieldDiff({ occurrences: [{ date: "2026-09-29", start_time: "20:00:00", end_time: null }, { date: "2026-10-06", start_time: "20:00:00", end_time: null }] }, multi), {});
});

Deno.test("computeFieldDiff: a less specific occurrence (date without the known hour) is not an update", () => {
  const multi = { ...ex, occurrences: [{ date: "2026-09-29", start_time: "20:00", end_time: null }, { date: "2026-10-06", start_time: "20:00", end_time: null }] };
  assertEquals(computeFieldDiff({ occurrences: [{ date: "2026-09-29", start_time: null, end_time: null }, { date: "2026-10-06", start_time: null, end_time: null }] }, multi), {});
  // a genuinely new performance still is
  const d = computeFieldDiff({ occurrences: [{ date: "2026-09-29", start_time: null, end_time: null }, { date: "2026-10-13", start_time: "20:00", end_time: null }] }, multi);
  assertEquals((d.occurrences as { after: string[] }).after, ["2026-10-13 20:00"]);
  // and a different hour on a known date is new, never "less specific"
  const h = computeFieldDiff({ occurrences: [{ date: "2026-09-29", start_time: "17:00", end_time: null }, { date: "2026-10-06", start_time: "20:00", end_time: null }] }, multi);
  assertEquals((h.occurrences as { after: string[] }).after, ["2026-09-29 17:00"]);
});

Deno.test("computeFieldDiff: booking labels the product treats as one meaning are wording; across buckets is real", () => {
  assertEquals(computeFieldDiff({ booking_requirement: "walk_in" }, ex), {});
  assertEquals(Object.keys(computeFieldDiff({ booking_requirement: "registration_required" }, ex)), ["booking_requirement"]);
  assertEquals(computeFieldDiff({ booking_requirement: "advance_booking" }, { ...ex, booking_requirement: "registration_required" }), {});
});

Deno.test("computeFieldDiff: real time/date changes are untouched", () => {
  assertEquals(Object.keys(computeFieldDiff({ one_time_date: "2026-09-29", start_time: "19:00" }, ex)), ["start_time"]);
  assertEquals(Object.keys(computeFieldDiff({ one_time_date: "2026-09-30" }, ex)), ["one_time_date"]);
});

Deno.test("EXPIRY uses the LAST occurrence; standing identities never expire; far future defers", () => {
  const row = (ed: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ match_type: "new", status: "new", validation_issues: [], extracted_data: { entity_type: "אירוע", schedule_type: "one_time", ...ed }, ...extra });
  assertEquals(pendingLifecycle(row({ one_time_date: "2026-09-20" }), TODAY, 180).action, "expire");
  const multi = row({ one_time_date: "2026-09-20", occurrences: [{ date: "2026-09-20" }, { date: "2026-09-27" }, { date: "2026-10-01" }] });
  assertEquals(pendingLifecycle(multi, TODAY, 180).action, "keep");
  assertEquals(pendingLifecycle(multi, "2026-10-02", 180).action, "expire");
  assertEquals(pendingLifecycle(row({ entity_type: "אירוע_קבוע", one_time_date: "2026-09-01" }), TODAY, 180).reason, "standing_identity");
  assertEquals(pendingLifecycle(row({ entity_type: "מקום_קבוע", one_time_date: "2026-09-01" }), TODAY, 180).reason, "standing_identity");
  const d = pendingLifecycle(row({ one_time_date: "2027-06-01" }), TODAY, 180);
  assertEquals([d.action, d.deferUntil], ["defer", "2026-12-03"]);
  assertEquals(farFutureDeferUntil({ entity_type: "אירוע", schedule_type: "one_time", one_time_date: "2027-03-23" }, TODAY, 180), null);
  assert(farFutureDeferUntil({ entity_type: "אירוע", schedule_type: "one_time", one_time_date: "2027-03-24" }, TODAY, 180) === "2026-09-25");
  assertEquals(addDays("2027-03-01", -1), "2027-02-28");
});
