// Deno twin of tools/import-tool/tests/standingProgrammeMatch.test.js - see that file's header for
// the full rationale (Repertoire Phase 1, 2026-09-22). Run with `deno test supabase/functions/_shared/`.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isStandingProgrammeMatch, titleMatchesStandingProgramme, type ExistingActivity } from "./matching.ts";

function standingBase(): ExistingActivity {
  return {
    id: "standing-1", name: "המדריך להרפתקן", name_source: null, description: null, category: "הצגה",
    min_age: null, max_age: null, price_type: null, price_amount: null, booking_requirement: null,
    source_url: null, location_name: null, city: null, lat: null, lng: null,
    venue_id: "venue-train-theater", event_fingerprint: null, schedule_type: null, one_time_date: null,
    start_time: null, end_time: null, recurring_days: [], has_image: false,
    entity_type: "אירוע_קבוע", organizer_name: "תיאטרון הקרון", duration_minutes: null,
  };
}
function candidateBase() {
  return {
    name: "המדריך להרפתקן", venue_id: "venue-train-theater", price_type: null as string | null, price_amount: null as number | null,
    min_age: null as number | null, max_age: null as number | null, organizer_name: "תיאטרון הקרון" as string | null, duration_minutes: null as number | null,
  };
}

Deno.test("EXACT PAIR (המדריך להרפתקן shape): dated candidate matches its standing programme", () => {
  assertEquals(isStandingProgrammeMatch(candidateBase(), standingBase()), true);
});

Deno.test("FUZZY PAIR (אקווקוודלה shape): subtitle suffix matches via the conservative prefix rule", () => {
  const standing = { ...standingBase(), name: "אקווקוודלה" };
  const candidate = { ...candidateBase(), name: "אקווקוודלה | הצגה חדשה" };
  assertEquals(isStandingProgrammeMatch(candidate, standing), true);
});

Deno.test("an already-attached standing programme (schedule_type one_time) can still receive another performance", () => {
  const standing = { ...standingBase(), schedule_type: "one_time" };
  assertEquals(isStandingProgrammeMatch(candidateBase(), standing), true);
});

Deno.test("NEGATIVE: same title at a different venue stays separate", () => {
  const candidate = { ...candidateBase(), venue_id: "venue-somewhere-else" };
  assertEquals(isStandingProgrammeMatch(candidate, standingBase()), false);
});

Deno.test("NEGATIVE: a number in the suffix suggests a sequel/different production - refused", () => {
  const candidate = { ...candidateBase(), name: "אקווקוודלה 2 המסע הבא" };
  const standing = { ...standingBase(), name: "אקווקוודלה" };
  assertEquals(isStandingProgrammeMatch(candidate, standing), false);
});

Deno.test("NEGATIVE: a fully generic/trivial standing title never serves as a fuzzy-match prefix", () => {
  const candidate = { ...candidateBase(), name: "הצגה חדשה לגמרי" };
  const standing = { ...standingBase(), name: "הצגה" };
  assertEquals(isStandingProgrammeMatch(candidate, standing), false);
});

Deno.test("NEGATIVE: ordinary one-time event (entity_type אירוע) never matches", () => {
  const standing = { ...standingBase(), entity_type: "אירוע" };
  assertEquals(isStandingProgrammeMatch(candidateBase(), standing), false);
});

Deno.test("NEGATIVE: a real weekly recurring series is a different class", () => {
  const standing = { ...standingBase(), schedule_type: "recurring" };
  assertEquals(isStandingProgrammeMatch(candidateBase(), standing), false);
});

Deno.test("NEGATIVE: no venue_id on either side is never guessed", () => {
  assertEquals(isStandingProgrammeMatch(candidateBase(), { ...standingBase(), venue_id: null }), false);
  assertEquals(isStandingProgrammeMatch({ ...candidateBase(), venue_id: null }, standingBase()), false);
});

Deno.test("FIELD CONFLICT: materially different price/age/organizer/duration each refuse the match", () => {
  assertEquals(isStandingProgrammeMatch({ ...candidateBase(), price_type: "fixed", price_amount: 90 }, { ...standingBase(), price_type: "fixed", price_amount: 40 }), false);
  assertEquals(isStandingProgrammeMatch({ ...candidateBase(), min_age: 12 }, { ...standingBase(), min_age: 3 }), false);
  assertEquals(isStandingProgrammeMatch({ ...candidateBase(), organizer_name: "מפיק אחר" }, { ...standingBase(), organizer_name: "תיאטרון הקרון" }), false);
  assertEquals(isStandingProgrammeMatch({ ...candidateBase(), duration_minutes: 120 }, { ...standingBase(), duration_minutes: 45 }), false);
});

Deno.test("no conflict when one side simply lacks the field", () => {
  const standing = { ...standingBase(), price_type: null, organizer_name: null };
  const candidate = { ...candidateBase(), price_type: "fixed", price_amount: 40, organizer_name: "תיאטרון הקרון" };
  assertEquals(isStandingProgrammeMatch(candidate, standing), true);
});

Deno.test("titleMatchesStandingProgramme: exact match always succeeds regardless of genericity", () => {
  assertEquals(titleMatchesStandingProgramme("המדריך להרפתקן", "המדריך להרפתקן"), true);
});
