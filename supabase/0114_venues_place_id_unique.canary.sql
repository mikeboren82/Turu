-- 0114 CANARY - run AFTER applying 0114. Persists NOTHING: the block always ends by raising, which rolls back
-- every canary row in any transaction mode. The raised message IS the report:
--   "0114 canary PASS ..."  -> plain ON CONFLICT (google_place_id) infers the unique index (what PostgREST emits for
--                              upsert onConflict:'google_place_id'), a repeated id is ignored, NULL ids never collide
--   "0114 canary FAIL ..."  -> investigate before resuming venue writers
--   npx supabase db query --linked -f supabase/0114_venues_place_id_unique.canary.sql
do $$
declare
  owners int; kept text; nulls int; returned int;
begin
  insert into public.venues (name_he, google_place_id, notes) values ('0114 canary first', '__0114_canary__', '0114 canary')
    on conflict (google_place_id) do nothing;
  with again as (
    insert into public.venues (name_he, google_place_id, notes) values ('0114 canary second', '__0114_canary__', '0114 canary')
      on conflict (google_place_id) do nothing returning id
  ) select count(*) into returned from again;
  insert into public.venues (name_he, google_place_id, notes) values ('0114 canary null a', null, '0114 canary'), ('0114 canary null b', null, '0114 canary')
    on conflict (google_place_id) do nothing;
  select count(*), min(name_he) into owners, kept from public.venues where google_place_id = '__0114_canary__';
  select count(*) into nulls from public.venues where notes = '0114 canary' and google_place_id is null;
  raise exception '0114 canary %: owners=% kept_name=% second_insert_returned=% null_rows=% (expected 1 / 0114 canary first / 0 / 2; always raised - nothing persisted)',
    case when owners = 1 and kept = '0114 canary first' and returned = 0 and nulls = 2 then 'PASS' else 'FAIL' end,
    owners, kept, returned, nulls;
end $$;
