-- TuRu - "🔎 חיפוש חכם": לוג לכל בקשת ניתוח-שפה-טבעית (query/intent/ambiguity/geocoding/
-- תוצאות/שגיאות - ראו supabase/functions/smart-search/index.ts) לצורך דיבוג ולשמש גם כבסיס
-- ל-rate limiting פשוט (סופרים שורות של המשתמש ב-24 השעות האחרונות, בלי טבלת-מונים נפרדת).
-- לא נשמר כאן מידע אישי מיותר - רק הטקסט שהמשתמש הקליד עצמו והפלט המובנה שחולץ ממנו.
create table public.smart_search_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  query text not null,
  parsed_intent jsonb,
  had_ambiguity boolean not null default false,
  geocode_attempted boolean not null default false,
  geocode_success boolean,
  result_count integer,
  error_message text,
  created_at timestamptz not null default now()
);

create index idx_smart_search_logs_user_created on public.smart_search_logs(user_id, created_at desc);

alter table public.smart_search_logs enable row level security;

-- הכתיבה קורית עם ה-JWT של המשתמש עצמו (לא service role - ראו smart-search/index.ts, אותו
-- דפוס בדיוק כמו extract-activity), אז insert מוגבל לשורה של המשתמש עצמו.
create policy "smart_search_logs_insert_own" on public.smart_search_logs for insert
  with check (auth.uid() = user_id);

-- קריאה: המשתמש רואה רק את הלוגים שלו (לא רלוונטי כרגע ב-UI, אבל עקרון-פרטיות נכון); מנהל/בוט
-- הייבוא יכולים לראות הכל לצורך דיבוג (אותה מדיניות is_admin() OR is_trusted_uploader() שחוזרת
-- בכל טבלת-לוג פנימית בפרויקט).
create policy "smart_search_logs_read" on public.smart_search_logs for select
  using (auth.uid() = user_id or public.is_admin() or public.is_trusted_uploader());
