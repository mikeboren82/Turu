-- TuRu - backfill חד-פעמי: יוצר שורת settlement_scan_review_cases אחת לכל google_place_id ייחודי
-- שקיבל outcome='needs_review_uncertain_type' אי-פעם (168 ייחודי מתוך 328 גולמי, לפי הדוח הארצי
-- הסופי) - כדי שהדשבורד החדש יראה אותם מיד, בלי לחכות ל-lazy-create בפעם הראשונה שמנהל פותח אותם.
-- existing_activity_id=null (ראו 0086) - אין התאמה-חשודה למועמדים האלה מטבעם. latest_distance_m
-- מחושב פה כמרחק לפעילות-גן-שעשועים הקרובה ביותר בפועל (אותה נוסחת haversine בדיוק כמו
-- matchAgainstExisting ב-_shared/placesDiscovery.ts), כדי שאזהרת 50-60מ' תעבוד גם על השורות
-- האלה בלי חישוב-runtime יקר בכל טעינת עמוד.

begin;

with latest_per_place as (
  -- שורת-המועמד האחרונה (created_at) לכל google_place_id - שם/כתובת/יישוב מהזיהוי העדכני ביותר.
  select distinct on (google_place_id)
    google_place_id, name, formatted_address, settlement_name, lat, lon, place_kind, batch_id
  from public.settlement_scan_candidates
  where outcome = 'needs_review_uncertain_type' and google_place_id is not null
  order by google_place_id, created_at desc
),
detection_counts as (
  select google_place_id, count(*) as n, min(created_at) as first_seen, max(created_at) as last_seen,
    (array_agg(batch_id order by created_at asc))[1] as first_batch_id,
    (array_agg(batch_id order by created_at desc))[1] as last_batch_id
  from public.settlement_scan_candidates
  where outcome = 'needs_review_uncertain_type' and google_place_id is not null
  group by google_place_id
),
plays as (
  select a.id as activity_id, l.lat, l.lng
  from public.activities a
  join public.locations l on l.id = a.location_id
  where a.category in ('גן שעשועים', 'פארק שעשועים') and l.lat is not null and l.lng is not null
),
nearest as (
  select lp.google_place_id,
    (select round((2 * 6371000 * asin(sqrt(
        power(sin(radians(p.lat - lp.lat)/2), 2) +
        cos(radians(lp.lat)) * cos(radians(p.lat)) * power(sin(radians(p.lng - lp.lon)/2), 2)
      )))::numeric, 1)
     from plays p order by
       power(sin(radians(p.lat - lp.lat)/2), 2) +
       cos(radians(lp.lat)) * cos(radians(p.lat)) * power(sin(radians(p.lng - lp.lon)/2), 2)
     limit 1) as nearest_dist_m
  from latest_per_place lp
  where lp.lat is not null and lp.lon is not null
)
insert into public.settlement_scan_review_cases (
  google_place_id, existing_activity_id, case_type, candidate_name, candidate_address,
  first_seen_at, last_seen_at, detection_count, first_batch_id, last_batch_id, status, latest_distance_m
)
select
  lp.google_place_id, null, 'needs_review_uncertain_type', lp.name, coalesce(lp.formatted_address, lp.settlement_name),
  dc.first_seen, dc.last_seen, dc.n, dc.first_batch_id, dc.last_batch_id, 'needs_review', n.nearest_dist_m
from latest_per_place lp
join detection_counts dc on dc.google_place_id = lp.google_place_id
left join nearest n on n.google_place_id = lp.google_place_id
where not exists (
  select 1 from public.settlement_scan_review_cases rc
  where rc.google_place_id = lp.google_place_id and rc.case_type = 'needs_review_uncertain_type'
);

commit;
