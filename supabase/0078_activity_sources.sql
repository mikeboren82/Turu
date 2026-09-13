-- TuRu - multi-source provenance: one activity, many places it was seen. activities.source_url /
-- source_id keep pointing at the ORIGINAL creator (unchanged semantics, and finally populated -
-- see backfill below); this junction records every additional detection (venue site + municipality
-- + aggregator = ONE activity, three rows here). scan-source writes a row on create and on every
-- duplicate/update match instead of creating another activity.
--
-- relation: 'created' = this detection created the activity; 'seen' = matched as duplicate;
-- 'updated' = matched and fields were applied. unique(activity_id, page_url) makes repeat scans
-- idempotent (upsert bumps last_seen_at).
create table if not exists public.activity_sources (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activities(id) on delete cascade,
  source_id uuid references public.sources(id) on delete set null,
  page_url text not null,
  incoming_activity_id uuid references public.incoming_activities(id) on delete set null,
  relation text not null default 'seen' check (relation in ('created', 'seen', 'updated')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (activity_id, page_url)
);
create index if not exists idx_activity_sources_activity on public.activity_sources(activity_id);
create index if not exists idx_activity_sources_source on public.activity_sources(source_id) where source_id is not null;

alter table public.activity_sources enable row level security;
create policy "activity_sources_read" on public.activity_sources for select
  using (public.is_admin() or public.is_trusted_uploader());
create policy "activity_sources_write" on public.activity_sources for all
  using (public.is_admin() or public.is_trusted_uploader())
  with check (public.is_admin() or public.is_trusted_uploader());

-- ---- Backfill (idempotent, read-only against activities except the source_id fill) ----

-- 1. Every activity's own creation URL is its first provenance row.
insert into public.activity_sources (activity_id, source_id, page_url, relation, first_seen_at, last_seen_at)
select a.id, a.source_id, a.source_url, 'created', a.created_at, a.created_at
from public.activities a
where a.source_url is not null
on conflict (activity_id, page_url) do nothing;

-- 2. incoming rows that created an activity (admin-approved or auto-approved). The scanner
--    re-discovers the same place many times (same activity+page_url across runs), so collapse to
--    one row per (activity, page_url) first - ON CONFLICT cannot touch the same row twice in one
--    statement.
insert into public.activity_sources (activity_id, source_id, page_url, incoming_activity_id, relation, first_seen_at, last_seen_at)
select i.created_activity_id,
       (array_agg(i.source_id) filter (where i.source_id is not null))[1],
       i.page_url,
       (array_agg(i.id order by i.found_at))[1],
       'created', min(i.found_at), max(coalesce(i.reviewed_at, i.found_at))
from public.incoming_activities i
where i.created_activity_id is not null
group by i.created_activity_id, i.page_url
on conflict (activity_id, page_url) do update
  set source_id = coalesce(public.activity_sources.source_id, excluded.source_id),
      incoming_activity_id = coalesce(public.activity_sources.incoming_activity_id, excluded.incoming_activity_id),
      last_seen_at = greatest(public.activity_sources.last_seen_at, excluded.last_seen_at);

-- 3. incoming rows matched against an existing activity (duplicate / update detections).
insert into public.activity_sources (activity_id, source_id, page_url, incoming_activity_id, relation, first_seen_at, last_seen_at)
select i.existing_activity_id,
       (array_agg(i.source_id) filter (where i.source_id is not null))[1],
       i.page_url,
       (array_agg(i.id order by i.found_at))[1],
       case when bool_or(i.status = 'updated') then 'updated' else 'seen' end,
       min(i.found_at), max(i.found_at)
from public.incoming_activities i
where i.existing_activity_id is not null and i.match_type in ('duplicate', 'update')
group by i.existing_activity_id, i.page_url
on conflict (activity_id, page_url) do update
  set last_seen_at = greatest(public.activity_sources.last_seen_at, excluded.last_seen_at);

-- 4. activities.source_id was never written by any creation path (audit 2026-09-13: 0 of 5,209).
--    Fill it where the creating incoming row knows its source.
update public.activities a
set source_id = i.source_id
from public.incoming_activities i
where i.created_activity_id = a.id and i.source_id is not null and a.source_id is null;
