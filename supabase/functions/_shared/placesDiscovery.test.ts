// TuRu - MOCKED integration tests for fetchAllPaginatedResults (2026-09-12, requested during the
// batch-4 quality audit: "verify Google's own result pagination works, without spending real
// Google API budget just to test it"). Every test here injects a fake fetchPage - none of these
// tests make a real network call or cost anything. Run with `deno test supabase/functions/_shared/`.
//
// These are the exact behaviors requested to be proven:
//   - page 1 is processed
//   - nextPageToken is followed
//   - page 2 is processed, and its results enter the same array (same downstream pipeline) as
//     page 1's - nothing about a page-2 result is treated differently
//   - no duplicate processing (each page is fetched exactly once)
//   - a safe maximum page/request limit exists (does not loop forever on a token that never ends)
//   - an error/invalid token on a later page is handled safely - page 1's already-fetched, already
//     paid-for results are not thrown away

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fetchAllPaginatedResults, type PageFetchResult } from "./placesDiscovery.ts";

interface FakePlace { id: string; label: string }

Deno.test("page 1 alone (no nextPageToken) - the common case, most settlements", async () => {
  let calls = 0;
  const result = await fetchAllPaginatedResults<FakePlace>(
    async (_pageToken) => {
      calls++;
      return { places: [{ id: "p1", label: "a" }, { id: "p2", label: "b" }] };
    },
    { maxPages: 3, delayMs: 2000, sleep: async () => {} },
  );
  assertEquals(calls, 1, "should fetch exactly one page when no token is returned");
  assertEquals(result.pagesFetched, 1);
  assertEquals(result.places.length, 2);
  assertEquals(result.places.every((p) => p._page === 1), true);
});

Deno.test("realistic >20-result settlement: page 1 (20 results) + page 2 (1 result) via nextPageToken", async () => {
  // This is the exact scenario the old, un-paginated code silently lost: a dense settlement with
  // more real playgrounds than fit on one page. The 21st result ("the hidden one") must appear.
  const page1Places: FakePlace[] = Array.from({ length: 20 }, (_, i) => ({ id: `p${i + 1}`, label: `playground ${i + 1}` }));
  const hiddenResult: FakePlace = { id: "p21_hidden", label: "the one that would be missed pre-fix" };
  const fetchedTokens: (string | undefined)[] = [];

  const result = await fetchAllPaginatedResults<FakePlace>(
    async (pageToken) => {
      fetchedTokens.push(pageToken);
      if (pageToken === undefined) {
        return { places: page1Places, nextPageToken: "real_token_abc" };
      }
      if (pageToken === "real_token_abc") {
        return { places: [hiddenResult] }; // no further nextPageToken - this is the last page
      }
      throw new Error(`unexpected pageToken: ${pageToken}`);
    },
    { maxPages: 3, delayMs: 2000, sleep: async () => {} },
  );

  assertEquals(fetchedTokens, [undefined, "real_token_abc"], "page 1 requested with no token, page 2 requested with the real token from page 1's response");
  assertEquals(result.pagesFetched, 2, "both pages were processed");
  assertEquals(result.places.length, 21, "page 2's result entered the same array as page 1's - not dropped, not treated specially");
  assertEquals(result.places.some((p) => p.id === "p21_hidden"), true, "the result that pre-fix pagination would have missed is present");
  assertEquals(result.places.filter((p) => p._page === 1).length, 20);
  assertEquals(result.places.filter((p) => p._page === 2).length, 1);
  // no duplicate processing: every id appears exactly once across both pages
  const ids = result.places.map((p) => p.id);
  assertEquals(new Set(ids).size, ids.length, "no place appears twice across pages");
});

Deno.test("safe maximum page limit - a token that never ends does not loop forever", async () => {
  let calls = 0;
  const result = await fetchAllPaginatedResults<FakePlace>(
    async (_pageToken) => {
      calls++;
      // Deliberately hostile mock: always returns a token, as if Google never stopped paginating.
      return { places: [{ id: `p${calls}`, label: "endless" }], nextPageToken: "always_more" };
    },
    { maxPages: 3, delayMs: 2000, sleep: async () => {} },
  );
  assertEquals(calls, 3, "must stop at the configured maxPages, never fetch a 4th page");
  assertEquals(result.pagesFetched, 3);
  assertEquals(result.places.length, 3);
});

Deno.test("page 2 throws (invalid/expired token) - page 1's results are NOT lost", async () => {
  const page1Places: FakePlace[] = [{ id: "p1", label: "a" }, { id: "p2", label: "b" }];
  const result = await fetchAllPaginatedResults<FakePlace>(
    async (pageToken) => {
      if (pageToken === undefined) return { places: page1Places, nextPageToken: "bad_token" };
      throw new Error("INVALID_REQUEST: page token is no longer valid");
    },
    { maxPages: 3, delayMs: 2000, sleep: async () => {} },
  );
  // This is the fix made *during* writing this test: the pre-existing behavior before this test
  // was written would have propagated the page-2 exception and lost page 1's results entirely,
  // even though that page was already fetched and already billed.
  assertEquals(result.pagesFetched, 1, "only page 1 counts as successfully fetched");
  assertEquals(result.places.length, 2, "page 1's results survive a page-2 failure, not discarded");
});

Deno.test("page 1 itself throws - propagates (nothing to salvage, unlike a later-page failure)", async () => {
  let threw = false;
  try {
    await fetchAllPaginatedResults<FakePlace>(
      async (_pageToken) => {
        throw new Error("HTTP 500");
      },
      { maxPages: 3, delayMs: 2000, sleep: async () => {} },
    );
  } catch (err) {
    threw = true;
    assertEquals((err as Error).message, "HTTP 500");
  }
  assertEquals(threw, true, "a page-1 failure has nothing to return - it must propagate, same as before this change");
});

Deno.test("delay is only invoked between pages, never after the last page (no wasted wait)", async () => {
  let sleepCalls = 0;
  await fetchAllPaginatedResults<FakePlace>(
    async (pageToken) => {
      if (pageToken === undefined) return { places: [{ id: "p1", label: "a" }], nextPageToken: "tok" };
      return { places: [{ id: "p2", label: "b" }] }; // last page - no further token
    },
    { maxPages: 3, delayMs: 2000, sleep: async () => { sleepCalls++; } },
  );
  assertEquals(sleepCalls, 1, "sleeps once, between page 1 and page 2 - not after page 2, which was the last one");
});
