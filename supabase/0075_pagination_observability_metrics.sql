-- TuRu - pagination observability metrics for scan-settlement-gaps (pre-flight work requested
-- before Batch 13, 2026-09-13). Purely additive/observational - does not touch the existing
-- page-fetch logic, page limit (MAX_TEXT_SEARCH_PAGES stays 3), or billing behavior in any way.
--
-- settlements_with_extra_pages and an aggregate page count already exist (0066:
-- settlements_with_extra_pages, text_search_pages) and are already populated every batch - see
-- index.ts's stats.settlementsWithExtraPages/stats.textSearchPages. This migration only adds the
-- finer-grained per-page-number success/failure counters that did not exist yet: until now a
-- page 2/3 fetch failure was only ever a console.error inside fetchAllPaginatedResults
-- (_shared/placesDiscovery.ts) with no persisted count anywhere, so "did extra-page fetches ever
-- actually fail in production" was not answerable from settlement_scan_runs alone. All twelve
-- batches to date have had settlements_with_extra_pages=0 (no settlement's playground count has
-- crossed 20 yet), so these will all read 0 until that changes - expected, not a bug.
alter table public.settlement_scan_runs
  add column if not exists page_2_success integer not null default 0,
  add column if not exists page_3_success integer not null default 0,
  add column if not exists page_2_failure integer not null default 0,
  add column if not exists page_3_failure integer not null default 0;
