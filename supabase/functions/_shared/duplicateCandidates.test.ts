// TuRu - Deno port of the duplicate-candidate generator + live single-row detector wired into
// scan-source/index.ts's autoApproveNewActivity (2026-09-21 future-detection activation). See
// tools/import-tool/tests/duplicateCandidates.test.js and futureDuplicateDetection.test.js for the
// Node-side equivalents this file mirrors in spirit (no shared fixture - see duplicateCandidates.ts's
// module header for why).
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isOfferingOfferingPair, buildIndex, candidatesForActivity, detectFutureDuplicates,
  GENERATOR_VERSION, CELL_DEG, MAX_NEIGHBOURHOOD_ROWS, ELIGIBLE_STATUS, NEIGHBOURHOOD_PAD_DEG,
  type CandidateRow,
} from "./duplicateCandidates.ts";
import { PLACE_ENTITY_TYPE } from "./placesDiscovery.ts";

const P = PLACE_ENTITY_TYPE;
const S = { lat: 32.0461112, lng: 34.8195887, address: "רמת גן", city: "רמת גן" };
function row(id: string, name: string, extra: Partial<CandidateRow> = {}): CandidateRow {
  return { id, name, status: "approved", entity_type: P, venue_id: null, source_url: null, lat: null, lng: null, address: null, city: null, ...extra };
}
function safari(): CandidateRow[] {
  return [
    row("a-parent", "ספארי רמת גן", { ...S, source_url: "https://www.safari.co.il/", venue_id: "v1" }),
    row("b-aggr", "ספארי - חוויה מרתקת לכל המשפחה", { ...S, source_url: "https://www.karamel.co.il/x.asp", venue_id: "v1" }),
    row("d-morning", "סיור ספארי על הבוקר", { ...S, entity_type: "אירוע_קבוע", source_url: "https://www.safari.co.il/", venue_id: "v1" }),
  ];
}

Deno.test("ROUTING: isOfferingOfferingPair excludes offering<->offering, not place<->offering or place<->place", () => {
  assertEquals(isOfferingOfferingPair({ entity_type: "מקום_קבוע" }, { entity_type: "מקום_קבוע" }), false);
  assertEquals(isOfferingOfferingPair({ entity_type: "מקום_קבוע" }, { entity_type: "אירוע" }), false);
  assertEquals(isOfferingOfferingPair({ entity_type: "אירוע_קבוע" }, { entity_type: "פעילות" }), true);
});

Deno.test("SINGLE-ROW DETECTION: an arriving aggregator copy yields exactly one candidate against the existing canonical row", () => {
  const existing = safari().filter((r) => r.id !== "b-aggr");
  const index = buildIndex(existing);
  const arriving = safari().find((r) => r.id === "b-aggr")!;
  const { candidates } = candidatesForActivity(arriving, index);
  assertEquals(candidates.length, 1);
  assertEquals([candidates[0].activity_id_a, candidates[0].activity_id_b], ["a-parent", "b-aggr"]);
  assert(candidates[0].identity_evidence.some((e) => e.startsWith("independent_sources_agree")));
});

Deno.test("SINGLE-ROW DETECTION: an arriving legitimate sibling tour yields no candidate", () => {
  const existing = safari().filter((r) => r.id !== "d-morning");
  const index = buildIndex(existing);
  const arriving = safari().find((r) => r.id === "d-morning")!;
  assertEquals(candidatesForActivity(arriving, index).candidates.length, 0);
});

// --- a small in-memory Supabase-shaped fake covering exactly the call patterns detectFutureDuplicates
// uses (select/eq/neq/not/gte/lte/in/maybeSingle, insert, update) - same approach as the Node test.
// deno-lint-ignore no-explicit-any
function fakeClient(seed: { activities?: any[]; locations?: any[]; duplicate_candidates?: any[] } = {}) {
  const state = {
    activities: (seed.activities || []).map((a) => ({ ...a })),
    locations: (seed.locations || []).map((l) => ({ ...l })),
    duplicate_candidates: (seed.duplicate_candidates || []).map((d) => ({ ...d })),
  };
  let nextId = 1;
  const failing = new Set<string>();
  // deno-lint-ignore no-explicit-any
  function builder(table: string) {
    const filters: [string, string, unknown][] = [];
    let selectCols: string | null = null, single = false, op: string | null = null, payload: Record<string, unknown> | null = null;
    const api = {
      // deno-lint-ignore no-explicit-any
      select(cols: string) { selectCols = cols; return api; },
      eq(k: string, v: unknown) { filters.push(["eq", k, v]); return api; },
      neq(k: string, v: unknown) { filters.push(["neq", k, v]); return api; },
      not(k: string, _cmp: string, v: unknown) { filters.push(["not", k, v]); return api; },
      gte(k: string, v: unknown) { filters.push(["gte", k, v]); return api; },
      lte(k: string, v: unknown) { filters.push(["lte", k, v]); return api; },
      in(k: string, v: unknown[]) { filters.push(["in", k, v]); return api; },
      maybeSingle() { single = true; return exec(); },
      insert(p: Record<string, unknown>) { op = "insert"; payload = p; return exec(); },
      update(p: Record<string, unknown>) { op = "update"; payload = p; return api; },
      // deno-lint-ignore no-explicit-any
      then(resolve: any, reject: any) { return exec().then(resolve, reject); },
    };
    // deno-lint-ignore no-explicit-any
    function applyFilters(rows: any[]) {
      return rows.filter((r) => filters.every(([type, k, v]) => {
        if (type === "eq") return r[k] === v;
        if (type === "neq") return r[k] !== v;
        if (type === "not") return v === null ? r[k] != null : r[k] !== v;
        if (type === "gte") return r[k] != null && r[k] >= (v as number);
        if (type === "lte") return r[k] != null && r[k] <= (v as number);
        if (type === "in") return (v as unknown[]).includes(r[k]);
        return true;
      }));
    }
    async function exec(): Promise<{ data: unknown; error: { message: string } | null }> {
      if (failing.has(table)) return { data: null, error: { message: `simulated failure on ${table}` } };
      // deno-lint-ignore no-explicit-any
      const t = (state as any)[table];
      if (op === "insert") {
        const r = { ...payload };
        if (table === "duplicate_candidates") {
          if ((r.activity_id_a as string) >= (r.activity_id_b as string)) return { data: null, error: { message: "duplicate_candidates_ordered" } };
          if (t.some((x: { activity_id_a: string; activity_id_b: string }) => x.activity_id_a === r.activity_id_a && x.activity_id_b === r.activity_id_b)) {
            return { data: null, error: { message: "duplicate_candidates_pair" } };
          }
          r.id = "dc-" + nextId++; r.detection_count = r.detection_count ?? 1;
        }
        t.push(r);
        return { data: r, error: null };
      }
      if (op === "update") {
        const rows = applyFilters(t);
        for (const r of rows) Object.assign(r, payload);
        return { data: rows, error: null };
      }
      let rows = applyFilters(t);
      if (table === "activities" && selectCols && selectCols.includes("locations(")) {
        rows = rows.map((r: { location_id: string }) => ({ ...r, locations: state.locations.find((l) => l.id === r.location_id) || null }));
      }
      if (single) return { data: rows[0] || null, error: null };
      return { data: rows, error: null };
    }
    return api;
  }
  return { from: (t: string) => builder(t), _state: state, _failOn: (t: string) => failing.add(t) };
}

function toRows(cands: CandidateRow[]) {
  return {
    activities: cands.map((r) => ({ id: r.id, name: r.name, status: r.status, entity_type: r.entity_type, venue_id: r.venue_id, source_url: r.source_url, location_id: "loc-" + r.id })),
    locations: cands.map((r) => ({ id: "loc-" + r.id, lat: r.lat, lng: r.lng, address: r.address, city: r.city })),
  };
}

Deno.test("LIVE DETECTION: an arriving aggregator copy is written to the queue", async () => {
  const { activities, locations } = toRows(safari());
  const client = fakeClient({ activities, locations });
  const r = await detectFutureDuplicates(client, "b-aggr", { reason: "new-activity" });
  assertEquals(r.error, null);
  assertEquals(r.candidatesFound, 1);
  assertEquals(r.inserted, 1);
  assertEquals(client._state.duplicate_candidates.length, 1);
  assertEquals(client._state.duplicate_candidates[0].status, "needs_review");
});

Deno.test("LIVE DETECTION: eligibility gates - not-approved and coordinate-less rows are skipped", async () => {
  const { activities, locations } = toRows(safari());
  activities.find((a) => a.id === "b-aggr")!.status = "needs_review";
  const client = fakeClient({ activities, locations });
  const r = await detectFutureDuplicates(client, "b-aggr", { reason: "new-activity" });
  assertEquals(r.skippedReason, "status:needs_review");

  const { activities: acts2, locations: locs2 } = toRows(safari());
  locs2.find((l) => l.id === "loc-b-aggr")!.lat = null;
  const client2 = fakeClient({ activities: acts2, locations: locs2 });
  const r2 = await detectFutureDuplicates(client2, "b-aggr", { reason: "new-activity" });
  assertEquals(r2.skippedReason, "no_coordinates");
});

Deno.test("LIVE DETECTION: a resolved pair is not reopened when re-detected, but A/C still gets created", async () => {
  const extra = row("f-aggr2", "ספארי רמת גן - הכרטיס המשפחתי", { ...S, source_url: "https://www.tiuli.example/", venue_id: "v1" });
  const { activities, locations } = toRows([...safari(), extra]);
  const duplicate_candidates = [{ activity_id_a: "a-parent", activity_id_b: "b-aggr", status: "approved_distinct", evidence_fingerprint: "x", detection_count: 1 }];
  const client = fakeClient({ activities, locations, duplicate_candidates });
  const r = await detectFutureDuplicates(client, "f-aggr2", { reason: "new-activity" });
  assert(r.candidatesFound >= 1);
  assertEquals(client._state.duplicate_candidates.find((c: { activity_id_a: string; activity_id_b: string }) => c.activity_id_a === "a-parent" && c.activity_id_b === "b-aggr").status, "approved_distinct");
  assert(client._state.duplicate_candidates.some((c: { activity_id_a: string; activity_id_b: string }) => c.activity_id_a === "a-parent" && c.activity_id_b === "f-aggr2"), "A/C created despite A/B being resolved");
});

Deno.test("LIVE DETECTION: idempotent - a second detection run refreshes instead of duplicating", async () => {
  const { activities, locations } = toRows(safari());
  const client = fakeClient({ activities, locations });
  const r1 = await detectFutureDuplicates(client, "b-aggr", { reason: "new-activity" });
  const r2 = await detectFutureDuplicates(client, "b-aggr", { reason: "new-activity" });
  assertEquals([r1.inserted, r1.refreshed, r2.inserted, r2.refreshed], [1, 0, 0, 1]);
  assertEquals(client._state.duplicate_candidates.length, 1);
  assertEquals(client._state.duplicate_candidates[0].detection_count, 2);
});

Deno.test("LIVE DETECTION: failure isolation - a query failure is captured in the result, never thrown", async () => {
  const { activities, locations } = toRows(safari());
  const client = fakeClient({ activities, locations });
  client._failOn("locations");
  const r = await detectFutureDuplicates(client, "b-aggr", { reason: "new-activity" });
  assert(r.error);
  assertEquals(r.inserted, 0);
});

Deno.test("LIVE DETECTION: an unknown activity id is a clean no-op", async () => {
  const client = fakeClient({});
  const r = await detectFutureDuplicates(client, "nope", { reason: "new-activity" });
  assertEquals(r.skippedReason, "activity_not_found");
});

Deno.test("CONSTANTS: NEIGHBOURHOOD_PAD_DEG is exactly CELL_DEG*2 (the proven worst case for the 3x3-cell neighbourhood)", () => {
  assertEquals(NEIGHBOURHOOD_PAD_DEG, CELL_DEG * 2);
  assertEquals(CELL_DEG, 0.001);
  assertEquals(MAX_NEIGHBOURHOOD_ROWS, 200);
  assertEquals(ELIGIBLE_STATUS, "approved");
});

Deno.test("DRIFT: this port's key constants match the Node original's", async () => {
  const nodeSrc = await Deno.readTextFile(new URL("../../../tools/import-tool/lib/duplicateCandidates.js", import.meta.url));
  assert(nodeSrc.includes(`const GENERATOR_VERSION = '${GENERATOR_VERSION}';`));
  assert(nodeSrc.includes("const CELL_DEG = 0.001;"));
  assert(nodeSrc.includes("const MAX_NEIGHBOURHOOD_ROWS = 200;"));
  assert(nodeSrc.includes("const ELIGIBLE_STATUS = 'approved';"));
  const liveSrc = await Deno.readTextFile(new URL("../../../tools/import-tool/lib/futureDuplicateDetection.js", import.meta.url));
  assert(liveSrc.includes("const NEIGHBOURHOOD_PAD_DEG = CELL_DEG * 2;"));
});
