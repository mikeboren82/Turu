-- 0114 PREFLIGHT - SELECT only, writes nothing. Run immediately before applying 0114_venues_place_id_unique.sql:
--   npx supabase db query --linked -f supabase/0114_venues_place_id_unique.preflight.sql
-- verdict must be PASS. One statement on purpose (the CLI prints only the last result set).
with
dup as (
  select count(*) as n, coalesce(string_agg(google_place_id, ', '), '') as ids
  from (select google_place_id from public.venues where google_place_id is not null group by 1 having count(*) > 1) d
),
blank as (
  select count(*) as n from public.venues
  where google_place_id is not null and (google_place_id = '' or google_place_id <> btrim(google_place_id))
),
target_name as (
  select count(*) as n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public' and c.relname = 'idx_venues_google_place_id_unique'
),
target_check as (
  select count(*) as n from pg_constraint
  where conrelid = 'public.venues'::regclass and conname = 'venues_google_place_id_trimmed_chk'
),
unexpected_unique as (
  select count(*) as n, coalesce(string_agg(i.relname, ', '), '') as names
  from pg_index x join pg_class i on i.oid = x.indexrelid
  where x.indrelid = 'public.venues'::regclass and x.indisunique and not x.indisprimary
),
unexpected_constraint as (
  select count(*) as n from pg_constraint where conrelid = 'public.venues'::regclass and contype in ('u', 'x')
),
invalid_index as (
  select count(*) as n from pg_index where indrelid = 'public.venues'::regclass and not indisvalid
)
select
  (select count(*) from public.venues)                             as venues_total,
  (select count(google_place_id) from public.venues)               as place_id_nonnull,
  (select count(distinct google_place_id) from public.venues)      as place_id_distinct,
  dup.n as duplicate_groups, dup.ids as duplicate_ids,
  blank.n as blank_or_untrimmed,
  target_name.n as target_index_name_taken,
  target_check.n as target_check_name_taken,
  unexpected_unique.n as unexpected_unique_indexes, unexpected_unique.names as unexpected_unique_index_names,
  unexpected_constraint.n as unexpected_unique_or_exclusion_constraints,
  invalid_index.n as invalid_indexes,
  pg_get_indexdef(to_regclass('public.idx_venues_google_place_id')) as old_index_def,
  case when dup.n = 0 and blank.n = 0 and target_name.n = 0 and target_check.n = 0 and unexpected_unique.n = 0
            and unexpected_constraint.n = 0 and invalid_index.n = 0
       then 'PASS' else 'FAIL' end as verdict
from dup, blank, target_name, target_check, unexpected_unique, unexpected_constraint, invalid_index;
