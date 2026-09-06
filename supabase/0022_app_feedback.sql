-- TuRu - דיווחי באגים/פידבק חופשיים מהמשתמשים ("משהו לא עובד? דווח לנו"). בכוונה טבלה
-- נפרדת מ-public.reports הקיימת (0015) - reports דורשת reporter_id מחובר (RLS: reporter_id =
-- auth.uid()) ומיועדת לדיווח על תוכן ספציפי (הודעה/פעילות/משתמש); כאן המטרה הפוכה - לאפשר
-- לגמרי לאנונימיים לשלוח, בלי טופס/התחברות, טקסט חופשי בלבד.
create table public.app_feedback (
  id uuid primary key default gen_random_uuid(),
  message text not null check (char_length(message) > 0 and char_length(message) <= 2000),
  page text,
  user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index idx_app_feedback_created_at on public.app_feedback(created_at desc);

alter table public.app_feedback enable row level security;

-- כל אחד יכול לשלוח - כולל anon (לא מחובר) - זו כל הנקודה של הפיצ'ר.
create policy "app_feedback_insert" on public.app_feedback for insert
  with check (true);

-- קריאה רק לאדמין (מסך הניהול, tools/import-tool/feedback.js - רץ עם service role וכך
-- ממילא עוקף RLS, אבל שומרים גם policy תואמת לוגית ליתר ביטחון/עקביות).
create policy "app_feedback_read" on public.app_feedback for select using (public.is_admin());

grant insert on public.app_feedback to anon, authenticated;
grant select on public.app_feedback to authenticated;
