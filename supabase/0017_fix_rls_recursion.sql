-- TuRu - תיקון באג: 0016 הרחיבה את profiles_read/profiles_update לכלול is_trusted_uploader(),
-- אבל is_trusted_uploader() עצמה שולפת מ-profiles - וזה יוצר רקורסיה אינסופית (הפונקציה
-- מפעילה את המדיניות על profiles, שמפעילה שוב את הפונקציה, וכו'), שגורמת לשגיאת
-- "stack depth limit exceeded" (נתפס כשמסך הדיווחים ב-/manage ניסה לטעון ונכשל).
-- הפתרון הסטנדרטי: להפוך את is_admin()/is_trusted_uploader() ל-security definer עם
-- search_path קבוע - כך הן רצות בהרשאות הבעלים (שעוקף RLS) ולא מפעילות את המדיניות מחדש.
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.is_trusted_uploader()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'importer'));
$$;
