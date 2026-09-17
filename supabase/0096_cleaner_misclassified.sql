-- 0096 - THE CLEANER: first-class MISCLASSIFIED case (2026-09-17).
-- A published record filed under "גן שעשועים" that its own name proves is something else: an indoor play
-- centre (regressions: "פאנקי מאנקי כפר יונה", "ג'ימבו פליי"), an amusement park, or not a place at all
-- (a playground-equipment company). Additive: one more allowed value in cleaner_cases.issue.
-- Rules: tools/import-tool/lib/playVenueClassifier.js (deterministic, HIGH only on unambiguous tokens).
begin;
alter table public.cleaner_cases drop constraint if exists cleaner_cases_issue_check;
alter table public.cleaner_cases add constraint cleaner_cases_issue_check
  check (issue in (
    'missing_location', 'unverified_location', 'incomplete_address', 'missing_coordinates', 'missing_venue',
    'missing_image', 'broken_image', 'missing_schedule', 'missing_region', 'missing_required_metadata',
    'low_quality_description', 'rejected_missing_address', 'settlement_review', 'missing_city', 'misclassified'
  ));
commit;
