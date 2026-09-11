-- TuRu - מקור השם המוצג (activities.name), כדי להבחין בין שם רשמי/שהתגלה, שם שיצר TuRu
-- מכתובת, ושם שמנהל אישר/ערך ידנית - בלי ההבחנה הזו, לוגיקת naming עתידית לא יכולה לדעת אם
-- מותר לה לדרוס name בבטחה (ראו tools/import-tool/playgroundNaming.js).
--   official             - שם אמיתי שהגיע ממקור (OSM/scraping/AI extraction/Google Places וכו').
--   generated_from_address - TuRu יצר את השם מכתובת כי לא היה שם רשמי (fallback, לא רשמי).
--   admin_confirmed      - מנהל ערך/אישר את השם ידנית בכלי הניהול - לעולם לא נדרס אוטומטית שוב.
-- null (ברירת המחדל) = לא ידוע/legacy - רשומות מלפני העמודה הזו; מטופל כמו 'official' (לא
-- נוגעים) ע"י כל קוד קורא, חוץ מהמיגרציה החד-פעמית שממלאת אותו לפי isGenericPlaygroundName.
alter table public.activities
  add column if not exists name_source text
    check (name_source in ('official', 'generated_from_address', 'admin_confirmed'));
