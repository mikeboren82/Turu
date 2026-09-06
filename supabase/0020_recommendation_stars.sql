-- WABBIT - כוכבי המלצה: משתמש שהוסיף פעילות שאושרה מקבל כוכב אחד לצמיתות (מוצג ליד
-- השם שלו ועל כרטיסיית הפעילות כ"הומלץ ע"י"). האישור עצמו לא עובר דרך האפליקציה - הוא
-- נעשה ב-tools/import-tool (UPDATE ישיר על activities.status), אז הענקת הכוכב חייבת
-- לקרות בטריגר ב-DB כדי לתפוס את זה בכל מקרה (כלי הניהול, עריכה ידנית ב-SQL וכו').

alter table public.profiles add column if not exists stars integer not null default 0;

-- star_awarded מונע הענקת כוכב כפולה אם פעילות עוברת approved -> rejected -> approved שוב.
alter table public.activities add column if not exists star_awarded boolean not null default false;

create or replace function public.award_recommendation_star()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved'
     and not new.star_awarded and new.created_by is not null then
    update public.profiles set stars = stars + 1 where id = new.created_by;
    new.star_awarded := true;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_award_recommendation_star on public.activities;
create trigger trg_award_recommendation_star
  before update on public.activities
  for each row
  execute function public.award_recommendation_star();

-- חושף גם stars דרך public_profiles (ראו 0006_public_profiles_view.sql) - עדיין רק
-- id+nickname+stars, בלי טלפון/אימייל/role.
create or replace view public.public_profiles as
  select id, nickname, stars from public.profiles;

grant select on public.public_profiles to anon, authenticated;
