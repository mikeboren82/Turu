-- TuRu - event fingerprint: cheap exact pre-check for dated/recurring events, the same role
-- idx_activities_google_place_id plays for places. Computed in app code
-- (_shared/matching.ts computeEventFingerprint, mirrored in tools/import-tool) from
-- normalized name | venue_id-or-normalized-city | one_time_date-or-sorted-days | start_time.
-- NOT unique: two sources may word the same event slightly differently; it is a fast first pass
-- before the similarity/venue matching, never the only signal. Backfilled by
-- tools/import-tool/backfill-fingerprints.js (only ~100 activities have schedules today).
alter table public.activities add column if not exists event_fingerprint text;
create index if not exists idx_activities_event_fingerprint on public.activities(event_fingerprint) where event_fingerprint is not null;
