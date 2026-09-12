-- TuRu - "⛔ לאן לא תרצו להגיע?" (components/ExcludeAreasPicker.js) - אחות ל-excluded_cities
-- (0039): אזורים (REGION_OPTIONS, אותם ערכים כמו locations.region) שהמשתמש בחר להסתיר לצמיתות
-- מתוצאות החיפוש הכלליות. עמודה נפרדת מ-excluded_cities כי מדובר במזהי-אזור, לא שמות עיר -
-- הסינון עצמו משווה ישירות מול activities.region (ראו isRegionExcluded, lib/filterActivities.js).
alter table public.profiles add column if not exists excluded_regions text[] not null default '{}';
