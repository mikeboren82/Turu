// TuRu - שכבת Placeholder אחידה (4 קבוצות בלבד, לא per-קטגוריה - ראו activities.placeholder_group,
// supabase/0059_activities_placeholder_group.sql) לפעילויות בלי תמונה משלהן. כל התמונות הן
// הקנגורו המיתוגי של TuRu (אותה דמות מהלוגו) בפוזות שונות, על אותו רקע מנטה - assets/placeholders/.
export const PLACEHOLDER_IMAGES = {
  PLAY_AND_FUN: require('../assets/placeholders/play-and-fun.jpg'),
  NATURE_AND_ANIMALS: require('../assets/placeholders/nature-and-animals.jpg'),
  CULTURE_CREATIVITY: require('../assets/placeholders/culture-creativity.jpg'),
  SPORTS_ADVENTURE: require('../assets/placeholders/sports-adventure.jpg'),
};

export function placeholderImageFor(placeholderGroup) {
  return PLACEHOLDER_IMAGES[placeholderGroup] || null;
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
