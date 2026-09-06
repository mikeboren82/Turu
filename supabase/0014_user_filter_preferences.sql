-- WABBIT - מאפשר למשתמש רשום להגדיר קטגוריות שלעולם לא יוצגו לו (למשל "לעולם אל תציג פארק מים"),
-- ופילטר ברירת מחדל שממלא אוטומטית את תיבות החיפוש במסך הראשי בכל כניסה.
alter table public.profiles add column if not exists excluded_categories text[] not null default '{}';
alter table public.profiles add column if not exists default_home_filters jsonb;
