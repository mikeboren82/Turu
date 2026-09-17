import { supabase } from './supabase';
import { showToast } from './toast';
import { t } from './i18n';

async function idSet(table, userId) {
  const { data, error } = await supabase.from(table).select('activity_id').eq('user_id', userId);
  if (error) throw error;
  return new Set((data || []).map((r) => r.activity_id));
}

export async function fetchUserActivityFlags(userId) {
  const [favoriteIds, visitedIds, hiddenIds, plannedIds] = await Promise.all([
    idSet('favorites', userId),
    idSet('visited_activities', userId),
    idSet('hidden_activities', userId),
    idSet('planned_activities', userId),
  ]);
  return { favoriteIds, visitedIds, hiddenIds, plannedIds };
}

export async function fetchActivityFlags(userId, activityId) {
  const [fav, visited, hidden, planned] = await Promise.all([
    supabase.from('favorites').select('activity_id').eq('user_id', userId).eq('activity_id', activityId).maybeSingle(),
    supabase.from('visited_activities').select('activity_id').eq('user_id', userId).eq('activity_id', activityId).maybeSingle(),
    supabase.from('hidden_activities').select('activity_id').eq('user_id', userId).eq('activity_id', activityId).maybeSingle(),
    supabase.from('planned_activities').select('activity_id').eq('user_id', userId).eq('activity_id', activityId).maybeSingle(),
  ]);
  return { isFavorite: !!fav.data, isVisited: !!visited.data, isHidden: !!hidden.data, isPlanned: !!planned.data };
}

async function toggleRow(table, userId, activityId, next) {
  if (next) {
    const { error } = await supabase.from(table).insert({ user_id: userId, activity_id: activityId });
    if (error && error.code !== '23505') throw error;
  } else {
    const { error } = await supabase.from(table).delete().eq('user_id', userId).eq('activity_id', activityId);
    if (error) throw error;
  }
}

export const toggleFavorite = (userId, activityId, next) => toggleRow('favorites', userId, activityId, next);
export const toggleVisited = (userId, activityId, next) => toggleRow('visited_activities', userId, activityId, next);
export const toggleHidden = (userId, activityId, next) => toggleRow('hidden_activities', userId, activityId, next);
export const togglePlanned = (userId, activityId, next) => toggleRow('planned_activities', userId, activityId, next);

// --- משוב-פעולה משותף (מועדפים/"כבר הייתי כאן"/הסתרה) ---
// שיתוף בין app/index.js (קרוסלת ההמלצות) ל-app/activities.js (רשימת תוצאות) - אותה התנהגות
// בדיוק בשני המקומות (בקשת המשתמש: "החל התנהגות עקבית בכל המקומות"), לא שני מימושים מקבילים
// שעלולים לסטות. setState הוא ה-setter המקומי של המסך (Set של activityId) - אין state גלובלי
// חדש לדגלים עצמם, רק ההתנהגות (אופטימי+שחזור+הודעה) משותפת.

// מועדפים/"כבר הייתי כאן": תגובה מיידית (setState) נשארת בדיוק כמו היום; בהצלחה - בלי הודעה
// (השינוי החזותי על הכרטיס מספיק, בקשת המשתמש: "אין צורך בהודעת הצלחה על כל סימון"). בכשל -
// שחזור המצב הקודם + הודעה קצרה וברורה, לא שקט כמו קודם.
export function toggleWithFeedback(setState, id, next, persist) {
  setState((prev) => { const s = new Set(prev); next ? s.add(id) : s.delete(id); return s; });
  persist().catch(() => {
    setState((prev) => { const s = new Set(prev); next ? s.delete(id) : s.add(id); return s; });
    showToast(t('common.toast.actionFailed'));
  });
}

// הסתרה: אופטימית מיד (הכרטיס נעלם - filteredActivities/recommendations כבר מסננים לפי
// hiddenIds), ואז הודעה זמנית עם "ביטול" בהצלחה. כשל בהסתרה עצמה -> משחזר ומודיע; כשל בביטול
// -> משחזר בחזרה למוסתר (התאמה בין התצוגה למצב השמור בפועל, לא "מציג כלא-מוסתר" כשבפועל
// עדיין מוסתר ב-DB) + הודעה נפרדת. הסתרות רצופות: showToast (lib/toast.js) מחליף הודעה קודמת
// בחדשה - כל הסתרה עדיין נשמרת בפועל, רק ה"ביטול" הזמין הוא תמיד על הפעילות האחרונה שהוסתרה.
export function hideActivityWithFeedback(setHiddenIds, userId, activityId) {
  setHiddenIds((prev) => new Set(prev).add(activityId));
  toggleHidden(userId, activityId, true)
    .then(() => {
      showToast(t('common.toast.activityHidden'), {
        actionLabel: t('common.actions.undo'),
        onAction: () => undoHideWithFeedback(setHiddenIds, userId, activityId),
      });
    })
    .catch(() => {
      setHiddenIds((prev) => { const s = new Set(prev); s.delete(activityId); return s; });
      showToast(t('common.toast.hideFailed'));
    });
}

function undoHideWithFeedback(setHiddenIds, userId, activityId) {
  setHiddenIds((prev) => { const s = new Set(prev); s.delete(activityId); return s; });
  toggleHidden(userId, activityId, false).catch(() => {
    setHiddenIds((prev) => new Set(prev).add(activityId));
    showToast(t('common.toast.unhideFailed'));
  });
}

// תאריך-יעד אופציונלי ל"היעדים שלי" - upsert (לא insert) בכוונה: אם הפעילות עדיין לא ב-
// planned_activities (רק שמורה/היינו-שם), הוספת תאריך מוסיפה אותה לשם אוטומטית - "תאריך →
// גם מתכננים" בלי טוגל נפרד. הסרת תאריך (targetDate:null) לא מסירה את החברות ב-planned; זה
// togglePlanned(false) הנפרד, אם המשתמש רוצה להסיר לגמרי.
export async function setPlannedTargetDate(userId, activityId, { targetDate, targetLabel } = {}) {
  const { error } = await supabase
    .from('planned_activities')
    .upsert(
      { user_id: userId, activity_id: activityId, target_date: targetDate || null, target_label: targetLabel || null },
      { onConflict: 'user_id,activity_id' }
    );
  if (error) throw error;
}

export async function fetchPersonalNote(userId, activityId) {
  const { data, error } = await supabase
    .from('personal_notes').select('note').eq('user_id', userId).eq('activity_id', activityId).maybeSingle();
  if (error) throw error;
  return data?.note || '';
}

export async function savePersonalNote(userId, activityId, note) {
  const trimmed = note.trim();
  if (!trimmed) {
    const { error } = await supabase.from('personal_notes').delete().eq('user_id', userId).eq('activity_id', activityId);
    if (error) throw error;
    return;
  }
  const { error } = await supabase
    .from('personal_notes')
    .upsert(
      { user_id: userId, activity_id: activityId, note: trimmed, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,activity_id' }
    );
  if (error) throw error;
}

// כל ההערות האישיות של משתמש, על פני כל הפעילויות - לאזור "📝 ההערות האישיות שלי" בעמוד
// האישי. אותו דפוס select בדיוק כמו loadTab ב-app/profile.js (favorites/planned/visited),
// עם note/created_at/updated_at + activity_images(url) לתמונה ממוזערת. limit(200) - כמו שאר
// הרשימות בעמוד (למשל loadTab עם limit(20)) שלא מממשות pagination אמיתי.
export async function fetchAllPersonalNotes(userId) {
  const { data, error } = await supabase
    .from('personal_notes')
    .select('activity_id, note, created_at, updated_at, activity:activities(id, name, category, placeholder_group, location:locations(name, city), activity_images(url))')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data || []).filter((r) => r.activity);
}

// כל הפעילויות שהמשתמש הסתיר, ל"פעילויות חסומות" בעמוד האישי - אותו דפוס בדיוק כמו
// fetchAllPersonalNotes למעלה (select עם activity:activities(...), סינון שורות ללא activity -
// קרה למשל אם הפעילות נמחקה, cascade כבר דואג לזה בפועל, זו רק הגנה עקבית).
export async function fetchHiddenActivities(userId) {
  const { data, error } = await supabase
    .from('hidden_activities')
    .select('activity_id, created_at, activity:activities(id, name, category, location:locations(name, city))')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data || []).filter((r) => r.activity);
}

// profiles.nickname isn't publicly readable via RLS (phone/email must stay private), so author
// names are looked up through the public_profiles view (see supabase/0006_public_profiles_view.sql).
// Until that migration is applied, this degrades to a generic label rather than failing.
export async function fetchCommunityNotes(activityId) {
  const { data, error } = await supabase
    .from('community_notes')
    .select('id, note, created_at, user_id')
    .eq('activity_id', activityId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  const notes = data || [];
  if (notes.length === 0) return [];

  const userIds = [...new Set(notes.map((n) => n.user_id))];
  let authorById = {};
  const { data: authors, error: authorsErr } = await supabase.from('public_profiles').select('id, nickname, stars').in('id', userIds);
  if (!authorsErr) {
    authorById = Object.fromEntries((authors || []).map((a) => [a.id, { nickname: a.nickname, stars: a.stars ?? 0 }]));
  }

  return notes.map((n) => ({
    ...n,
    // null when unknown - the display fallback (activity.notes.anonymousAuthor) is resolved at render time.
    nickname: authorById[n.user_id]?.nickname || null,
    stars: authorById[n.user_id]?.stars ?? 0,
  }));
}

export async function postCommunityNote(userId, activityId, note) {
  const trimmed = note.trim();
  if (!trimmed) return;
  const { error } = await supabase.from('community_notes').insert({ user_id: userId, activity_id: activityId, note: trimmed });
  if (error) throw error;
}
