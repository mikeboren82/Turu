// 🎲 Result Diversity (2026-09-25) - "Result Diversity / Playground Saturation" task. Pure,
// React-free product/presentation logic: reduces one abundant category (mainly גן שעשועים, ~87% of
// the whole approved catalog - measured live against production data, see the final report) from
// dominating the first screenful of a BROAD, no-explicit-intent browse, WITHOUT touching
// lib/filterActivities.js's ranking/scoring at all. This never reorders when the user asked for
// something specific (a category, a free-text search, an explicit distance sort) - see
// isBroadDiscovery below - and never discards, duplicates, or shuffles an activity.

// EXPLICIT INTENT (bypass diversity) vs BROAD DISCOVERY - deterministic, from `filters` alone:
//   - filters.category non-empty: the user picked a category (QuickPicker/FiltersSheet/a discovery
//     tile via navigateToCategoryResults, app/index.js).
//   - filters.q non-empty: a free-text search is itself a specific ask, not generic browsing -
//     lib/smartSearch.js#intentToFilters already promotes a resolved category into filters.category
//     when the AI/alias layer recognizes one, so this only remains for whatever residual text stays
//     in q (deriveTextQuery, lib/searchIntent.js) - still a deliberate query, not idle browsing.
//   - filters.categoryAliasPhrases non-empty: a category CONCEPT was recognized in free text even
//     when the exact stored category didn't match (lib/categorySemantics.js's soft-recall channel) -
//     also a specific ask, not broad browsing.
// Everything else - Home CTA with no category, "מה קרוב?" (goNearMe: category always []), a plain
// location-only browse, Advanced Filters with age/price/etc but no category - is broad discovery.
export function isBroadDiscovery(filters) {
  if (!filters) return true;
  if (filters.category?.length) return false;
  if ((filters.q || '').trim()) return false;
  if (filters.categoryAliasPhrases?.length) return false;
  return true;
}

// The diversity key: the same canonical category the app already filters/displays by, falling back
// to entity_type only for the rare row with no category at all - never a coarser/fuzzier grouping
// (no substring/keyword collapsing, same "exact concepts stay distinct" principle as this task's
// sibling placeholder-mapping fix, lib/placeholderImages.js).
function diversityKey(activity) {
  return activity?.category || activity?.entity_type || null;
}

// DEFAULT_MAX_CONSECUTIVE=2 and DEFAULT_LOOKAHEAD=6 were chosen against real catalog behaviour, not
// picked in the abstract (see the final report's "before/after" section for the actual numbers):
//   - Tel-Aviv-density areas rarely hit even 2 consecutive playgrounds in the raw ranked order
//     already (plenty of other categories are geographically close too) - this rule is close to a
//     no-op there, which is correct: nothing to fix.
//   - Playground-dominated areas (measured: Haifa/Beer Sheva top-10 by distance = 10/10 playgrounds;
//     Netanya top-10 = 7/10, one run of 5 in a row) are exactly where 2-in-a-row triggers a search
//     for an alternative.
//   - The lookahead window is deliberately SMALL and never grows to "search the whole list": in an
//     already-ranked array, an item 6 positions away is still a reasonably relevant candidate for
//     this same broad query, whereas reaching to position 200 to manufacture variety could promote
//     something far less relevant than what it displaces (task section 8: never leapfrog a
//     dramatically better match just for variety). This is the whole mechanism for "diversify only
//     among reasonably relevant candidates" - no numeric score is available this far down the
//     pipeline (rankActivities discards it after sorting), so bounding *how far forward* a
//     replacement may come from stands in for a relevance-gap check without needing the real score.
const DEFAULT_MAX_CONSECUTIVE = 2;
const DEFAULT_LOOKAHEAD = 6;

// Preserves the ranked order as the base priority; when the same category would appear more than
// `maxConsecutive` times in a row, pulls the NEAREST later item (within `lookahead` positions) of a
// different category forward to break the run. Every item skipped over stays in the list, in its
// same relative order, and surfaces later exactly where it would have anyway - nothing is dropped,
// duplicated, or randomized, and the head of the list (the single best match) is never touched: the
// very first item can never already be "at the consecutive limit" before it is even placed.
// If no different-category candidate exists within the window (e.g. only one category is available
// at all, regression case E), the run continues honestly - this never invents variety that is not
// actually there.
export function diversifyResults(activities, { maxConsecutive = DEFAULT_MAX_CONSECUTIVE, lookahead = DEFAULT_LOOKAHEAD } = {}) {
  if (!activities || activities.length <= maxConsecutive) return activities;
  const remaining = activities.slice();
  const result = [];
  let lastKey = null;
  let streak = 0;
  while (remaining.length) {
    const head = remaining[0];
    const headKey = diversityKey(head);
    if (headKey != null && headKey === lastKey && streak >= maxConsecutive) {
      // `lookahead` positions AHEAD of head (remaining[0] itself is the repeat, not part of the
      // reach) - remaining[1..lookahead] inclusive, hence windowEnd = lookahead + 1 as the exclusive
      // loop bound below.
      const windowEnd = Math.min(remaining.length, lookahead + 1);
      let swapAt = -1;
      for (let i = 1; i < windowEnd; i += 1) {
        if (diversityKey(remaining[i]) !== lastKey) { swapAt = i; break; }
      }
      if (swapAt === -1) {
        // No alternative within reach - take the honest next item rather than reaching further.
        result.push(remaining.shift());
        streak += 1;
      } else {
        const [promoted] = remaining.splice(swapAt, 1);
        result.push(promoted);
        lastKey = diversityKey(promoted);
        streak = 1;
      }
    } else {
      result.push(remaining.shift());
      streak = headKey === lastKey ? streak + 1 : 1;
      lastKey = headKey;
    }
  }
  return result;
}
