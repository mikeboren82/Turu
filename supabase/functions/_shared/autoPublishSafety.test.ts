// TuRu - auto-publish content safety (2026-09-24). Runs the SAME case table as the Node twin
// (autoPublishSafety.cases.json). Run with `npx deno test supabase/functions/_shared/`.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assessAutoPublishSafety } from "./autoPublishSafety.ts";

const table = JSON.parse(await Deno.readTextFile(new URL("./autoPublishSafety.cases.json", import.meta.url)));

for (const k of table.cases) {
  Deno.test(`content safety: ${k.id} -> ${k.expect ? "eligible" : "held"} (${k.code})`, () => {
    // the model's own family labels are on every case: they must never be what decides
    const v = assessAutoPublishSafety({ ...k.c, audience: "family", family_fit: ["מתאים לילד ולהורה"] }, table[k.source]);
    assertEquals([v.allow, v.code], [k.expect, k.code]);
  });
}

Deno.test("trust never enters the decision: the verdict is the same for any source trust state", () => {
  for (const k of table.cases) {
    const base = assessAutoPublishSafety(k.c, table[k.source]);
    const trusted = assessAutoPublishSafety(k.c, { ...table[k.source], is_trusted: true, source_trust_score: 100, auto_publish_earned: true } as never);
    assertEquals(trusted, base, k.id);
  }
});

Deno.test("scan-source: content safety is part of the canonical policy autoApproveEligible delegates to, independent of trust", async () => {
  const src = await Deno.readTextFile(new URL("../scan-source/index.ts", import.meta.url));
  const fn = src.slice(src.indexOf("function autoApproveEligible("), src.indexOf("async function autoApproveNewActivity("));
  assert(fn.includes("evaluatePublishPolicy("));
  const policy = await Deno.readTextFile(new URL("./publishPolicy.ts", import.meta.url));
  assert(/const evidence = withoutUntrustedEnrichment\(c\);/.test(policy) && /const safety = assessAutoPublishSafety\(evidence,/.test(policy) &&!/trusted &&[^\n]*safety/.test(policy));
  assert(/if \(!safety\.allow && !issues\.includes\(SAFETY_ISSUE_LABEL\)\) \{ issues\.push\(SAFETY_ISSUE_LABEL\)/.test(src), "held candidates carry the gating label");
});
