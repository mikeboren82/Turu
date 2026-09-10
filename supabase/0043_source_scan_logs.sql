-- TuRu - היסטוריית סריקות פר-מקור. קריאה בלבד לכלי הניהול - כתיבה רק מ-Edge Function
-- (service role, עוקף RLS) כדי שהלוג יהיה אמין ולא ניתן-לזיוף מכלי הניהול עצמו.
create table public.source_scan_logs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.sources(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'success', 'partial', 'error')),
  pages_checked integer not null default 0,
  pages_changed integer not null default 0,
  pages_unchanged integer not null default 0,
  ai_calls integer not null default 0,
  activities_found integer not null default 0,
  new_count integer not null default 0,
  updated_count integer not null default 0,
  duplicate_count integer not null default 0,
  rejected_count integer not null default 0,
  missing_count integer not null default 0,
  expired_count integer not null default 0,
  error_count integer not null default 0,
  error_type text check (error_type in ('network', 'parse', 'ai', 'validation', 'rate_limited', 'other')),
  error_message text
);

create index idx_source_scan_logs_source on public.source_scan_logs(source_id, started_at desc);

alter table public.source_scan_logs enable row level security;
create policy "source_scan_logs_read" on public.source_scan_logs for select
  using (public.is_admin() or public.is_trusted_uploader());
