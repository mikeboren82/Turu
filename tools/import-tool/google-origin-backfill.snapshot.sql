-- READ-ONLY snapshot for google-origin-backfill.js (Google legacy scrub P3). SELECT only - writes nothing.
-- Run AFTER 0115 is applied (it reads content_origin):
--   npx supabase db query --linked -f tools/import-tool/google-origin-backfill.snapshot.sql > <PRIVATE>/activities-snapshot.json
-- The output contains Maps source URLs: keep it private (TuruPrivate/google-scrub-2026-10/), never in the repo.
select a.id, a.source_url, a.content_origin, a.google_place_id, a.location_id, a.status
from public.activities a
order by a.id;
