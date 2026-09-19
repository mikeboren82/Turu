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

// שים לב: הפונקציה "טהורה" באותה מידה שכל שאר lib/*.js בפרויקט נחשב טהור - formatDistance/
// formatBenefitCardTag/buildMatchReasons קוראים ל-t() (lib/i18n) שקורא locale נוכחי מ-module-
// level store, לא מקבל אותו כפרמטר מפורש (דפוס i18n קיים בכל הפרויקט, לא הונהג כאן). זו הסיבה
// ש-locale מופיע ברשימת-התלויות של ה-useMemo הקורא לפונקציה הזו ב-app/index.js, למרות שהוא לא
// מוזן ישירות לפרמטרים למטה.
export function buildHomeDiscoveryCandidates({
  activities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities,
  originCoords, excludedRegions, hiddenIds, favoriteIds, visitedIds, notesByActivity, childAges, limit,
}) {
  return rankActivitiesWithSmartRadius(
    activities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities, null, originCoords, excludedRegions
  )
    .activities
    .filter((a) => !hiddenIds.has(a.id))
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
