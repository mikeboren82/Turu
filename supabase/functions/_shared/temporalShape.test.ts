// TuRu - temporal shape (2026-09-24): the SAME case table as the Node twin (tools/import-tool/tests/temporalShape.test.js).
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assessTemporalShape, cardDateSpan } from "./temporalShape.ts";

const table = JSON.parse(await Deno.readTextFile(new URL("./temporalShape.cases.json", import.meta.url)));
// deno-lint-ignore no-explicit-any
for (const k of table.card as any[]) {
  Deno.test(`temporal shape card span: ${k.id}`, () => {
    const s = cardDateSpan(k.text, k.title, k.date);
    assertEquals(s ? [s.start, s.end, s.days] : null, k.expect);
  });
}
// deno-lint-ignore no-explicit-any
for (const k of table.assess as any[]) {
  Deno.test(`temporal shape assess: ${k.id}`, () => {
    const a = assessTemporalShape(k.c);
    assertEquals([a.collapsed, a.signals], k.expect);
  });
}
