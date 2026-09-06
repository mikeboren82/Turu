-- TuRu - "התעלם" לבעיות איכות-נתונים בודדות (חסר גיל/מחיר/כתובת/שעות/קישור שבור/תמונה)
-- באותה תבנית בדיוק כמו dismissed_duplicates (0031) - זוג activity_id+issue_code שהמנהל בחר
-- להתעלם ממנו נשמר כאן, ו-computeIssues (public/admin-shared.js) מסנן אותו מכל התצוגות
-- (דשבורד, פעילויות, איכות נתונים) בלי לגעת בנתון עצמו - הבעיה לא נפתרה, רק לא מוצגת יותר.
create table if not exists public.dismissed_issues (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activities(id) on delete cascade,
  issue_code text not null,
  dismissed_at timestamptz not null default now(),
  unique (activity_id, issue_code)
);

alter table public.dismissed_issues enable row level security;

create policy "dismissed_issues_read" on public.dismissed_issues for select
  using (public.is_admin() or public.is_trusted_uploader());

create policy "dismissed_issues_insert" on public.dismissed_issues for insert
  with check (public.is_admin() or public.is_trusted_uploader());
