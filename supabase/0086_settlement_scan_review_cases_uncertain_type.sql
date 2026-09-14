-- TuRu - מרחיב את settlement_scan_review_cases כדי לכלול גם מועמדי 'needs_review_uncertain_type'
-- (מהמשימה: "needs_review_uncertain_type, if those candidates are available through the existing
-- review data"). אלה מועמדים בלי existing_activity תואם בכלל (matchAgainstExisting כבר קבע
-- NEW_CANDIDATE - "פארק"/סוג לא-חד-משמעי בלבד עצר את הפרסום האוטומטי, לא חשד לכפילות) - כרגע
-- קיימים רק כשורות ב-settlement_scan_candidates, בלי שום מנגנון סטטוס/מעקב-החלטה. במקום להמציא
-- מנגנון סטטוס מקביל בשביל 22 המועמדים האלה (328 גולמי, 168 ייחודי - ראו הדוח הארצי), עדיף
-- לשלב אותם באותו מודל review_cases קיים - פחות קוד, פחות מקומות-אמת. שני שינויים סכימה קטנים
-- ותוספתיים בלבד נדרשים לשם כך:

-- existing_activity_id היה NOT NULL - הגיוני כשה-case_types היחידים היו כפילות-חשודה (יש תמיד
-- פעילות-קיימת שחושדת). 'needs_review_uncertain_type' אין לו התאמה בכלל מטבעו - null לגיטימי.
alter table public.settlement_scan_review_cases alter column existing_activity_id drop not null;

alter table public.settlement_scan_review_cases drop constraint if exists settlement_scan_review_cases_case_type_check;
alter table public.settlement_scan_review_cases add constraint settlement_scan_review_cases_case_type_check
  check (case_type in (
    'strong_match', 'possible_duplicate', 'needs_review_possible_duplicate',
    'same_street_review', 'duplicate_exact_place_id', 'needs_review_uncertain_type'
  ));

-- הערה: ה-unique (google_place_id, existing_activity_id) הקיים (0073) ממשיך לעבוד תקין - NULL
-- נחשב שונה מכל NULL אחר ב-Postgres, אז כמה שורות needs_review_uncertain_type (existing_activity_id
-- תמיד null) עם google_place_id שונה זה מזה נשארות ייחודיות כרגיל; דה-דופ על אותו google_place_id
-- ממש (לא אמור לקרות בפועל, אין batch עתידי שיריץ שוב) מטופל באפליקציה (select-then-upsert), לא ב-DB.
