-- TuRu - activities.category: text -> text[] (2026-09-16). An activity may now carry 1-3 canonical
-- categories; category[1] is the PRIMARY category (what cards/badges show), category[2..3] are
-- secondary. Existing scalar values become single-element arrays, so every existing activity keeps
-- exactly the category it had as its primary - nothing is reclassified here.
--
-- Gate: repo-wide audit of every reader/writer of activities.category completed first (app, lib,
-- Edge Functions, import-tool, Cleaner, tests) and all scalar-assuming sites were updated in the
-- same pass. Verified live before writing this: no view/function/trigger/policy/CHECK references
-- the column - only idx_activities_category (plain btree, useless for array containment/overlap).
--
-- Rollback (documented, not executed): the down-migration is lossy only for secondaries -
--   alter table public.activities alter column category type text using category[1];
--   drop index if exists idx_activities_category;
--   create index idx_activities_category on public.activities(category);
begin;

drop index if exists public.idx_activities_category;

alter table public.activities
  alter column category type text[]
  using case when category is null then null else array[category] end;

-- Hard cap + no empty strings: max 3 entries, none of them blank. Not a canonical-values CHECK -
-- the canonical list lives in categoryValues.json and a handful of legacy non-canonical values
-- exist in the data already (e.g. 'ציור'); code-level normalization enforces canonicality on write.
alter table public.activities
  add constraint activities_category_max3 check (
    category is null or (
      coalesce(array_length(category, 1), 0) <= 3
      and not exists (select 1 from unnest(category) c where coalesce(btrim(c), '') = '')
    )
  );

-- GIN for the real query pattern from now on: category @> '{x}' / category && '{x,y}'.
create index idx_activities_category on public.activities using gin (category);

commit;
