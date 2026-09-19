-- 0100 - THE CLEANER: first-class CITY_NOT_CANONICAL case (2026-09-19). Additive only: one more allowed value
-- in cleaner_cases.issue. A published location whose city is a regional council ("מועצה אזורית X"), a
-- non-canonical spelling variant ("תל אביב" for "תל אביב יפו") or a locality string the canonical settlement
-- resolver does not know (Arabic-script values of the OSM import) is repaired by the missing_city pipeline
-- (tools/import-tool/cleaner/cityResolver.js, replace_city) with the stored value as evidence and write guard.
-- Split out of 0099 so the (authorization) part can be decided separately.
begin;
alter table public.cleaner_cases drop constraint if exists cleaner_cases_issue_check;
alter table public.cleaner_cases add constraint cleaner_cases_issue_check
  check (issue in (
    'missing_location', 'unverified_location', 'incomplete_address', 'missing_coordinates', 'missing_venue',
    'missing_image', 'broken_image', 'missing_schedule', 'missing_region', 'missing_required_metadata',
    'low_quality_description', 'rejected_missing_address', 'settlement_review', 'missing_city', 'misclassified',
    'city_not_canonical'
  ));
commit;
