-- 0107 - THE CLEANER: first-class NOT_INDEPENDENTLY_ACTIONABLE case (Entity Granularity Phase 1,
-- 2026-09-22). Additive only: one more allowed value in cleaner_cases.issue.
--
-- *** STATUS: APPLIED in production ('not_independently_actionable' is in the live cleaner_cases.issue
-- CHECK; confirmed by the 2026-09-25 repo-hygiene forensic). *** Originally prepared as safe to apply at
-- any time - it widens an allowed-value list, it does not touch a single row. Applying it is what
-- turns on DISCOVERY of this issue on the existing catalogue; until then, the ingestion-time gate
-- (supabase/functions/_shared/granularity.ts, scan-source) already prevents NEW wrapper/sub-area
-- rows from auto-publishing regardless of this migration's status - this file only concerns
-- HISTORICAL cleanup, which this phase deliberately does not touch (see project memory: the 5 known
-- regression rows - 4 Midbarium zones + one Safari wrapper - are read-only fixtures for this phase,
-- not something this task archives).
--
-- The READ-ONLY Entity Granularity forensic found a missing THIRD axis: TURU already has category
-- (WHAT) and offering_access_type (WHO/HOW, 0106) but nothing asks "is this an independently
-- actionable thing?". A row failing that question is either an INDEX/WRAPPER (a list of several
-- offerings mistaken for one, e.g. "פעילויות בספארי" with a synthetic 7-weekday recurring schedule)
-- or a SUB-AREA/ZONE (a part of a larger destination mistaken for its own destination, e.g. the 4
-- Midbarium zone rows, each describing itself as "אזור בפארק..." with no price/hours of its own).
--
-- Expected resolution directions once a case is opened (Section 6 of the task) - all through
-- EXISTING plumbing, no new archive_reason needed:
--   archive as wrong_entity_type   the row is confirmed a wrapper/sub-area with no salvageable
--                                  independent identity (already in the 0105 archive_activity
--                                  allowlist - lib/activityArchive.js)
--   consolidate into parent        the row's useful fields (schedule, images) are merged onto the
--                                  parent מקום_קבוע via lib/activitySourceMerge.js's non-destructive
--                                  merge, then archived as duplicate_of_existing_activity
--   convert to parent metadata     the row's description becomes free-text evidence on the parent
--                                  (amenities/description), never a new column
--   human review                  when the Cleaner cannot safely identify the parent/action -
--                                  Section 7 explicitly forbids guessing a parent_activity_id
begin;
alter table public.cleaner_cases drop constraint if exists cleaner_cases_issue_check;
alter table public.cleaner_cases add constraint cleaner_cases_issue_check
  check (issue in (
    'missing_location', 'unverified_location', 'incomplete_address', 'missing_coordinates', 'missing_venue',
    'missing_image', 'broken_image', 'missing_schedule', 'missing_region', 'missing_required_metadata',
    'low_quality_description', 'rejected_missing_address', 'settlement_review', 'missing_city', 'misclassified',
    'city_not_canonical', 'not_independently_actionable'
  ));
commit;
