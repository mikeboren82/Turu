-- TuRu - תיקון: בדיקה ישירה מול ה-DB הראתה ש-INSERT אנונימי ל-app_feedback עדיין נחסם על
-- ידי RLS למרות ה-policy ב-0022 (ייתכן שהריצה הקודמת לא השלימה את כל הפקודות). מריצים שוב
-- בצורה אידמפוטנטית (drop if exists + create) כדי שזה יעבוד בטוח בלי קשר למצב הנוכחי.
alter table public.app_feedback enable row level security;

drop policy if exists "app_feedback_insert" on public.app_feedback;
create policy "app_feedback_insert" on public.app_feedback for insert
  to anon, authenticated
  with check (true);

drop policy if exists "app_feedback_read" on public.app_feedback;
create policy "app_feedback_read" on public.app_feedback for select
  to authenticated
  using (public.is_admin());

grant insert on public.app_feedback to anon, authenticated;
grant select on public.app_feedback to authenticated;
