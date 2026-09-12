-- TuRu - safety-requirement hardening before resuming the settlement-gap scan nationwide
-- (2026-09-12, user's explicit Batch 8 pre-flight list, item 3): for the (30m,50m]
-- POSSIBLE_DUPLICATE zone, the audit trail must carry supporting evidence (name/address
-- similarity), not just distance + outcome - advisory only, never used to change routing
-- (matchAgainstExisting's three-zone thresholds in _shared/placesDiscovery.ts are untouched).
-- Nullable/numeric because only POSSIBLE_DUPLICATE rows populate these today (see index.ts) -
-- every other outcome leaves both null, which is intentional, not a data-quality gap.
alter table public.settlement_scan_candidates
  add column if not exists name_similarity_score numeric,
  add column if not exists address_similarity_score numeric;
