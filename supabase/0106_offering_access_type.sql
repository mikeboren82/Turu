-- 0106 - Offering access type: WHO MAY ATTEND a row (Phase 1, 2026-09-21).
--
-- SCHEMA DELTA (exactly two objects touched):
--   1. activities.offering_access_type  text NULL  CHECK (in public/private_group/mixed/unknown)
--   2. archive_activity() (0105)        same body, allowlist gains 'private_hire_policy'
-- Nothing else. No RLS change, no ownership change, no backfill, no index (the column is read on
-- single rows by id; the catalogue never filters on it in Phase 1).
--
-- WHY A COLUMN AND NOT A CATEGORY. category answers "what is the experience" (zoo, theatre);
-- access answers "who may come". A birthday package at a zoo is still zoo content. The project
-- already models catalogue eligibility as a declarative axis separate from category
-- (shouldArchiveForCommitment, 0041) - this is the second such axis.
--
-- WHY NULL AND NO BACKFILL. 5,692 live rows; the private-hire base rate measured on 2026-09-21 is
-- ~0.04%. Existing rows stay NULL, which every reader treats as 'unknown' = today's behaviour.
-- A separate human review pass handles the ~35 historical candidates (b5cfe4f2 is the canary).
--
-- WHY NO incoming_activities COLUMN. The extracted verdict and its evidence travel inside
-- incoming_activities.extracted_data (offering_access_type, offering_access_evidence) exactly like
-- every other extracted field, and the review queue's validation_issues carries the gating label
-- 'גישה'. That is how the classification survives into review before an activity exists.
--
-- archive_reason itself is free text (no constraint); only the 0105 RPC constrains it, so the new
-- reason is added to that allowlist. Only a FINAL human verdict ever produces it.
--
-- ROLLBACK: alter table public.activities drop column offering_access_type;
--           re-run supabase/0105_archive_activity_rpc.sql (restores the previous allowlist)
begin;

alter table public.activities
  add column if not exists offering_access_type text
  check (offering_access_type is null or offering_access_type in ('public', 'private_group', 'mixed', 'unknown'));

create or replace function public.archive_activity(
  p_activity_id uuid,
  p_expected_status text,
  p_archive_reason text,
  p_keeper_activity_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text;
  v_keeper_status text;
  v_now timestamptz := now();
begin
  if not (public.is_admin() or public.is_trusted_uploader()) then
    raise exception 'permission denied: admin or trusted uploader only'
      using errcode = '42501';
  end if;

  if p_archive_reason is null or p_archive_reason not in (
    'duplicate_of_existing_activity',
    'expired',
    'missing_address_unresolved',
    'missing_from_source',
    'outside_service_area',
    'commitment_policy',
    'wrong_entity_type',
    'private_hire_policy'
  ) then
    raise exception 'archive_reason not allowed: %', coalesce(p_archive_reason, '(null)')
      using errcode = '22023';
  end if;

  if p_expected_status is null or p_expected_status = 'archived'
     or p_expected_status not in ('pending', 'approved', 'rejected') then
    raise exception 'expected_status must be a live status (pending/approved/rejected), got: %',
      coalesce(p_expected_status, '(null)') using errcode = '22023';
  end if;

  if p_keeper_activity_id is not null and p_keeper_activity_id = p_activity_id then
    raise exception 'keeper_activity_id must differ from the archived activity'
      using errcode = '22023';
  end if;

  select status into v_current from public.activities where id = p_activity_id;
  if not found then
    return jsonb_build_object('outcome', 'row_not_found', 'activity_id', p_activity_id);
  end if;
  if v_current = 'archived' then
    return jsonb_build_object('outcome', 'already_archived', 'activity_id', p_activity_id,
                              'current_status', v_current);
  end if;
  if v_current is distinct from p_expected_status then
    return jsonb_build_object('outcome', 'precondition_changed', 'activity_id', p_activity_id,
                              'expected_status', p_expected_status, 'current_status', v_current);
  end if;

  if p_keeper_activity_id is not null then
    select status into v_keeper_status from public.activities where id = p_keeper_activity_id;
    if not found then
      return jsonb_build_object('outcome', 'keeper_not_found', 'activity_id', p_activity_id,
                                'keeper_activity_id', p_keeper_activity_id);
    end if;
    if v_keeper_status <> 'approved' then
      return jsonb_build_object('outcome', 'keeper_not_approved', 'activity_id', p_activity_id,
                                'keeper_activity_id', p_keeper_activity_id,
                                'keeper_status', v_keeper_status);
    end if;
  end if;

  update public.activities
     set status = 'archived',
         archive_reason = p_archive_reason,
         archived_at = v_now
   where id = p_activity_id
     and status = p_expected_status;

  if not found then
    return jsonb_build_object('outcome', 'precondition_changed', 'activity_id', p_activity_id,
                              'expected_status', p_expected_status, 'current_status', null,
                              'note', 'row changed between check and write');
  end if;

  return jsonb_build_object(
    'outcome', 'archived',
    'activity_id', p_activity_id,
    'previous_status', p_expected_status,
    'archive_reason', p_archive_reason,
    'archived_at', v_now,
    'keeper_activity_id', p_keeper_activity_id
  );
end;
$$;

-- CREATE OR REPLACE keeps the existing grants/revokes from 0105 (authenticated + service_role only).
commit;

-- CANARIES (after apply, as the importer bot):
--  1. select column_name, is_nullable from information_schema.columns
--       where table_name='activities' and column_name='offering_access_type';   -> text, YES
--  2. insert with offering_access_type='whatever' on a throwaway row             -> CHECK violation
--  3. select archive_activity(<throwaway approved id>, 'approved', 'private_hire_policy');
--       -> {"outcome":"archived", ...}; then hard-delete the throwaway (bot owns it)
--  4. grants on archive_activity unchanged: authenticated, service_role, postgres only
--  5. pg_policy on activities: still exactly 4 rows, activities_update unchanged
