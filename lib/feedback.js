import { supabase } from './supabase';

// שולח דיווח באג/פידבק - בכוונה לא דורש התחברות (ראו supabase/0022_app_feedback.sql,
// policy app_feedback_insert מאפשרת insert לגמרי פתוח). אם יש session פעיל, מצרפים user_id
// כהקשר נוסף לאדמין - אבל זה תמיד אופציונלי, אף פעם לא דרישה. name (0027) אופציונלי לגמרי
// גם הוא - ה-UI ממלא אותו מראש בכינוי למשתמש רשום, אבל אפשר למחוק/לשנות/לשלוח ריק.
export async function submitFeedback(message, page, name) {
  const trimmed = (message || '').trim();
  if (!trimmed) throw new Error('כתבו כמה מילים על מה שקרה');

  const { data: { session } } = await supabase.auth.getSession();
  const { error } = await supabase.from('app_feedback').insert({
    message: trimmed,
    page: page || null,
    name: (name || '').trim() || null,
    user_id: session?.user?.id || null,
  });
  if (error) throw error;
}
