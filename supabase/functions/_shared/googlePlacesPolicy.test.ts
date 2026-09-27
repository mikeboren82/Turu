// Google Places persistence policy (2026-09-27) - the Deno twin against the shared case table
// (googlePlacesPolicy.cases.json, also run by the Node and Python twins), the scan-settlement-gaps hard gate, and the
// edge page fetcher's Maps-page guard. Run with `npx deno test supabase/functions/_shared/`.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  GOOGLE_PLACES_CONTENT_PERSISTENCE, POLICY_REASON, isGoogleMapsUrl, isPlacesOriginCandidate, settlementScanGate,
} from "./googlePlacesPolicy.ts";
import { fetchHtml } from "./extraction.ts";

const table = JSON.parse(await Deno.readTextFile(new URL("./googlePlacesPolicy.cases.json", import.meta.url)));

Deno.test("twin parity: constant, reason and every shared case", () => {
  assertEquals(GOOGLE_PLACES_CONTENT_PERSISTENCE, table.persistence);
  assertEquals(POLICY_REASON, table.policyReason);
  for (const [url, want] of table.mapsUrls) assertEquals(isGoogleMapsUrl(url), want, String(url));
  for (const [ed, pageUrl, want] of table.placesOrigin) assertEquals(isPlacesOriginCandidate(ed, pageUrl), want, JSON.stringify([ed, pageUrl]));
});

Deno.test("scan-settlement-gaps gate: operational setting ON + persistence policy OFF -> skipped, no run", () => {
  assertEquals(settlementScanGate({ settlement_scan_enabled: true }), { run: false, skipped: POLICY_REASON });
  // a missing settings row used to mean "run" - the policy still stops it
  assertEquals(settlementScanGate({}), { run: false, skipped: POLICY_REASON });
});

Deno.test("scan-settlement-gaps gate: ordinary OFF state -> no run", () => {
  assertEquals(settlementScanGate({ settlement_scan_enabled: false }).run, false);
  // with the policy reopened (a future code change) the operational toggle keeps its old meaning
  assertEquals(settlementScanGate({ settlement_scan_enabled: false }, true), { run: false, skipped: "disabled" });
  assertEquals(settlementScanGate({ settlement_scan_enabled: true }, true), { run: true });
});

Deno.test("edge fetchHtml never requests a Google Maps page; ordinary pages still fetch", async () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((u: string | URL | Request) => { calls.push(String(u)); return Promise.resolve(new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } })); }) as typeof fetch;
  try {
    const blocked = await fetchHtml("https://maps.google.com/?cid=1", { timeoutMs: 1000, retries: 0 });
    assertEquals([blocked.ok, blocked.fetchError], [false, "google_maps_page_not_a_source"]);
    assertEquals(calls, []);
    const ok = await fetchHtml("https://www.raanana.muni.il/events", { timeoutMs: 1000, retries: 0 });
    assertEquals(ok.ok, true);
    assertEquals(calls, ["https://www.raanana.muni.il/events"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
