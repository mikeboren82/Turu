-- 0089: THE CLEANER absorbs the retired settlement scanner's review backlog as a work source.
-- Additive only. The Cleaner case references the existing settlement_scan_review_cases row
-- (subject_kind='settlement_review', subject_id=review case id) - no copied queue; candidate/
-- decision history stays where it is. See tools/import-tool/THE-CLEANER.md ("Settlement review").

-- 1. Cleaner queue: a new subject kind + issue
alter table public.cleaner_cases drop constraint if exists cleaner_cases_subject_kind_check;
alter table public.cleaner_cases add constraint cleaner_cases_subject_kind_check
  check (subject_kind in ('activity', 'incoming', 'settlement_review'));
alter table public.cleaner_cases drop constraint if exists cleaner_cases_issue_check;
alter table public.cleaner_cases add constraint cleaner_cases_issue_check
  check (issue in (
    'missing_location', 'unverified_location', 'incomplete_address', 'missing_coordinates', 'missing_venue',
    'missing_image', 'broken_image', 'missing_schedule', 'missing_region', 'missing_required_metadata',
    'low_quality_description', 'rejected_missing_address', 'settlement_review'
  ));

-- 2. Review cases: who resolved (admin | cleaner), structured evidence, and an explicit "invalid /
--    irrelevant" terminal status (the three legacy statuses mean duplicate / new / held-for-later;
--    none of them says "this is not a Turu entity").
alter table public.settlement_scan_review_cases
  add column if not exists resolved_by text check (resolved_by in ('admin', 'cleaner')),
  add column if not exists resolution jsonb;
alter table public.settlement_scan_review_cases drop constraint if exists settlement_scan_review_cases_status_check;
alter table public.settlement_scan_review_cases add constraint settlement_scan_review_cases_status_check
  check (status in ('needs_review', 'approved_duplicate', 'approved_distinct', 'dismissed', 'resolved_invalid'));

-- 3. Append-only decision log accepts the new decision and records the resolver
alter table public.settlement_scan_review_decisions drop constraint if exists settlement_scan_review_decisions_decision_check;
alter table public.settlement_scan_review_decisions add constraint settlement_scan_review_decisions_decision_check
  check (decision in ('approved_duplicate', 'approved_distinct', 'dismissed', 'resolved_invalid'));
alter table public.settlement_scan_review_decisions
  add column if not exists resolver text check (resolver in ('admin', 'cleaner')),
  add column if not exists evidence jsonb;
