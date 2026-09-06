-- WABBIT/TuRu - ניקוי פעילויות שפג תוקפן (חד-פעמיות עם תאריך שעבר).
--
-- "פג תוקף" מוגדר לפי activity_schedules, לא לפי עמודה על activities עצמה: פעילות נחשבת
-- פגת-תוקף רק אם *כל* שורות ה-schedule שלה הן schedule_type='one_time' עם one_time_date
-- שעבר. פעילות עם schedule_type='recurring' (יום קבוע בשבוע) או 'fixed_hours' (מקום קבוע,
-- שעות פתיחה) אף פעם לא "פגה" ככה - אין לה תאריך יחיד שהופך אותה ללא-רלוונטית. בפועל
-- (ראו lib/submitActivity.js) לכל פעילות יש בדיוק schedule_type אחד לכל שורותיה, אבל
-- ה-bool_and כאן מתייחס לכך באופן מפורש כדי לא להסתמך רק על invariant ברמת האפליקציה.
--
-- ה-DELETE רץ כמשפט SQL בודד (set-based) בתוך פונקציית RPC אחת - בלי לשלוף רשומות לצד
-- הלקוח ולמחוק אחת-אחת. activities_schedules/activity_images/favorites/וכו' כבר מוגדרים
-- "on delete cascade" מ-activities (ראו supabase/schema.sql) אז מספיק למחוק מ-activities
-- וכל הטבלאות הקשורות מתנקות אוטומטית. אינדקס ייעודי לא נדרש בקנה המידה הנוכחי - idx_schedules_activity
-- הקיים (על activity_id) כבר מספיק ל-group by כאן; טבלת לוג/מעקב נפרדת הייתה רק תוספת state
-- שצריך לשמור מסונכרן בלי שום יתרון ביצועים אמיתי בגודל הטבלה הזה.
--
-- security definer + בדיקת הרשאה פנימית (is_admin/is_trusted_uploader) - כמו שאר פונקציות
-- ה-RPC בפרויקט (ראו is_admin/is_trusted_uploader ב-0012/0017) - כך שגם הבוט (role='importer')
-- של כלי הניהול יכול להריץ את זה, לא רק role='admin' ממש.
--
-- dry_run=true (ברירת המחדל) רק *מחזיר* אילו פעילויות היו נמחקות, בלי לגעת בהן - לתצוגת
-- אישור לפני מחיקה בממשק הניהול ("לאשר מחיקת X פעילויות?"). dry_run=false מבצע בפועל.
create or replace function public.cleanup_expired_activities(dry_run boolean default true)
returns table(id uuid, name text, one_time_date date)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (public.is_admin() or public.is_trusted_uploader()) then
    raise exception 'permission denied: admin or trusted uploader only';
  end if;

  if dry_run then
    return query
    select a.id, a.name, expired.last_date
    from public.activities a
    join (
      select s.activity_id, max(s.one_time_date) as last_date
      from public.activity_schedules s
      group by s.activity_id
      having bool_and(s.schedule_type = 'one_time' and coalesce(s.one_time_date < current_date, false))
    ) expired on expired.activity_id = a.id
    order by expired.last_date asc;
  else
    return query
    delete from public.activities a
    using (
      select s.activity_id, max(s.one_time_date) as last_date
      from public.activity_schedules s
      group by s.activity_id
      having bool_and(s.schedule_type = 'one_time' and coalesce(s.one_time_date < current_date, false))
    ) expired
    where a.id = expired.activity_id
    returning a.id, a.name, expired.last_date;
  end if;
end;
$$;

grant execute on function public.cleanup_expired_activities(boolean) to authenticated;
