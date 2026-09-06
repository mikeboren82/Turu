-- TuRu - חושף גם role דרך public_profiles, כדי שהקליינט יוכל להסתיר "הומלץ ע"י" עבור
-- חשבון הבוט (role='importer', ראו 0016_member_management.sql) וחשבון האדמין (role='admin') -
-- "הומלץ ע"י" אמור להופיע רק על המלצות אמיתיות של משתמשים חיצוניים רגילים (role='user').
-- role עצמו לא סוד (admin/importer/user) - רק phone/email/banned נשארים חסויים ב-profiles.
create or replace view public.public_profiles as
  select id, nickname, stars, role from public.profiles;

grant select on public.public_profiles to anon, authenticated;
