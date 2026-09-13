// TuRu - source health state machine tests. Temporary failures back off but never disappear;
// only hard access failures on non-high-value sources can auto-pause, and always with an
// explicit reason. Run with `npx deno test supabase/functions/_shared/`.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyFetchFailure, nextSourceHealthOnFailure, healthOnSuccess, worstFailureKind } from "./sourceHealth.ts";

const settings = { attentionAfter: 5, autoPauseAfter: 10, backoffMaxHours: 168 };

Deno.test("classifyFetchFailure maps status codes and network errors", () => {
  assertEquals(classifyFetchFailure({ status: 404 }), "gone_404");
  assertEquals(classifyFetchFailure({ status: 410 }), "gone_404");
  assertEquals(classifyFetchFailure({ status: 403 }), "access_403_waf");
  assertEquals(classifyFetchFailure({ status: 429 }), "access_403_waf");
  assertEquals(classifyFetchFailure({ status: 503, bodySnippet: "Just a moment... Cloudflare" }), "access_403_waf");
  assertEquals(classifyFetchFailure({ status: 502 }), "timeout_network");
  assertEquals(classifyFetchFailure({ errorName: "TimeoutError", errorMessage: "Signal timed out." }), "timeout_network");
  assertEquals(classifyFetchFailure({ errorName: "TypeError", errorMessage: "fetch failed" }), "timeout_network");
  assertEquals(classifyFetchFailure({}), "unknown");
});

Deno.test("temporary failure: failing -> backed_off with exponential delay, capped, never paused", () => {
  const base = { failureKind: "timeout_network" as const, priority: 5, baseFrequencyHours: 24, settings };
  assertEquals(nextSourceHealthOnFailure({ ...base, consecutiveFailures: 1 }).healthStatus, "failing");
  assertEquals(nextSourceHealthOnFailure({ ...base, consecutiveFailures: 1 }).nextScanDelayHours, 24);
  const f3 = nextSourceHealthOnFailure({ ...base, consecutiveFailures: 3 });
  assertEquals(f3.healthStatus, "backed_off");
  assertEquals(f3.nextScanDelayHours, 48);
  const f4 = nextSourceHealthOnFailure({ ...base, consecutiveFailures: 4 });
  assertEquals(f4.nextScanDelayHours, 96);
  const f20 = nextSourceHealthOnFailure({ ...base, consecutiveFailures: 20 });
  assertEquals(f20.healthStatus, "attention_required");
  assertEquals(f20.isActive, true);
  assertEquals(f20.nextScanDelayHours, 168);
  assertEquals(f20.disabledReason, null);
});

Deno.test("permanent failure (404) on a normal source auto-pauses only after the threshold, with a reason", () => {
  const base = { failureKind: "gone_404" as const, priority: 5, baseFrequencyHours: 24, settings };
  assertEquals(nextSourceHealthOnFailure({ ...base, consecutiveFailures: 5 }).healthStatus, "attention_required");
  assertEquals(nextSourceHealthOnFailure({ ...base, consecutiveFailures: 9 }).isActive, true);
  const paused = nextSourceHealthOnFailure({ ...base, consecutiveFailures: 10 });
  assertEquals(paused.healthStatus, "auto_paused");
  assertEquals(paused.isActive, false);
  assertEquals(paused.disabledReason, "auto_paused: 10 consecutive gone_404 failures");
});

Deno.test("high-value sources (priority >= 8) are never auto-paused", () => {
  const t = nextSourceHealthOnFailure({ consecutiveFailures: 50, failureKind: "gone_404", priority: 8, baseFrequencyHours: 24, settings });
  assertEquals(t.healthStatus, "attention_required");
  assertEquals(t.isActive, true);
});

Deno.test("parse/extraction failures never auto-pause", () => {
  const t = nextSourceHealthOnFailure({ consecutiveFailures: 50, failureKind: "parse_extraction", priority: 1, baseFrequencyHours: 24, settings });
  assertEquals(t.healthStatus, "attention_required");
  assertEquals(t.isActive, true);
});

Deno.test("success resets to healthy", () => {
  assertEquals(healthOnSuccess(), { healthStatus: "healthy", consecutiveFailures: 0, disabledReason: null });
});

Deno.test("worstFailureKind prefers hard access failures", () => {
  assertEquals(worstFailureKind(["unknown", "timeout_network", "access_403_waf"]), "access_403_waf");
  assertEquals(worstFailureKind(["content_changed", "parse_extraction"]), "parse_extraction");
  assertEquals(worstFailureKind([]), null);
});
