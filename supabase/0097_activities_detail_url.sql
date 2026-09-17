-- 0097 - URL ROLES reach the product (wave 2, 2026-09-17).
-- The app's "buy tickets" button opened activities.source_url - for scanned events that is the LISTING page
-- (a whole municipal calendar), not the event. The verified event-detail URL already exists as provenance
-- (activity_sources.url_role='detail', 0091) but provenance is admin-only under RLS, so the product could not
-- use it. activities.detail_url is the canonical, public copy of that verified URL.
--   directness ladder (never guessed):  official_url (explicit booking action)  >  detail_url (the event's own
--   page)  >  source_url (listing).   A detail page is NEVER written into official_url (wave 1 rule unchanged).
-- Additive + nullable; backfill = the most recently seen detail provenance row per activity.
alter table public.activities add column if not exists detail_url text;
comment on column public.activities.detail_url is 'Verified event-detail page (activity_sources.url_role=detail). Action ladder: official_url > detail_url > source_url.';
update public.activities a set detail_url = d.page_url
from (select distinct on (activity_id) activity_id, page_url from public.activity_sources where url_role = 'detail' and page_url ~* '^https?://' order by activity_id, last_seen_at desc nulls last) d
where d.activity_id = a.id and a.detail_url is null;
