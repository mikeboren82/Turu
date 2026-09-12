-- TuRu - post-Batch-8 evidence-model upgrade (user's explicit instruction, 2026-09-12): the
-- single full-address word-overlap score (0070) can look misleadingly high when the only real
-- overlap between two addresses is the city name - observed in practice in Batch 8 ("פארק
-- החורשות", no street at all, scored 0.75 against an existing address purely from sharing "תל
-- אביב יפו"). Not removed (still address_similarity_score) - these are additive, more granular
-- fields so a reviewer can tell "same street/house number" (strong evidence) apart from
-- "same city only" (weak evidence) instead of one blended number. Only POSSIBLE_DUPLICATE rows
-- populate these (see matchAgainstExisting in _shared/placesDiscovery.ts) - every other outcome
-- leaves them null, same convention as name_similarity_score/address_similarity_score (0070).
--
-- source/source_url - explicit instruction to preserve "source" and "source URL" in the audit
-- trail per candidate row, not only on the incoming_activities review-queue row (page_url) or
-- the final activities row (source_url) once/if approved - this table is the one audit trail
-- that covers every candidate regardless of outcome (including rejected/duplicate ones, which
-- never get an incoming_activities or activities row at all).
alter table public.settlement_scan_candidates
  add column if not exists street_similarity_score numeric,
  add column if not exists house_number_match numeric,
  add column if not exists city_match boolean,
  add column if not exists neighborhood_match boolean,
  add column if not exists source text not null default 'google_places',
  add column if not exists source_url text;
