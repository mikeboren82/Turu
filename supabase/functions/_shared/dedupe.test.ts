// TuRu - event deduplication behaviour (2026-09-13): the same children's event published by a
// venue site and by a municipality/Facebook-style page must resolve to ONE activity; a time change
// must surface as an UPDATE diff on the existing activity, not a new row; city spelling variants
// must not defeat matching. Run with `npx deno test supabase/functions/_shared/`.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeConfidence, distinctiveSharedWords, hhmm, descriptionMateriallyDiffers, placeLabelChanged, computeEventFingerprint, computeFieldDiff, getConfidenceThresholds, type ExistingActivity } from "./matching.ts";

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
