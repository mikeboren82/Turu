// TuRu - place-photo endpoint hardening (2026-09-27). Google and the database are mocked: no network, no writes.
// Run with the _shared gate: `npx deno test supabase/functions/_shared/`.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BoundedTtlCache, clientIpKey, createPlacePhotoHandler, extractPlaceId, isValidPlaceId, placeGoogleMapsUrl,
  servingDisabled, shapeAuthorAttributions, supabaseDbGuards, TokenBucketLimiter, type RateLimitOptions, type SelectOnlyClient,
} from "./placePhoto.ts";

const KEY = "AIzaSyTEST-SECRET-KEY-0123456789abcdef";
const PID = "ChIJN1t_tDeuEmsRUsoyG83frY4"; // 27 chars, the only length in production
const ARCHIVED_PID = "ChIJArchivedOnly_000000000";
const UNKNOWN_PID = "ChIJUnknownPlace_000000000";
const BASE = "https://proj.supabase.co/functions/v1/place-photo";
const PHOTO_NAME = `places/${PID}/photos/AUc7tXVSYNTHETIC_photo-ref`;
const PHOTO_URI = "https://lh3.googleusercontent.com/places/ANXAkqSYNTHETIC=s1200";
const ATTRIB = [{ displayName: "Dana Levi", uri: "https://maps.google.com/maps/contrib/1", photoUri: "https://lh3.googleusercontent.com/a/x" }];

// ---------------------------------------------------------------- fakes

type Row = Record<string, unknown>;
// A recording supabase-js stand-in: EVERY method invoked on the client or a query builder is recorded by name, so a
// write path (insert/update/upsert/delete/rpc/...) cannot hide. Only select/eq/limit are implemented.
function recordingClient(tables: Record<string, Row[]>, opts: { fail?: boolean } = {}) {
  const calls: string[] = [];
  const tablesTouched: string[] = [];
  function builder(table: string) {
    const filters: [string, unknown][] = [];
    let limit = Infinity;
    const target: Record<string, unknown> = {
      select: () => proxy,
      eq: (col: string, val: unknown) => { filters.push([col, val]); return proxy; },
      limit: (n: number) => { limit = n; return proxy; },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        if (opts.fail) return Promise.resolve({ data: null, error: { message: "db down" } }).then(res, rej);
        const data = (tables[table] || []).filter((r) => filters.every(([c, v]) => r[c] === v)).slice(0, limit);
        return Promise.resolve({ data, error: null }).then(res, rej);
      },
    };
    const proxy: unknown = new Proxy(target, {
      get(t, prop) {
        if (typeof prop === "string" && prop !== "then") calls.push(prop);
        if (prop in t) return t[prop as string];
        return () => { throw new Error(`unexpected query-builder method ${String(prop)}`); };
      },
    });
    return proxy;
  }
  const client = new Proxy({} as SelectOnlyClient, {
    get(_t, prop) {
      calls.push(String(prop));
      if (prop === "from") return (table: string) => { tablesTouched.push(table); return builder(table); };
      return () => { throw new Error(`unexpected client method ${String(prop)}`); };
    },
  });
  return { client, calls, tablesTouched };
}

const CATALOGUE: Row[] = [
  { id: "a1", google_place_id: PID, status: "approved" },
  { id: "a2", google_place_id: PID, status: "archived" },
  { id: "a3", google_place_id: ARCHIVED_PID, status: "archived" },
  { id: "a4", google_place_id: ARCHIVED_PID, status: "rejected" },
  { id: "a5", google_place_id: ARCHIVED_PID, status: "pending" },
];

interface FetchCall { url: string; method: string; headers: Record<string, string> }
function fakeGoogle(opts: {
  photos?: unknown; detailsStatus?: number; mediaStatus?: number; mediaBody?: unknown; throwWith?: string; errorBody?: string;
} = {}) {
  const calls: FetchCall[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, method: init?.method || "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (opts.throwWith) return Promise.reject(new TypeError(opts.throwWith));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (/\/v1\/places\/[^/]+$/.test(new URL(url).pathname)) {
      if (opts.detailsStatus && opts.detailsStatus >= 400) return Promise.resolve(new Response(opts.errorBody ?? "", { status: opts.detailsStatus }));
      const photos = "photos" in opts ? opts.photos : [{ name: PHOTO_NAME, widthPx: 4032, heightPx: 3024, authorAttributions: ATTRIB, googleMapsUri: "https://maps.google.com/maps/place//data=photo" }];
      return Promise.resolve(json(photos === undefined ? {} : { photos }));
    }
    if (url.includes("/media?")) {
      if (opts.mediaStatus && opts.mediaStatus >= 400) return Promise.resolve(new Response(opts.errorBody ?? "", { status: opts.mediaStatus }));
      return Promise.resolve(json(opts.mediaBody ?? { name: `${PHOTO_NAME}/media`, photoUri: PHOTO_URI }));
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };
  return { fetch: fn as typeof fetch, calls };
}

function setup(o: {
  flag?: unknown; noFlagRow?: boolean; google?: Parameters<typeof fakeGoogle>[0]; dbFail?: boolean; rateLimit?: RateLimitOptions;
  apiKey?: string | undefined; clock?: { t: number };
} = {}) {
  const settings = o.noFlagRow || !("flag" in o) ? [] : [{ key: "place_photo_serving_enabled", value: o.flag }];
  const db = recordingClient({ activities: CATALOGUE, automation_settings: settings }, { fail: o.dbFail });
  const g = fakeGoogle(o.google);
  const logs: string[] = [];
  const clock = o.clock ?? { t: 1_000_000 };
  const handle = createPlacePhotoHandler({
    fetch: g.fetch,
    getApiKey: () => ("apiKey" in o ? o.apiKey : KEY),
    db: supabaseDbGuards(() => db.client),
    now: () => clock.t,
    log: (m) => logs.push(m),
    rateLimit: o.rateLimit,
  });
  return { handle, db, g, logs, clock };
}
const get = (path: string, headers: Record<string, string> = {}) => new Request(`${BASE}/${path}`, { headers: { "x-forwarded-for": "203.0.113.7", ...headers } });
async function everything(res: Response): Promise<string> {
  return JSON.stringify([...res.headers.entries()]) + (await res.text());
}

// ---------------------------------------------------------------- place-id validation

Deno.test("place id: strict bounded format", () => {
  assert(isValidPlaceId(PID), "typical ChIJ id");
  assert(isValidPlaceId("a".repeat(20)) && isValidPlaceId("a".repeat(300)), "bounds inclusive");
  assert(isValidPlaceId("GhIJQWDl0CIeQUARxks3icF8U8A"), "non-ChIJ id with _ / - allowed");
  for (const bad of ["", "a".repeat(19), "a".repeat(301), "ChIJN1t tDeuEmsRUsoyG83frY4", "ChIJN1t/tDeuEmsRUsoyG83frY4",
    "ChIJN1t_tDeuEmsRUsoyG83frY4?x", "ChIJN1t_tDeuEmsRUsoyG83frY4\n", "ChIJN1t_tDeuEmsRUsoyG83frY4\u0000",
    "ChIJN1t%20tDeuEmsRUsoyG83frY4", "ChIJN1t.tDeuEmsRUsoyG83frY4", "ChIJN1t_tDeuEmsRUsoyG83frY4#", "..%2F..%2Fplaces%2Fx"]) {
    assert(!isValidPlaceId(bad), `rejects ${JSON.stringify(bad)}`);
  }
  assert(!isValidPlaceId(undefined) && !isValidPlaceId(null));
});

Deno.test("place id: extracted from the single segment after place-photo", () => {
  assertEquals(extractPlaceId(`/place-photo/${PID}`), PID);
  assertEquals(extractPlaceId(`/functions/v1/place-photo/${PID}/`), PID, "trailing slash tolerated (as before)");
  assertEquals(extractPlaceId("/place-photo"), null, "empty id");
  assertEquals(extractPlaceId("/place-photo/"), null, "empty id with slash");
  assertEquals(extractPlaceId(`/place-photo/${PID}/extra`), null, "slash inside the id");
});

Deno.test("B: malformed ids are 400 with 0 Google calls and 0 DB reads", async () => {
  const s = setup();
  for (const path of ["", "short", "a".repeat(301), "ChIJN1t%20tDeuEmsRUsoyG83frY4", `ChIJN1t/tDeuEmsRUsoyG83frY4`,
    "ChIJN1t_tDeuEmsRUsoyG83frY4%0A", "ChIJN1t_tDeuEmsRUsoyG83frY4%00", "ChIJN1t_tDeuEmsRUsoyG83frY4%3Fkey%3Dx", "%2E%2E%2F%2E%2E%2Fx"]) {
    const res = await s.handle(get(path));
    assertEquals(res.status, 400, path);
    assertEquals(await res.json(), { error: "invalid_place_id" });
  }
  assertEquals(s.g.calls.length, 0);
  assertEquals(s.db.tablesTouched.length, 0);
});

Deno.test("unknown format is 400 before any lookup", async () => {
  const s = setup();
  const res = await s.handle(get(`${PID}?format=xml`));
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "unsupported_format" });
  assertEquals(s.g.calls.length + s.db.tablesTouched.length, 0);
});

// ---------------------------------------------------------------- allow-list

Deno.test("A + G: valid + approved + serving (flag absent) -> 302 to Google's photo URI (redirect contract)", async () => {
  const s = setup();
  const res = await s.handle(get(`${PID}?maxwidth=800`));
  assertEquals(res.status, 302);
  assertEquals(res.headers.get("location"), PHOTO_URI);
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertEquals(s.g.calls.length, 2, "details + media");
  assertEquals(s.g.calls[0].url, `https://places.googleapis.com/v1/places/${PID}`);
  assertEquals(s.g.calls[0].headers["x-goog-fieldmask"], "photos", "same field mask as before - no SKU change");
  assertEquals(s.g.calls[1].url, `https://places.googleapis.com/v1/${PHOTO_NAME}/media?maxWidthPx=800&skipHttpRedirect=true`);
  assertEquals(await res.text(), "");
});

Deno.test("G: default maxwidth and clamping are unchanged", async () => {
  for (const [q, want] of [["", 1200], ["?maxwidth=5000", 1600], ["?maxwidth=10", 100], ["?maxwidth=abc", 1200]] as const) {
    const s = setup();
    await s.handle(get(`${PID}${q}`));
    assert(s.g.calls[1].url.includes(`maxWidthPx=${want}&`), `${q} -> ${want}`);
  }
});

Deno.test("C: valid id with no approved activity -> 404 place_not_listed, 0 Google calls", async () => {
  const s = setup();
  const res = await s.handle(get(UNKNOWN_PID));
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "place_not_listed" });
  assertEquals(s.g.calls.length, 0);
});

Deno.test("D: place id only on archived/rejected/pending activities -> refused, 0 Google calls", async () => {
  const s = setup();
  const res = await s.handle(get(ARCHIVED_PID));
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "place_not_listed" });
  assertEquals(s.g.calls.length, 0);
});

Deno.test("allow-list query is activities.google_place_id = id AND status = 'approved'", async () => {
  const db = recordingClient({ activities: CATALOGUE });
  const guards = supabaseDbGuards(() => db.client);
  assertEquals(await guards.isApprovedPlaceId(PID), { ok: true, value: true });
  assertEquals(await guards.isApprovedPlaceId(ARCHIVED_PID), { ok: true, value: false });
  assertEquals(db.tablesTouched, ["activities", "activities"]);
  assertEquals(await supabaseDbGuards(() => null).isApprovedPlaceId(PID), { ok: false }, "no client -> unknown");
});

Deno.test("DB unavailable -> 503 service_unavailable, fail closed, 0 Google calls", async () => {
  const s = setup({ dbFail: true });
  const res = await s.handle(get(PID));
  assertEquals(res.status, 503);
  assertEquals(await res.json(), { error: "service_unavailable" });
  assertEquals(s.g.calls.length, 0);
});

// ---------------------------------------------------------------- memoization

Deno.test("memo: positive and negative allow-list answers are reused briefly, then re-read", async () => {
  const s = setup();
  await s.handle(get(PID));
  await s.handle(get(PID));
  await s.handle(get(UNKNOWN_PID));
  await s.handle(get(UNKNOWN_PID));
  const actReads = () => s.db.tablesTouched.filter((t) => t === "activities").length;
  assertEquals(actReads(), 2, "one read per id");
  assertEquals(s.db.tablesTouched.filter((t) => t === "automation_settings").length, 1, "flag read once per 30 s");
  s.clock.t += 61_000; // negative TTL 60 s, positive 5 min
  await s.handle(get(PID));
  await s.handle(get(UNKNOWN_PID));
  assertEquals(actReads(), 3, "negative expired, positive still cached");
  s.clock.t += 5 * 60_000;
  await s.handle(get(PID));
  assertEquals(actReads(), 4, "positive expired");
  assertEquals(s.g.calls.length, 8, "Google photo metadata is NEVER cached: 4 served requests x 2 calls");
});

Deno.test("memo: bounded - oldest / expired entries are evicted at the cap", () => {
  const c = new BoundedTtlCache<boolean>(3);
  c.set("a", true, 1000, 0); c.set("b", true, 1000, 0); c.set("c", true, 1000, 0); c.set("d", true, 1000, 0);
  assertEquals(c.size, 3);
  assertEquals(c.get("a", 1), undefined, "oldest evicted");
  assertEquals(c.get("d", 1), true);
  assertEquals(c.get("d", 1000), undefined, "expired at TTL");
});

// ---------------------------------------------------------------- kill flag

Deno.test("E: explicit false kill flag -> 503 service_disabled, 0 Google calls, 0 allow-list reads", async () => {
  for (const flag of [false, "false", "FALSE"]) {
    const s = setup({ flag });
    const res = await s.handle(get(PID));
    assertEquals(res.status, 503, String(flag));
    assertEquals(await res.json(), { error: "service_disabled" });
    assertEquals(s.g.calls.length, 0);
    assert(!s.db.tablesTouched.includes("activities"));
  }
});

Deno.test("kill flag semantics: only explicit false disables; absent / true / other values serve", async () => {
  assert(servingDisabled(false) && servingDisabled("false") && servingDisabled(" False "));
  for (const v of [null, undefined, true, "true", 0, "0", "off", {}, []]) assert(!servingDisabled(v), JSON.stringify(v));
  for (const o of [{ noFlagRow: true }, { flag: true }]) {
    const s = setup(o);
    assertEquals((await s.handle(get(PID))).status, 302, JSON.stringify(o));
  }
});

Deno.test("kill flag takes effect within the 30 s flag memo", async () => {
  const clock = { t: 0 };
  const settings: Row[] = [];
  const db = recordingClient({ activities: CATALOGUE, automation_settings: settings });
  const g = fakeGoogle();
  const handle = createPlacePhotoHandler({ fetch: g.fetch, getApiKey: () => KEY, db: supabaseDbGuards(() => db.client), now: () => clock.t, log: () => {} });
  assertEquals((await handle(get(PID))).status, 302);
  settings.push({ key: "place_photo_serving_enabled", value: false });
  clock.t += 31_000;
  assertEquals((await handle(get(PID))).status, 503);
});

// ---------------------------------------------------------------- rate limit

Deno.test("F: per-IP bucket exceeded -> 429 with Retry-After, 0 Google calls for the refused request", async () => {
  const s = setup({ rateLimit: { capacity: 3, refillPerSec: 1, maxKeys: 100 } });
  for (let i = 0; i < 3; i++) assertEquals((await s.handle(get(PID))).status, 302);
  const googleBefore = s.g.calls.length;
  const dbBefore = s.db.tablesTouched.length;
  const res = await s.handle(get(PID));
  assertEquals(res.status, 429);
  assertEquals(await res.json(), { error: "rate_limited" });
  assertEquals(res.headers.get("retry-after"), "1");
  assertEquals(s.g.calls.length, googleBefore, "no Google call");
  assertEquals(s.db.tablesTouched.length, dbBefore, "no DB read");
  assertEquals((await s.handle(get(PID, { "x-forwarded-for": "198.51.100.9" }))).status, 302, "other IP unaffected");
  s.clock.t += 1000;
  assertEquals((await s.handle(get(PID))).status, 302, "refilled after 1 s");
});

Deno.test("rate limiter: bounded key map with predictable expiry", () => {
  const l = new TokenBucketLimiter({ capacity: 2, refillPerSec: 1, maxKeys: 3 });
  for (const k of ["a", "b", "c", "d"]) l.take(k, 0);
  assertEquals(l.size, 3, "capped");
  l.take("a", 0); l.take("a", 0);
  assertEquals(l.take("a", 0).ok, false);
  assertEquals(l.take("a", 2000).ok, true, "full again after capacity/refill seconds");
});

Deno.test("client IP: rightmost public X-Forwarded-For hop; spoofed left entries ignored", () => {
  const h = (xff?: string, real?: string) => {
    const x = new Headers();
    if (xff !== undefined) x.set("x-forwarded-for", xff);
    if (real !== undefined) x.set("x-real-ip", real);
    return x;
  };
  assertEquals(clientIpKey(h("203.0.113.7")), "203.0.113.7");
  assertEquals(clientIpKey(h("1.2.3.4, 5.6.7.8, 203.0.113.7")), "203.0.113.7", "attacker-prepended entries don't rotate the key");
  assertEquals(clientIpKey(h("203.0.113.7, 10.0.0.5, 172.16.3.1")), "203.0.113.7", "internal hops skipped");
  assertEquals(clientIpKey(h("2001:db8::1")), "2001:db8::1");
  assertEquals(clientIpKey(h("garbage, 203.0.113.7")), "203.0.113.7");
  assertEquals(clientIpKey(h("203.0.113.9, not-an-ip")), "unknown", "an unparsable last hop stops the walk");
  assertEquals(clientIpKey(h(undefined, "198.51.100.2")), "198.51.100.2");
  assertEquals(clientIpKey(h()), "unknown");
  assertEquals(clientIpKey(h("999.1.1.1")), "unknown");
});

// ---------------------------------------------------------------- JSON mode

Deno.test("H + I + J: JSON mode returns the live attribution structure, no-store, CORS", async () => {
  const s = setup();
  const res = await s.handle(get(`${PID}?format=json&maxwidth=600`));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "application/json; charset=utf-8");
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assertEquals(await res.json(), {
    photoUri: PHOTO_URI,
    widthPx: 4032,
    heightPx: 3024,
    authorAttributions: ATTRIB,
    photoGoogleMapsUri: "https://maps.google.com/maps/place//data=photo",
    placeGoogleMapsUrl: `https://www.google.com/maps/place/?q=place_id:${PID}`,
  });
  assertEquals(placeGoogleMapsUrl(PID), `https://www.google.com/maps/place/?q=place_id:${PID}`);
});

Deno.test("J: CORS preflight (OPTIONS) is 204 with methods/headers, no lookups", async () => {
  const s = setup();
  const res = await s.handle(new Request(`${BASE}/${PID}?format=json`, { method: "OPTIONS", headers: { origin: "https://turu.example", "access-control-request-headers": "authorization, apikey" } }));
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assertEquals(res.headers.get("access-control-allow-methods"), "GET, OPTIONS");
  assert(res.headers.get("access-control-allow-headers")!.includes("authorization"));
  assert(res.headers.get("access-control-allow-headers")!.includes("apikey"));
  assertEquals(s.g.calls.length + s.db.tablesTouched.length, 0);
  assertEquals((await s.handle(new Request(`${BASE}/${PID}`, { method: "POST" }))).status, 405);
});

Deno.test("K: missing / garbled author attribution -> [] (never invented)", async () => {
  for (const authorAttributions of [undefined, null, [], "x", [{ uri: "https://x" }], [null]]) {
    const s = setup({ google: { photos: [{ name: PHOTO_NAME, widthPx: 10, heightPx: 10, authorAttributions }] } });
    const body = await (await s.handle(get(`${PID}?format=json`))).json();
    assertEquals(body.authorAttributions, [], JSON.stringify(authorAttributions));
    assertEquals(body.photoGoogleMapsUri, null);
  }
  assertEquals(shapeAuthorAttributions([{ displayName: "A", uri: "javascript:alert(1)", photoUri: "http://x" }]),
    [{ displayName: "A", uri: null, photoUri: null }], "non-https links dropped, name kept");
});

Deno.test("no photo on the place -> 404 no_photo (both modes)", async () => {
  for (const photos of [undefined, [], [{}], [{ name: "../../evil" }]]) {
    const s = setup({ google: { photos } });
    const res = await s.handle(get(`${PID}?format=json`));
    assertEquals(res.status, 404, JSON.stringify(photos));
    assertEquals(await res.json(), { error: "no_photo" });
    assertEquals(s.g.calls.length, 1, "media never requested");
  }
});

// ---------------------------------------------------------------- upstream errors + key safety

Deno.test("L: upstream failures are stable codes and never expose the API key", async () => {
  const leaky = `{"error":{"message":"API key ${KEY} not valid","details":"internal stack"}}`;
  const cases: [Parameters<typeof fakeGoogle>[0], number, string][] = [
    [{ detailsStatus: 403, errorBody: leaky }, 502, "upstream_error"],
    [{ detailsStatus: 500, errorBody: leaky }, 502, "upstream_error"],
    [{ detailsStatus: 429, errorBody: leaky }, 503, "upstream_quota"],
    [{ mediaStatus: 400, errorBody: leaky }, 502, "upstream_error"],
    [{ throwWith: `error sending request for url (https://places.googleapis.com/v1/x?key=${KEY})` }, 502, "upstream_error"],
    [{ mediaBody: { photoUri: `https://lh3.googleusercontent.com/p?key=${KEY}` } }, 502, "upstream_error"],
    [{ mediaBody: { photoUri: "http://insecure.example/p" } }, 502, "upstream_error"],
    [{ mediaBody: {} }, 502, "upstream_error"],
  ];
  for (const fmt of ["", "?format=json"]) {
    for (const [google, status, code] of cases) {
      const s = setup({ google });
      const res = await s.handle(get(`${PID}${fmt}`));
      assertEquals(res.status, status, JSON.stringify(google));
      const all = await everything(res);
      assert(all.includes(`"error":"${code}"`), all);
      assert(!all.includes(KEY) && !all.includes("internal stack"), "no key / upstream body in response");
      assert(!s.logs.join("\n").includes(KEY), "no key in logs");
      assert(!s.logs.join("\n").includes("googleapis"), "no upstream URL in logs");
    }
  }
});

Deno.test("API key travels only in the X-Goog-Api-Key header, never in a URL / Location / body", async () => {
  for (const fmt of ["", "?format=json"]) {
    const s = setup();
    const res = await s.handle(get(`${PID}${fmt}`));
    assert(!(await everything(res)).includes(KEY));
    for (const c of s.g.calls) {
      assert(!c.url.includes(KEY) && !c.url.includes("key="), c.url);
      assertEquals(c.headers["x-goog-api-key"], KEY);
      assertEquals(c.method, "GET");
    }
  }
  const s = setup({ apiKey: undefined });
  const res = await s.handle(get(PID));
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: "misconfigured" });
  assertEquals(s.g.calls.length, 0);
});

// ---------------------------------------------------------------- no persistence

Deno.test("M: the handler performs no persistent write - only SELECTs on activities / automation_settings, only GETs to Google", async () => {
  const s = setup({ flag: true });
  for (const path of [PID, `${PID}?format=json`, UNKNOWN_PID, ARCHIVED_PID, "bad"]) await s.handle(get(path));
  assertEquals([...new Set(s.db.calls)].sort(), ["eq", "from", "limit", "select"]);
  assertEquals([...new Set(s.db.tablesTouched)].sort(), ["activities", "automation_settings"]);
  assert(s.g.calls.every((c) => c.method === "GET" && c.url.startsWith("https://places.googleapis.com/v1/")));

  // Static: neither the handler module nor the entrypoint has any write / storage path.
  for (const rel of ["./placePhoto.ts", "../place-photo/index.ts"]) {
    const src = await Deno.readTextFile(new URL(rel, import.meta.url));
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    for (const bad of [".insert(", ".upsert(", ".rpc(", "Deno.writeFile", "Deno.writeTextFile", "Deno.openKv", "caches.open", "localStorage", "storage.from("]) {
      assert(!code.includes(bad), `${rel} contains ${bad}`);
    }
    // .update( / .delete( on a query builder (Map.delete on the in-memory caches is fine)
    assert(!/\.from\([^)]*\)[\s\S]{0,200}?\.(update|delete)\(/.test(code), `${rel} has a query-builder update/delete`);
    assert(!/\.update\(/.test(code), `${rel} contains .update(`);
  }
});
