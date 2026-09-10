-- TuRu - משנה את ניקוי הפעילויות שפג תוקפן (0028/0029) מ-DELETE ל-UPDATE status='archived'.
--
-- למה: ה-cron היומי הקיים (03:00 UTC) מחק לצמיתות כל פעילות חד-פעמית שפג תוקפה - כולל כל
-- הקשרים המקושרים אליה דרך cascade (activity_schedules/activity_images/favorites/וכו').
-- זה מתנגש עם הדרישה של מערכת "מקורות מידע" החדשה (ראו plan) לעולם לא למחוק מידע - גם פעילות
-- שהסתיימה נשארת בבסיס הנתונים כארכיון, לצורך היסטוריה/מניעת-כפילויות-עתידית/ניתוח-מקורות.
-- ההחלטה היא גורפת (חלה על כל פעילות באפליקציה, לא רק על פעילויות ממקורות סרוקים) - אושרה
-- במפורש מול המשתמש לפני שינוי מנגנון קיים שכבר רץ בפרודקשן.
--
-- status='archived' כבר ערך חוקי (ARCHIVE_CATEGORIES/shouldArchiveForCommitment בכלי הניהול
-- כבר משתמשים בו) - פעילויות archived כבר מוסתרות בפועל מכל מסך משתמש-קצה (כל שאילתה קיימת
-- מסננת status='approved'), כך שההתנהגות הנראית-למשתמש זהה למחיקה (הפעילות נעלמת), רק שהנתונים
-- נשארים ב-DB.

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
    where a.status <> 'archived';
  else
    return query
    update public.activities a
    set status = 'archived'
    from public._expired_activity_ids() e
    where a.id = e.activity_id
      and a.status <> 'archived'
    returning a.id, a.name, e.last_date;
  end if;
end;
$$;

-- פונקציית ה-cron הפנימית - אותו שינוי (DELETE -> UPDATE), עדיין בלי בדיקת auth (ה-caller הוא
-- ה-scheduler עצמו) ועדיין revoked מ-PUBLIC/anon/authenticated (revoke כבר קיים מ-0029, לא
-- צריך להצהיר שוב - CREATE OR REPLACE לא מאפס גרנטים/revokes קיימים על הפונקציה).
create or replace function public._cleanup_expired_activities_cron()
returns void
language sql
security definer
set search_path = public
as $$
  update public.activities a
  set status = 'archived'
  from public._expired_activity_ids() e
  where a.id = e.activity_id
    and a.status <> 'archived';
$$;
