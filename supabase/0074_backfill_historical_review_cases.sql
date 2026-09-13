-- TuRu - one-time, idempotent backfill of settlement_scan_review_cases (0073) from the full
-- detection history already sitting in settlement_scan_candidates (0066-0071). Pre-flight work
-- requested before Batch 13, explicit instruction (2026-09-13): the review-case rollup only
-- started writing live during Batch 12 - every strong_match/possible_duplicate/
-- needs_review_possible_duplicate/duplicate_exact_place_id detection from Batches 1-11 (and the
-- pre-rollup portion of Batch 12 itself) has a full row in settlement_scan_candidates but never
-- got rolled up, so a pair rediscovered across many batches (e.g. "פארק החורשות" vs
-- "...לבון, תל אביב-יפו", independently logged in both Batch 9 and Batch 11 per
-- project_session_2026-09-11_status) looked like a single first-time detection instead of a
-- recurring one.
--
-- Source is settlement_scan_candidates ONLY, exactly as instructed - NOT
-- settlement_scan_same_street_reviews. This intentionally does not backfill historical
-- 'same_street_review' cases (that table has its own historical gap for Batch 11's two live
-- SAME_STREET_REVIEW hits, predating recordReviewCase's same-street support in index.ts) -
-- flagged separately in this batch's pre-flight report, not addressed here without being asked.
--
-- Read/write safety:
--   - Never touches settlement_scan_candidates (read-only source) or public.activities.
--   - Never invents a detection: every row counted here is a real settlement_scan_candidates row
--     that already exists (count(*) over an immutable historical table), nothing synthesized.
--   - case_type/candidate_name/candidate_address/last_batch_id/latest_*_score always take the
--     value from the chronologically LATEST matching candidates row for that pair - this mirrors
--     recordReviewCase's own "latest always wins, first_seen_at/status never regress" semantics
--     in index.ts exactly, so a re-run (or Batch 13 running live afterwards) can never see this
--     backfill's output as inconsistent with the live upsert logic.
--   - `status` is set only on first INSERT (default 'needs_review', the same default the live
--     code has always used) and is NEVER included in the ON CONFLICT UPDATE - a case an admin may
--     have already triaged live during/after Batch 12 can never be silently reopened by this
--     backfill.
--   - Idempotent by construction, not by a "have I run before" flag: every value written is
--     recomputed fresh from settlement_scan_candidates each run. Running this twice recomputes
--     the exact same detection_count/timestamps/evidence both times (the source table hasn't
--     changed), so nothing double-counts - verify with the SELECT at the bottom of this file.
with relevant_candidates as (
  select
    google_place_id,
    matched_existing_activity_id as existing_activity_id,
    outcome,
    name as candidate_name,
    formatted_address as candidate_address,
    distance_from_settlement_m,
    name_similarity_score,
    street_similarity_score,
    address_similarity_score,
    batch_id,
    created_at
  from public.settlement_scan_candidates
  where matched_existing_activity_id is not null
    and google_place_id is not null
    -- exactly the four settlement_scan_candidates outcomes that ever map to a review_cases
    -- case_type (0073's check constraint) - 'duplicate_confirmed' (certain MATCH_CONFIRMED) is
    -- deliberately excluded, same as the live recordReviewCase call sites in index.ts.
    and outcome in ('strong_match', 'possible_duplicate', 'needs_review_possible_duplicate', 'duplicate_exact_place_id')
),
ranked as (
  select
    *,
    row_number() over (partition by google_place_id, existing_activity_id order by created_at asc, batch_id asc) as rn_first,
    row_number() over (partition by google_place_id, existing_activity_id order by created_at desc, batch_id desc) as rn_last
  from relevant_candidates
),
rollup as (
  select
    google_place_id,
    existing_activity_id,
    count(*) as detection_count,
    min(created_at) as first_seen_at,
    max(created_at) as last_seen_at,
    -- max(uuid) doesn't exist in Postgres - cast to text for the aggregate (exactly one non-null
    -- value survives the filter per group thanks to row_number(), so min/max/either give the same
    -- single answer either way; text avoids needing a uuid ordering operator at all) and back.
    max(case when rn_first = 1 then batch_id::text end)::uuid as first_batch_id,
    max(case when rn_last = 1 then batch_id::text end)::uuid as last_batch_id,
    max(case when rn_last = 1 then outcome end) as case_type,
    max(case when rn_last = 1 then candidate_name end) as candidate_name,
    max(case when rn_last = 1 then candidate_address end) as candidate_address,
    max(case when rn_last = 1 then distance_from_settlement_m end) as latest_distance_m,
    max(case when rn_last = 1 then name_similarity_score end) as latest_name_similarity_score,
    max(case when rn_last = 1 then street_similarity_score end) as latest_street_similarity_score,
    max(case when rn_last = 1 then address_similarity_score end) as latest_address_similarity_score
  from ranked
  group by google_place_id, existing_activity_id
)
insert into public.settlement_scan_review_cases (
  google_place_id, existing_activity_id, case_type, candidate_name, candidate_address,
  first_seen_at, last_seen_at, detection_count, first_batch_id, last_batch_id,
  latest_distance_m, latest_name_similarity_score, latest_street_similarity_score, latest_address_similarity_score,
  status, updated_at
)
select
  google_place_id, existing_activity_id, case_type, candidate_name, candidate_address,
  first_seen_at, last_seen_at, detection_count, first_batch_id, last_batch_id,
  latest_distance_m, latest_name_similarity_score, latest_street_similarity_score, latest_address_similarity_score,
  'needs_review', now()
from rollup
on conflict (google_place_id, existing_activity_id) do update set
  -- detection_count/first_seen_at/last_seen_at/evidence/last_batch_id: settlement_scan_candidates
  -- is always a superset of whatever produced the existing live row (every recordReviewCase call
  -- in index.ts has a matching logCandidate call in the same code path, same batch, same pair) -
  -- so the freshly recomputed rollup value is always >= what's already stored. Safe to overwrite
  -- outright for these; first_seen_at/first_batch_id still take the earlier of the two explicitly
  -- (least/case-when) purely as defence in depth, not because it's expected to differ downward.
  detection_count = excluded.detection_count,
  first_seen_at = least(public.settlement_scan_review_cases.first_seen_at, excluded.first_seen_at),
  last_seen_at = greatest(public.settlement_scan_review_cases.last_seen_at, excluded.last_seen_at),
  case_type = excluded.case_type,
  candidate_name = excluded.candidate_name,
  candidate_address = excluded.candidate_address,
  last_batch_id = excluded.last_batch_id,
  first_batch_id = case
    when excluded.first_seen_at < public.settlement_scan_review_cases.first_seen_at
    then excluded.first_batch_id
    else public.settlement_scan_review_cases.first_batch_id
  end,
  latest_distance_m = excluded.latest_distance_m,
  latest_name_similarity_score = excluded.latest_name_similarity_score,
  latest_street_similarity_score = excluded.latest_street_similarity_score,
  latest_address_similarity_score = excluded.latest_address_similarity_score,
  updated_at = now();
  -- status is intentionally absent from this SET list - never touched on conflict.

-- Verification query (read-only, run after the INSERT above to produce the report numbers):
-- select count(*) as total_review_cases,
--        count(*) filter (where detection_count > 1) as recurring_cases
-- from public.settlement_scan_review_cases;
