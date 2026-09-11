-- TuRu - שכבת Placeholder אחידה לפעילויות בלי תמונה: 4 קבוצות ויזואליות בלבד (לא לפי קטגוריה
-- מדויקת - "גן שעשועים"/"ג'ימבורי"/"משחקייה" למשל חולקים placeholder אחד, PLAY_AND_FUN).
-- עמודה נפרדת מ-category (לא מחליפה אותה, לא משנה UI קיים) - רק קלט עתידי לבחירת תמונת-
-- placeholder כשלפעילות אין תמונה משלה. null = לא סווג עדיין (ראו סקריפט הסיווג החד-פעמי).
alter table public.activities
  add column if not exists placeholder_group text
    check (placeholder_group in ('PLAY_AND_FUN', 'NATURE_AND_ANIMALS', 'CULTURE_CREATIVITY', 'SPORTS_ADVENTURE'));
