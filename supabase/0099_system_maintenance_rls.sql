-- ============================================================================
-- ⚠️  STATUS: NOT APPLIED TO PRODUCTION. DO NOT APPLY WITHOUT A DEDICATED
--     RLS/SECURITY REVIEW AND EXPLICIT OWNER APPROVAL.
--
--     This migration changes the RLS AUTHORIZATION SURFACE of public.activities
--     and public.activity_schedules (widens who may UPDATE/INSERT/DELETE rows -
--     see can_maintain_activity() below). It is committed to source control for
--     review/history visibility only.
--
--     Committing or merging this file into any branch is NOT approval to run
--     it. Applying it requires a separate, dedicated RLS/security review.
-- ============================================================================
--
-- 0099 - CLEANER system-maintenance semantics + first-class CITY_NOT_CANONICAL case (2026-09-19).
--
-- 1. Authorization. activities_update allowed only `created_by = auth.uid() or is_admin()`. The Cleaner
--    bot has role 'importer' (is_trusted_uploader), not admin, so every repair on an activity it did not
--    create was a SILENT zero-row UPDATE (54 published rows with created_by NULL - 43 from the retired
--    Google settlement scanner, 11 from scan-source scans of sources whose creator is NULL - plus any
--    row another actor created). The importer/system role may now maintain INGESTION-OWNED records:
--    created_by IS NULL (only service-role paths can produce that - the insert policy forces
--    created_by = auth.uid() for humans) or source_id IS NOT NULL (the Monster ingested it). Normal
--    users keep exactly their own rows; nothing is granted to them; no fake ownership is assigned.
--    activity_schedules follow their activity through the same predicate.
-- 2. (moved to 0100) cleaner_cases.issue 'city_not_canonical' - kept separate so the authorization change
--    above can be decided on its own. NOT APPLIED as of 2026-09-19 (owner decision: report only).
begin;

create or replace function public.can_maintain_activity(p_created_by uuid, p_source_id uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select (p_created_by = auth.uid())
      or public.is_admin()
      or (public.is_trusted_uploader() and (p_created_by is null or p_source_id is not null));
$$;

drop policy if exists activities_update on public.activities;
create policy activities_update on public.activities
  for update using (public.can_maintain_activity(created_by, source_id));

drop policy if exists schedules_write on public.activity_schedules;
create policy schedules_write on public.activity_schedules
  for insert with check (exists (
    select 1 from public.activities a
    where a.id = activity_schedules.activity_id and public.can_maintain_activity(a.created_by, a.source_id)));

drop policy if exists schedules_update on public.activity_schedules;
create policy schedules_update on public.activity_schedules
  for update using (exists (
    select 1 from public.activities a
    where a.id = activity_schedules.activity_id and public.can_maintain_activity(a.created_by, a.source_id)));

drop policy if exists schedules_delete on public.activity_schedules;
create policy schedules_delete on public.activity_schedules
  for delete using (exists (
    select 1 from public.activities a
    where a.id = activity_schedules.activity_id and public.can_maintain_activity(a.created_by, a.source_id)));

commit;
