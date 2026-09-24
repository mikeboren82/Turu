import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { reconfirmationTarget, reconfirmExistingFromPending, type PendingReviewRow } from "./reconfirmation.ts";
import { recordProvenance } from "./provenance.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

// Table-backed fake of the supabase-js chains these helpers use (select/update/insert + eq/is, maybeSingle, await).
function fakeDb(init: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = structuredClone(init);
  const writes: { table: string; op: string; row?: Row; patch?: Row; n?: number }[] = [];
  const from = (table: string) => {
    const q = { op: "select", patch: null as Row | null, filters: [] as [string, unknown, string][], returning: false };
    const match = (r: Row) => q.filters.every(([k, v, kind]) => kind === "is" ? (r[k] ?? null) === v : r[k] === v);
    const run = () => {
      const rows = tables[table] ||= [];
      if (q.op === "insert") { const r = { id: `new-${rows.length + 1}`, ...q.patch }; rows.push(r); writes.push({ table, op: "insert", row: r }); return { data: [r], error: null }; }
      const hit = rows.filter(match);
      if (q.op === "update") { for (const r of hit) Object.assign(r, q.patch); writes.push({ table, op: "update", patch: q.patch!, n: hit.length }); return { data: q.returning ? hit.map((r) => ({ ...r })) : null, error: null }; }
      return { data: hit.map((r) => ({ ...r })), error: null };
    };
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() { if (q.op !== "select") q.returning = true; return b; },
      update(p: Row) { q.op = "update"; q.patch = p; return b; },
      insert(p: Row) { q.op = "insert"; q.patch = p; return b; },
      eq(k: string, v: unknown) { q.filters.push([k, v, "eq"]); return b; },
      is(k: string, v: unknown) { q.filters.push([k, v, "is"]); return b; },
      maybeSingle() { const r = run(); return Promise.resolve({ data: (r.data as Row[] | null)?.[0] ?? null, error: null }); },
      then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  };
  return { client: { from }, tables, writes };
}

const upd = (over: Partial<PendingReviewRow> = {}): PendingReviewRow => ({ id: "inc-1", match_type: "update", existing_activity_id: "act-1", confidence_score: 1, ...over });

// ---- decision rule ------------------------------------------------------------------------------

Deno.test("reconfirmationTarget: confident pending update linked to one activity -> refresh that activity", () => {
  assertEquals(reconfirmationTarget([upd()], 0.9), { refresh: true, activityId: "act-1", pendingId: "inc-1" });
  assertEquals(reconfirmationTarget([upd({ confidence_score: "0.97" })], 0.9).refresh, true); // numeric column arrives as string
  assertEquals(reconfirmationTarget([upd({ id: "a", confidence_score: 0.7 }), upd({ id: "b", confidence_score: 0.95 })], 0.9), { refresh: true, activityId: "act-1", pendingId: "b" });
});

Deno.test("reconfirmationTarget: nothing pending / pending NEW candidate with no live activity -> no refresh", () => {
  assertEquals(reconfirmationTarget([], 0.9), { refresh: false, reason: "no_pending" });
  assertEquals(reconfirmationTarget([upd({ match_type: "new", existing_activity_id: null })], 0.9), { refresh: false, reason: "unlinked_pending" });
  // a pending row of type 'duplicate' is not a reviewed-identity link either
  assertEquals(reconfirmationTarget([upd({ match_type: "duplicate" })], 0.9), { refresh: false, reason: "unlinked_pending" });
});

Deno.test("reconfirmationTarget: link below the duplicate threshold is an identity question -> no refresh", () => {
  assertEquals(reconfirmationTarget([upd({ confidence_score: 0.75 })], 0.9), { refresh: false, reason: "low_confidence_link" });
  assertEquals(reconfirmationTarget([upd({ confidence_score: 0.65 })], 0.9), { refresh: false, reason: "low_confidence_link" }); // standing-programme match
  assertEquals(reconfirmationTarget([upd({ confidence_score: null })], 0.9), { refresh: false, reason: "low_confidence_link" });
});

Deno.test("reconfirmationTarget: ambiguous pending rows (two activities, or linked + unlinked twin) -> no refresh", () => {
  assertEquals(reconfirmationTarget([upd({ id: "a" }), upd({ id: "b", existing_activity_id: "act-2" })], 0.9), { refresh: false, reason: "ambiguous_link" });
  assertEquals(reconfirmationTarget([upd({ id: "a" }), upd({ id: "b", match_type: "new", existing_activity_id: null })], 0.9), { refresh: false, reason: "ambiguous_link" });
});

// ---- known-case replay: a08ab845 "ילדי בית העץ" + pending update 18bc65b8 ------------------------

const LISTING = "https://www.holon.muni.il/Havingfun/pages/allevents.aspx";
const CASE_TWIN = "https://www.holon.muni.il/Havingfun/Pages/AllEvents.aspx";
function a08Shape() {
  return fakeDb({
    activities: [{ id: "act-1", status: "approved", name: "ילדי בית העץ", event_fingerprint: "ילדי בית העץ|c:חולון|2026-09-28|17:00", last_seen_at: "2026-09-13T18:25:09Z", consecutive_missing_scans: 19, detail_url: null }],
    activity_schedules: [{ id: "sch-1", activity_id: "act-1", one_time_date: "2026-09-28", start_time: "10:30:00", end_time: "11:40:00" }],
    incoming_activities: [{ id: "inc-1", match_type: "update", status: "needs_review", existing_activity_id: "act-1", confidence_score: 1, extracted_data: { event_fingerprint: "ילדי בית העץ|v:3133b3db|2026-09-28|10:30", start_time: "10:30" } }],
    activity_sources: [
      { id: "src-created", activity_id: "act-1", source_id: "holon", page_url: `${LISTING}#part=4`, relation: "created", url_role: null, first_seen_at: "2026-09-13T16:53:54Z", last_seen_at: "2026-09-13T16:53:54Z" },
      { id: "src-updated", activity_id: "act-1", source_id: "holon", page_url: `${CASE_TWIN}#part=4`, relation: "updated", url_role: null, first_seen_at: "2026-09-13T18:25:09Z", last_seen_at: "2026-09-13T18:25:09Z" },
    ],
  });
}
const pendingRowOf = (db: ReturnType<typeof fakeDb>): PendingReviewRow[] =>
  db.tables.incoming_activities.map(({ id, match_type, existing_activity_id, confidence_score }) => ({ id, match_type, existing_activity_id, confidence_score }));

Deno.test("KNOWN CASE a08ab845/18bc65b8: rescan while update pending -> live activity seen, no review row, update not applied", async () => {
  const db = a08Shape();
  const t0 = new Date().toISOString();
  const out = await reconfirmExistingFromPending(db.client, { rows: pendingRowOf(db), duplicateThreshold: 0.9, sourceId: "holon", pageUrl: `${LISTING}#part=2` });
  assertEquals(out, { outcome: "RECONFIRMED_EXISTING_PENDING_REVIEW", activityId: "act-1", pendingId: "inc-1" });

  const act = db.tables.activities[0];
  assert(act.last_seen_at >= t0, "live activity last_seen_at refreshed");
  assertEquals(act.consecutive_missing_scans, 0);
  assertEquals(act.event_fingerprint, "ילדי בית העץ|c:חולון|2026-09-28|17:00"); // pending update NOT applied

  assertEquals(db.tables.incoming_activities.length, 1); // no second review row
  assertEquals(db.tables.incoming_activities[0].status, "needs_review");
  assertEquals(db.writes.some((w) => w.table === "incoming_activities" || w.table === "activity_schedules"), false);

  const fresh = db.tables.activity_sources.find((s) => s.page_url === `${LISTING}#part=2`)!;
  assertEquals([fresh.relation, fresh.url_role, fresh.source_id, fresh.incoming_activity_id], ["seen", "listing", "holon", "inc-1"]);
  assertEquals(db.tables.activity_sources.length, 3);
});

Deno.test("KNOWN CASE: re-seen on an existing provenance page never downgrades created/updated nor first_seen_at", async () => {
  const db = a08Shape();
  for (const page of [`${LISTING}#part=4`, `${CASE_TWIN}#part=4`]) {
    await reconfirmExistingFromPending(db.client, { rows: pendingRowOf(db), duplicateThreshold: 0.9, sourceId: "holon", pageUrl: page });
  }
  const created = db.tables.activity_sources.find((s) => s.id === "src-created")!;
  const updated = db.tables.activity_sources.find((s) => s.id === "src-updated")!;
  assertEquals([created.relation, created.first_seen_at], ["created", "2026-09-13T16:53:54Z"]);
  assertEquals([updated.relation, updated.first_seen_at], ["updated", "2026-09-13T18:25:09Z"]);
  assert(created.last_seen_at > "2026-09-14" && updated.last_seen_at > "2026-09-14", "last_seen_at bumped");
  assertEquals(db.tables.activity_sources.length, 2); // no duplicate provenance rows
});

Deno.test("reconfirm: verified detail page gets 'detail' provenance + fill-null detail_url", async () => {
  const db = a08Shape();
  await reconfirmExistingFromPending(db.client, { rows: pendingRowOf(db), duplicateThreshold: 0.9, sourceId: "holon", pageUrl: `${LISTING}#part=2`, detailUrl: "https://www.holon.muni.il/e/123" });
  const d = db.tables.activity_sources.find((s) => s.page_url === "https://www.holon.muni.il/e/123")!;
  assertEquals([d.relation, d.url_role], ["seen", "detail"]);
  assertEquals(db.tables.activities[0].detail_url, "https://www.holon.muni.il/e/123");
});

Deno.test("reconfirm: pending link to a no-longer-approved activity refreshes nothing", async () => {
  const db = a08Shape();
  db.tables.activities[0].status = "archived";
  const out = await reconfirmExistingFromPending(db.client, { rows: pendingRowOf(db), duplicateThreshold: 0.9, sourceId: "holon", pageUrl: `${LISTING}#part=2` });
  assertEquals(out, { outcome: "PENDING_REVIEW_ONLY", reason: "activity_not_approved" });
  assertEquals(db.tables.activities[0].consecutive_missing_scans, 19);
  assertEquals(db.writes.filter((w) => w.table === "activity_sources").length, 0);
});

Deno.test("reconfirm: unsafe links (low confidence / ambiguous / unlinked new) perform zero writes", async () => {
  for (const rows of [
    [upd({ confidence_score: 0.7 })],
    [upd({ id: "a" }), upd({ id: "b", existing_activity_id: "act-2" })],
    [upd({ match_type: "new", existing_activity_id: null })],
  ]) {
    const db = a08Shape();
    const out = await reconfirmExistingFromPending(db.client, { rows, duplicateThreshold: 0.9, sourceId: "holon", pageUrl: `${LISTING}#part=2` });
    assertEquals(out.outcome, "PENDING_REVIEW_ONLY");
    assertEquals(db.writes.length, 0);
  }
});

// ---- provenance helper: behaviour-identical move + opt-in preserveRelation -------------------------

Deno.test("recordProvenance (default): legacy semantics kept - created sticky, otherwise relation overwritten, url_role fill-null", async () => {
  const db = fakeDb({ activity_sources: [
    { id: "c", activity_id: "act-1", page_url: "p1", relation: "created", url_role: "listing", first_seen_at: "2026-01-01" },
    { id: "u", activity_id: "act-1", page_url: "p2", relation: "updated", url_role: null, first_seen_at: "2026-01-01" },
  ], activities: [] });
  await recordProvenance(db.client, { activityId: "act-1", sourceId: "s", pageUrl: "p1", incomingId: null, relation: "seen", urlRole: "detail" });
  await recordProvenance(db.client, { activityId: "act-1", sourceId: "s", pageUrl: "p2", incomingId: null, relation: "seen", urlRole: "listing" });
  const [c, u] = db.tables.activity_sources;
  assertEquals([c.relation, c.url_role, c.first_seen_at], ["created", "listing", "2026-01-01"]);
  assertEquals([u.relation, u.url_role, u.first_seen_at], ["seen", "listing", "2026-01-01"]);
});

Deno.test("recordProvenance (preserveRelation): existing relation kept, new page inserted once as 'seen'", async () => {
  const db = fakeDb({ activity_sources: [{ id: "u", activity_id: "act-1", page_url: "p2", relation: "updated", url_role: "listing", first_seen_at: "2026-01-01" }], activities: [] });
  await recordProvenance(db.client, { activityId: "act-1", sourceId: "s", pageUrl: "p2", incomingId: "i", relation: "seen", urlRole: "listing", preserveRelation: true });
  await recordProvenance(db.client, { activityId: "act-1", sourceId: "s", pageUrl: "p3", incomingId: "i", relation: "seen", urlRole: "listing", preserveRelation: true });
  await recordProvenance(db.client, { activityId: "act-1", sourceId: "s", pageUrl: "p3", incomingId: "i", relation: "seen", urlRole: "listing", preserveRelation: true });
  assertEquals(db.tables.activity_sources.find((r) => r.id === "u")!.relation, "updated");
  assertEquals(db.tables.activity_sources.filter((r) => r.page_url === "p3").length, 1);
});
