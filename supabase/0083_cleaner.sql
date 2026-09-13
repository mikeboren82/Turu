-- 0083: THE CLEANER - queue/lifecycle model + machine-readable terminal states (additive only).
-- See tools/import-tool/THE-CLEANER.md. Nothing here deletes or rewrites existing rows except the
-- backfill of archive_reason for rows that were archived before a reason column existed.

-- 1. Every archive gets a reason (four writers existed with no trace: commitment policy, the
--    expired cron, resolve-missing, archive-unrecoverable).
alter table public.activities
  add column if not exists archive_reason text,
  add column if not exists archived_at timestamptz;
comment on column public.activities.archive_reason is 'machine-readable: commitment_policy | expired | missing_from_source | missing_address_unresolved | ambiguous_location | venue_not_found | insufficient_required_data | invalid_event | duplicate_of_existing_activity | source_unreachable | unsupported_source | legacy_unknown | other';

update public.activities a set
  archive_reason = case
    when a.entity_type = 'פעילות' then 'commitment_policy'
    when exists (select 1 from public.activity_schedules s where s.activity_id = a.id and s.schedule_type = 'one_time' and s.one_time_date < current_date) then 'expired'
    else 'legacy_unknown' end,
  archived_at = coalesce(a.archived_at, now())
where a.status = 'archived' and a.archive_reason is null;

-- the expired-events cron now records why it archived
-- same selection as 0041 (public._expired_activity_ids()), only the reason/timestamp are new
create or replace function public._cleanup_expired_activities_cron()
returns void language sql security definer set search_path = public as $$
  update public.activities a
     set status = 'archived', archive_reason = 'expired', archived_at = now()
    from public._expired_activity_ids() e
   where a.id = e.activity_id and a.status <> 'archived';
$$;

-- 2. Incoming rows: terminal 'rejected' keeps its free-text reason; the Cleaner adds a code.
alter table public.incoming_activities
  add column if not exists archive_reason text;

-- 3. Resolved addresses carry provenance + confidence (the Cleaner never writes a LOW result).
alter table public.locations
  add column if not exists address_source text,
  add column if not exists address_confidence text check (address_confidence in ('HIGH', 'MEDIUM', 'LOW')),
  add column if not exists address_resolved_at timestamptz;

-- 4. Images: what kind of image this is (event vs venue) and where it came from.
alter table public.activity_images
  add column if not exists image_kind text check (image_kind in ('event_specific', 'event_series', 'venue_specific', 'organizer_specific', 'generic_fallback')),
  add column if not exists image_page_url text,
  add column if not exists retrieved_at timestamptz;

-- 5. The queue: one case per (subject, issue). status open -> resolved | archived; reopen = back to open.
create table if not exists public.cleaner_cases (
  id uuid primary key default gen_random_uuid(),
  subject_kind text not null check (subject_kind in ('activity', 'incoming')),
  subject_id uuid not null,
  issue text not null check (issue in (
    'missing_location', 'unverified_location', 'incomplete_address', 'missing_coordinates', 'missing_venue',
    'missing_image', 'broken_image', 'missing_schedule', 'missing_region', 'missing_required_metadata',
    'low_quality_description', 'rejected_missing_address'
  )),
  priority int not null default 50,           -- lower = sooner
  status text not null default 'open' check (status in ('open', 'resolved', 'archived')),
  attempts int not null default 0,
  methods_tried text[] not null default '{}',
  last_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  resolution jsonb,                            -- {method, confidence, evidence, outcome}
  archive_reason text,
  event_date date,                             -- for prioritization (nearer first)
  source_id uuid references public.sources(id) on delete set null,
  opened_reason text,
  reopened_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (subject_kind, subject_id, issue)
);
create index if not exists idx_cleaner_cases_due on public.cleaner_cases (status, next_attempt_at, priority);
create index if not exists idx_cleaner_cases_subject on public.cleaner_cases (subject_kind, subject_id);
alter table public.cleaner_cases enable row level security;
drop policy if exists cleaner_cases_read on public.cleaner_cases;
create policy cleaner_cases_read on public.cleaner_cases for select using (public.is_admin() or public.is_trusted_uploader());
drop policy if exists cleaner_cases_write on public.cleaner_cases;
create policy cleaner_cases_write on public.cleaner_cases for all using (public.is_admin() or public.is_trusted_uploader()) with check (public.is_admin() or public.is_trusted_uploader());

create table if not exists public.cleaner_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  mode text not null default 'batch',
  counters jsonb not null default '{}',
  notes text
);
alter table public.cleaner_runs enable row level security;
drop policy if exists cleaner_runs_rw on public.cleaner_runs;
create policy cleaner_runs_rw on public.cleaner_runs for all using (public.is_admin() or public.is_trusted_uploader()) with check (public.is_admin() or public.is_trusted_uploader());

-- 6. Settings (editable in admin like the other automation keys)
insert into public.automation_settings (key, value) values
  ('cleaner_enabled', 'true'),
  ('cleaner_max_attempts', '3'),
  ('cleaner_backoff_hours', '[6, 24, 72]'),
  ('cleaner_batch_size', '40'),
  ('cleaner_places_daily_budget', '100')
on conflict (key) do nothing;
