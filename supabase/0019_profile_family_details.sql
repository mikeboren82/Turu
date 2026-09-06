-- TuRu - פרטים אישיים אופציונליים (אזור מגורים, גילאי ילדים) ב"עמוד שלי", כדי שנוכל
-- למקד פעילויות ולחבר בעתיד בין הורים במצב דומה. שני השדות אופציונליים - ברירת המחדל
-- ריקה, ולא חוסמת שום פעולה אחרת באפליקציה.

-- אותה רשימת אזורים בדיוק כמו locations.region (ראו 0007_update_regions.sql) ו-
-- constants/filterSchema.js - אם משנים כאן, לעדכן גם שם.
alter table public.profiles add column if not exists region text;
alter table public.profiles drop constraint if exists profiles_region_check;
alter table public.profiles add constraint profiles_region_check
  check (region is null or region in (
    'גוש דן והמרכז',
    'השרון',
    'ירושלים והסביבה',
    'חיפה והקריות',
    'הצפון והעמק',
    'השפלה והדרום',
    'יו"ש והבנימין'
  ));

-- כל איבר במערך הוא גיל של ילד אחד (שנים, 0 = פחות משנה) - גם מספר הילדים וגם הגילאים
-- שלהם נגזרים מאותו שדה אחד.
alter table public.profiles add column if not exists children_ages integer[] not null default '{}';
