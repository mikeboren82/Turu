-- TuRu - post-Batch-10 improvements (user's explicit instructions, 2026-09-12):
--
-- 1. Canonical settlement normalization. Batch 10 found city_match=false for "שוהם" vs "שהם" -
--    the same real settlement (שוהם, settlement_id 1304 in public.settlements - "שהם" is a
--    common misspelling, not a distinct settlement in the official CBS list). Per explicit
--    instruction: do NOT solve this with generic fuzzy matching - use the existing canonical
--    settlements table (0063) as the source of truth, plus a small, explicit, curated alias
--    table for genuine spelling variants that aren't already handled by normalizeCityName's
--    deterministic hyphen/קריה normalization (e.g. "תל אביב-יפו" already normalizes to match
--    "תל אביב - יפו" without needing an alias at all - only true respellings like שהם/שוהם need
--    one). Read-open (public settlement data, same policy as 0063), write restricted to
--    admin/trusted_uploader so new aliases can be curated without a deploy.
create table public.settlement_aliases (
  alias_name text primary key,
  settlement_id text not null references public.settlements(settlement_id) on delete cascade,
  notes text,
  created_at timestamptz not null default now()
);
alter table public.settlement_aliases enable row level security;
create policy "settlement_aliases_read" on public.settlement_aliases for select using (true);
create policy "settlement_aliases_write" on public.settlement_aliases for all
  using (public.is_admin() or public.is_trusted_uploader())
  with check (public.is_admin() or public.is_trusted_uploader());

insert into public.settlement_aliases (alias_name, settlement_id, notes) values
  ('שהם', '1304', 'Common misspelling of שוהם seen in Google Places data (Batch 10) - not a distinct settlement in the official CBS list.');

-- 2. SAME_STREET_REVIEW - a separate, purely advisory signal (explicit instruction: "This must
--    NOT mean DUPLICATE"). Batch 10 found two NEW_CANDIDATE activities 135.7m/152.9m from an
--    existing activity on the same street in the same settlement - outside the 0-50m duplicate
--    zones (correctly so; the radius itself is NOT being changed), but worth a human glance.
--    Deliberately its OWN table, not a new settlement_scan_candidates.outcome value - a
--    same-street flag doesn't replace or override that candidate's real classification (it can
--    still become 'new'/imported, or 'needs_review_uncertain_type', etc. - this is additional
--    evidence alongside that, not instead of it). Never referenced by any merge/delete/update
--    logic - existing_activity_id here is context for a human reviewer, not a target.
create table public.settlement_scan_same_street_reviews (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references public.settlement_scan_runs(id) on delete cascade,
  candidate_settlement_id text not null,
  candidate_settlement_name text,
  google_place_id text,
  candidate_name text,
  candidate_address text,
  candidate_lat numeric,
  candidate_lon numeric,
  candidate_house_number text,
  existing_activity_id uuid not null,
  existing_house_number text,
  canonical_settlement_id text,
  canonical_settlement_name text,
  normalized_street text not null,
  distance_m numeric not null,
  name_similarity_score numeric,
  street_similarity_score numeric,
  ceiling_m numeric not null,
  reason text not null default 'SAME_STREET_REVIEW',
  created_at timestamptz not null default now()
);
create index idx_same_street_reviews_batch on public.settlement_scan_same_street_reviews(batch_id);
create index idx_same_street_reviews_existing on public.settlement_scan_same_street_reviews(existing_activity_id);

alter table public.settlement_scan_same_street_reviews enable row level security;
create policy "settlement_scan_same_street_reviews_read" on public.settlement_scan_same_street_reviews for select
  using (public.is_admin() or public.is_trusted_uploader());

-- Configurable ceiling (explicit instruction: "Make the threshold configurable so we can tune it
-- later based on real data") - read by scan-settlement-gaps alongside the other
-- settlement_scan_* settings, default 200m as suggested. Changing this value alone can never
-- create/merge/delete anything - it only widens or narrows which NEW_CANDIDATE rows get an
-- advisory SAME_STREET_REVIEW row alongside their normal (unaffected) classification.
insert into public.automation_settings (key, value) values
  ('settlement_scan_same_street_ceiling_m', '200')
on conflict (key) do nothing;
