-- WABBIT - מאפשר למשתמש רשום לבחור אילו פילטרים (מעבר לסוג פעילות/מיקום/גיל הקבועים
-- במסך הראשי) יופיעו לו גם כן כקישורים קטנים במסך הראשי, לצד ברירת המחדל שכל אחד מהם
-- (default_home_filters, כבר קיים מ-0019/0014) - "מה מוצג" בנוסף ל"מה ערך ברירת המחדל".
alter table public.profiles add column if not exists visible_home_filters text[] not null default '{}'::text[];
