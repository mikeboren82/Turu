-- TuRu - שומר את השם המקורי-מהמקור לפני שמיגרציית-שמות-גני-שעשועים (migrate-playground-names.js)
-- מחליפה שם גנרי בשם תיאורי-לפי-מיקום - "לא לאבד את המידע המקורי בגלל שינוי ה-display name".
-- null עבור כל שאר הפעילויות (לא נוגעים בהן) ועבור גני שעשועים ששמם כבר לא השתנה במיגרציה.
alter table public.activities
  add column if not exists original_source_name text;
