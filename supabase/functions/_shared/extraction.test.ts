// TuRu - extraction robustness regression tests (2026-09-13). The gershayim case is the real root
// cause of "המודל החזיר תשובה פגומה" on 5 of 11 production sources: Haiku wrote "גן החיות התנ"כי"
// with a raw ASCII quote inside a JSON string. Run with `npx deno test supabase/functions/_shared/`.

import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  repairHebrewGershayim, repairUnescapedQuotes, parseExtractionResponse, filterPastOneTimeActivities, isPlausibleEventDate, looksLikeStaleRepost,
} from "./extraction.ts";

import { assessChildRelevance, hasExplicitChildAge, cheapPageText, cheapDiscoverLinks, missingTemporalEvidence, repairEntityTypeFromSchedule, TEMPORAL_ISSUE_LABEL } from "./extraction.ts";

// ENTITY-TYPE-AWARE approval gate (2026-09-19): scan-source's autoApproveEligible refuses any candidate
// with missing temporal evidence and sanitizeCandidate turns it into a gating validation issue.
Deno.test('temporal gate: a one-time event needs a date (or occurrences), a recurring event needs weekdays, an evergreen place needs nothing', () => {
  assertEquals(missingTemporalEvidence({ entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: null }), 'one_time_without_date');
  assertEquals(missingTemporalEvidence({ entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: '2026-10-01' }), null);
  assertEquals(missingTemporalEvidence({ entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: null, occurrences: [{ date: '2026-10-01' }] }), null);
  assertEquals(missingTemporalEvidence({ entity_type: 'אירוע_קבוע', schedule_type: 'recurring', recurring_days: [] }), 'recurring_without_days');
  assertEquals(missingTemporalEvidence({ entity_type: 'פעילות', schedule_type: 'recurring', recurring_days: ['שני'] }), null);
  assertEquals(missingTemporalEvidence({ entity_type: 'פעילות', schedule_type: null }), 'recurring_event_without_schedule', 'a workshop/class genuinely needs a real recurring cadence - unchanged');
  assertEquals(missingTemporalEvidence({ entity_type: 'אירוע', schedule_type: 'fixed_hours' }), 'event_without_one_time_schedule');
  // evergreen: an OSM / Google playground or any permanent place without hours stays valid
  assertEquals(missingTemporalEvidence({ entity_type: 'מקום_קבוע', schedule_type: 'fixed_hours', start_time: null }), null);
  assertEquals(missingTemporalEvidence({ entity_type: 'מקום_קבוע', schedule_type: null }), null);
  assertEquals(TEMPORAL_ISSUE_LABEL.recurring_without_days, 'ימי פעילות');
});

Deno.test('REPERTOIRE PHASE 1 (2026-09-22): a standing programme record (אירוע_קבוע, no schedule at all) is "awaiting_schedule", not "missing" data', () => {
  assertEquals(missingTemporalEvidence({ entity_type: 'אירוע_קבוע', schedule_type: null }), 'awaiting_schedule');
  assertEquals(TEMPORAL_ISSUE_LABEL.awaiting_schedule, 'ממתין ללוח זמנים');
  assertEquals(missingTemporalEvidence({ entity_type: 'אירוע_קבוע', schedule_type: 'recurring', recurring_days: ['שבת'] }), null);
  assertEquals(missingTemporalEvidence({ entity_type: 'אירוע_קבוע', schedule_type: 'one_time', one_time_date: '2026-10-01' }), null);
});

Deno.test('temporal gate: an "אירוע" with a repeating schedule is repaired to אירוע_קבוע (the prompt definition), nothing else is touched', () => {
  assertEquals(repairEntityTypeFromSchedule({ entity_type: 'אירוע', schedule_type: 'recurring', recurring_days: ['שישי'] }), 'אירוע_קבוע');
  assertEquals(repairEntityTypeFromSchedule({ entity_type: 'אירוע', schedule_type: 'recurring', recurring_days: [] }), 'אירוע');
  assertEquals(repairEntityTypeFromSchedule({ entity_type: 'מקום_קבוע', schedule_type: 'recurring', recurring_days: ['שישי'] }), 'מקום_קבוע');
  assertEquals(repairEntityTypeFromSchedule({ entity_type: null, schedule_type: 'one_time' }), null);
});

Deno.test("cheapPageText strips scripts/tags/entities without a DOM", () => {
  const html = '<html><head><script>var x = "<b>no</b>";</script><style>.a{}</style></head><body><nav>x</nav><h1>פסטיבל הקוסם</h1><p>27.09 &amp; 28.09 &nbsp; ב-<a href="/x">קניון</a></p><!-- c --></body></html>';
  const t = cheapPageText(html);
  assertEquals(t.includes("var x"), false);
  assertEquals(t.includes("פסטיבל הקוסם"), true);
  assertEquals(t.includes("27.09 & 28.09"), true);
  assertEquals(t.includes("<"), false);
});

Deno.test("cheapDiscoverLinks keeps same-host event links only", () => {
  const html = '<a href="/אירועים/4/x/">כל האירועים</a> <a href="https://other.com/events">events</a> <a href="/about">אודות</a> <a href="/calendar?page=2">2</a>';
  const links = cheapDiscoverLinks(html, "https://www.azrielimalls.co.il/אירועים/", 5);
  assertEquals(links.length, 2);
  assertEquals(links.every((l) => l.includes("azrielimalls.co.il")), true);
});
Deno.test("assessChildRelevance: adult events from mixed municipal calendars are rejected, kids pass, unclear reviewed", () => {
  assertEquals(assessChildRelevance({ audience: "adults", name: "קפה עסקי בימי שני" }), "reject");
  assertEquals(assessChildRelevance({ audience: "unknown", name: "סדרת הסיקסטיז - מנוי" }), "reject");
  assertEquals(assessChildRelevance({ audience: "unknown", name: "סדנת הכר את הנייד", description: "לגיל הזהב" }), "reject");
  assertEquals(assessChildRelevance({ audience: "children", name: "קסם של סיפור - הזחל הרעב", description: "הצגת ילדים" }), "ok");
  assertEquals(assessChildRelevance({ audience: "unknown", name: "שעת סיפור בספרייה", description: "לגילאי 3-6" }), "ok");
  assertEquals(assessChildRelevance({ audience: "unknown", name: "אהבה מודרנית", description: "מופע" }), "review");
  assertEquals(assessChildRelevance({ audience: "family", name: "פסטיבל הקוסם מארץ עוץ" }), "ok");
  // (2026-09-24 trusted age evidence) the model's own 4-8 proves nothing; the same ages stated by the item's card do
  assertEquals(assessChildRelevance({ audience: "unknown", name: "יוגה", min_age: 4, max_age: 8 }), "review");
  assertEquals(assessChildRelevance({ audience: "unknown", name: "יוגה", min_age: 4, max_age: 8, age_evidence: { provenance: "event_local_explicit_age", evidence: "לגילאי 4-8", scope: "listing_card", min_age: 4, max_age: 8, model_agrees: true } } as Record<string, unknown>), "ok");
});

Deno.test("repairUnescapedQuotes escapes a quoted word inside a string, leaves valid JSON alone", () => {
  const broken = '[{"name": "סדנה", "description": "הסדנה "מדע לילדים" מתאימה לכולם", "city": "חיפה"}]';
  const fixed = repairUnescapedQuotes(broken);
  assertEquals(JSON.parse(fixed)[0].description, 'הסדנה "מדע לילדים" מתאימה לכולם');
  const valid = '[{"a":"ב, ג","c":["ד","ה"],"f":"x\\"y"}]';
  assertEquals(repairUnescapedQuotes(valid), valid);
  assertEquals(parseExtractionResponse(broken).activities.length, 1);
  assertEquals(parseExtractionResponse(broken).repaired, true);
});

Deno.test("repairHebrewGershayim replaces a quote only between Hebrew letters", () => {
  assertEquals(repairHebrewGershayim('"name": "גן החיות התנ"כי"'), '"name": "גן החיות התנ״כי"');
  assertEquals(repairHebrewGershayim('"ע"ש הרב", "מתנ"ס"'), '"ע״ש הרב", "מתנ״ס"');
  // real JSON delimiters are untouched
  assertEquals(repairHebrewGershayim('{"a":"ב","c":"ד"}'), '{"a":"ב","c":"ד"}');
  assertEquals(repairHebrewGershayim('["x", "y"]'), '["x", "y"]');
});

Deno.test("parseExtractionResponse recovers the production failure (unescaped gershayim in first object)", () => {
  const raw = '```json\n[\n  {"name": "גן החיות התנ"כי ואקווריום ישראל", "entity_type": "מקום_קבוע"},\n  {"name": "סיור לילה", "entity_type": "אירוע"}\n]\n```';
  const res = parseExtractionResponse(raw);
  assertEquals(res.activities.length, 2);
  assertEquals(res.repaired, true);
  assertEquals(res.truncated, false);
  assertEquals((res.activities[0] as { name: string }).name, "גן החיות התנ״כי ואקווריום ישראל");
});

Deno.test("parseExtractionResponse: clean array, fenced array, prose after array", () => {
  assertEquals(parseExtractionResponse('[{"name":"א"}]').activities.length, 1);
  assertEquals(parseExtractionResponse('```json\n[{"name":"א"}]\n```').activities.length, 1);
  assertEquals(parseExtractionResponse('[{"name":"א"}]\nהערה: [מקור]').activities.length, 1);
  assertEquals(parseExtractionResponse('[{"name":"א"}]').repaired, false);
});

Deno.test("parseExtractionResponse salvages a truncated array", () => {
  const res = parseExtractionResponse('[{"name":"א","x":1},{"name":"ב","x":2},{"name":"ג","x');
  assertEquals(res.activities.length, 2);
  assertEquals(res.truncated, true);
});

Deno.test("parseExtractionResponse throws on garbage", () => {
  assertThrows(() => parseExtractionResponse('לא מצאתי פעילויות'));
  assertThrows(() => parseExtractionResponse('[{"name": "פגום'));
});

Deno.test("filterPastOneTimeActivities drops past one-time events only", () => {
  const acts = [
    { name: "past", schedule_type: "one_time", one_time_date: "2026-01-01" },
    { name: "future", schedule_type: "one_time", one_time_date: "2026-12-01" },
    { name: "recurring", schedule_type: "recurring", one_time_date: null },
  ];
  assertEquals(filterPastOneTimeActivities(acts, "2026-09-13").map((a) => a.name), ["future", "recurring"]);
});

Deno.test("isPlausibleEventDate: today..+maxDays only, malformed rejected", () => {
  assertEquals(isPlausibleEventDate("2026-09-13", "2026-09-13", 180), true);
  assertEquals(isPlausibleEventDate("2026-12-13", "2026-09-13", 180), true);
  assertEquals(isPlausibleEventDate("2027-09-13", "2026-09-13", 180), false);
  assertEquals(isPlausibleEventDate("2026-09-12", "2026-09-13", 180), false);
  assertEquals(isPlausibleEventDate("27.9", "2026-09-13", 180), false);
  assertEquals(isPlausibleEventDate(null, "2026-09-13", 180), false);
});

Deno.test("looksLikeStaleRepost: old published post offered as a one-time event", () => {
  assertEquals(looksLikeStaleRepost({ schedule_type: "one_time", source_published_date: "2024-03-01" }, "2026-09-13"), true);
  assertEquals(looksLikeStaleRepost({ schedule_type: "one_time", source_published_date: "2026-08-01" }, "2026-09-13"), false);
  assertEquals(looksLikeStaleRepost({ schedule_type: "fixed_hours", source_published_date: "2020-01-01" }, "2026-09-13"), false);
  assertEquals(looksLikeStaleRepost({ schedule_type: "one_time", source_published_date: null }, "2026-09-13"), false);
});

Deno.test("child relevance: an 'adults' label contradicted by an explicit child age is reviewable, not rejected (dual-tagged toddlers' show)", () => {
  assertEquals(assessChildRelevance({ audience: 'adults', name: 'גולי והגיטרה ששרה לגיל 2-4', description: 'הפעלה מוסיקלית לקטנטנים. ילדים ומשפחה, אזרחים ותיקים' }), 'review');
  assertEquals(assessChildRelevance({ audience: 'adults', name: 'הרצאה: המוח החברתי', description: 'לגיל הזהב' }), 'reject');
  assertEquals(assessChildRelevance({ audience: 'adults', name: 'סדנה למבוגרים בני 40+', description: '' }), 'reject');
  assertEquals(hasExplicitChildAge('תיאטרון סיפור לגילאי 4 -2'), true);
});

// חדרי בריחה (escape rooms, 2026-09-16): a new category exercising the SAME generic gates - no
// category-specific branching added anywhere in extraction.ts, just fixtures proving the existing
// audience/age machinery already does the right thing (plus one real gap it closed: min_age>=18 as
// adult evidence, see hasAdult above - previously an operator's page labeled "family" for the venue
// as a whole with an explicit min_age:18 on one room silently passed as 'ok').
Deno.test('escape rooms: clear family framing and explicit child age pass, an adult-only room is rejected even when mislabeled family, unclear suitability is reviewed (never invented)', () => {
  // A: clear family escape room
  assertEquals(assessChildRelevance({ audience: 'family', name: 'חדר בריחה למשפחות ולילדים', category: 'חדרי בריחה' }), 'ok');
  // B: explicit child age evidence ("מגיל 8") is preserved through the existing hasExplicitChildAge/min_age model, not dropped
  assertEquals(hasExplicitChildAge('מתאים לילדים מגיל 8'), true);
  assertEquals(assessChildRelevance({ audience: 'unknown', name: 'חדר הפיראטים', description: 'מתאים לילדים מגיל 8', category: 'חדרי בריחה', min_age: 8 }), 'ok');
  // D: an explicit adult marker rejects outright regardless of category
  assertEquals(assessChildRelevance({ audience: 'unknown', name: 'חדר בריחה - אימה 18+', category: 'חדרי בריחה' }), 'reject');
  // D: the venue page's own "family" audience label does not override an explicit min_age:18 on this
  // room - this is the exact case the new hasAdult min_age signal fixes (was silently 'ok' before)
  assertEquals(assessChildRelevance({ audience: 'family', name: 'חדר בריחה קיצוני', description: 'מתאים מגיל 18 בלבד', category: 'חדרי בריחה', min_age: 18 }), 'review');
  // E: escape-room identity is clear but child suitability isn't stated at all - existing
  // confidence/review rules apply (never invented as ok, never blanket-rejected either)
  assertEquals(assessChildRelevance({ audience: 'unknown', name: 'חדרי בריחה - האולפן', category: 'חדרי בריחה' }), 'review');
});
