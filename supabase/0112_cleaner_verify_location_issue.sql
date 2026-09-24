-- 0112 - cleaner_cases_issue_check gains 'verify_location' (Cleaner verify_location Phase 2, 2026-09-24).
--
-- SCHEMA DELTA (exactly one object): the issue CHECK on public.cleaner_cases - the live list plus one value.
-- No column, table, RLS, grant or data change. verify_location = an incoming candidate whose ONLY remaining blocker is
-- a verified location (or an already-resolved row that needs re-evaluation / hand-back only) - see
-- tools/import-tool/cleaner/verifyLocation.js. Until this is applied the Cleaner skips-and-reports the issue
-- (MIGRATION_GATED_ISSUES in cleaner/discover.js), it never fails a discovery pass.
--
-- The list below is the constraint as it exists in production on 2026-09-24 (read from pg_constraint), not a
-- reconstruction from older migration files.
-- ROLLBACK: re-create the constraint without 'verify_location' (only after no verify_location case remains).
begin;
alter table public.cleaner_cases drop constraint if exists cleaner_cases_issue_check;
alter table public.cleaner_cases add constraint cleaner_cases_issue_check check (issue in (
  'missing_location', 'unverified_location', 'incomplete_address', 'missing_coordinates', 'missing_venue',
  'missing_image', 'broken_image', 'missing_schedule', 'missing_region', 'missing_required_metadata',
  'low_quality_description', 'rejected_missing_address', 'settlement_review', 'missing_city', 'misclassified',
  'city_not_canonical', 'not_independently_actionable',
  'verify_location'
));
commit;
