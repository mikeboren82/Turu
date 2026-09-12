-- TuRu - fix a real labeling defect found while reconciling Batch 4's metrics (2026-09-12):
-- scan-settlement-gaps/index.ts logged TWO semantically different things under the same
-- outcome string 'needs_review_uncertain_type':
--   1. matchAgainstExisting() returning NEEDS_REVIEW (a weaker duplicate-suspicion signal than
--      STRONG_MATCH, still matched against an existing activity - matched_existing_activity_id
--      is set)
--   2. a genuinely NEW_CANDIDATE whose place classification (PARK/UNCERTAIN) wasn't clear enough
--      to auto-approve - matched_existing_activity_id is always null here
-- These were only distinguishable after the fact by checking matched_existing_activity_id -
-- fine forensically, but a real design defect (the whole point of this audit trail is not
-- needing that kind of reconstruction). Splitting the constraint so future rows are unambiguous
-- from the outcome column alone.
alter table public.settlement_scan_candidates drop constraint settlement_scan_candidates_outcome_check;
alter table public.settlement_scan_candidates add constraint settlement_scan_candidates_outcome_check
  check (outcome in (
    'new', 'duplicate_confirmed', 'strong_match', 'needs_review_possible_duplicate',
    'needs_review_uncertain_type', 'needs_review_missing_address', 'rejected_distance',
    'rejected_not_relevant', 'rejected_out_of_bounds', 'rejected_missing_place_id'
  ));

-- Backfill Batch 4's existing rows so past data reads correctly too, not just future rows.
update public.settlement_scan_candidates
set outcome = 'needs_review_possible_duplicate'
where outcome = 'needs_review_uncertain_type' and matched_existing_activity_id is not null;
