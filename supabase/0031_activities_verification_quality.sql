-- TuRu - תשתית ל"מערכת ניהול חכמה": מעקב תוקף מידע (מתי נבדקה כל פעילות לאחרונה,
-- ומתי צריך לבדוק אותה שוב), בדיקת קישורים שבורים, וטבלה קטנה לזכור זוגות כפילויות שהמנהל
-- כבר בדק וקבע שהם לא כפילות (כדי שלא יופיעו שוב בכל רענון של עמוד הכפילויות).
--
-- last_verified_at מתחיל ב-now() לכל הפעילויות הקיימות - בסיס סביר ("אישרנו שהמאגר תקין נכון
-- להיום"), ומתעדכן אוטומטית בכל שמירת עריכה (ראו server.js, POST /api/manage/update) ובפעולת
-- האימות המפורשת החדשה (bulk-verify). next_review_at נשאר null עד שמנהל בוחר תזכורת מפורשת
-- (30/60/90 יום); כשהוא null, "דורשות עדכון" בדשבורד נופל חזרה לחלון גלובלי (last_verified_at
-- ישן מ-90 יום - הלוגיקה הזו ב-public/admin-shared.js, לא כאן).
alter table public.activities
  add column if not exists last_verified_at timestamptz not null default now(),
  add column if not exists next_review_at timestamptz,
  add column if not exists link_broken boolean,
  add column if not exists link_checked_at timestamptz;

create table if not exists public.dismissed_duplicates (
  id uuid primary key default gen_random_uuid(),
  activity_id_a uuid not null references public.activities(id) on delete cascade,
  activity_id_b uuid not null references public.activities(id) on delete cascade,
  dismissed_at timestamptz not null default now(),
  unique (activity_id_a, activity_id_b)
);

alter table public.dismissed_duplicates enable row level security;

create policy "dismissed_duplicates_read" on public.dismissed_duplicates for select
  using (public.is_admin() or public.is_trusted_uploader());

create policy "dismissed_duplicates_insert" on public.dismissed_duplicates for insert
  with check (public.is_admin() or public.is_trusted_uploader());
