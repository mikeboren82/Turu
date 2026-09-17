-- 0094 - THE CLEANER: first-class MISSING_CITY case (2026-09-17).
-- A published activity whose location has coordinates but no canonical city (the ActivityCard shows no
-- locality while the detail screen can still show the address). Additive only: one more allowed value
-- in cleaner_cases.issue (the constraint is widened, no existing row can violate it).
-- The repair itself lives in tools/import-tool/cleaner/cityResolver.js and resolves every raw locality
-- through public.settlements + public.settlement_aliases (lib/canonicalSettlement.js).
begin;
alter table public.cleaner_cases drop constraint if exists cleaner_cases_issue_check;
alter table public.cleaner_cases add constraint cleaner_cases_issue_check
  check (issue in (
    'missing_location', 'unverified_location', 'incomplete_address', 'missing_coordinates', 'missing_venue',
    'missing_image', 'broken_image', 'missing_schedule', 'missing_region', 'missing_required_metadata',
    'low_quality_description', 'rejected_missing_address', 'settlement_review', 'missing_city'
  ));
commit;
