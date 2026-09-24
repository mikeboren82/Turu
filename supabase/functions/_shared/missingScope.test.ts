import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decideMissing, applyMissingAccounting, scopeKey, normalizeForPresence, type PageScope, type ScopeActivity } from "./missingScope.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
function fakeDb(init: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = structuredClone(init);
  const from = (table: string) => {
    const q = { op: "select", patch: null as Row | null, f: [] as [string, unknown, string][], ret: false };
    const match = (r: Row) => q.f.every(([k, v, kind]) => kind === "eq" ? r[k] === v : kind === "in" ? (v as unknown[]).includes(r[k]) : (r[k] ?? null) === v);
    const run = () => {
      const hit = (tables[table] ||= []).filter(match);
      if (q.op === "update") { for (const r of hit) Object.assign(r, q.patch); return { data: q.ret ? hit.map((r) => ({ ...r })) : null, error: null }; }
      return { data: hit.map((r) => ({ ...r })), error: null };
    };
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() { if (q.op !== "select") q.ret = true; return b; },
      update(p: Row) { q.op = "update"; q.patch = p; return b; },
      eq(k: string, v: unknown) { q.f.push([k, v, "eq"]); return b; }, in(k: string, v: unknown[]) { q.f.push([k, v, "in"]); return b; },
      is(k: string, v: unknown) { q.f.push([k, v, "is"]); return b; },
      then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  };
  return { client: { from }, tables };
}

const CAL = "https://www.holon.muni.il/Havingfun/pages/allevents.aspx";
const KEY = scopeKey(CAL);
const act = (over: Partial<ScopeActivity> = {}): ScopeActivity => ({ id: "a", name: "ילדי בית העץ", consecutive_missing_scans: 0, rows: [{ page_url: `${CAL}#part=4`, key: KEY }], ...over });
const scope = (over: Partial<PageScope> = {}): PageScope => ({ complete: true, changedProcessed: true, text: normalizeForPresence("לוח אירועים גוליבר 10:00"), ...over });
const one = (k: string, s: PageScope) => new Map([[k, s]]);

Deno.test("scopeKey: relay parts and seed case variants are one listing page", () => {
  assertEquals(scopeKey(`${CAL}#part=4`), scopeKey("https://holon.muni.il/Havingfun/Pages/AllEvents.aspx#part=2"));
  assertEquals(scopeKey(`${CAL}#part=4`), KEY);
});

Deno.test("decideMissing: the matrix", () => {
  const present = scope({ text: normalizeForPresence("... ילדי בית העץ 10:30 ...") });
  assertEquals(decideMissing(act(), one(KEY, present), false).action, "seen_on_page");
  assertEquals(decideMissing(act(), one(KEY, { ...present, changedProcessed: false }), false).action, "seen_on_page"); // unchanged page
  assertEquals(decideMissing(act(), one(KEY, scope()), true).action, "seen_matched");
  assertEquals(decideMissing(act(), one(KEY, scope()), false).action, "absent"); // changed, fully processed, gone
  assertEquals(decideMissing(act(), one(KEY, scope({ changedProcessed: false })), false).reason, "unchanged_no_new_evidence");
  assertEquals(decideMissing(act(), one(KEY, scope({ complete: false })), false).reason, "scope_incomplete"); // deferred / cut / AI error
  assertEquals(decideMissing(act(), one("other.page/x", scope()), false).reason, "scope_not_checked"); // unrelated page / batch
  assertEquals(decideMissing(act({ rows: [] }), one(KEY, scope()), false).reason, "no_listing_provenance");
  assertEquals(decideMissing(act({ rows: [...act().rows, { page_url: "https://x.il/b", key: "x.il/b" }] }), one(KEY, scope()), false).reason, "scope_not_checked");
  assertEquals(decideMissing(act({ name: "יוגה" }), one(KEY, scope({ text: "יוגה לגיל הרך" })), false).action, "seen_on_page");
  assertEquals(decideMissing(act({ name: "אב" }), one(KEY, scope({ text: "אב ובן" })), false).action, "present_short_name");
});

const a08World = () => fakeDb({
  activities: [
    { id: "a08", name: "ילדי בית העץ", source_id: "holon", status: "approved", consecutive_missing_scans: 21, last_seen_at: "2026-09-13T18:25:09Z" },
    { id: "gone", name: "הצגה שירדה מהלוח", source_id: "holon", status: "approved", consecutive_missing_scans: null, last_seen_at: "2026-09-13T00:00:00Z" },
    { id: "legacy", name: "פעילות ישנה", source_id: "holon", status: "approved", consecutive_missing_scans: 4, last_seen_at: "2026-09-01T00:00:00Z" },
  ],
  activity_sources: [
    { activity_id: "a08", source_id: "holon", page_url: `${CAL}#part=4`, url_role: null, relation: "created", last_seen_at: "2026-09-13T16:53:54Z" },
    { activity_id: "a08", source_id: "holon", page_url: "https://www.holon.muni.il/Havingfun/Pages/AllEvents.aspx#part=4", url_role: null, relation: "updated", last_seen_at: "2026-09-13T18:25:09Z" },
    { activity_id: "gone", source_id: "holon", page_url: `${CAL}#part=1`, url_role: "listing", relation: "created", last_seen_at: "2026-09-13T00:00:00Z" },
    { activity_id: "legacy", source_id: "holon", page_url: "https://www.holon.muni.il/e/77", url_role: "detail", relation: "seen", last_seen_at: "2026-09-01T00:00:00Z" },
  ],
});
const pageText = "לוח אירועים\n---\nגוליבר 10:00-11:00\n---\nילדי בית העץ 10:30-11:40";

Deno.test("a08ab845 REGRESSION: its page is unchanged (no extraction) - the counter must not grow; it is seen on the page", async () => {
  const db = a08World();
  const { summary } = await applyMissingAccounting(db.client, { sourceId: "holon", scopes: one(KEY, { complete: true, changedProcessed: false, text: pageText }), matchedIds: new Set(), threshold: 3 });
  const a = db.tables.activities.find((x) => x.id === "a08")!;
  assertEquals(a.consecutive_missing_scans, 0);
  assert(a.last_seen_at > "2026-09-24");
  const rows = db.tables.activity_sources.filter((r) => r.activity_id === "a08");
  assert(rows.every((r) => r.last_seen_at > "2026-09-24"));
  assertEquals(rows.map((r) => r.relation), ["created", "updated"]); // relation untouched
  assertEquals(db.tables.activities.find((x) => x.id === "gone")!.consecutive_missing_scans, null); // unchanged page: no new evidence
  assertEquals(db.tables.activities.find((x) => x.id === "legacy")!.consecutive_missing_scans, 4); // detail-only provenance
  assertEquals([summary.seen_on_page, summary.absent, summary.skipped.unchanged_no_new_evidence, summary.skipped.no_listing_provenance], [1, 0, 1, 1]);
});

Deno.test("TRUE REMOVAL: changed + fully processed page without the activity -> exactly one increment", async () => {
  const db = a08World();
  const { summary } = await applyMissingAccounting(db.client, { sourceId: "holon", scopes: one(KEY, { complete: true, changedProcessed: true, text: pageText }), matchedIds: new Set(), threshold: 3 });
  assertEquals(db.tables.activities.find((x) => x.id === "gone")!.consecutive_missing_scans, 1);
  assertEquals(db.tables.activities.find((x) => x.id === "a08")!.consecutive_missing_scans, 0);
  assertEquals(summary.absent, 1);
});

Deno.test("FALSE-MISSING guards: incomplete (deferred / truncated / AI error) or unchecked pages never increment", async () => {
  for (const scopes of [one(KEY, { complete: false, changedProcessed: true, text: pageText }), one(KEY, { complete: false, changedProcessed: false, text: pageText }), one("other.site/p", { complete: true, changedProcessed: true, text: "x" }), new Map<string, PageScope>()]) {
    const db = a08World();
    await applyMissingAccounting(db.client, { sourceId: "holon", scopes, matchedIds: new Set(), threshold: 3 });
    assertEquals(db.tables.activities.find((x) => x.id === "gone")!.consecutive_missing_scans, null);
  }
});

Deno.test("matched / pending-review-reconfirmed activity is left to the match path (no write here)", async () => {
  const db = a08World();
  await applyMissingAccounting(db.client, { sourceId: "holon", scopes: one(KEY, { complete: true, changedProcessed: true, text: "ריק" }), matchedIds: new Set(["gone", "a08"]), threshold: 3 });
  assertEquals(db.tables.activities.find((x) => x.id === "gone")!.consecutive_missing_scans, null);
  assertEquals(db.tables.activities.find((x) => x.id === "a08")!.consecutive_missing_scans, 21);
});
