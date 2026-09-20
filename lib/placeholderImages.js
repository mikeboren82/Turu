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

// hash מינימלי (לא קריפטוגרפי) על seed (בד"כ activity.id) - בחירה יציבה בין כמה תמונות באותה
// קבוצה, כדי שאותה פעילות תמיד תציג את אותה תמונת-placeholder (לא מתחלפת בכל רינדור/רענון).
function stableIndex(seed, length) {
  if (length <= 1) return 0;
  const s = String(seed ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % length;
}

export function placeholderImageFor(placeholderGroup, seed) {
  const images = PLACEHOLDER_IMAGES[placeholderGroup];
  if (!images || !images.length) return null;
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
