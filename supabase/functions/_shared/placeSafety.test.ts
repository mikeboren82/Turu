// TuRu - place identity safety (2026-09-24, pilot #5): the SAME tables as the Node twin (tests/placeSafety.test.js).
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { compoundPlace, samePlaceName, sameAddress } from "./placeSafety.ts";
import { computeConfidence, getConfidenceThresholds, type ExistingActivity } from "./matching.ts";
import { evaluatePublishPolicy } from "./publishPolicy.ts";

const table = JSON.parse(await Deno.readTextFile(new URL("./placeSafety.cases.json", import.meta.url)));
// deno-lint-ignore no-explicit-any
for (const k of table.compound as any[]) Deno.test(`compound place: ${k.id}`, () => { const r = compoundPlace(k.label, k.title); assertEquals([r.compound, r.titleComponent], k.expect); });
// deno-lint-ignore no-explicit-any
for (const k of table.names as any[]) Deno.test(`same place name: ${k.id}`, () => assertEquals(samePlaceName(k.a, k.b, k.city || null), k.expect));
// deno-lint-ignore no-explicit-any
for (const k of table.addresses as any[]) Deno.test(`same address: ${k.id}`, () => assertEquals(sameAddress(k.a, k.b), k.expect));

const th = getConfidenceThresholds({});
const aquarium: ExistingActivity = { id: "42b4758b", name: "אקווריום ישראל", name_source: null, description: null, category: "מוזיאון לילדים", min_age: null, max_age: null, price_type: null, price_amount: null, booking_requirement: null, source_url: "https://www.karamel.co.il/", location_name: "אקווריום ישראל", address: "אהרון שולוב 1", city: "ירושלים", lat: 31.744884, lng: 35.1658507, venue_id: null, event_fingerprint: null, schedule_type: "fixed_hours", one_time_date: null, start_time: null, end_time: null, recurring_days: [], has_image: true, entity_type: "מקום_קבוע" };
const cand = (over = {}) => ({ name: "אקווריום ישראל", city: "ירושלים", entity_type: "מקום_קבוע", schedule_type: "fixed_hours", location_name: "גן החיות ואקווריום ישראל", pageUrl: "https://www.jerusalemzoo.org.il/", lat: 31.7461139, lng: 35.1766343, venue_id: null, recurring_days: [], ...over });

Deno.test("same name + same city + WRONG coordinates -> possible identity, never a new place and never a duplicate", () => {
  const c = computeConfidence(cand(), aquarium, th);
  assertEquals(c.breakdown.place_name_identity, 1);
  assert(c.score >= th.needsReview && c.score < th.duplicate, String(c.score));
});
Deno.test("same name + same address -> strong identity; same name in another city -> no identity floor", () => {
  assert(computeConfidence(cand({ address: "אהרון שולוב 1, ירושלים" }), aquarium, th).score >= th.duplicate);
  const other = computeConfidence(cand({ city: "אילת" }), aquarium, th);
  assertEquals(other.breakdown.place_name_identity, undefined);
  assert(other.score < th.needsReview);
});
Deno.test("canonical policy holds the aquarium sub-place under its compound label; a whole-complex event is not held", () => {
  const base = { description: "אקווריום לילדים", category: "פינת חי", entity_type: "מקום_קבוע", schedule_type: "fixed_hours", city: "ירושלים", audience: "children" };
  const ctx = { source: { is_trusted: true, source_trust_score: 90 }, issues: [], today: "2026-09-24", minTrust: 80, maxDaysAhead: 180, row: null };
  const held = evaluatePublishPolicy({ ...base, name: "אקווריום ישראל", location_name: "גן החיות ואקווריום ישראל" }, ctx);
  assertEquals(held.reasons.map((r) => r.code), ["location_compound_label"]);
  const whole = evaluatePublishPolicy({ ...base, name: "חנוכה לילדים בגן החיות ואקווריום ישראל", location_name: "גן החיות ואקווריום ישראל" }, ctx);
  assertEquals(whole.reasons.some((r) => r.code === "location_compound_label"), false);
  const pinned = evaluatePublishPolicy({ ...base, name: "אקווריום ישראל", location_name: "גן החיות ואקווריום ישראל", cleaner_location: { method: "detail_page", confidence: "HIGH", verification: { class: "HIGH" } } }, ctx);
  assertEquals(pinned.reasons.some((r) => r.code === "location_compound_label"), false);
});
