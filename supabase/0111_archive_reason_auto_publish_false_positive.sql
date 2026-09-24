-- 0111 - archive_activity(): allowlist gains 'auto_publish_false_positive_retail' (2026-09-24).
--
-- SCHEMA DELTA (exactly one object touched): archive_activity() (0105/0106) - same body, one more allowed reason.
-- No table, constraint, RLS, grant or data change. archive_reason itself is free text; only this RPC constrains it.
--
-- WHY. Before scan-source v81 the relevance gate trusted the extraction model's own "family" audience label, so
-- trusted mall / tourism sources auto-published ordinary shops, restaurants, food trucks, hotels, malls and
-- markets (category 'אחר'). The content-safety gate (_shared/autoPublishSafety.ts, 88514e2) now holds them. The
-- historical rows need an honest reason: none of the existing ones says "this was a published business listing,
-- not a children's activity" (wrong_entity_type is about entity shape, and the markets are real events).
-- Only a reviewed, human-approved cohort ever produces this reason.
--
-- ROLLBACK: re-run supabase/0106_offering_access_type.sql's create-or-replace (restores the previous allowlist).
begin;

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
    'private_hire_policy',
    'auto_publish_false_positive_retail'
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

-- CANARY (after apply, as the importer bot): archive_activity(<random uuid>, 'approved',
-- 'auto_publish_false_positive_retail') -> {"outcome":"row_not_found"} (reason accepted, nothing written).
