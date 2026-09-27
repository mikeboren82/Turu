-- 0115 - permanent Google-origin provenance marker on activities and locations (2026-09-27). NOT APPLIED.
--
-- WHY. Until now activities.source_url (a Google Maps URL) was the ONLY durable sign that a row was created from
-- Google Places-derived catalogue facts. Every guard keys on it: the client map/source-link filter, the Cleaner hold,
-- enrich-playground-addresses, the place-id backfill. The legacy scrub must null that source_url, and orphan
-- `locations` rows never had any sign at all. Without a second marker the scrubbed rows would become invisible to
-- every guard. This marker answers one question: "was this row CREATED from Google Places-derived facts?"
--
-- SCHEMA DELTA (additive; no data change, no RLS/grant change):
--   + activities.content_origin text NULL   CHECK (null | 'google_places_legacy')
--   + locations.content_origin  text NULL   CHECK (null | 'google_places_legacy')   (own marker: orphan locations
--                                             have no activity to inherit from; never derived from an activity row)
--   + partial indexes on both (content_origin is not null) - the scrub phases select by it
--   + trigger _content_origin_is_permanent on both: the marker is HISTORICAL provenance, so once set it cannot be
--     cleared or changed. A later re-sourcing, merge, rename or field scrub never removes it. INSERT with a marker is
--     refused as well: no writer creates Google-origin rows (GOOGLE_PLACES_CONTENT_PERSISTENCE=false). The frozen
--     backfill (tools/import-tool/google-origin-backfill.js) is its only writer (null -> marker, UPDATE).
--     Escape hatch for the backfill's own rollback only: `set local turu.content_origin_rollback = 'on'` inside
--     that transaction.
--
-- WHY NOT an existing column:
--   activities.source      'manual' | 'user_submitted' | 'scraped' - Google rows are 'scraped', like OSM and
--                          municipal rows. It cannot tell them apart without a new value, and every writer and
--                          filter would then have to learn that value.
--   activities.source_url  this is the value the scrub removes.
--   activities.source_id   an FK to sources, ON DELETE SET NULL. It is rewritten by re-sourcing, and scan-source
--                          uses it for its missing-from-source logic. Not durable, not dedicated.
--   activities.google_place_id  216 independent OSM/municipal rows carry one too (place-id-only reconciliation is
--                          allowed). A place id says nothing about where the row's FACTS came from.
--   activity_sources       the scrub rewrites its Maps page_url rows (-> urn:google-place:<id>), and merges move
--                          them between activities. It is evidence, not a row-level marker.
--   a boolean is_google    works, but a closed text value leaves room for a second provenance class without another
--                          migration, and it reads unambiguously in SQL, logs and JSON. The CHECK keeps the value set
--                          closed, so no free text can drift in.
--
-- BACKWARD COMPATIBILITY. NULL for every existing row, so every current reader behaves exactly as before, and the
-- classifiers fall back to the Maps source_url (lib/googlePlacesPolicy.js isGoogleOriginActivity = marker OR Maps
-- URL). The 216 independent rows that only carry google_place_id stay NULL: nothing here reads google_place_id.
--
-- ORDERING (hard gate). Apply 0115 BEFORE merging or deploying code that SELECTs content_origin
-- (google-origin-provenance-hardening-2026-09-27): the client list/detail queries, the Cleaner and the Python
-- backfill select the column, and PostgREST answers 400 for an unknown column. Applying it first is harmless for the
-- code live today (it never names the column).
--
-- NOT CONCURRENTLY. `supabase db query -f` runs the file as one implicit transaction. activities is ~6k rows and
-- locations ~6k: adding a nullable column is metadata-only, the CHECK validation and the partial index builds scan in
-- milliseconds. lock_timeout makes the file fail fast (and roll back) instead of queueing behind a writer.
--
-- APPLY PROCEDURE (manual - there is no migration ledger):
--   1. no Monster / Cleaner run in progress
--   2. npx supabase db query --linked -f supabase/0115_content_origin_google_legacy.sql
--   3. select table_name, column_name, data_type, is_nullable from information_schema.columns
--        where table_schema='public' and column_name='content_origin';                    -> 2 rows, text, YES
--      select count(*) from activities where content_origin is not null;                   -> 0
--      select count(*) from locations  where content_origin is not null;                   -> 0
--   4. npx supabase db query --linked -f supabase/0115_content_origin_google_legacy.canary.sql
--        -> ALWAYS ends in an error; its message must start "0115 canary PASS" (nothing is persisted)
--   5. only then merge/deploy the code; the marker backfill (P3) is a separate, later, owner-approved step
--
-- ROLLBACK (only BEFORE the P3 backfill; forbidden after the source_url scrub - it would make scrubbed rows invisible):
--   begin;
--   drop trigger if exists trg_activities_content_origin_permanent on public.activities;
--   drop trigger if exists trg_locations_content_origin_permanent on public.locations;
--   drop function if exists public._content_origin_is_permanent();
--   drop index if exists public.idx_activities_content_origin;
--   drop index if exists public.idx_locations_content_origin;
--   alter table public.activities drop column if exists content_origin;
--   alter table public.locations drop column if exists content_origin;
--   commit;
begin;

set local lock_timeout = '5s';

alter table public.activities
  add column if not exists content_origin text
    constraint activities_content_origin_chk check (content_origin is null or content_origin = 'google_places_legacy');

alter table public.locations
  add column if not exists content_origin text
    constraint locations_content_origin_chk check (content_origin is null or content_origin = 'google_places_legacy');

comment on column public.activities.content_origin is
  'Permanent historical provenance (0115). google_places_legacy = the row was created from Google Places-derived catalogue facts. Set only by the frozen backfill; never cleared, never inferred from google_place_id / coordinates / name / source_url. NULL = not Google-origin (or not yet backfilled: then a Maps source_url still identifies it).';
comment on column public.locations.content_origin is
  'Permanent historical provenance (0115). google_places_legacy = the location row holds Google Places-derived facts (name/address/city/coordinates), including orphan rows no activity references. Own marker; never copied from an activity by a writer.';

create index if not exists idx_activities_content_origin on public.activities (content_origin) where content_origin is not null;
create index if not exists idx_locations_content_origin on public.locations (content_origin) where content_origin is not null;

create or replace function public._content_origin_is_permanent() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('turu.content_origin_rollback', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.content_origin is not null then
      raise exception '%.content_origin: a new row cannot be created Google-origin (GOOGLE_PLACES_CONTENT_PERSISTENCE=false)', tg_table_name
        using errcode = 'check_violation';
    end if;
  elsif old.content_origin is not null and new.content_origin is distinct from old.content_origin then
    raise exception '%.content_origin is permanent historical provenance (%): it cannot be cleared or changed', tg_table_name, old.content_origin
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists trg_activities_content_origin_permanent on public.activities;
create trigger trg_activities_content_origin_permanent
  before insert or update of content_origin on public.activities
  for each row execute function public._content_origin_is_permanent();

drop trigger if exists trg_locations_content_origin_permanent on public.locations;
create trigger trg_locations_content_origin_permanent
  before insert or update of content_origin on public.locations
  for each row execute function public._content_origin_is_permanent();

commit;
