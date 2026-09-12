-- TuRu - add 'possible_duplicate' as its own distinct outcome value (2026-09-12, three-zone
-- matching model, post-Batch-6 "פארק עירוני 76" case). Per explicit instruction: keep
-- POSSIBLE_DUPLICATE conceptually separate from STRONG_MATCH - do not overload either the
-- matching outcome type or this audit-trail's outcome column.
alter table public.settlement_scan_candidates drop constraint settlement_scan_candidates_outcome_check;
alter table public.settlement_scan_candidates add constraint settlement_scan_candidates_outcome_check
  check (outcome in (
    'new', 'duplicate_confirmed', 'strong_match', 'possible_duplicate',
    'needs_review_possible_duplicate', 'needs_review_uncertain_type', 'needs_review_missing_address',
    'rejected_distance', 'rejected_not_relevant', 'rejected_out_of_bounds', 'rejected_missing_place_id'
  ));
