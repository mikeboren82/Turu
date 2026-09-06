-- WABBIT - מעקב אחרי אתרים שכבר נסרקו ע"י כלי הגילוי האוטומטי (חיפוש גוגל), כדי לא לחזור עליהם
create table public.scraped_sources (
  id uuid primary key default gen_random_uuid(),
  url text not null unique,
  domain text,
  title text,
  search_query text,
  status text not null default 'pending' check (status in ('pending', 'scraped', 'error', 'skipped')),
  activities_found integer not null default 0,
  error_message text,
  scraped_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  scraped_at timestamptz
);

create index idx_scraped_sources_domain on public.scraped_sources(domain);
create index idx_scraped_sources_status on public.scraped_sources(status);

alter table public.scraped_sources enable row level security;
-- אותה רמת אמון כמו locations - נתוני תפעול פנימיים של כלי הייבוא, לא מידע אישי/רגיש
create policy "scraped_sources_all" on public.scraped_sources for all
  using (auth.uid() is not null) with check (auth.uid() is not null);
