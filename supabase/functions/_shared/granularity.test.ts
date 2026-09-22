// Deno twin of tools/import-tool/tests/granularity.test.js - see that file's header for the full
// rationale (Entity Granularity Phase 1, 2026-09-22). Run with `deno test supabase/functions/_shared/`.
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assessGranularity, blocksAutoPublish, needsGranularityAcknowledgement, granularityDecision, hasPlaceSiblingAtVenue, ACK_CHOICES } from "./granularity.ts";

Deno.test('WRAPPER shape (16bc5416 "פעילויות בספארי"): title + description + 7-weekday saturation -> NOT_INDEPENDENT', () => {
  const c = {
    name: "פעילויות בספארי", description: "מגוון פעילויות לכל הגילאים בספארי, כולל הכרות עם סיפורים אישיים של בעלי החיים.",
    schedule_type: "recurring", recurring_days: ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"],
    price_type: "free",
  };
  const a = assessGranularity(c);
  assertEquals(a.verdict, "not_independent");
  assertEquals(a.reason, "wrapper");
  assertEquals(a.evidence.some((e) => e.code === "wrapper_title"), true);
  assertEquals(a.evidence.some((e) => e.code === "wrapper_description"), true);
  assertEquals(a.evidence.some((e) => e.code === "weekday_saturation"), true);
  assertEquals(blocksAutoPublish(a), true);
});

Deno.test("SUB-ENTITY shape (Midbarium zones): zone title + zone description, no price -> NOT_INDEPENDENT", () => {
  const cases = [
    { name: "קניון - אזור צוקים וטיפוס", description: "אזור בפארק המדמה קניון מדברי עם צוקים תלולים." },
    { name: "נווה מדבר - אזור מעיינות ובעלי חיים", description: "אזור בפארק המדמה נווה מדבר טבעי עם מקור מים." },
    { name: "ערבה - אזור מישור מדברי", description: "אזור בפארק המדמה מישור מדברי עם תנאים קיצוניים." },
    { name: "חאן - אזור בעלי חיים מחוק", description: "אזור בפארק המסמל את נקודת המפגש בין בני אדם לבעלי חיים." },
  ];
  for (const base of cases) {
    const c = { ...base, schedule_type: "fixed_hours", price_type: null };
    const a = assessGranularity(c);
    assertEquals(a.verdict, "not_independent", `expected NOT_INDEPENDENT for "${base.name}"`);
    assertEquals(a.reason, "sub_entity");
    assertEquals(a.evidence.some((e) => e.code === "zone_title"), true);
    assertEquals(a.evidence.some((e) => e.code === "zone_description"), true);
  }
});

Deno.test('production dry-run catch: booking_requirement alone must NOT suppress a confirmed wrapper', () => {
  const c = {
    name: "פעילויות בספארי", description: "מגוון פעילויות לכל הגילאים בספארי, כולל הכרות עם סיפורים אישיים של בעלי החיים וסודות המטפלים. פעילויות ללא תשלום בשבתות וחגים, וסיורים מודרכים בתשלום בהזמנה מראש.",
    schedule_type: "recurring", recurring_days: ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"],
    price_type: "free", registration_url: null, booking_requirement: "registration_required",
  };
  const a = assessGranularity(c);
  assertEquals(a.verdict, "not_independent");
  assertEquals(a.suppressors.length, 0);
});

Deno.test('production dry-run catch: "מתחם" title+description alone with NO venue is UNCERTAIN, not NOT_INDEPENDENT', () => {
  const c = { name: "מתחם סטאר סנטר", description: "מתחם קניות ופנאי הממוקם בתפר שבין אזור התעשייה ללב העיר", schedule_type: "fixed_hours", price_type: null };
  assertEquals(assessGranularity(c, { hasVenue: false }).verdict, "uncertain");
  assertEquals(assessGranularity(c).verdict, "not_independent");
});

Deno.test("hasVenue=false does not affect the WRAPPER path", () => {
  const c = { name: "פעילויות בספארי", description: "מגוון פעילויות לכל הגילאים", schedule_type: "recurring", recurring_days: ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"], price_type: null };
  assertEquals(assessGranularity(c, { hasVenue: false }).verdict, "not_independent");
});

Deno.test("parent_sibling_exists combines with a weak title signal to reach NOT_INDEPENDENT", () => {
  const c = { name: "פינת ליטוף", description: "חוויה נעימה לילדים", schedule_type: "fixed_hours", price_type: null };
  const withoutSibling = assessGranularity(c, { siblingPlaceAtVenue: false });
  assertEquals(withoutSibling.verdict, "uncertain");
  const withSibling = assessGranularity(c, { siblingPlaceAtVenue: true });
  assertEquals(withSibling.verdict, "not_independent");
});

Deno.test("NEGATIVE (b0ba1702 boating): own price + own fixed_hours -> INDEPENDENT", () => {
  const c = { name: "שייט בסירה באגם הפארק", description: "אטרקציית שייט בסירה באגם המלאכותי במרכז פארק רעננה.", schedule_type: "fixed_hours", price_type: "fixed" };
  assertEquals(assessGranularity(c).verdict, "independent");
});

Deno.test('NEGATIVE (fdb70d6b "פינת חי"): zone-shaped title but own price -> INDEPENDENT', () => {
  const c = { name: "פינת חי בפארק רעננה", description: "פינת חי חמודה עם בעלי חיים למגע.", schedule_type: "fixed_hours", price_type: "fixed" };
  assertEquals(assessGranularity(c).verdict, "independent");
});

Deno.test("NEGATIVE: genuine dated events are never flagged", () => {
  const c = { name: "מפגשים בספארי", description: "מפגשים ייחודיים בספארי בתאריך 26.12.2026.", schedule_type: "one_time", one_time_date: "2026-12-26", price_type: null };
  assertEquals(assessGranularity(c).verdict, "independent");
});

Deno.test("REPERTOIRE EXCLUSION: undated standing-show record with no wrapper/zone wording stays out of NOT_INDEPENDENT", () => {
  const c = { name: "המדריך להרפתקן", description: "הצגת ילדים בתיאטרון הקרון.", schedule_type: null, price_type: null };
  assertNotEquals(assessGranularity(c).verdict, "not_independent");
});

Deno.test("do NOT classify from title alone: single wrapper title -> UNCERTAIN, never confident", () => {
  const c = { name: "פעילויות לילדים בקניון", description: "קניון עם חנויות שונות.", schedule_type: "fixed_hours", price_type: null };
  assertEquals(assessGranularity(c).verdict, "uncertain");
});

Deno.test("blocksAutoPublish: true for not_independent and uncertain, false for independent", () => {
  assertEquals(blocksAutoPublish({ verdict: "not_independent", reason: null, evidence: [], suppressors: [] }), true);
  assertEquals(blocksAutoPublish({ verdict: "uncertain", reason: null, evidence: [], suppressors: [] }), true);
  assertEquals(blocksAutoPublish({ verdict: "independent", reason: null, evidence: [], suppressors: [] }), false);
  assertEquals(needsGranularityAcknowledgement({ verdict: "uncertain", reason: null, evidence: [], suppressors: [] }), true);
});

Deno.test("granularityDecision: acknowledgement outcomes", () => {
  assertEquals(granularityDecision({ assessment: { verdict: "independent", reason: null, evidence: [], suppressors: [] } }).kind, "proceed");
  assertEquals(granularityDecision({ assessment: {} as any, acknowledgedGranularity: "wrapper" }).kind, "ineligible");
  assertEquals(granularityDecision({ assessment: {} as any, acknowledgedGranularity: "sub_area" }).kind, "ineligible");
  assertEquals(granularityDecision({ assessment: {} as any, acknowledgedGranularity: "uncertain" }).kind, "hold_uncertain");
  assertEquals(granularityDecision({ assessment: {} as any, acknowledgedGranularity: "bogus" }).kind, "invalid_acknowledgement");
  const held = granularityDecision({ assessment: { verdict: "not_independent", reason: "wrapper", evidence: [], suppressors: [] } });
  assertEquals(held.kind, "needs_granularity_acknowledgement");
  if (held.kind === "needs_granularity_acknowledgement") assertEquals(held.choices, [...ACK_CHOICES]);
});

Deno.test("hasPlaceSiblingAtVenue: null venueId -> null; true/false on count", async () => {
  assertEquals(await hasPlaceSiblingAtVenue({} as any, null), null);
  const makeClient = (count: number | null, error: unknown = null) => ({
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ count, error }) }) }) }) }),
  });
  assertEquals(await hasPlaceSiblingAtVenue(makeClient(1), "v1"), true);
  assertEquals(await hasPlaceSiblingAtVenue(makeClient(0), "v1"), false);
  assertEquals(await hasPlaceSiblingAtVenue(makeClient(null, { message: "x" }), "v1"), null);
});
