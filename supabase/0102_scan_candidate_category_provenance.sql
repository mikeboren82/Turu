-- 0102 - Discovery classification provenance (Phase E, 2026-09-21).
--
-- *** PREPARED BUT NOT APPLIED. *** Additive only: two nullable columns on an audit table that no
-- application read path depends on. No row is touched, no existing column changes.
--
-- CONTEXT / WHY THIS IS SMALL:
-- The Phase D audit reported that the original scanner verdict was unrecoverable for existing rows.
-- Re-checking during Phase E showed that is only half true: settlement_scan_candidates ALREADY
-- stores place_kind alongside created_activity_id (see 0066), so activity -> original Google verdict
-- is a plain join and needs no schema change at all. Phase D could not see it because the table is
-- RLS-restricted to admin/trusted_uploader and the audit ran with the anon key.
--
-- So the provenance gap is narrower than reported. What is genuinely missing is only:
--   proposed_category   - the category the discovery classifier DERIVED from the verdict
--                         (placesDiscovery.resolvePlaceCategory). Without it we can reconstruct
--                         "Google said PARK_WITH_PLAYGROUND" but not "and we therefore chose פארק",
--                         which is the part that answers "was this row's category ever reviewed?".
--   classifier_version  - which ruleset produced that choice, so a future ruleset change can be
--                         scoped to the rows it actually affected instead of re-auditing everything.
--
-- Deliberately NOT a JSON blob: this table is the existing structured home for per-candidate
-- discovery provenance, and two typed columns keep it queryable.
begin;
alter table public.settlement_scan_candidates
  add column if not exists proposed_category text,
  add column if not exists classifier_version text;

comment on column public.settlement_scan_candidates.proposed_category is
  'Canonical category derived from place_kind by placesDiscovery.resolvePlaceCategory at discovery time. NULL for candidates that were rejected or routed to review before a category was chosen.';
comment on column public.settlement_scan_candidates.classifier_version is
  'Identifier of the discovery classification ruleset that produced proposed_category (e.g. "phase-e-2026-09-21"), so a later ruleset change can be scoped to affected rows.';
commit;
