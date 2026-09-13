-- TuRu - "local relay" fetch strategy for sources that block the edge runtime's cloud IPs.
--
-- Observed in the first Phase-1 backfill (2026-09-13): 13 of the highest-value sources - mostly
-- municipal calendars (הרצליה, מודיעין, גבעתיים, חיפה 482/Incapsula, גני תקווה, אבן יהודה, לב השרון,
-- נוף הגליל) plus מדעטק, G-City, חוויות רחובות, ספריית כפר סבא - answer 403/WAF or time out for the
-- Supabase edge function, while serving full HTML to a normal Israeli IP (verified locally).
-- Mitigation without bypassing anything: the fetch stage for such a source runs on the admin
-- machine (tools/import-tool/relay-scan.js, normal browser-like fetch from a residential IP) and the
-- already-extracted page TEXT (not raw HTML) is handed to the same scan-source function, which runs
-- the identical hash/AI/dedupe/provenance/health pipeline. The edge function keeps sole ownership of
-- all writes; the relay only supplies page content.
--
-- 1. strategy 'local_relay' - the cron scheduler skips these (a cloud fetch would fail again);
--    relay-scan.js picks them up when they are due.
alter table public.sources drop constraint if exists sources_strategy_check;
alter table public.sources add constraint sources_strategy_check check (strategy in (
  'generic_html', 'json_ld_event', 'rss', 'ics', 'api_json', 'wordpress_events', 'municipal_calendar', 'chain_events_page', 'local_relay'
));

create or replace function public._scan_due_sources_cron()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  src record;
  scanning_on boolean;
begin
  select coalesce((value)::boolean, true) into scanning_on
    from public.automation_settings where key = 'scanning_enabled';
  if scanning_on is false then
    return;
  end if;
  for src in
    select id from public.sources
    where is_active and next_scan_at <= now() and strategy <> 'local_relay'
    order by priority desc, next_scan_at asc
    limit 20
  loop
    perform public._dispatch_source_scan(src.id);
  end loop;
end;
$$;

-- 2. RPC used by relay-scan.js (admin/trusted-uploader only): forwards the pre-fetched pages to
--    scan-source over pg_net with the Vault service-role key - the admin tool never sees that key.
create or replace function public.relay_scan_source(p_source_id uuid, p_pages jsonb)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  svc_key text;
  fn_url text;
begin
  if not (public.is_admin() or public.is_trusted_uploader()) then
    raise exception 'permission denied: admin or trusted uploader only';
  end if;
  if jsonb_typeof(p_pages) <> 'array' or jsonb_array_length(p_pages) = 0 then
    raise exception 'p_pages must be a non-empty json array';
  end if;
  select decrypted_secret into svc_key
    from vault.decrypted_secrets where name = 'edge_function_service_role_key' limit 1;
  select value #>> '{}' into fn_url
    from public.automation_settings where key = 'scan_source_function_url';
  if svc_key is null or fn_url is null or fn_url = '' then
    raise exception 'scan-source function URL / service key not configured';
  end if;
  perform net.http_post(
    url := fn_url,
    headers := jsonb_build_object('Authorization', 'Bearer ' || svc_key, 'Content-Type', 'application/json'),
    body := jsonb_build_object('source_id', p_source_id, 'relay_pages', p_pages),
    timeout_milliseconds := 120000
  );
  update public.sources set next_scan_at = now() + interval '1 hour' where id = p_source_id;
end;
$$;

grant execute on function public.relay_scan_source(uuid, jsonb) to authenticated;
