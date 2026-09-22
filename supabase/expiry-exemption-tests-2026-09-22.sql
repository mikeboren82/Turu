-- Repertoire Phase 1 (2026-09-22) - Expiry safety tests, cases A-F.
-- Transactional, READ-ONLY in effect: inserts fixture rows, evaluates the OLD (live, 0083) and NEW
-- (0108, not yet applied) _expired_activity_ids() query logic side by side as plain SELECTs, asserts
-- the expected result with RAISE EXCEPTION on any mismatch, then ROLLBACKs. Never touches the actual
-- function definition (that CREATE OR REPLACE ... SECURITY DEFINER is what needs the user's own
-- migration apply) and leaves no rows behind either way.
begin;

create temporary table t_activities (like public.activities including defaults) on commit drop;
alter table t_activities alter column location_id drop not null;

insert into t_activities (id, name, entity_type, status, source) values
  ('a0000000-0000-0000-0000-00000000000a', 'CASE A - standing, zero schedules', 'אירוע_קבוע', 'approved', 'manual'),
  ('b0000000-0000-0000-0000-00000000000b', 'CASE B - standing, one PAST one_time', 'אירוע_קבוע', 'approved', 'manual'),
  ('c0000000-0000-0000-0000-00000000000c', 'CASE C - standing, recurring cadence', 'אירוע_קבוע', 'approved', 'manual'),
  ('d0000000-0000-0000-0000-00000000000d', 'CASE D - standing, one past + one future one_time', 'אירוע_קבוע', 'approved', 'manual'),
  ('e0000000-0000-0000-0000-00000000000e', 'CASE E - ordinary event, one PAST one_time', 'אירוע', 'approved', 'manual'),
  ('f0000000-0000-0000-0000-00000000000f', 'CASE F - ordinary event, one FUTURE one_time', 'אירוע', 'approved', 'manual');

create temporary table t_schedules (like public.activity_schedules including defaults) on commit drop;

insert into t_schedules (activity_id, schedule_type, one_time_date) values
  ('b0000000-0000-0000-0000-00000000000b', 'one_time', current_date - interval '10 days'),
  ('c0000000-0000-0000-0000-00000000000c', 'recurring', null),
  ('d0000000-0000-0000-0000-00000000000d', 'one_time', current_date - interval '10 days'),
  ('d0000000-0000-0000-0000-00000000000d', 'one_time', current_date + interval '10 days'),
  ('e0000000-0000-0000-0000-00000000000e', 'one_time', current_date - interval '10 days'),
  ('f0000000-0000-0000-0000-00000000000f', 'one_time', current_date + interval '10 days');
-- CASE A intentionally gets zero rows here (proves the "invisible to group-by" invariant on its own).

-- OLD (live 0083) logic: no entity_type awareness at all.
create temporary view old_expired as
  select s.activity_id
  from t_schedules s
  group by s.activity_id
  having bool_and(s.schedule_type = 'one_time' and coalesce(s.one_time_date < current_date, false));

-- NEW (0108, not yet applied) logic: excludes אירוע_קבוע entirely before the group-by.
create temporary view new_expired as
  select s.activity_id
  from t_schedules s
  join t_activities a on a.id = s.activity_id
  where a.entity_type <> 'אירוע_קבוע'
  group by s.activity_id
  having bool_and(s.schedule_type = 'one_time' and coalesce(s.one_time_date < current_date, false));

do $$
declare
  old_ids uuid[];
  new_ids uuid[];
begin
  select coalesce(array_agg(activity_id order by activity_id), '{}') into old_ids from old_expired;
  select coalesce(array_agg(activity_id order by activity_id), '{}') into new_ids from new_expired;

  -- CASE A: zero-schedule standing row is invisible under BOTH queries (baseline invariant, unaffected by 0108).
  if 'a0000000-0000-0000-0000-00000000000a' = any(old_ids) or 'a0000000-0000-0000-0000-00000000000a' = any(new_ids) then
    raise exception 'CASE A FAILED: zero-schedule standing row must never appear in either expiry query';
  end if;

  -- CASE B: the actual bug this migration fixes - OLD expires it, NEW must exempt it.
  if not ('b0000000-0000-0000-0000-00000000000b' = any(old_ids)) then
    raise exception 'CASE B FAILED (test invalid): OLD query was expected to catch a standing row with one past one_time date';
  end if;
  if 'b0000000-0000-0000-0000-00000000000b' = any(new_ids) then
    raise exception 'CASE B FAILED: NEW query must exempt a standing programme with only a past one_time date';
  end if;

  -- CASE C: recurring cadence never satisfies bool_and(schedule_type='one_time'...) - unaffected either way.
  if 'c0000000-0000-0000-0000-00000000000c' = any(old_ids) or 'c0000000-0000-0000-0000-00000000000c' = any(new_ids) then
    raise exception 'CASE C FAILED: a recurring-cadence standing row must never be caught by either query';
  end if;

  -- CASE D: mixed past+future one_time dates fail bool_and (not ALL past) - unaffected either way, no
  -- regression from the entity_type join alone.
  if 'd0000000-0000-0000-0000-00000000000d' = any(old_ids) or 'd0000000-0000-0000-0000-00000000000d' = any(new_ids) then
    raise exception 'CASE D FAILED: a standing row with any future one_time date must never be caught by either query';
  end if;

  -- CASE E: NO CATALOGUE-WIDE WEAKENING - an ordinary past one-time event still expires under BOTH.
  if not ('e0000000-0000-0000-0000-00000000000e' = any(old_ids) and 'e0000000-0000-0000-0000-00000000000e' = any(new_ids)) then
    raise exception 'CASE E FAILED: an ordinary (non-standing) past one-time event must still expire under both OLD and NEW logic';
  end if;

  -- CASE F: an ordinary future one-time event never expires under either - unaffected, sanity check.
  if 'f0000000-0000-0000-0000-00000000000f' = any(old_ids) or 'f0000000-0000-0000-0000-00000000000f' = any(new_ids) then
    raise exception 'CASE F FAILED: an ordinary future one-time event must never be caught by either query';
  end if;

  raise notice 'ALL EXPIRY SAFETY CASES A-F PASSED';
end $$;

rollback;
