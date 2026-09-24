// TuRu - canonical publish policy (2026-09-24): the SAME case table as the Node twin
// (tools/import-tool/tests/publishPolicy.test.js). Run with `npx deno test supabase/functions/_shared/`.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluatePublishPolicy } from "./publishPolicy.ts";

const table = JSON.parse(await Deno.readTextFile(new URL("./publishPolicy.cases.json", import.meta.url)));
// deno-lint-ignore no-explicit-any
const merge = (k: any) => ({
  c: { ...table.base.c, ...(k.c || {}) },
  source: { ...table.base.source, ...(k.source || {}) },
  issues: k.issues || table.base.issues,
  row: k.row === null ? null : { ...table.base.row, ...(k.row || {}) },
});

for (const k of table.cases) {
  Deno.test(`publish policy: ${k.id} -> ${k.expect[0]} ${JSON.stringify(k.expect[2])}`, () => {
    const m = merge(k);
    const r = evaluatePublishPolicy(m.c, { source: m.source, issues: m.issues, today: table.today, minTrust: table.minTrust, maxDaysAhead: table.maxDaysAhead, row: m.row, trustOverride: k.trustOverride || null });
    assertEquals([r.decision, r.humanApprovable, r.reasons.map((x) => x.code)], k.expect);
  });
}

Deno.test("scan-source intake delegates autoApproveEligible to the canonical policy", async () => {
  const src = await Deno.readTextFile(new URL("../scan-source/index.ts", import.meta.url));
  const fn = src.slice(src.indexOf("function autoApproveEligible("), src.indexOf("async function autoApproveNewActivity("));
  assert(/return evaluatePublishPolicy\(candidate, \{[^}]*\}\)\.decision === 'ELIGIBLE';/.test(fn));
});
