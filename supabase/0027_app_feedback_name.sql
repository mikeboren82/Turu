-- WABBIT - שדה "שם" חופשי ואופציונלי בדיווח "משהו לא עובד" - נפרד מ-user_id (שדורש session
-- אמיתי): כל אחד יכול למלא שם, גם אנונימי. למשתמש רשום השדה יבוא ממולא מראש בכינוי שלו
-- (בצד הלקוח, ראו components/FeedbackButton.js) אבל הוא חופשי לשנות/למחוק אותו.
alter table public.app_feedback add column if not exists name text;
