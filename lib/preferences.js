import { supabase } from './supabase';

// profiles.region (0019) הוחלף בפועל ע"י default_home_filters.location (עשיר יותר - יכול
// להיות אזור/עיר/רדיוס/קואורדינטות, לא רק ערך אזור בודד) - לא נקרא יותר כאן, נשאר בטבלה בלי
// לשבור כלום (0 משתמשים אמיתיים כרגע, אין נזק).
export async function fetchUserPreferences(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('excluded_categories, excluded_cities, excluded_regions, default_home_filters, children, saved_locations, notification_prefs, visible_home_filters, benefit_clubs, benefit_clubs_other')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return {
    excludedCategories: data?.excluded_categories || [],
    excludedCities: data?.excluded_cities || [],
    excludedRegions: data?.excluded_regions || [],
    defaultHomeFilters: data?.default_home_filters || null,
    children: data?.children || [],
    savedLocations: data?.saved_locations || [],
    notificationPrefs: data?.notification_prefs || {},
    visibleHomeFilters: data?.visible_home_filters || [],
    benefitClubs: data?.benefit_clubs || [],
    benefitClubsOther: data?.benefit_clubs_other || '',
  };
}

export async function saveVisibleHomeFilters(userId, keys) {
  const { error } = await supabase.from('profiles').update({ visible_home_filters: keys }).eq('id', userId);
  if (error) throw error;
}

// מחליף את saveFamilyDetails הישן (children_ages שטוח) - כל ילד עכשיו {id, name?, birthdate,
// gender?} כדי שהגיל יחושב טרי מתאריך הלידה בכל טעינה (ראו lib/children.js) במקום להיות
// מספר קבוע שצריך לעדכן ידנית מדי שנה.
export async function saveChildren(userId, children) {
  const { error } = await supabase.from('profiles').update({ children }).eq('id', userId);
  if (error) throw error;
}

export async function saveNotificationPrefs(userId, prefs) {
  const { error } = await supabase.from('profiles').update({ notification_prefs: prefs }).eq('id', userId);
  if (error) throw error;
}

export async function saveExcludedCategories(userId, categories) {
  const { error } = await supabase.from('profiles').update({ excluded_categories: categories }).eq('id', userId);
  if (error) throw error;
}

// "📍 אזורים שלא להציג" - אחות ל-saveExcludedCategories, אותו דפוס בדיוק.
export async function saveExcludedCities(userId, cities) {
  const { error } = await supabase.from('profiles').update({ excluded_cities: cities }).eq('id', userId);
  if (error) throw error;
}

// "⛔ לאן לא תרצו להגיע?" (אזורים, components/ExcludeAreasPicker.js) - אחות ל-saveExcludedCities,
// עמודה נפרדת כי מדובר במזהי REGION_OPTIONS, לא שמות עיר.
export async function saveExcludedRegions(userId, regions) {
  const { error } = await supabase.from('profiles').update({ excluded_regions: regions }).eq('id', userId);
  if (error) throw error;
}

// אילו מועדונים/כרטיסים יש למשתמש ("🎟️ ההטבות שלי" בפרופיל) - אופציונלי לגמרי, ריק כברירת
// מחדל, לא חוסם שום פונקציונליות אם לא הוגדר. otherText - הטקסט החופשי שהמשתמש ממלא כשבוחר
// "אחר" (ראו 0052) - נשמר יחד עם הרשימה באותה קריאה, לא endpoint נפרד.
export async function saveBenefitClubs(userId, clubs, otherText) {
  const { error } = await supabase.from('profiles').update({
    benefit_clubs: clubs, benefit_clubs_other: otherText?.trim() || null,
  }).eq('id', userId);
  if (error) throw error;
}

export async function saveDefaultHomeFilters(userId, filters) {
  const { error } = await supabase.from('profiles').update({ default_home_filters: filters }).eq('id', userId);
  if (error) throw error;
}

export async function clearDefaultHomeFilters(userId) {
  const { error } = await supabase.from('profiles').update({ default_home_filters: null }).eq('id', userId);
  if (error) throw error;
}
