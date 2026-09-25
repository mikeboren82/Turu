// 🎲 Result Diversity - Phase 2 (2026-09-25). Pure, React-free product/presentation logic.
//
// COVERAGE-BIAS CORRECTION (Phase 2 finding, see the final report): גן שעשועים being ~87% of the
// approved catalog is a CURRENT-COVERAGE fact (a dedicated nationwide playground-discovery pass ran
// for over a week; comparable discovery has not run for most other categories) - it is NOT evidence
// that users prefer playgrounds 87% of the time. Nothing in this file may read or depend on that
// global catalog share, or any other catalog-wide statistic. Every decision below is computed purely
// from the CURRENT local ranked result set (its own score spread, its own category composition) and
// the caller's own filters - never from what the whole catalog looks like.
//
// PRODUCT GOAL (corrected from Phase 1's framing): not "every category represented equally," but
// "in a broad discovery feed, when several reasonably-ranked distinct options exist, don't
// unnecessarily show a monotonous wall of one category." If the local area genuinely only has
// playgrounds, or the only other options are dramatically weaker matches, showing playgrounds is
// correct, not a bug to paper over.
//
// PHASE 1 REGRESSION FOUND: a bounded-lookahead greedy swap fixed shallow (top-10) runs, but "spent"
// every nearby alternative on the FIRST run it could break, leaving nothing for later runs within the
// same broad prefix - Haifa top-20 max consecutive run went 10 -> 13 (measured with a naive
// distance-only proxy ranking, see the final report). A first Phase 2 redesign (batch-partition the
// whole prefix, then re-interleave alternatives at globally evenly-spaced target slots) was measured
// against the REAL production ranker (rankActivitiesWithSmartRadius, real scores) and rejected: it
// computed target slots from the TOTAL count of alternatives across the whole prefix, with no idea
// where an alternative already naturally sat - so it could (and did, e.g. Tel Aviv depth 8, Netanya
// depth 8/10) PUSH AN ALREADY-WELL-RANKED alternative LATER than its own original position, purely to
// hit a "nicer" global spacing target. That is strictly worse than doing nothing: it can turn a
// shallow view that was already fine into one that looks worse.
//
// Phase 2 (this version) keeps Phase 1's core mechanism - a left-to-right, greedy, run-breaking scan
// that only ever pulls a LATER item EARLIER, never the reverse - and adds exactly two things: a
// bounded prefix (nothing past it is ever touched, so a deep window can never look worse than the
// plain ranking did there) and a quality gate (scoreOf/isCompetitive below) so a swap can only pull
// in an alternative that is genuinely competitive with the local field, never a weak one promoted
// purely for variety (task section 7's negative case). Measured against real production scores across
// four sample cities at five depths (see the final report's before/after table) this combination
// never makes a shallow depth worse than the plain ranking, and meaningfully reduces same-category
// runs exactly where the real (not naive-distance-proxy) ranking actually has them.

// EXPLICIT INTENT (bypass diversity) vs BROAD DISCOVERY - deterministic, from `filters` alone. This
// is a USER-INTENT signal (what the user asked for), not a catalog-composition one.
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
// (no substring/keyword collapsing, same "exact concepts stay distinct" principle as the sibling
// placeholder-mapping fix, lib/placeholderImages.js).
function diversityKey(activity) {
  return activity?.category || activity?.entity_type || null;
}

// lib/filterActivities.js#rankActivitiesWithSmartRadius attaches this (Phase 2) - the only source of
// quality information this file uses, and only ever compared against OTHER scores in the SAME local
// result set (never a global/catalog number). Missing on an item (a caller that didn't go through
// that ranker, e.g. a hand-built test fixture) reads as "unknown," which the quality gate treats as
// competitive by default - it can never justify BLOCKING a swap, only skip judging it.
function scoreOf(activity) {
  return typeof activity?._diversityScore === 'number' ? activity._diversityScore : null;
}

// PREFIX_SIZE bounds how much of the list this function will ever touch. Beyond it, activities keep
// their exact original relative order - a deep window (top-30, the full list) can never look worse
// than the plain ranked order did there, because nothing out there is reordered at all.
const DEFAULT_PREFIX_SIZE = 20;

// After this many consecutive same-category items, look for a competitive alternative to pull
// forward. 2 matches the measured shape of a genuine repeat (task's own "max 2 consecutive" example,
// section 6) without triggering on every incidental pair.
const DEFAULT_MAX_CONSECUTIVE = 2;

// How far ahead (within the prefix) to look for that alternative. Bounded and small on purpose: this
// is what stops the swap from reaching deep into the list for "any different category at all" -
// combined with the quality gate, it is the mechanism for task section 8's "never leapfrog a
// dramatically better match for variety" (no raw numeric comparison across the FULL remaining list is
// made; only nearby, already-comparable-by-rank candidates are ever considered).
const DEFAULT_LOOKAHEAD = 6;

// QUALITY_MARGIN_RATIO gates which alternatives are even eligible to be pulled forward: a candidate's
// score must be within this fraction of the PREFIX'S OWN score spread (its own max minus its own min
// - a local, per-search number, never a catalog-wide one) of the score of the item it would be
// jumping ahead of (the current `head`, not the prefix's single best score) - "is this alternative
// competitive with what's actually being deferred for it," not "is it as good as the single best
// match in the whole prefix." Measuring against the prefix's best score instead was tried first and
// found too strict: in a prefix whose scores decay only gently across a wide range of otherwise-fine
// candidates (measured: Tel Aviv's real top-20 spans just 20.3-19.4), it blocked every alternative
// past the first couple of positions even though each one was perfectly competitive with its own
// immediate neighbors, simply because none of them matched the very top score. 0.5 was chosen by
// measuring real score distributions across the four sample cities used throughout this task (see the
// final report): a genuinely weak alternative (task section 7's "1 mediocre event, 1 poor workshop"
// case) sits well outside half the local spread even against a same-position baseline, once real
// signals (age match, rating, completeness, distance) are summed, while a merely-different-category
// but comparably-well-matched activity usually sits inside it.
const DEFAULT_QUALITY_MARGIN_RATIO = 0.5;

function isCompetitive(activity, baselineScore, scoreSpread, marginRatio) {
  const score = scoreOf(activity);
  if (score == null || baselineScore == null) return true; // no score info to judge by - never block on ignorance
  if (scoreSpread <= 0) return true; // every candidate ties - nothing to discriminate on
  return score >= baselineScore - scoreSpread * marginRatio;
}

// Preserves the ranked order as the base priority. Within a bounded prefix (never beyond it, and
// position 0 - the single best match - is never moved): scans left to right, and once the same
// category has appeared `maxConsecutive` times in a row, looks within `lookahead` positions for a
// quality-competitive activity of a different category and pulls it forward - exactly like moving a
// single card up in a hand, never the reverse. This is the one property that keeps every depth safe
// at once: an item can only ever move to an EARLIER position than where the ranker originally put it,
// never later, so a shallower view can never come out worse than the plain ranked order already was.
// A weak alternative (fails the quality gate) is never pulled forward just for variety's sake (task's
// "18 excellent playgrounds + 1 mediocre event + 1 poor workshop" case) - it simply stays exactly
// where the ranked order already put it. Nothing is ever dropped or duplicated; a single-category
// prefix, or a run with no competitive alternative within reach, passes through unchanged - this
// never invents variety that is not actually there.
export function diversifyResults(activities, {
  prefixSize = DEFAULT_PREFIX_SIZE, maxConsecutive = DEFAULT_MAX_CONSECUTIVE,
  lookahead = DEFAULT_LOOKAHEAD, qualityMarginRatio = DEFAULT_QUALITY_MARGIN_RATIO,
} = {}) {
  if (!activities || activities.length < 2) return activities;
  const size = Math.min(activities.length, prefixSize);
  const prefix = activities.slice(0, size);
  const rest = activities.slice(size);

  const anchorKey = diversityKey(prefix[0]);
  if (prefix.every((a) => diversityKey(a) === anchorKey)) return activities; // single category - nothing to do

  const scores = prefix.map(scoreOf).filter((s) => s != null);
  const bestScore = scores.length ? Math.max(...scores) : null;
  const scoreSpread = scores.length ? bestScore - Math.min(...scores) : 0;

  const remaining = prefix.slice();
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
      const baselineScore = scoreOf(head) ?? bestScore;
      let swapAt = -1;
      for (let i = 1; i < windowEnd; i += 1) {
        const candidate = remaining[i];
        if (diversityKey(candidate) !== lastKey && isCompetitive(candidate, baselineScore, scoreSpread, qualityMarginRatio)) {
          swapAt = i;
          break;
        }
      }
      if (swapAt === -1) {
        // No competitive alternative within reach - take the honest next item rather than reaching
        // further or promoting something weak.
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
  return [...result, ...rest];
}
