// TuRu - extraction robustness regression tests (2026-09-13). The gershayim case is the real root
// cause of "המודל החזיר תשובה פגומה" on 5 of 11 production sources: Haiku wrote "גן החיות התנ"כי"
// with a raw ASCII quote inside a JSON string. Run with `npx deno test supabase/functions/_shared/`.

import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  repairHebrewGershayim, repairUnescapedQuotes, parseExtractionResponse, filterPastOneTimeActivities, isPlausibleEventDate, looksLikeStaleRepost,
} from "./extraction.ts";

import { assessChildRelevance, hasExplicitChildAge, cheapPageText, cheapDiscoverLinks } from "./extraction.ts";

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
  assertEquals(assessChildRelevance({ audience: "unknown", name: "יוגה", min_age: 4, max_age: 8 }), "ok");
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
