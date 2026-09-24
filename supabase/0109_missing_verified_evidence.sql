-- TuRu - Missing-from-source cutover: LEGACY counter vs VERIFIED evidence (2026-09-24).
--
-- activities.consecutive_missing_scans was produced by invalid semantics until scan-source v78 (+1 per invocation,
-- source-wide: unchanged pages, other relay batches and PARTIAL runs all counted as "not seen"). Its values are not
-- evidence. Missing flags read ONLY missing_verified_streak, which is written solely by the page-scoped v79+ rule
-- (a complete, changed, fully-extracted listing page that no longer names a still-eligible dated event) and starts
-- at 0 for every row here - so no legacy count can ever become a review flag.
alter table public.activities
  add column if not exists missing_verified_streak integer not null default 0,
  add column if not exists missing_verified_last_at timestamptz;

comment on column public.activities.missing_verified_streak is
  'Consecutive VERIFIED absences (v79+ page-scoped rule, dated events only). The only input to missing-from-source flags.';
comment on column public.activities.missing_verified_last_at is
  'When the last verified absence was recorded.';
comment on column public.activities.consecutive_missing_scans is
  'LEGACY/informational: values before scan-source v78 came from per-invocation semantics. Never used for flags.';

-- Flags are switched by data, not code: both scan-source and the local relay read this. Off until the gate passes.
insert into public.automation_settings (key, value, updated_at)
values ('missing_flags_enabled', 'false'::jsonb, now())
on conflict (key) do nothing;
