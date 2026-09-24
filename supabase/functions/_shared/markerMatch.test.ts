// HEBREW-AWARE MARKER MATCHING + MARKER STRENGTH (2026-09-24) - the SAME case table as the Node twin
// (tools/import-tool/tests/markerMatch.test.js).
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { markersIn } from "./markerMatch.ts";
import { childRelevanceEvidence } from "./extraction.ts";
import { extractDetailEvidence } from "./detailEvidence.ts";

const table = JSON.parse(await Deno.readTextFile(new URL("./markerMatch.cases.json", import.meta.url)));

Deno.test("marker matcher: shared table", () => {
  for (const [text, marker, want] of table.matcher as [string, string, boolean][]) assertEquals(markersIn(text, [marker]).length > 0, want, `${marker} in ${text}`);
});
// deno-lint-ignore no-explicit-any
for (const k of table.relevance as any[]) Deno.test(`relevance (marker strength): ${k.id}`, () => { const r = childRelevanceEvidence(k.c); assertEquals([r.verdict, r.reason], k.expect); });

Deno.test("detail page: arts ('אמנויות') is not an adult subscription marker; birds are not Purim", () => {
  const ev = extractDetailEvidence('<html><head><title>סדנה</title></head><body><main><h1>סדנה</h1><p>סדנה לילדים בבית הספר לאמנויות. סיפורים וציפורים לכל המשפחה.</p></main></body></html>', "2026-09-24");
  assertEquals(ev.adultMarkers, 0);
  assertEquals(ev.childMarkers, 3); // ילדים (in לילדים), לכל המשפחה, משפחה (in המשפחה) - never פורים from ציפורים / סיפורים
});
