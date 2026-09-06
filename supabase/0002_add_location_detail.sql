-- TuRu - הוספת שדה פרטי מיקום לפעילות (למשל קומה/אזור בתוך מקום גדול יותר)
alter table public.activities add column location_detail text;
