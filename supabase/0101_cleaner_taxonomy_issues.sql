-- 0101 - THE CLEANER: taxonomy/data-integrity case types (Phase E, 2026-09-21).
--
-- *** PREPARED BUT NOT APPLIED. *** Additive only, and safe to apply at any time: it widens an
-- allowed-value list, it does not touch a single row. Listed separately in the Phase E report.
--
-- Four new issue types, each corresponding to a concrete failure class the Phase D catalogue audit
-- measured rather than guessed at:
--
--   category_noncanonical
--     activities.category holds a value that is not in constants/categoryValues.json. Phase D found
--     two ('גן חיות', 'חדשנות בחקלאות'), both written by the import tool's AI extraction path, which
--     handed CATEGORY_VALUES to the model in the prompt but never checked the model's answer.
--     That hole is closed going forward (tools/import-tool/lib/categoryValidation.js); this case
--     type is for the rows already in the catalogue.
--
--   category_primary_experience_mismatch
--     the stored category contradicts the record's own evidence under the PRIMARY EXPERIENCE rule -
--     e.g. פארק שרונה (a 21-dunam municipal park with lawns) stored as the attraction-complex value,
--     or מדבריום (an animal destination) stored as פארק / פארק שעשועים.
--
--   scanner_place_kind_mismatch
--     the stored category disagrees with the original Google Places verdict recorded in
--     settlement_scan_candidates.place_kind for the same activity. Before Phase E every imported row
--     was written as 'גן שעשועים' regardless of whether the verdict was PLAYGROUND or
--     PARK_WITH_PLAYGROUND, so this is how those rows become findable again.
--
--   possible_coordinate_duplicate
--     two or more approved rows at effectively the same coordinates with a corroborating identity
--     signal (same domain / overlapping names). The Midbarium triplicate - three rows at identical
--     coordinates with three different names AND three different categories - defeated every
--     name-based and category-based dedupe axis simultaneously and survived.
--
-- NOTE: opening a case does not authorise a write. These are investigation queues; the Cleaner's
-- write guards are unchanged by this migration.
begin;
alter table public.cleaner_cases drop constraint if exists cleaner_cases_issue_check;
alter table public.cleaner_cases add constraint cleaner_cases_issue_check
  check (issue in (
    'missing_location', 'unverified_location', 'incomplete_address', 'missing_coordinates', 'missing_venue',
    'missing_image', 'broken_image', 'missing_schedule', 'missing_region', 'missing_required_metadata',
    'low_quality_description', 'rejected_missing_address', 'settlement_review', 'missing_city', 'misclassified',
    'city_not_canonical',
    'category_noncanonical', 'category_primary_experience_mismatch',
    'scanner_place_kind_mismatch', 'possible_coordinate_duplicate'
  ));
commit;
