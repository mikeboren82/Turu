-- WABBIT/TuRu - תאריך-יעד אופציונלי לפעילות "מתוכננת" (עמוד חדש "📍 היעדים שלי"). שני השדות
-- nullable בכוונה - אסור לחייב משתמש להגדיר תאריך. target_label מכסה מקרים כמו "חול המועד
-- סוכות" שאינם ניתנים לשמירה כתאריך יחיד.
alter table public.planned_activities
  add column if not exists target_date date,
  add column if not exists target_label text;
