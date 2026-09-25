// 🏠 קרוסלת-הגילוי של עמוד הבית (Home Refactor Phase 3A) - הועבר byte-for-byte מתוך ה-useMemo
// "recommendations" ב-app/index.js: לוגיקה טהורה בלבד (בלי React, בלי fetch, בלי Supabase, בלי
// storage) שמקבלת קלט מפורש ומחזירה מערך-מועמדים סופי לתצוגה. ה-useMemo עצמו (כולל ה-dependency
// array) נשאר ב-app/index.js בלי שינוי - זו רק הפונקציה שרצה בתוכו. rankActivitiesWithSmartRadius
// (lib/filterActivities.js) הוא מנוע-הדירוג הקנוני הקיים (בשימוש גם ב-app/activities.js) - לא
// שוכפל/שוכתב כאן, רק נקרא.
import { rankActivitiesWithSmartRadius } from './filterActivities';
import { formatDistance } from './activities';
import { formatBenefitCardTag } from './benefits';
import { buildMatchReasons } from './matchReasons';
import { isBroadDiscovery, diversifyResults } from './resultDiversity';

// שים לב: הפונקציה "טהורה" באותה מידה שכל שאר lib/*.js בפרויקט נחשב טהור - formatDistance/
// formatBenefitCardTag/buildMatchReasons קוראים ל-t() (lib/i18n) שקורא locale נוכחי מ-module-
// level store, לא מקבל אותו כפרמטר מפורש (דפוס i18n קיים בכל הפרויקט, לא הונהג כאן). זו הסיבה
// ש-locale מופיע ברשימת-התלויות של ה-useMemo הקורא לפונקציה הזו ב-app/index.js, למרות שהוא לא
// מוזן ישירות לפרמטרים למטה.
export function buildHomeDiscoveryCandidates({
  activities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities,
  originCoords, excludedRegions, hiddenIds, favoriteIds, visitedIds, notesByActivity, childAges, limit,
}) {
  const ranked = rankActivitiesWithSmartRadius(
    activities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities, null, originCoords, excludedRegions
  )
    .activities
    .filter((a) => !hiddenIds.has(a.id));
  // Result Diversity (2026-09-25, lib/resultDiversity.js) - the carousel's own filters
  // (buildCarouselFilters, app/index.js) always strip category to [], so this is always a broad,
  // general-discovery surface by design (never "temporarily a museum carousel" mid Quick-Choice
  // pick) - isBroadDiscovery is kept as the single shared gate rather than assuming that here, so a
  // future caller with real category/q intent gets the same explicit-intent bypass as app/activities.js.
  // Applied BEFORE slicing to `limit`, not after - diversifying an already-truncated 8-card slice
  // could never pull in an alternative sitting just past the cut.
  //
  // prefixSize deliberately does NOT reuse app/activities.js's 20-item default here: that default is
  // sized for a long, scrollable results list, while this carousel only ever shows `limit` (8) cards
  // at all - reordering candidates the slice below would discard anyway is wasted reach for no visible
  // benefit. limit + the default lookahead (6) is exactly enough room to still pull in an alternative
  // sitting just past the visible cut (the same "just below the limit" case the tests pin), without
  // scanning arbitrarily far into candidates that could never appear on this small a surface. Same
  // architecture as the full results page (diversifyResults, isBroadDiscovery) - a narrower, carousel-
  // appropriate prefix, per this task's own allowance for different conservative parameters per surface.
  const CAROUSEL_DIVERSITY_PREFIX = limit + 6;
  return (isBroadDiscovery(filters) ? diversifyResults(ranked, { prefixSize: CAROUSEL_DIVERSITY_PREFIX }) : ranked)
    .slice(0, limit)
    .map((a) => ({
      ...a,
      distance: formatDistance(a, deviceCoords),
      favorite: favoriteIds.has(a.id),
      visited: visitedIds.has(a.id),
      hasNote: notesByActivity.has(a.id),
      benefitTag: formatBenefitCardTag(a.benefits, benefitClubs),
      // "✓ למה זה מתאים" - אין מצב ספונטני בעמוד הבית (זה רק קישור אל /activities), אז תמיד
      // buildMatchReasons; אותה פונקציה משותפת בדיוק כמו app/activities.js.
      matchReason: buildMatchReasons(a, { childAges }),
    }));
}
