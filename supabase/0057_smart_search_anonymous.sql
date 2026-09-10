-- TuRu - "🔎 חיפוש חכם" עובר להיות פתוח גם למשתמשים לא-מחוברים (בקשת המשתמש: "כל אחד יוכל
-- להשתמש בו, לא רק משתמש רשום") - ראו supabase/functions/smart-search/index.ts, שם ה-401
-- הישן על העדר-משתמש-מחובר מוחלף ב-rate-limit לפי IP למי שאין לו session.
alter table public.smart_search_logs
  add column if not exists ip_address text;

-- ה-policy הישן (auth.uid() = user_id) היה דוחה בשקט כל insert עם user_id null (NULL=NULL
-- אינו true ב-SQL) - זה בדיוק המצב של בקשה אנונימית. מרחיבים כדי לאפשר גם את זה.
drop policy if exists "smart_search_logs_insert_own" on public.smart_search_logs;
create policy "smart_search_logs_insert_own_or_anon" on public.smart_search_logs for insert
  with check (auth.uid() = user_id or user_id is null);
