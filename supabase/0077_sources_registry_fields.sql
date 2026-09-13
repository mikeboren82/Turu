-- TuRu - source registry expansion (WHO publishes) + source health model. Extends public.sources
-- in place - no parallel table. All columns nullable or defaulted, so the existing 11 rows and the
-- existing scan-source deploy keep working unchanged until the new code is deployed.
--
-- source_kind  = what the page technically/semantically is (events_page, municipality_calendar,
--                facebook, instagram, aggregator, ...). sources.type (html/api/rss) stays the fetch type.
-- publisher_*  = WHO owns/publishes the source (municipality, mall_chain, organizer...). This is the
--                deliberate alternative to modelling publishers as venues (see 0076 header).
-- venue_id     = set ONLY when the source is a physical venue's own page.
-- priority     = 1-10; >= 8 is "high-value" and is never auto-paused by the health model.
-- health_status: healthy -> failing (1-2 consecutive failures) -> backed_off (3+, exponential
--                next_scan_at up to 7 days) -> attention_required (>= source_attention_after_failures,
--                still scheduled, surfaced prominently) -> auto_paused (is_active=false, only for
--                gone_404/access_403_waf after source_auto_pause_after_failures, never for priority>=8,
--                never for timeout/parse/content_changed). Every transition is written by scan-source.
--                A paused source is a coverage GAP in reports, never silently dropped.
alter table public.sources
  add column if not exists source_kind text not null default 'website' check (source_kind in (
    'website', 'events_page', 'municipality_calendar', 'facebook', 'instagram', 'ticketing',
    'aggregator', 'chain_events_page', 'rss', 'api', 'other'
  )),
  add column if not exists publisher_name text,
  add column if not exists publisher_type text check (publisher_type in (
    'municipality', 'local_council', 'regional_council', 'mall_chain', 'venue_operator', 'organizer',
    'aggregator', 'community_center_network', 'library_network', 'government_body', 'other'
  )),
  add column if not exists venue_id uuid references public.venues(id) on delete set null,
  add column if not exists priority integer not null default 5 check (priority between 1 and 10),
  add column if not exists consecutive_failures integer not null default 0,
  add column if not exists last_success_at timestamptz,
  add column if not exists last_failure_kind text check (last_failure_kind in (
    'gone_404', 'access_403_waf', 'timeout_network', 'parse_extraction', 'content_changed', 'unknown'
  )),
  add column if not exists health_status text not null default 'healthy' check (health_status in (
    'healthy', 'failing', 'backed_off', 'attention_required', 'auto_paused'
  )),
  add column if not exists disabled_reason text,
  add column if not exists discovery_batch text,
  -- adapter strategy for the fetch/parse stage (Phase 2 groundwork; 'generic_html' is today's only
  -- implemented behaviour, others are registered as data so onboarding stays configuration-driven).
  add column if not exists strategy text not null default 'generic_html' check (strategy in (
    'generic_html', 'json_ld_event', 'rss', 'ics', 'api_json', 'wordpress_events', 'municipal_calendar', 'chain_events_page'
  ));

create index if not exists idx_sources_health on public.sources(health_status);
create index if not exists idx_sources_venue on public.sources(venue_id) where venue_id is not null;

-- finer failure classification per scan (sources.last_failure_kind is the latest of these)
alter table public.source_scan_logs
  add column if not exists failure_kind text check (failure_kind in (
    'gone_404', 'access_403_waf', 'timeout_network', 'parse_extraction', 'content_changed', 'unknown'
  )),
  add column if not exists auto_approved_count integer not null default 0;

-- WHO runs the activity (when the page says so) - distinct from where it happens (venue_id) and
-- from who published the page (activity_sources / sources.publisher_*).
alter table public.activities add column if not exists organizer_name text;

insert into public.automation_settings (key, value) values
  ('auto_approve_min_trust_score', '80'),
  ('source_attention_after_failures', '5'),
  ('source_auto_pause_after_failures', '10'),
  ('event_max_days_ahead', '180'),
  ('source_backoff_max_hours', '168')
on conflict (key) do nothing;

-- Scheduler: same job, same limit, now priority-aware (high-value sources first when many are due).
-- CREATE OR REPLACE keeps the existing revoke-from-public/anon/authenticated (0049).
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
    where is_active and next_scan_at <= now()
    order by priority desc, next_scan_at asc
    limit 20
  loop
    perform public._dispatch_source_scan(src.id);
  end loop;
end;
$$;
