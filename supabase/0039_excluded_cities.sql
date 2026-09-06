-- WABBIT/TuRu - "📍 אזורים שלא להציג" - אחות ל-excluded_categories (0014): ערים שהמשתמש בחר
-- להסתיר לצמיתות מתוצאות החיפוש הכלליות. שם העיר עצמו הוא ה-ID (בדיוק כמו excluded_categories,
-- אין טבלת-ערים/FK אמיתי במערכת - locations.city הוא טקסט חופשי, ראו 0003_add_filter_metadata.sql).
-- לא קשור בכלל ל-profiles.saved_locations (0033) - זו תכונה נדחית אחרת (מיקומים שמורים כמו בית/גן).
alter table public.profiles add column if not exists excluded_cities text[] not null default '{}';
