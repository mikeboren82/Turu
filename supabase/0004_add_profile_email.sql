-- WABBIT - הוספת אימייל אופציונלי לפרופיל (לצורך עדכונים, לא לצורך התחברות)
alter table public.profiles
  add column email text,
  add column notify_by_email boolean not null default false;
