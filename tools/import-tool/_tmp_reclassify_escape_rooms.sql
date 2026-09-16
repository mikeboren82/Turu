-- Safe, scoped, one-off reclassification of 4 HIGH-confidence existing escape-room activities found
-- during the pre-launch DB audit for the new "חדרי בריחה" category (2026-09-16). Guarded by id AND
-- the exact category value already observed during the audit (no updated_at column exists on
-- public.activities to check instead - confirmed via schema.sql) - if either the id no longer exists
-- or the category has since changed, that row's UPDATE simply matches zero rows, it never overwrites
-- a changed row blindly. Explicitly excludes: the archived near-duplicate twin of the ספקטרום venue
-- (79037c3f - duplicate, not touched), the two "לייזר" combat-framed rows with no clear family
-- evidence (375866cb, 64571a98 - ambiguous, left for human review), and משחקיית רינו (42e34500 - a
-- play center that merely CONTAINS an escape room among other amenities, category already correct).
update public.activities set category = 'חדרי בריחה'
where id = '3993a84d-6d3d-4c8e-893d-cb3a58480b6d' and category = 'אחר';

update public.activities set category = 'חדרי בריחה'
where id = 'ef440f5c-f5e0-4483-aaf0-337dc3682394' and category = 'אחר';

update public.activities set category = 'חדרי בריחה'
where id = '767016c4-5607-4b3b-861a-80735c85aa05' and category = 'אחר';

update public.activities set category = 'חדרי בריחה'
where id = 'b08737f3-d43a-43c8-84af-4bf7680e5dba' and category = 'אטרקציה';

select id, name, category, status from public.activities where id in (
  '3993a84d-6d3d-4c8e-893d-cb3a58480b6d', 'ef440f5c-f5e0-4483-aaf0-337dc3682394',
  '767016c4-5607-4b3b-861a-80735c85aa05', 'b08737f3-d43a-43c8-84af-4bf7680e5dba'
);
