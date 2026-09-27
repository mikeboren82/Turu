-- 0115 canary - run AFTER 0115_content_origin_google_legacy.sql. It ALWAYS ends in an error so that nothing it does
-- is persisted (the whole file is one transaction). PASS = the error message starts with "0115 canary PASS".
-- Any other error = FAIL (read the message). It touches one existing activity row and one location row inside the
-- rolled-back transaction only.
begin;

do $$
declare
  a_id uuid;
  l_id uuid;
  ok_clear boolean := false;
  ok_change boolean := false;
  ok_insert boolean := false;
  ok_loc boolean := false;
begin
  select id into a_id from public.activities where content_origin is null limit 1;
  select id into l_id from public.locations where content_origin is null limit 1;
  if a_id is null or l_id is null then raise exception '0115 canary FAIL: no unmarked activity/location to probe'; end if;

  -- CHECK: only the closed value
  begin
    update public.activities set content_origin = 'osm' where id = a_id;
    raise exception '0115 canary FAIL: CHECK accepted an unknown content_origin';
  exception when check_violation then null;
  end;

  -- null -> marker is the backfill's write and is allowed
  update public.activities set content_origin = 'google_places_legacy' where id = a_id;
  update public.locations set content_origin = 'google_places_legacy' where id = l_id;

  -- permanence: clearing / changing is refused
  begin
    update public.activities set content_origin = null where id = a_id;
  exception when check_violation then ok_clear := true;
  end;
  begin
    update public.locations set content_origin = null where id = l_id;
  exception when check_violation then ok_loc := true;
  end;
  -- an unrelated column update on a marked row still works (the trigger is column-scoped)
  update public.activities set name = name where id = a_id;
  -- the marker survives a source_url scrub
  update public.activities set source_url = null where id = a_id;
  if (select content_origin from public.activities where id = a_id) is distinct from 'google_places_legacy' then
    raise exception '0115 canary FAIL: marker lost after a source_url update';
  end if;

  -- a new row can never be born Google-origin
  begin
    insert into public.locations (name, content_origin) values ('0115 canary', 'google_places_legacy');
  exception when check_violation then ok_insert := true;
  end;

  -- the rollback escape hatch works only when set explicitly in the transaction
  perform set_config('turu.content_origin_rollback', 'on', true);
  update public.activities set content_origin = null where id = a_id;
  ok_change := (select content_origin from public.activities where id = a_id) is null;
  perform set_config('turu.content_origin_rollback', '', true);

  if not (ok_clear and ok_loc and ok_insert and ok_change) then
    raise exception '0115 canary FAIL: clear=% loc=% insert=% rollback_hatch=%', ok_clear, ok_loc, ok_insert, ok_change;
  end if;
  raise exception '0115 canary PASS (nothing persisted)';
end $$;

rollback;
