-- 0095 - THE MONSTER wave 2: dense-listing recall funnel per scan (2026-09-17).
-- scan-source enumerates the repeated DOM cards of a listing page deterministically
-- (_shared/listingCards.ts) and records: cards_detected -> ai_returned -> past_filtered ->
-- cards_matched / cards_unaccounted -> recovery_calls / recovered -> rejected_* / twins_folded / capped.
-- Additive, nullable; NULL = the scan saw no card-structured page.
alter table public.source_scan_logs add column if not exists listing_metrics jsonb;
comment on column public.source_scan_logs.listing_metrics is 'Dense-listing recall funnel of this scan (THE MONSTER wave 2); null when no page had a repeated card structure.';
