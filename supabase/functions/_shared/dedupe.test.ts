// TuRu - event deduplication behaviour (2026-09-13): the same children's event published by a
// venue site and by a municipality/Facebook-style page must resolve to ONE activity; a time change
// must surface as an UPDATE diff on the existing activity, not a new row; city spelling variants
// must not defeat matching. Run with `npx deno test supabase/functions/_shared/`.

import { assertEquals, assertNotEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeConfidence, distinctiveSharedWords, seriesRemainders, hhmm, descriptionMateriallyDiffers, placeLabelChanged, computeEventFingerprint, computeEventFingerprintProbes, computeFieldDiff, getConfidenceThresholds, type ExistingActivity } from "./matching.ts";

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

// --- computeEventFingerprintProbes (2026-09-21, "Stabilize Event Fingerprint Matching") ----------
// The WHERE segment of the stored fingerprint is venue-if-known-else-city, so the SAME occurrence
// gets a DIFFERENT fingerprint depending on whether venue resolution had already run when each side
// was ingested. This is what produced the live Beit Ariela duplicates: an old row stored city-form,
// a later scan's candidate resolved a venue and stored venue-form, and the exact pre-check compared
// two different strings for one event. These tests cover the LOOKUP widening only - storage
// (computeEventFingerprint itself, tested above) is untouched.

Deno.test("dual-probe: venue known + city known -> [canonical venue-form, city-form an unresolved-venue ingestion would have stored]", () => {
  const input = { name: "הקוסם מארץ עוץ", venueId: "venue-renanim", city: "רעננה", scheduleType: "one_time", oneTimeDate: "2026-09-27", startTime: "17:00" } as const;
  const probes = computeEventFingerprintProbes(input);
  const canonical = computeEventFingerprint(input);
  const cityForm = computeEventFingerprint({ ...input, venueId: null });
  assertEquals(probes, [canonical, cityForm]);
  assertEquals(probes[0], "הקוסם מארץ עוץ|v:venue-renanim|2026-09-27|17:00");
  assertEquals(probes[1], "הקוסם מארץ עוץ|c:רעננה|2026-09-27|17:00");
});

Deno.test("dual-probe: no venue -> a single probe (the canonical IS already the city-form, nothing to widen)", () => {
  const probes = computeEventFingerprintProbes({ name: "שעת סיפור", city: "חולון", scheduleType: "one_time", oneTimeDate: "2026-09-27", startTime: "10:00" });
  assertEquals(probes.length, 1);
  assertEquals(probes[0], computeEventFingerprint({ name: "שעת סיפור", city: "חולון", scheduleType: "one_time", oneTimeDate: "2026-09-27", startTime: "10:00" }));
});

Deno.test("dual-probe: venue known but NO city -> a single probe (never a degenerate 'c:' empty-city probe that could over-match unrelated events)", () => {
  const probes = computeEventFingerprintProbes({ name: "שעת סיפור", venueId: "venue-x", city: null, scheduleType: "one_time", oneTimeDate: "2026-09-27", startTime: "10:00" });
  assertEquals(probes.length, 1);
  assert(probes[0].includes("v:venue-x"));
});

Deno.test("dual-probe: no name/no date -> empty (nothing to probe with, matches computeEventFingerprint's own null cases)", () => {
  assertEquals(computeEventFingerprintProbes({ name: "", venueId: "v1", city: "חולון", scheduleType: "one_time", oneTimeDate: "2026-09-27" }), []);
  assertEquals(computeEventFingerprintProbes({ name: "אירוע", venueId: "v1", city: "חולון", scheduleType: "one_time", oneTimeDate: null }), []);
});

Deno.test("POSITIVE REGRESSION: scan 1 stores city-form (venue unresolved), scan 2's candidate resolves a venue - the probe set must contain scan 1's exact stored fingerprint", () => {
  // Scan 1: same event, same date/time, city known, venue NOT yet resolved for this publisher.
  const scan1Fingerprint = computeEventFingerprint({
    name: "גלגולו של זחל - שעת סיפור", city: "תל אביב יפו", scheduleType: "one_time", oneTimeDate: "2026-10-29", startTime: "17:00",
  });
  const existingRow = { ...existingBase, id: "old-row", venue_id: null, city: "תל אביב יפו", event_fingerprint: scan1Fingerprint, event_key: null };
  assertEquals(scan1Fingerprint, "גלגולו של זחל שעת סיפור|c:תל אביב יפו|2026-10-29|17:00");

  // Scan 2: identical event, identical date/time - but this time venue resolution succeeds.
  const scan2Input = { name: "גלגולו של זחל - שעת סיפור", venueId: "af47029d-venue", city: "תל אביב יפו", scheduleType: "one_time", oneTimeDate: "2026-10-29", startTime: "17:00" };
  const scan2Probes = computeEventFingerprintProbes(scan2Input);

  // Expected: existing row matched (its stored fingerprint appears in the probe set) - NO new activity.
  assert(scan2Probes.includes(existingRow.event_fingerprint!), "scan 2's probe set must include scan 1's stored city-form fingerprint");
  assertEquals(scan2Probes.length, 2);
});

Deno.test("HOUSE (BEIT ARIELA) PATTERN, replayed generically without hardcoding a specific publisher: a real production shape (title with quotes/punctuation, Tel-Aviv-Yafo spelling) matches through the probe", () => {
  const oldStored = computeEventFingerprint({ name: "“גלגולו של זחל” שעת סיפור עם רומי מורן גונן", city: "תל אביב-יפו", scheduleType: "one_time", oneTimeDate: "2026-10-29", startTime: "17:00" });
  const newCandidateProbes = computeEventFingerprintProbes({ name: "“גלגולו של זחל” שעת סיפור עם רומי מורן גונן", venueId: "af47029d-3b57-4103-82e5-6cdc439212dc", city: "תל אביב יפו", scheduleType: "one_time", oneTimeDate: "2026-10-29", startTime: "17:00" });
  assert(newCandidateProbes.includes(oldStored!));
});

// --- NEGATIVE CONTROLS: the dual-probe must never widen matching along date, time, venue identity
// or title - only the venue-vs-city REPRESENTATION of an otherwise-identical occurrence. ---

Deno.test("NEGATIVE: same title, same venue, DIFFERENT DATE -> no probe overlap", () => {
  const a = computeEventFingerprintProbes({ name: "הקוסם מארץ עוץ", venueId: "v1", city: "רעננה", scheduleType: "one_time", oneTimeDate: "2026-09-27", startTime: "17:00" });
  const b = computeEventFingerprintProbes({ name: "הקוסם מארץ עוץ", venueId: "v1", city: "רעננה", scheduleType: "one_time", oneTimeDate: "2026-10-05", startTime: "17:00" });
  assertEquals(a.filter((fp) => b.includes(fp)), []);
});

Deno.test("NEGATIVE: same title, same venue, same date, DIFFERENT TIME -> no probe overlap", () => {
  const a = computeEventFingerprintProbes({ name: "הקוסם מארץ עוץ", venueId: "v1", city: "רעננה", scheduleType: "one_time", oneTimeDate: "2026-09-27", startTime: "17:00" });
  const b = computeEventFingerprintProbes({ name: "הקוסם מארץ עוץ", venueId: "v1", city: "רעננה", scheduleType: "one_time", oneTimeDate: "2026-09-27", startTime: "18:00" });
  assertEquals(a.filter((fp) => b.includes(fp)), []);
});

Deno.test("NEGATIVE: same title/city/date/time but the EXISTING row already has its OWN resolved (different) venue -> no match, because a resolved row is never STORED under the city-form to begin with", () => {
  // This mirrors the real lookup shape: candidate probes vs. the ONE fingerprint a real row has
  // stored - not two candidates' probe lists compared to each other (a resolved venue's stored
  // fingerprint is always its venue-form; it is never left as a city-form once a venue is known, so
  // there is nothing for a candidate's city-form probe to accidentally match here).
  const existingStoredFingerprint = computeEventFingerprint({ name: "הקוסם מארץ עוץ", venueId: "venue-b", city: "רעננה", scheduleType: "one_time", oneTimeDate: "2026-09-27", startTime: "17:00" });
  const candidateProbes = computeEventFingerprintProbes({ name: "הקוסם מארץ עוץ", venueId: "venue-a", city: "רעננה", scheduleType: "one_time", oneTimeDate: "2026-09-27", startTime: "17:00" });
  assert(!candidateProbes.includes(existingStoredFingerprint!));
});

Deno.test("KNOWN RESIDUAL RISK (pre-existing, not introduced by this fix, documented not hidden): two DIFFERENT events sharing title/city/date/time both fall back to the city-form when NEITHER side has a resolved venue - unchanged from before this task", () => {
  // If both sides lack a venue, city-form matching was already exact-pre-check identity before this
  // task (venue distinction was never part of that comparison). Dual-probe does not add this risk -
  // it only extends the SAME already-accepted city-scoped identity to also match a later-resolved
  // candidate against an still-unresolved historical row. Recorded explicitly so this tradeoff is
  // never mistaken for something the fix newly introduced.
  const oldRowNeverResolved = computeEventFingerprint({ name: "הקוסם מארץ עוץ", city: "רעננה", scheduleType: "one_time", oneTimeDate: "2026-09-27", startTime: "17:00" });
  const otherCandidateAlsoUnresolved = computeEventFingerprintProbes({ name: "הקוסם מארץ עוץ", city: "רעננה", scheduleType: "one_time", oneTimeDate: "2026-09-27", startTime: "17:00" });
  assert(otherCandidateAlsoUnresolved.includes(oldRowNeverResolved!)); // true both before and after this task's change
});

Deno.test("NEGATIVE: similar-but-not-identical titles at the same venue/date/time -> no probe overlap (the exact fingerprint still requires an EXACT normalized title, dual-probe does not loosen that)", () => {
  const a = computeEventFingerprintProbes({ name: "הקוסם מארץ עוץ", venueId: "v1", city: "רעננה", scheduleType: "one_time", oneTimeDate: "2026-09-27", startTime: "17:00" });
  const b = computeEventFingerprintProbes({ name: "הקוסם מארץ עוץ - מופע מיוחד", venueId: "v1", city: "רעננה", scheduleType: "one_time", oneTimeDate: "2026-09-27", startTime: "17:00" });
  assertEquals(a.filter((fp) => b.includes(fp)), []);
});

Deno.test("NEGATIVE / documentation: event_fingerprint was never source-scoped before this change and still is not - dual-probe does not add or remove that boundary", () => {
  // Unlike event_key's tvs: kind (which embeds s:<sourceId>), computeEventFingerprint never took a
  // source as input. Two different sources describing the exact same occurrence already produced the
  // same fingerprint before this task (by design - see the file header: "the same children's event
  // published by a venue site and by a municipality... must resolve to ONE activity"). Recorded here
  // so a future reader does not mistake dual-probe for a source-scoping change in either direction.
  const probesX = computeEventFingerprintProbes({ name: "הקוסם מארץ עוץ", venueId: "v1", city: "רעננה", scheduleType: "one_time", oneTimeDate: "2026-09-27", startTime: "17:00" });
  const probesY = computeEventFingerprintProbes({ name: "הקוסם מארץ עוץ", venueId: "v1", city: "רעננה", scheduleType: "one_time", oneTimeDate: "2026-09-27", startTime: "17:00" });
  assertEquals(probesX, probesY); // no source parameter exists to make these differ
});

Deno.test("REVERSE DIRECTION (reported, not implemented): a venue-keyed existing row cannot be safely probed from a venue-less candidate", () => {
  // If venue resolution regresses (existing row already has v:<venue>, a later candidate has none),
  // the candidate has no venueId to construct that key with - inventing one would mean guessing WHICH
  // venue in the city is meant, which this task forbids. computeEventFingerprintProbes therefore
  // returns exactly the city-form-only single probe here; it does NOT attempt to reconstruct a
  // venue-form key. This is a property test, not a gap left untested - the fix is intentionally
  // one-directional (see the rationale comment on computeEventFingerprintProbes).
  const probes = computeEventFingerprintProbes({ name: "הקוסם מארץ עוץ", venueId: null, city: "רעננה", scheduleType: "one_time", oneTimeDate: "2026-09-27", startTime: "17:00" });
  assertEquals(probes.length, 1);
  assert(probes[0].startsWith("הקוסם מארץ עוץ|c:"));
});

// --- Hebrew city-form normalization ("Normalize Hebrew City Names for Stable Fingerprints",
// 2026-09-22) - the city segment of a venue-less fingerprint goes through normalizeCityName, so a
// niqqud-spelled city (a plausible LLM scan output) must produce the SAME fingerprint as the plain
// form already stored, without collapsing genuinely different cities. Node twin: eventFingerprint.test.js.
Deno.test("FINGERPRINT SAFETY: niqqud-spelled city produces the identical fingerprint as the plain form", () => {
  const withNiqqud = computeEventFingerprint({ name: "שעת סיפור", city: "בְּאֵר שֶׁבַע", scheduleType: "one_time", oneTimeDate: "2026-09-27", startTime: "10:00" });
  const plain = computeEventFingerprint({ name: "שעת סיפור", city: "באר שבע", scheduleType: "one_time", oneTimeDate: "2026-09-27", startTime: "10:00" });
  assertEquals(withNiqqud, plain);
  assertEquals(withNiqqud, "שעת סיפור|c:באר שבע|2026-09-27|10:00");
});

Deno.test("FINGERPRINT SAFETY: niqqud normalization never collapses two genuinely different cities", () => {
  const beerSheva = computeEventFingerprint({ name: "שעת סיפור", city: "בְּאֵר שֶׁבַע", scheduleType: "one_time", oneTimeDate: "2026-09-27", startTime: "10:00" });
  const beitShemesh = computeEventFingerprint({ name: "שעת סיפור", city: "בֵּית שֶׁמֶשׁ", scheduleType: "one_time", oneTimeDate: "2026-09-27", startTime: "10:00" });
  assertNotEquals(beerSheva, beitShemesh);
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

Deno.test("shared LISTING page + a coinciding date but no name agreement is NOT identity (2026-09-14: 'משחקייה בקטנטנים' was matched to a honey workshop this way)", () => {
  const candidate = {
    name: "משחקייה בקטנטנים", city: "רעננה", venue_id: null, pageUrl: "https://venue.example/events",
    one_time_date: "2026-09-27", start_time: "16:30", recurring_days: [],
    occurrences: [{ date: "2026-09-14", start_time: "16:30", end_time: null }, { date: "2026-09-27", start_time: "16:30", end_time: null }],
  };
  const c = computeConfidence(candidate, { ...existingBase, venue_id: null }, thresholds);
  assertEquals(c.breakdown.exact_url_match, 1);
  assertEquals(c.breakdown.schedule_match, 1);
  assertEquals(c.breakdown.name_overlap, 0);
  assert(c.score < thresholds.needsReview, `score ${c.score} must stay below needsReview`);
});

Deno.test("enrichment-only diff (exact fingerprint re-detection): fills gaps found on the detail page, ignores wording and never replaces a known price", () => {
  const candidate = { name: "הצגת ילדים: הקוסם מארץ עוץ", city: "רעננה", venue_id: "venue-renanim", pageUrl: "x", description: "ניסוח אחר לגמרי", one_time_date: "2026-09-27", start_time: "17:00", end_time: "18:00", recurring_days: [], image_urls: [], price_type: "fixed", price_amount: 45, address: "הפלמ\"ח 2 א", address_source: "monster:detail", event_key: "url:https://x/e/1", detail_url: "https://x/e/1" };
  const d = computeFieldDiff(candidate, { ...existingBase, price_type: null, price_amount: null, address: null }, { enrichmentOnly: true });
  assertEquals(Object.keys(d).sort(), ["address", "event_key", "price_amount", "price_type"]);
  const known = computeFieldDiff(candidate, { ...existingBase, price_type: "fixed", price_amount: 30, address: null }, { enrichmentOnly: true });
  assertEquals("price_amount" in known, false); // never proposes 30 -> 45 as "enrichment"
  assertEquals("description" in known, false);
  assertEquals(Object.keys(computeFieldDiff(candidate, existingBase, { enrichmentOnly: true })).sort(), ["address", "event_key"]);
});

// ---- wave 2 (2026-09-17): update ASSOCIATION. Production regression (Ra'anana story-theatre listing):
// "הצב והארנב - תיאטרון סיפור" (9.11, אודיטוריום יד לבנים, 17:00) was queued as an UPDATE of another
// "... - תיאטרון סיפור" show (10.10, מרכז קהילתי נווה זמר, 11:00): same listing URL + 0.5 overlap made
// of genre words only. Approving it would have moved a real event to another venue, date and hour.
Deno.test("update association: genre words on a shared listing are not identity; place + dates contradiction blocks URL identity", () => {
  const th = getConfidenceThresholds({});
  const listing = "https://tickets.example.muni.il/kids";
  // deno-lint-ignore no-explicit-any
  const existing: any = { id: "e1", name: "הארנב שמצא חבר - תיאטרון סיפור", source_url: listing, location_name: "מרכז קהילתי נווה זמר", city: "רעננה", lat: null, lng: null, venue_id: null, event_fingerprint: "fp-a", one_time_date: "2026-10-10", occurrences: [{ date: "2026-10-10", start_time: "11:00" }], recurring_days: [] };
  const other = { name: "הצב והצפרדע - תיאטרון סיפור", city: "רעננה", pageUrl: listing, location_name: "אודיטוריום יד לבנים", venue_id: null, one_time_date: "2026-11-09", recurring_days: [], event_fingerprint: "fp-b" };
  const c = computeConfidence(other, existing, th);
  assertEquals(c.breakdown.exact_url_match, 1);
  assertEquals(c.breakdown.distinctive_name, 0);
  assert(c.score < th.needsReview, `different show must not even reach review as an update: ${c.score}`);

  // the SAME show, a later performance at the same place: still the same event (occurrence model)
  const later = { name: "הארנב שמצא חבר - תיאטרון סיפור", city: "רעננה", pageUrl: listing, location_name: "מרכז קהילתי נווה זמר", venue_id: null, one_time_date: "2026-11-14", recurring_days: [], event_fingerprint: "fp-c" };
  assert(computeConfidence(later, existing, th).score >= th.duplicate);

  // the same title at ANOTHER place on OTHER dates: a different event, never an update of this one
  const elsewhere = { ...later, location_name: "ספריית כפר בתיה", one_time_date: "2026-12-01" };
  const e = computeConfidence(elsewhere, existing, th);
  assertEquals(e.breakdown.association_conflict, 1);
  assert(e.score < th.duplicate, `place + dates contradict: ${e.score}`);

  assertEquals(distinctiveSharedWords("סינדרלה - מחזמר לכל המשפחה", "סינדרלה - הצגת ילדים"), 1);
  assertEquals(distinctiveSharedWords("שעת סיפור לגילאי 2-4", "הצגת ילדים לגילאי 2-4"), 0);
});

// ---- wave 2 (2026-09-17): UPDATE NOISE. 611 pending update rows in production; 172 start_time "changes"
// were "17:00:00" vs "17:00", 194 descriptions were model rewordings, 37 place labels contained each other.
Deno.test("update noise: time format, a reworded summary and a contained place label are not changes; real changes still surface", () => {
  // deno-lint-ignore no-explicit-any
  const ex: any = { id: "e1", name: "סיור במרכז המבקרים", name_source: null, description: "פארק המציע מגוון פעילויות ואטרקציות כולל קיר טיפוס, מכוניות מתנגשות ובריכה מותאמת לילדים.", category: "אטרקציה", min_age: null, max_age: null, price_type: null, price_amount: null, booking_requirement: null, source_url: "x", location_name: "ספריה", city: "רמת השרון", address: null, one_time_date: "2026-10-10", start_time: "17:00:00", end_time: "18:30:00", recurring_days: [], occurrences: [], has_image: true, event_key: "k" };
  const same = { name: ex.name, description: "פארק המציע מגוון פעילויות ואטרקציות כמו קיר טיפוס, מכוניות מתנגשות ובריכה מותאמת לילדים.", location_name: "ספרייה רמת השרון", city: "רמת השרון", one_time_date: "2026-10-10", start_time: "17:00", end_time: "18:30" };
  assertEquals(Object.keys(computeFieldDiff(same, ex)), []);
  const changed = { ...same, start_time: "18:00", location_name: "אודיטוריום יד לבנים", description: "הרצאה למבוגרים על תולדות היישוב ומסלול הליכה לילי בהדרכת מורה דרך מוסמך." };
  assertEquals(Object.keys(computeFieldDiff(changed, ex)).sort(), ["description", "location_name", "start_time"]);
  // a description that FILLS a gap is information gain
  assertEquals(Object.keys(computeFieldDiff({ ...same }, { ...ex, description: null })), ["description"]);
  assertEquals(hhmm("9:05:00"), "09:05"); assertEquals(hhmm(null), null);
  assertEquals(descriptionMateriallyDiffers("אותו טקסט בדיוק", "אותו טקסט בדיוק"), false);
  assertEquals(placeLabelChanged("מתנ״ס", "מתנס"), false);
});

// verify_location pilot (2026-09-24): festival sub-events on one listing share a series prefix - that prefix is not identity.
Deno.test("series prefix: festival sub-events on one listing are not the same event; the same sub-event still is", () => {
  const listing = "https://www.haifa.muni.il/festival-beit-galim";
  const ex: ExistingActivity = { ...existingBase, name: "פסטיבל בית גלים: סיורים מודרכים", source_url: listing, location_name: "בית גלים", city: "חיפה", lat: null, lng: null, venue_id: null, event_fingerprint: "fp-a", one_time_date: "2026-10-08", occurrences: [{ date: "2026-10-08", start_time: "10:00", end_time: null }], recurring_days: [] };
  for (const name of ["פסטיבל בית גלים: תערוכת בד-גלים", "פסטיבל בית גלים: מתחם הורים וילדים", "פסטיבל בית גלים: פעילויות בגינה הקהילתית"]) {
    const c = computeConfidence({ name, city: "חיפה", pageUrl: listing, location_name: "בית גלים", venue_id: null, one_time_date: "2026-10-08", recurring_days: [] }, ex, thresholds);
    assertEquals(c.breakdown.series_prefix, 1);
    assert(c.score < thresholds.duplicate, `${name}: ${c.score}`);
  }
  const same = computeConfidence({ name: "פסטיבל בית גלים: סיורים מודרכים", city: "חיפה", pageUrl: listing, location_name: "בית גלים", venue_id: null, one_time_date: "2026-10-09", recurring_days: [] }, ex, thresholds);
  assert(same.score >= thresholds.duplicate);
  assertEquals(seriesRemainders("שלגיה - מחזמר", "שלגיה - הצגה"), null);
  assertEquals(seriesRemainders("שעת סיפור 11:00", "שעת סיפור 11:30"), null);
  const r = seriesRemainders("״כולם עושים קקי״ - מאת טָארוֹ גּוֹמִי", "״כולם עושים קקי״ - מאת טארו גומי");
  assertEquals(r?.[0], r?.[1]);
});
