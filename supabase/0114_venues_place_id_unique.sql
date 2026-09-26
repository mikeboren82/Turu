-- 0114 - venues.google_place_id becomes external identity: at most ONE venues row per non-null id (2026-09-26).
--
-- SCHEMA DELTA (venues only; no data change, no RLS/grant change):
--   + CHECK venues_google_place_id_trimmed_chk   non-null ids are trimmed and non-empty ('' must never be an "id"
--                                                  two unrelated venues could share)
--   + UNIQUE INDEX idx_venues_google_place_id_unique ON venues(google_place_id)   NON-partial on purpose
--   - INDEX idx_venues_google_place_id (0076, non-unique partial) - redundant once the unique index exists
--
-- WHY NON-PARTIAL. Postgres unique indexes treat NULLs as distinct, so UNIQUE(google_place_id) already means
-- "unique whenever non-null" and any number of venues may have no id. A PARTIAL index (WHERE ... IS NOT NULL) is
-- only an ON CONFLICT arbiter when the statement repeats its predicate, which PostgREST's on_conflict= cannot
-- express; the non-partial index is inferred by plain ON CONFLICT (google_place_id), i.e. by supabase-js
-- upsert({ onConflict: 'google_place_id', ignoreDuplicates: true }) in tools/import-tool/lib/venuePlaceId.js.
--
-- WHY. SELECT-before-INSERT is not atomic: two writers (retry after an uncertain response, parallel coverage runs,
-- two admin sessions) can both see "no venue" and both insert. Writers + merge contract: lib/venuePlaceId.js.
-- Merge invariant (server.js /api/venues/merge): exactly one row owns an id, active OR merged - the merge clears
-- the loser's id before giving it to the keeper, and refuses when both carry different ids.
--
-- NOT CONCURRENTLY. `supabase db query -f` runs a multi-statement file as one implicit transaction (probed
-- 2026-09-26), where CREATE INDEX CONCURRENTLY is an error. venues is ~100 rows: the plain build holds its
-- locks for milliseconds. lock_timeout makes the file fail fast (and roll back) instead of queueing behind a
-- writer and blocking venue reads while it waits.
-- ORDER. Unique index is created before the old index is dropped, inside one transaction: any failure (duplicate,
-- blank, lock timeout) rolls back everything and the old index is untouched. Re-running after success fails
-- harmlessly ("already exists") and rolls back.
--
-- APPLY PROCEDURE (manual - there is no migration ledger):
--   1. pause venue writers: admin server (POST /api/venues, /api/venues/merge), Cleaner (venue cluster step),
--      propose-venues / escalate-venue / seed-venues-and-sources CLIs; no coverage apply running
--   2. npx supabase db query --linked -f supabase/0114_venues_place_id_unique.preflight.sql   -> verdict = PASS
--   3. same output: old_index_def is the 0076 partial index (or null); no unexpected unique index / constraint
--   4. npx supabase db query --linked -f supabase/0114_venues_place_id_unique.sql
--   5. select indexname, indexdef from pg_indexes where schemaname='public' and tablename='venues';
--        -> CREATE UNIQUE INDEX idx_venues_google_place_id_unique ON public.venues USING btree (google_place_id)
--        -> idx_venues_google_place_id absent
--   6. npx supabase db query --linked -f supabase/0114_venues_place_id_unique.canary.sql
--        -> ALWAYS ends in an error; its message must start "0114 canary PASS" (nothing is persisted)
--   7. resume writers; record the application (date, operator) in project notes
--
-- ROLLBACK (restores the pre-0114 schema exactly):
--   begin;
--   create index if not exists idx_venues_google_place_id on public.venues(google_place_id) where google_place_id is not null;
--   drop index if exists public.idx_venues_google_place_id_unique;
--   alter table public.venues drop constraint if exists venues_google_place_id_trimmed_chk;
--   commit;
-- Rollback does NOT revert code: ensureVenueByPlaceId then gets 42P10 from PostgREST and REFUSES
-- (VENUE_PLACE_ID_INDEX_MISSING, HTTP 503 on the admin API) rather than creating a duplicate. It also does not
-- remove duplicates created after rollback by writers that bypass the helper.
--
-- FOLLOW-UP (not here): 0115 venues.external_ids jsonb - separate additive migration; not needed for the first
-- bounded coverage pilot, required before nationwide refresh / diff / closure workflows. Until it exists a merge
-- that moves a place id keeps no copy on the loser (merged_into still links the pair).
begin;

set local lock_timeout = '5s';

do $$
begin
  if exists (select 1 from public.venues where google_place_id is not null group by google_place_id having count(*) > 1) then
    raise exception '0114 aborted: duplicate venues.google_place_id values - run 0114_venues_place_id_unique.preflight.sql';
  end if;
  if exists (select 1 from public.venues where google_place_id is not null and (google_place_id = '' or google_place_id <> btrim(google_place_id))) then
    raise exception '0114 aborted: blank or untrimmed venues.google_place_id values - run 0114_venues_place_id_unique.preflight.sql';
  end if;
end $$;

alter table public.venues
  add constraint venues_google_place_id_trimmed_chk
  check (google_place_id is null or (google_place_id <> '' and google_place_id = btrim(google_place_id)));

create unique index idx_venues_google_place_id_unique on public.venues (google_place_id);

drop index if exists public.idx_venues_google_place_id;

commit;
