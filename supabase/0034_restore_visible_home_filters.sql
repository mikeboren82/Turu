-- WABBIT/TuRu - profiles.visible_home_filters (מיגרציה 0025, המקורית) התברר בבדיקה שחסר
-- מה-DB החי כרגע למרות שה-UI כבר תלוי בו מזמן (Header/profile.js) - כנראה 0025 לא רץ עד הסוף
-- באיזשהו שלב. idempotent, בטוח להריץ גם אם בסוף מתברר שכן קיים.
alter table public.profiles
  add column if not exists visible_home_filters text[] not null default '{}'::text[];
