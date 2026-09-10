-- TuRu - עוקב אחרי content_hash (מנורמל) לכל דף שהתגלה פעם עבור מקור, כדי ש-scan-source
-- (ה-Edge Function) יוכל לדעת "האם הדף הזה השתנה מאז הסריקה הקודמת" *לפני* ששולחים אותו ל-AI -
-- אם הגיבוב זהה, קריאת-ה-AI מדולגת לגמרי (חיסכון עלות/זמן/עומס).
--
-- שורה אחת לכל URL-שהתגלה-אי-פעם עבור מקור נתון (גם ה-seed URL וגם דפי-הרשימה שהתגלו דרכו).
-- קריאה בלבד לכלי הניהול (לתצוגת "אילו דפים השתנו" בהיסטוריית-סריקות) - כתיבה רק מ-Edge Function.
create table public.source_page_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.sources(id) on delete cascade,
  url text not null,
  content_hash text not null,
  last_fetched_at timestamptz not null default now(),
  last_changed_at timestamptz not null default now(),
  unique (source_id, url)
);

create index idx_source_page_snapshots_source on public.source_page_snapshots(source_id);

alter table public.source_page_snapshots enable row level security;
create policy "source_page_snapshots_read" on public.source_page_snapshots for select
  using (public.is_admin() or public.is_trusted_uploader());
