-- 0108 - Repertoire Phase 1: exempt standing programme identity from the expiry cron
-- (2026-09-22). The READ-ONLY repertoire forensic proved the daily
-- cleanup-expired-activities-daily cron (0029/0083, live, 03:00 UTC) reads FROM
-- activity_schedules grouped by activity_id, having bool_and(one_time AND past) - a row with ZERO
-- schedules never appears in that group-by and is immune today. That immunity is what has kept the
-- 59 undated standing/repertoire rows (Train Theater, MUZA, Davidson, ...) alive so far.
--
-- Repertoire Phase 1 (matching.ts#isStandingProgrammeMatch) will start ATTACHING dated performances
-- onto these rows as activity_schedules, on purpose - that is the whole point of the feature. But the
-- moment a standing row holds only PAST one_time dates, bool_and flips true and the SAME cron would
-- archive the programme identity itself. A seasonal show returning months later would then be
-- archived in between and re-created as a duplicate on its next performance - a failure mode that
-- does not exist today and that this migration exists to prevent.
--
-- THE RULE: entity_type = 'אירוע_קבוע' is excluded from _expired_activity_ids() entirely, regardless
-- of its current schedule shape. This is deliberately scoped to the exact column value the ingestion
-- prompt already uses for "a recurring-shaped, non-workshop record" (extraction.ts) - not a new flag,
-- not every activity, not 'אירוע' (ordinary one-time events, still expire normally) or 'פעילות'
-- (workshops under the commitment-policy archive gate, unaffected).
--
-- CONFIRMED ZERO CURRENT IMPACT (dry-run before this migration): 0 currently-approved אירוע_קבוע
-- rows have ANY one_time schedule today (the whole 59-row standing population has zero schedules;
-- the 49-row recurring-cadence population has none either) - this migration changes NOTHING for any
-- existing row, it is purely prospective protection for future standing-programme attachments.
--
-- RESIDUAL RISK (accepted, documented): a wrapper/sub-entity row that was manually approved despite
-- the granularity gate (v70) AND later, independently, acquired a one_time schedule would also be
-- expiry-immune under this rule. Two independent facts make this an acceptable trade-off rather than
-- a gap to close here: (1) wrapper rows are structurally given a synthetic RECURRING schedule, not
-- one_time (already immune to this cron regardless of entity_type, unchanged by this migration);
-- (2) isStandingProgrammeMatch() itself independently refuses to attach a one_time date to a
-- wrapper/zone-shaped existing row (assessGranularity check, matching.ts), so the only path to this
-- residual shape is a human overriding TWO separate safety checks. Manual archival remains fully
-- available via the existing archive_activity RPC regardless of this exemption.
--
-- Additive, reversible: ROLLBACK by re-running 0083's original definition (below, in a comment).
begin;

create or replace function public._expired_activity_ids()
returns table(activity_id uuid, last_date date)
language sql
stable
security definer
set search_path = public
as $$
  select s.activity_id, max(s.one_time_date) as last_date
  from public.activity_schedules s
  join public.activities a on a.id = s.activity_id
  where a.entity_type <> 'אירוע_קבוע'
  group by s.activity_id
  having bool_and(s.schedule_type = 'one_time' and coalesce(s.one_time_date < current_date, false));
$$;

commit;

-- ROLLBACK (0083's original definition, no entity_type exclusion):
--   create or replace function public._expired_activity_ids()
--   returns table(activity_id uuid, last_date date)
--   language sql stable security definer set search_path = public as $$
--     select s.activity_id, max(s.one_time_date) as last_date
--     from public.activity_schedules s
--     group by s.activity_id
--     having bool_and(s.schedule_type = 'one_time' and coalesce(s.one_time_date < current_date, false));
--   $$;
