-- WABBIT/TuRu - "אתר רשמי" לפעילות, נפרד מ-source_url (שיכול להיות אתר ריכוז/לוח אירועים חיצוני
-- שממנו יובאה הפעילות, לא בהכרח האתר של הפעילות עצמה). מתמלא אוטומטית בכלי הניהול (tools/import-tool)
-- ברגע שפעילות נשמרת, ע"י חיפוש גוגל (SERPAPI) - ראו findOfficialWebsite ב-server.js. אם לא נמצא
-- אתר רשמי, השדה נשאר null וה-UI ממשיך להציג את קישור המקור הקיים ("המידע נאסף מהאתר הזה").
alter table public.activities add column if not exists official_url text;
