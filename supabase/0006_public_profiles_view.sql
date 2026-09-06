-- WABBIT - חשיפת כינוי (nickname) בלבד לכל המשתמשים, כדי להציג "מי כתב" הערת קהילה,
-- בלי לחשוף טלפון/אימייל/role - אלה נשארים חסויים בטבלת profiles המקורית (RLS לא השתנה שם).
-- View בלי security_invoker רץ בהרשאות היוצר שלו ולכן "עוקף" את ה-RLS המגביל של profiles,
-- אבל מכיוון שהוא חושף רק id+nickname, זה בטוח.
create or replace view public.public_profiles as
  select id, nickname from public.profiles;

grant select on public.public_profiles to anon, authenticated;
