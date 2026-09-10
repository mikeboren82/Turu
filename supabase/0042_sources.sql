-- TuRu - "מקורות מידע": רישום אתרים שנסרקים מחדש באופן חוזר (בניגוד ל-scraped_sources הקיים,
-- שהוא רק רשימת-דה-דופ שטוחה מהזרימה הידנית של "גילוי אתרים חדשים" - אין לה תדירות/חזרתיות,
-- ולא נוגעים בה כאן, היא ממשיכה לשרת את הפיצ'ר הידני הקיים כמו שהוא).
--
-- source_trust_score/is_trusted הם שני שדות נפרדים במכוון (לא נגזרים זה מזה): trust_score הוא
-- ציון עדין (0-100) שהמנהל קובע/מעדכן ידנית - בלי ברירת-מחדל-אוטומטית-לפי-סוג-מקור, כדי לא
-- "לנחש" עד כמה מקור אמין. is_trusted הוא flag בוליארי גס יותר לשימוש עתידי (לדוגמה, כלל
-- "trusted source + confidence גבוה = מותר Auto Approve"). שניהם לא משמשים לשום החלטה אוטומטית
-- כרגע - נשמרים כדי שסבב עתידי יוכל להשתמש בהם בלי migration נוסף.
create table public.sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  seed_url text not null,
  type text not null default 'html' check (type in ('html', 'api', 'rss', 'sitemap', 'other')),
  region text,
  categories text[] not null default '{}',
  scan_frequency_hours integer not null default 24 check (scan_frequency_hours > 0),
  is_active boolean not null default true,
  source_trust_score numeric check (source_trust_score >= 0 and source_trust_score <= 100),
  is_trusted boolean not null default false,
  last_scan_at timestamptz,
  next_scan_at timestamptz not null default now(),
  last_scan_status text check (last_scan_status in ('success', 'partial', 'error')),
  last_scan_error text,
  activities_found_total integer not null default 0,
  activities_approved_total integer not null default 0,
  scan_errors_total integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- source_trust_level מחושב מהציון (לא מוזן בנפרד) - "המערכת יכולה לחשב את הרמה מתוך הציון".
alter table public.sources add column source_trust_level text
  generated always as (
    case
      when source_trust_score is null then null
      when source_trust_score >= 80 then 'HIGH'
      when source_trust_score >= 50 then 'MEDIUM'
      else 'LOW'
    end
  ) stored;

create index idx_sources_next_scan on public.sources(next_scan_at) where is_active;

alter table public.sources enable row level security;
create policy "sources_all" on public.sources for all
  using (public.is_admin() or public.is_trusted_uploader())
  with check (public.is_admin() or public.is_trusted_uploader());
