-- TuRu - הרצה אוטומטית יומית של ניקוי פעילויות שפג תוקפן (0028), בנוסף לכפתור הידני
-- בממשק הניהול. משתמשים ב-pg_cron, שמובנה ונתמך ב-Supabase (Database -> Extensions).
--
-- למה לא קוראים ל-cleanup_expired_activities() הקיימת ישירות מה-cron: היא בודקת הרשאה דרך
-- auth.uid() (is_admin()/is_trusted_uploader()) - ומחוץ להקשר בקשה אמיתי מול PostgREST (בדיוק
-- המצב כש-pg_cron מריץ SQL ישירות בתוך הדאטהבייס) אין JWT בכלל, אז auth.uid() תמיד null וההרשאה
-- הייתה נכשלת תמיד. הפתרון: מחלצים את לוגיקת "מה נחשב פג תוקף" לפונקציית עזר משותפת אחת
-- (_expired_activity_ids, לא חשופה ל-API - מקור אמת יחיד), ועוטפים אותה בשתי פונקציות חיצוניות
-- נפרדות: cleanup_expired_activities() הציבורית (עם בדיקת הרשאה, ל-RPC מהאפליקציה/כלי הניהול)
-- ופונקציית ה-cron הפנימית (בלי בדיקת auth.uid() - אבל לא נגישה מבחוץ, ראו revoke למטה).
create or replace function public._expired_activity_ids()
returns table(activity_id uuid, last_date date)
language sql
stable
security definer
set search_path = public
as $$
  select s.activity_id, max(s.one_time_date) as last_date
  from public.activity_schedules s
  group by s.activity_id
  having bool_and(s.schedule_type = 'one_time' and coalesce(s.one_time_date < current_date, false));
$$;

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
    select a.id, a.name, e.last_date
    from public.activities a
    join public._expired_activity_ids() e on e.activity_id = a.id
    order by e.last_date asc;
  else
    return query
    delete from public.activities a
    using public._expired_activity_ids() e
    where a.id = e.activity_id
    returning a.id, a.name, e.last_date;
  end if;
end;
$$;

grant execute on function public.cleanup_expired_activities(boolean) to authenticated;

-- פונקציית ה-cron הפנימית - בלי בדיקת הרשאה (אין למי לבדוק - ה-caller הוא ה-scheduler עצמו,
-- לא בקשת API). revoke מפורש מ-PUBLIC/anon/authenticated כדי שלא תהיה נגישה גם דרך RPC ישיר
-- למרות שהיא security definer (ברירת המחדל ב-Postgres מעניקה EXECUTE ל-PUBLIC על פונקציה חדשה).
create or replace function public._cleanup_expired_activities_cron()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.activities a
  using public._expired_activity_ids() e
  where a.id = e.activity_id;
$$;

revoke all on function public._cleanup_expired_activities_cron() from public, anon, authenticated;

-- הפעלת pg_cron (אם עדיין לא מופעל בפרויקט - אם השורה הזו נכשלת עם שגיאת הרשאה, יש להפעיל את
-- ההרחבה "pg_cron" ידנית דרך Supabase Dashboard -> Database -> Extensions, ואז להריץ את שאר
-- הקובץ הזה שוב).
create extension if not exists pg_cron with schema extensions;

-- 03:00 UTC = 05:00/06:00 בישראל (בהתאם לשעון קיץ/חורף) - שעה שקטה שלא מתנגשת עם שימוש פעיל.
-- cron.schedule עם שם job קיים מעדכן אותו (לא יוצר כפול) - אפשר להריץ את המיגרציה הזו שוב בבטחה.
select cron.schedule(
  'cleanup-expired-activities-daily',
  '0 3 * * *',
  $$ select public._cleanup_expired_activities_cron(); $$
);
