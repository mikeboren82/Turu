-- 0105 - Controlled archive transition for trusted system tooling (2026-09-21).
--
-- *** NOT APPLIED. Created for review first (see FINAL REPORT section F/K). ***
--
-- THE PROBLEM THIS SOLVES. public.activities has exactly one UPDATE policy:
--     activities_update  USING ((created_by = auth.uid()) OR is_admin())
-- The importer bot (profiles.role = 'importer') is is_trusted_uploader() but NOT is_admin(), so it can
-- only update rows it created itself. On 2026-09-21, 55 of 6,180 activities have created_by IS NULL
-- (53 of them approved) - early imports that predate created_by being stamped. For those rows every
-- bot UPDATE is filtered out by RLS and PostgREST answers 200 / error=null / zero rows affected, which
-- a caller that does not inspect the affected-row count reads as SUCCESS. That is how duplicate
-- Resolution Batch #1 (2026-09-21) reported two activities archived that were never archived
-- (38ba9f4b Technoda, c2275eae Kfar Yona). The same class was found in the Cleaner on 2026-09-19 and
-- fixed there by DETECTION only (cleaner/apply.js verifiedUpdate -> 'write_denied'); detection turns a
-- silent failure into an honest one but still leaves the bot unable to archive those rows at all.
--
-- WHY NOT SIMPLY WIDEN activities_update TO is_trusted_uploader(). That policy has no WITH CHECK, so
-- its USING expression governs the new row as well: any caller that satisfies it may rewrite EVERY
-- column of EVERY activity - name, description, price, category, status in both directions, and
-- created_by itself. Widening it to is_trusted_uploader() would hand the importer permanent arbitrary
-- write access over the whole catalogue (including the 53 rows it does not own and every future
-- user-submitted row) in order to flip three columns on two rows. That is a privilege escalation
-- disproportionate to the problem.
--
-- WHY THIS SHAPE. It is the shape the project already uses for exactly this situation:
-- cleanup_expired_activities (0028 -> 0041) is a SECURITY DEFINER function that lets the same
-- importer identity archive activities it does not own, while constraining WHICH rows and WHICH
-- column may change, and it authorises itself internally with the same is_admin() OR
-- is_trusted_uploader() gate. This migration generalises that precedent from "expired one-time rows"
-- to "one named row, with a stated expected status and a reason from a closed list".
--
-- WHAT THE CAPABILITY IS, EXACTLY. The grantee may move ONE named activity from a live status to
-- 'archived', stamping archive_reason (from a closed list) and archived_at. It may do nothing else:
--   - no other column is writable through it (no name/description/category/price/created_by/venue)
--   - it is FORWARD-ONLY. There is no restore. archived -> approved remains admin-only through RLS,
--     which is the transition that can publish content, and is therefore the one worth guarding.
--   - it cannot delete. DELETE on activities remains is_admin() OR created_by = auth.uid().
--   - archive_reason is an allowlist, so it cannot be used to write arbitrary text into the table.
--   - the caller must state the expected current status; a row that moved since the caller read it
--     is reported back as precondition_changed and is NOT archived.
-- Compared with widening RLS, the delta granted here is: "may set status='archived' + 2 provenance
-- columns on a row it does not own". Compared with the service_role key (the project's other
-- privileged path, used by the scan-source Edge Function), this grants no read amplification, no
-- access to other tables, and nothing usable outside this one transition - and unlike a service_role
-- key it does not have to be distributed to a developer machine.
--
-- RETURN CONTRACT. Returns jsonb; outcome is one of:
--   'archived'             the row was archived by this call (exactly one row)
--   'row_not_found'        no activity with that id
--   'already_archived'     it was archived before this call (no write performed)
--   'precondition_changed' current status <> p_expected_status (no write performed)
--   'keeper_not_found' / 'keeper_not_approved'   duplicate provenance failed validation (no write)
-- An authorisation failure, a bad reason and a self-referencing keeper RAISE, they do not return an
-- outcome - a caller can never mistake them for a benign result. There is no code path that returns
-- 'archived' without exactly one row having been updated in this call.
--
-- ROLLBACK: drop function public.archive_activity(uuid, text, text, uuid);
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
  -- 1. AUTHORISATION - same gate as cleanup_expired_activities (0041). 42501 = insufficient_privilege.
  if not (public.is_admin() or public.is_trusted_uploader()) then
    raise exception 'permission denied: admin or trusted uploader only'
      using errcode = '42501';
  end if;

  -- 2. REASON ALLOWLIST - the capability may not write arbitrary text into archive_reason.
  --    These are the values already in production plus the ones the existing archive callers pass.
  if p_archive_reason is null or p_archive_reason not in (
    'duplicate_of_existing_activity',
    'expired',
    'missing_address_unresolved',
    'missing_from_source',
    'outside_service_area',
    'commitment_policy',
    'wrong_entity_type'
  ) then
    raise exception 'archive_reason not allowed: %', coalesce(p_archive_reason, '(null)')
      using errcode = '22023';
  end if;

  -- 3. The caller must state what it believed the row's status was. Refusing 'archived' here keeps
  --    the function forward-only: it can never be used to move a row OUT of the archive.
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

  -- 4. DUPLICATE PROVENANCE. When the archive is a duplicate resolution the surviving side is
  --    validated here, so a keeper that is itself gone or not published cannot be recorded as one.
  --    The verdict row itself lives in duplicate_candidates (0104); this call does not write it.
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

  -- 5. THE ONLY MUTATION THIS FUNCTION CAN PERFORM: three columns, one row, forward-only.
  --    The status guard is repeated here so a concurrent change between the read above and this
  --    write is reported as precondition_changed instead of silently overwriting it.
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

-- Stricter than the 0028/0041 precedent, which ended up executable by PUBLIC/anon and relied solely
-- on its internal gate. Anon should not even be able to reach this function to be refused by it.
revoke all on function public.archive_activity(uuid, text, text, uuid) from public, anon;
grant execute on function public.archive_activity(uuid, text, text, uuid) to authenticated, service_role;

commit;

-- ============================================================================================
-- CANARIES - run AFTER applying, as the importer bot (not as postgres; psql/db query connects as a
-- privileged role and would pass the internal gate for the wrong reason). Expected results noted.
--
-- 1. forward-only: there is no restore capability at all
--    \df public.archive_activity            -> exactly one function, no restore_activity counterpart
--
-- 2. reason allowlist rejects arbitrary text
--    select public.archive_activity('<id>'::uuid, 'approved', 'because i said so');
--    -> ERROR: archive_reason not allowed: because i said so
--
-- 3. forward-only guard rejects an 'archived' expected status
--    select public.archive_activity('<id>'::uuid, 'archived', 'expired');
--    -> ERROR: expected_status must be a live status (pending/approved/rejected), got: archived
--
-- 4. precondition is enforced (state a status the row does not have)
--    select public.archive_activity('<approved id>'::uuid, 'pending', 'expired');
--    -> {"outcome": "precondition_changed", "current_status": "approved", ...}   NO WRITE
--
-- 5. unknown row is not a success
--    select public.archive_activity('00000000-0000-0000-0000-000000000000'::uuid, 'approved', 'expired');
--    -> {"outcome": "row_not_found", ...}
--
-- 6. keeper validation
--    select public.archive_activity('<id>'::uuid, 'approved', 'duplicate_of_existing_activity',
--                                   '00000000-0000-0000-0000-000000000000'::uuid);
--    -> {"outcome": "keeper_not_found", ...}   NO WRITE
--
-- 7. THE CAPABILITY ITSELF - a row the bot did NOT create (created_by is null) is archived:
--    select public.archive_activity('38ba9f4b-b6e3-44ff-95bc-5f489072165e'::uuid, 'approved',
--                                   'duplicate_of_existing_activity',
--                                   '06e48ef2-2f4e-4f6a-83ad-921faf823e82'::uuid);
--    -> {"outcome": "archived", ...}
--    NOTE: do NOT run canary 7 until the two production canary pairs are explicitly released for
--    retry - d29beda6 / 3618aeb6 are deliberately left unresolved (see the batch #1 report).
--    Use a throwaway row, or run 4/5/6 only.
--
-- 8. anon cannot reach it
--    (as anon)  select public.archive_activity(...)   -> ERROR: permission denied for function
-- ============================================================================================
