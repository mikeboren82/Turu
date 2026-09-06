-- WABBIT/TuRu - תשתית ל"המשפחה שלי": מודל ילדים עשיר (שם+תאריך לידה, לא רק מערך גילאים שטוח -
-- כדי שהגיל יחושב טרי בכל טעינה ולא "יקפא" בערך ישן), placeholder למיקומים שמורים מרובים
-- (לא בונים UI עדיין - רק מקום ב-DB לעתיד), והעדפות התראות (UI+שמירה בלבד, אין עדיין תשתית
-- push בפועל). children_ages/region הישנים (0019) נשארים כמו שהם - 0 משתמשים אמיתיים כרגע,
-- אין סיכון, ופשוט מפסיקים לקרוא מ-children_ages דרך lib/preferences.js.
alter table public.profiles
  add column if not exists children jsonb not null default '[]',
  add column if not exists saved_locations jsonb not null default '[]',
  add column if not exists notification_prefs jsonb not null default '{}';

-- "רוצה לעשות" - זהה לגמרי במבנה ל-favorites/visited_activities הקיימות (schema.sql).
create table if not exists public.planned_activities (
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_id uuid not null references public.activities(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, activity_id)
);

alter table public.planned_activities enable row level security;
create policy "planned_own" on public.planned_activities for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
