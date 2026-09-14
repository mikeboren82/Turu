-- 0088: THE CLEANER - atomic case claiming (leases), run heartbeats, weak-address provenance.
-- Additive only. See tools/import-tool/THE-CLEANER.md ("Concurrency").
--
-- Why: cleaner.js used a plain SELECT of due cases; two processes (or an overlapping scheduled run)
-- would work the same case twice, and a crashed process left nothing behind to tell. A small
-- Postgres lease is enough: claim = UPDATE ... FOR UPDATE SKIP LOCKED with a lease_until; every
-- terminal/retry write releases it; an expired lease is simply claimable again (crash recovery).

alter table public.cleaner_cases
  add column if not exists claimed_by text,
  add column if not exists claimed_at timestamptz,
  add column if not exists lease_until timestamptz;
create index if not exists idx_cleaner_cases_lease on public.cleaner_cases (status, lease_until);

alter table public.cleaner_runs
  add column if not exists worker text,
  add column if not exists heartbeat_at timestamptz;

comment on column public.activities.archive_reason is 'machine-readable: commitment_policy | expired | missing_from_source | missing_address_unresolved | ambiguous_location | venue_not_found | insufficient_required_data | invalid_event | duplicate_of_existing_activity | source_unreachable | unsupported_source | legacy_unknown | activity_expired_before_resolution | image_unavailable_only | address_unresolved_nonblocking | ambiguous_audience | other';

-- Claim up to p_limit due, unleased cases (optionally one issue, or specific ids, optionally ignoring
-- the backoff for controlled runs). Atomic across concurrent workers.
create or replace function public.cleaner_claim_cases(
  p_worker text,
  p_limit int,
  p_issue text default null,
  p_lease_seconds int default 900,
  p_case_ids uuid[] default null,
  p_ignore_backoff boolean default false
) returns setof public.cleaner_cases
language plpgsql security definer set search_path = public as $$
begin
  return query
  with picked as (
    select c.id
      from public.cleaner_cases c
     where c.status = 'open'
       and (p_ignore_backoff or c.next_attempt_at <= now())
       and (c.lease_until is null or c.lease_until < now())
       and (p_issue is null or c.issue = p_issue)
       and (p_case_ids is null or c.id = any(p_case_ids))
     order by c.priority asc, c.event_date asc nulls last, c.created_at asc
     limit greatest(p_limit, 0)
     for update skip locked
  )
  update public.cleaner_cases c
     set claimed_by = p_worker, claimed_at = now(), lease_until = now() + make_interval(secs => p_lease_seconds)
    from picked
   where c.id = picked.id
  returning c.*;
end $$;

-- Extend the lease of cases this worker still holds (long page fetches).
create or replace function public.cleaner_extend_lease(p_worker text, p_case_ids uuid[], p_lease_seconds int default 900)
returns int language sql security definer set search_path = public as $$
  with u as (
    update public.cleaner_cases
       set lease_until = now() + make_interval(secs => p_lease_seconds)
     where claimed_by = p_worker and id = any(p_case_ids) and status = 'open'
    returning id
  ) select count(*)::int from u;
$$;

-- Settings for the continuation pass (editable like the other cleaner_* keys)
insert into public.automation_settings (key, value) values
  ('cleaner_cluster_min_size', '3'),
  ('cleaner_lease_seconds', '900')
on conflict (key) do nothing;
