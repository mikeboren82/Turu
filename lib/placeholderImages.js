// TuRu - שכבת Placeholder אחידה (4 קבוצות בלבד, לא per-קטגוריה - ראו activities.placeholder_group,
// supabase/0059_activities_placeholder_group.sql) לפעילויות בלי תמונה משלהן. כל התמונות הן
// הקנגורו המיתוגי של TuRu (אותה דמות מהלוגו) בפוזות שונות, על אותו רקע מנטה - assets/placeholders/.
// כל ערך הוא מערך (בד"כ תמונה אחת) - PLAY_AND_FUN מקבל שתיים (2026-09-20, בקשת המשתמש: "הוספתי
// שני קבצי תמונה... אני רוצה ששניהם ישמשו מעכשיו כplaceholder של גני שעשועים במקום מה שיש היום")
// כדי שתהיה קצת גיוון בין פעילויות שכנות באותה קבוצה, לא אותה תמונה בדיוק בכל כרטיס.
// PLAY_AND_FUN כ-JPG (2026-09-20, "Performance Phase 1" audit סעיף 5) - שני קבצי ה-PNG המקוריים
// (turu_kangaroo_swing_800x450.png/_placeholder) היו 319-322KB כל אחד - התמונה עצמה אטומה
// לגמרי (אומת: alpha=255 בכל הפיקסלים שנדגמו, אין באמת שקיפות) אז PNG (דחיסה חסרת-אובדן) לא
// היה נחוץ מלכתחילה - בדיוק כמו שלושת קבוצות ה-placeholder האחרות שכבר JPG (32-41KB). הומרו
// ל-JPG (איכות 82, אותה רזולוציה 800x450 בדיוק - בלי שינוי-רזולוציה, רק שינוי-פורמט) ל-27-34KB,
// ~91% פחות - נבדק חזותית שאין artifacts נראים-לעין בגודל-הצגה (כרטיס ~260x158). קבצי ה-PNG
// המקוריים הוסרו (assets/turu_kangaroo_swing_800x450.png/_placeholder) - היו בשימוש רק כאן.
// 2026-09-20 (המשך): עוד שני ואריאנטים - קרוסלת-שעשועים (PLAY_AND_FUN, תואם למיפוי
// 'פארק שעשועים'->PLAY_AND_FUN ב-tools/import-tool/placeholderGroup.js) וקנגורו-מצייר בסדנה
// (CULTURE_CREATIVITY, תואם למיפוי 'סדנה'->CULTURE_CREATIVITY שם) - אותו קנגורו מיתוגי, אותו
// רקע מנטה, כדי שיהיה יותר גיוון בכל קבוצה בלי להוסיף קבוצת placeholder חמישית. שני הקבצים
// הגיעו ברזולוציה 1672x941 (גבוהה משאר קבוצת ה-placeholder, 800-900px) ולא כווצו כאן - אין
// כלי-עיבוד-תמונה זמין בסביבה הזו (לא sharp/jimp/PIL); 64-65KB כל אחד בכל זאת, קרוב לגודל שאר
// התמונות (32-41KB) ולא בעיית-ביצועים.
export const PLACEHOLDER_IMAGES = {
  PLAY_AND_FUN: [
    require('../assets/placeholders/play-and-fun-kangaroo.jpg'),
    require('../assets/placeholders/play-and-fun-kangaroo-alt.jpg'),
    require('../assets/placeholders/play-and-fun-roller-coaster.jpg'),
  ],
  NATURE_AND_ANIMALS: [require('../assets/placeholders/nature-and-animals.jpg')],
  CULTURE_CREATIVITY: [
    require('../assets/placeholders/culture-creativity.jpg'),
    require('../assets/placeholders/culture-creativity-workshop.jpg'),
  ],
  SPORTS_ADVENTURE: [require('../assets/placeholders/sports-adventure.jpg')],
};

// Root cause of "גן שעשועים shows the roller-coaster ride" (Card Metadata + Placeholder Mapping
// task, 2026-09-25): activities.placeholder_group is a coarse VISUAL bucket, not the canonical
// category - tools/import-tool/placeholderGroup.js (and its Deno twin, supabase/functions/_shared)
// deliberately map both גן שעשועים (a public playground) and פארק שעשועים (a paid amusement park -
// a different concept entirely, see that file's own "VISUAL GROUPING IS NOT TAXONOMY" comment) into
// the same PLAY_AND_FUN bucket, because no dedicated art existed for the ride. placeholderImageFor
// then picked among ALL of a bucket's images purely by a hash of the activity id, with no idea which
// specific category it was looking at - so roughly one in three genuine playgrounds got the ride.
// GROUP_CATEGORY_SUBSETS below is the presentation-only fix: given the activity's own canonical
// category (already available at every call site), prefer the subset of a bucket's images that
// actually depicts that exact concept - EXACT match first; a category with no entry here (including
// anything the ingestion side only reached via its keyword fallback, e.g. free-text 'קרנבל'/'מיני
// גולף') falls through to the pre-existing hash-across-the-whole-bucket behavior, unchanged. This
// never changes which BUCKET an activity is in (that stays owned by the ingestion-side mapping) or
// which image files exist - only which of an already-assigned bucket's images gets shown.
const SWING_INDICES = [0, 1]; // kangaroo-on-swing, alt angle - playground/indoor-play, not a ride
const RIDE_INDICES = [2]; // roller-coaster - a paid attraction, not a public playground
const GROUP_CATEGORY_SUBSETS = {
  PLAY_AND_FUN: {
    'גן שעשועים': SWING_INDICES,
    "ג'ימבורי": SWING_INDICES,
    'משחקייה': SWING_INDICES,
    'טרמפולינות': SWING_INDICES,
    'פארק שעשועים': RIDE_INDICES,
  },
};

// hash מינימלי (לא קריפטוגרפי) על seed (בד"כ activity.id) - בחירה יציבה בין כמה תמונות באותה
// קבוצה, כדי שאותה פעילות תמיד תציג את אותה תמונת-placeholder (לא מתחלפת בכל רינדור/רענון).
function stableIndex(seed, length) {
  if (length <= 1) return 0;
  const s = String(seed ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % length;
}

// category (אופציונלי) - הקטגוריה הקנונית (activity.category) לצמצום-קבוצה מדויק, ראו ההערה
// המלאה למעלה. קריאה קיימת בלי הפרמטר הזה ממשיכה להתנהג בדיוק כמו קודם (hash על כל התמונות
// בקבוצה) - לא breaking change.
export function placeholderImageFor(placeholderGroup, seed, category) {
  const images = PLACEHOLDER_IMAGES[placeholderGroup];
  if (!images || !images.length) return null;
  const subsetIndices = GROUP_CATEGORY_SUBSETS[placeholderGroup]?.[category];
  const pool = subsetIndices?.length ? subsetIndices.map((i) => images[i]).filter(Boolean) : null;
  if (pool && pool.length) return pool[stableIndex(seed, pool.length)];
  return images[stableIndex(seed, images.length)];
}

// צבע הרקע (מנטה) של כל תמונת-placeholder בפועל, נמדד ישירות מהקובץ - לא קירוב. חיוני כי
// התמונות מוצגות ב-resizeMode="contain" (לא "cover" הרגיל): הדמות המצוירת חייבת להישאר שלמה
// ולא להיחתך, אז ה-View שמסביב צריך את הרקע המדויק כדי שה"מסגרת" הריקה (letterbox) שנשארת
// כשהיחס-רוחב/גובה של התמונה שונה מיחס-הכרטיס תיבלע בתוך הרקע במקום להיראות כפס-צבע שונה.
export const PLACEHOLDER_BG_COLORS = {
  PLAY_AND_FUN: '#d8f3f0',
  NATURE_AND_ANIMALS: '#c5f4f0',
  CULTURE_CREATIVITY: '#c9f4ee',
  SPORTS_ADVENTURE: '#c6f2ed',
};

export function placeholderBgColorFor(placeholderGroup) {
  return PLACEHOLDER_BG_COLORS[placeholderGroup] || null;
}
