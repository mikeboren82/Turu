-- 0091 - THE MONSTER wave 1: stable EVENT identity, URL roles on provenance, per-occurrence data.
-- Additive only (nullable columns + indexes + one CHECK verified against live data: 0 violating rows,
-- 0 activities with >1 one_time row, 0 duplicate (activity,date,time) rows on 2026-09-14).
--
-- IDENTITY MODEL (binding):
--   activities.event_key        = EVENT identity. Stable across occurrences: it does not change when
--                                 the earliest performance passes or a new date is added.
--   activities.event_fingerprint = LEGACY occurrence-level / first-occurrence fingerprint
--                                 (name|venue-or-city|date-or-days|HH:MM), retained for compatibility
--                                 with the exact pre-checks. NEVER use it as the canonical
--                                 multi-occurrence event identity.
--   activity_schedules rows     = OCCURRENCES: (activity, one_time_date, start_time) [+ external_id].
--
-- Rollback: drop the added columns/indexes/constraint (no data is rewritten here).

alter table public.activities
  add column if not exists event_key text,
  add column if not exists event_key_kind text
    check (event_key_kind in ('external_id', 'detail_url', 'provider_key', 'title_venue_source'));

comment on column public.activities.event_key is
  'EVENT identity (stable across occurrences). Kinds by strength: ext:<source>:<provider event id> > url:<verified event-specific detail URL> > pk:<provider key> > tvs:<normalized title>|v:<venue>|s:<source> (conservative fallback, never outranks the others). NULL = no strong event identity; similarity matching applies.';
comment on column public.activities.event_fingerprint is
  'LEGACY occurrence-level fingerprint of the first ingested occurrence (name|venue-or-city|date-or-days|HH:MM). Kept for exact pre-checks; never rotated on expiry. NOT the multi-occurrence event identity - use event_key.';

-- non-unique for now: 37 historical same-event groups (100 rows) still exist until the HIGH-only
-- consolidation runs; uniqueness is enforced in code, a partial unique index is a wave-2 item.
create index if not exists idx_activities_event_key
  on public.activities (event_key) where event_key is not null;

-- URL role on provenance: listing / detail / booking / other. Legacy rows stay NULL (= unknown) and a
-- NULL-role or listing URL is never treated as event identity (a listing page holds many events).
alter table public.activity_sources
  add column if not exists url_role text
    check (url_role in ('listing', 'detail', 'booking', 'other'));
comment on column public.activity_sources.url_role is
  'Role of page_url for this activity: listing (discovery/calendar page), detail (the event''s own page), booking (registration/purchase), other. NULL = unknown (legacy). Only a verified detail URL may serve as event identity.';

-- Per-occurrence data: each performance keeps its own time, provider occurrence id and purchase link.
alter table public.activity_schedules
  add column if not exists external_id text,
  add column if not exists booking_url text;
comment on column public.activity_schedules.external_id is 'Provider occurrence id (e.g. the ?id= of a per-performance purchase link).';
comment on column public.activity_schedules.booking_url is 'Purchase/registration URL of THIS occurrence (never the event detail page).';

-- One row per occurrence: no duplicate (activity, date, time). Verified: 0 duplicates before adding.
create unique index if not exists ux_activity_schedules_occurrence
  on public.activity_schedules (activity_id, one_time_date, (coalesce(start_time, '00:00'::time)))
  where schedule_type = 'one_time';

-- A row is either a weekday (recurring) or a dated occurrence, never both. Verified: 0 violating rows.
alter table public.activity_schedules
  drop constraint if exists activity_schedules_day_or_date_check;
alter table public.activity_schedules
  add constraint activity_schedules_day_or_date_check
  check (not (day_of_week is not null and one_time_date is not null));
