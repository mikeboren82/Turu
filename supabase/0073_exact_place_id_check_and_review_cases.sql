-- TuRu - post-Batch-11 required fix (user's explicit instruction, 2026-09-12): Batch 11 hit
-- "duplicate key value violates unique constraint idx_activities_google_place_id" - the
-- in-memory `existing` snapshot scan-settlement-gaps builds once per batch can miss a real row
-- (stale snapshot / category-filter mismatch / a race with another process). The DB constraint
-- itself already prevented any actual duplicate row - this fix adds an application-level
-- authoritative pre-check (index.ts: fresh SELECT by google_place_id immediately before INSERT)
-- so the gap is caught and classified explicitly instead of surfacing only as a raw insert error.
--
-- 'duplicate_exact_place_id' - a new settlement_scan_candidates outcome, extending the same
-- CHECK constraint pattern as 0067/0068 (POSSIBLE_DUPLICATE's own introduction). Distinct from
-- the existing 'duplicate_confirmed' (MATCH_CONFIRMED via the in-memory snapshot) specifically so
-- the audit trail can show *which* layer caught a given duplicate - useful diagnostic signal,
-- not just a relabeling.
alter table public.settlement_scan_candidates drop constraint settlement_scan_candidates_outcome_check;
alter table public.settlement_scan_candidates add constraint settlement_scan_candidates_outcome_check
  check (outcome in (
    'new', 'duplicate_confirmed', 'duplicate_exact_place_id', 'strong_match', 'possible_duplicate',
    'needs_review_possible_duplicate', 'needs_review_uncertain_type', 'needs_review_missing_address',
    'rejected_distance', 'rejected_not_relevant', 'rejected_out_of_bounds', 'rejected_missing_place_id'
  ));

-- Repeated-review deduplication (user's explicit instruction): "פארק החורשות" vs "...לבון,
-- ת"א-יפו" was independently rediscovered and logged as a disconnected review item across
-- multiple batches (Batch 9, Batch 11) with no way to tell it was the same pair recurring. This
-- is a dedup ROLLUP keyed on (google_place_id, existing_activity_id), NOT a replacement for the
-- full per-detection history already kept in settlement_scan_candidates (every detection still
-- gets its own row there exactly as before) - detection_count/last_seen_at update on each repeat
-- detection; first_seen_at/first_batch_id/status are set once on first insert and deliberately
-- never touched again by the scanner (see index.ts's recordReviewCase - its UPDATE payload
-- excludes them), so a case an admin has already triaged doesn't silently reopen, and "when did
-- we first see this" is never lost. status starts 'needs_review' and can only move from there via
-- an admin action (none exists yet - not built as part of this fix, per explicit instruction: "do
-- not build a large UI yet... the important requirement for now is the underlying persistent
-- state") - the scanner itself never sets anything but 'needs_review' and never auto-resolves.
create table public.settlement_scan_review_cases (
  id uuid primary key default gen_random_uuid(),
  google_place_id text not null,
  existing_activity_id uuid not null,
  case_type text not null check (case_type in (
    'strong_match', 'possible_duplicate', 'needs_review_possible_duplicate',
    'same_street_review', 'duplicate_exact_place_id'
  )),
  candidate_name text,
  candidate_address text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  detection_count integer not null default 1,
  first_batch_id uuid references public.settlement_scan_runs(id),
  last_batch_id uuid references public.settlement_scan_runs(id),
  status text not null default 'needs_review' check (status in (
    'needs_review', 'approved_duplicate', 'approved_distinct', 'dismissed'
  )),
  latest_distance_m numeric,
  latest_name_similarity_score numeric,
  latest_street_similarity_score numeric,
  latest_address_similarity_score numeric,
  updated_at timestamptz not null default now(),
  unique (google_place_id, existing_activity_id)
);
create index idx_review_cases_existing on public.settlement_scan_review_cases(existing_activity_id);
create index idx_review_cases_status on public.settlement_scan_review_cases(status);

alter table public.settlement_scan_review_cases enable row level security;
-- read: same as every other settlement_scan_* audit table. write: service_role (the Edge
-- Function, upserting detection rollups) needs no policy (bypasses RLS) - but admin/
-- trusted_uploader also get UPDATE here (unlike the append-only audit tables) so a future admin
-- tool can move `status` off 'needs_review' without another migration; the scanner itself never
-- exercises that path.
create policy "settlement_scan_review_cases_read" on public.settlement_scan_review_cases for select
  using (public.is_admin() or public.is_trusted_uploader());
create policy "settlement_scan_review_cases_update" on public.settlement_scan_review_cases for update
  using (public.is_admin() or public.is_trusted_uploader())
  with check (public.is_admin() or public.is_trusted_uploader());
