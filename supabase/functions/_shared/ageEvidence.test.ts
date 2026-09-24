// TRUSTED AGE EVIDENCE (2026-09-24) - the SAME case table as the Node twin (tools/import-tool/tests/ageEvidence.test.js)
// + the scan-time detail parser reading page CONTENT only.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { agesIn, trustedAges, ageEvidenceFor } from "./ageEvidence.ts";
import { childRelevanceEvidence } from "./extraction.ts";
import { assessAutoPublishSafety } from "./autoPublishSafety.ts";
import { extractDetailEvidence, applyDetailEvidence } from "./detailEvidence.ts";
import { boundCardText, type ListingCard } from "./listingCards.ts";

const table = JSON.parse(await Deno.readTextFile(new URL("./ageEvidence.cases.json", import.meta.url)));

Deno.test("age parser: shared table", () => {
  for (const [text, want] of table.parser as [string, unknown][]) {
    const a = agesIn(text);
    assertEquals(a && [a.min_age, a.max_age, a.kind], want, JSON.stringify(text));
  }
});
// deno-lint-ignore no-explicit-any
for (const k of table.trusted as any[]) Deno.test(`trustedAges: ${k.id}`, () => { const t = trustedAges(k.c); assertEquals(t && [t.min_age, t.max_age, t.provenance], k.expect); });
// deno-lint-ignore no-explicit-any
for (const k of table.intake as any[]) Deno.test(`ageEvidenceFor: ${k.id}`, () => { const r = ageEvidenceFor(k.c, { cardText: k.cardText ?? null, detailText: k.detailText ?? null }); assertEquals(r && [r.provenance, r.scope, r.min_age, r.max_age, r.model_agrees], k.expect); });
// deno-lint-ignore no-explicit-any
for (const k of table.relevance as any[]) Deno.test(`relevance (trusted ages): ${k.id}`, () => { const r = childRelevanceEvidence(k.c); assertEquals([r.verdict, r.reason], k.expect); });
// deno-lint-ignore no-explicit-any
for (const k of table.safety as any[]) Deno.test(`content safety (trusted ages): ${k.id}`, () => { const r = assessAutoPublishSafety(k.c, { name: "עיריית חולון", url: "https://www.holon.muni.il" }); assertEquals([r.allow, r.code], k.expect); });

// G: a robotics workshop whose municipal site menu / footer says "גיל הרך" - no age from chrome, no age_evidence
const MENU = '<header><div class="header-menu-container"><ul><li><a href="/early">תחום הגיל הרך</a></li><li><a href="/youth">רשות הצעירים והגיל הרך</a></li></ul></div></header>';
const FOOTER = '<footer><ul><li><a>הגיל הרך</a></li><li><a>לפעוטות</a></li></ul></footer>';
const page = (main: string) => `<html><head><title>סדנת רובוטיקה ואלקטרוניקה</title></head><body>${MENU}<main><h1>סדנת רובוטיקה ואלקטרוניקה</h1>${main}</main>${FOOTER}</body></html>`;

Deno.test("G: detail page chrome cannot create age evidence (robotics page, menu says גיל הרך)", () => {
  const ev = extractDetailEvidence(page("<p>סדנת בנייה ותכנות של רובוטים בספרייה. יום רביעי 01/10/2026 בשעה 17:00</p>"), "2026-09-24");
  assertEquals(ev.ages, null);
  assertEquals(ev.childMarkers, 0, "menu / footer words are not audience markers either");
  const c: Record<string, unknown> = { name: "סדנת רובוטיקה ואלקטרוניקה", schedule_type: "one_time", min_age: null, max_age: null, audience: "unknown" };
  const filled = applyDetailEvidence(c, ev, "https://lib.example/robotics", "lib.example");
  assertEquals(filled.includes("ages") || filled.includes("age_evidence") || filled.includes("audience"), false);
  assertEquals(c.min_age, null); assertEquals(c.age_evidence, undefined);
});

Deno.test("detail page CONTENT that states the age is trusted age evidence (H: bound toddler wording too)", () => {
  const ev = extractDetailEvidence(page("<div class=\"ages\"><a>13-18</a><br><a>6-12</a></div><p>סדנת רובוטיקה</p>"), "2026-09-24");
  assertEquals([ev.ages?.min_age, ev.ages?.max_age], [6, 18]);
  const c: Record<string, unknown> = { name: "סדנת רובוטיקה ואלקטרוניקה", min_age: 0, max_age: 5, audience: "children" };
  applyDetailEvidence(c, ev, "https://lib.example/robotics", "lib.example");
  assertEquals(trustedAges(c), { min_age: 6, max_age: 18, provenance: "detail_content", evidence: "13-18, 6-12" });
  assertEquals(c.min_age, 0, "the stored model age is not overwritten - it just no longer proves anything");
  const toddler = extractDetailEvidence(page("<p>שעת תנועה לגיל הרך בליווי הורה</p>"), "2026-09-24");
  assertEquals([toddler.ages?.min_age, toddler.ages?.max_age, toddler.ages?.kind], [0, 5, "child_wording"]);
});

Deno.test("bound card text: the item's own card only - a title printed on two differing cards gives none", () => {
  const card = (title: string, lines: string[]): ListingCard => ({ title, text: [title, ...lines].join("\n"), url: null, image: null, signature: "div|card" });
  const cards = [card("סדנת רובוטיקה", ["לגילאי 6-12", "01/10/2026"]), card("מופע ערב", ["גיל 4", "20:30"])];
  assertEquals(boundCardText(cards, { name: "סדנת רובוטיקה" }), "סדנת רובוטיקה\nלגילאי 6-12\n01/10/2026");
  assertEquals(boundCardText(cards, { name: "מופע אחר" }), null);
  const twice = [card("הצגה", ["לגילאי 3-6", "01/10/2026"]), card("הצגה", ["לגילאי 7-9", "02/10/2026"])];
  assertEquals(boundCardText(twice, { name: "הצגה" }), null);
  assertEquals(boundCardText(twice, { name: "הצגה", one_time_date: "2026-10-02" }), "הצגה\nלגילאי 7-9\n02/10/2026");
});
