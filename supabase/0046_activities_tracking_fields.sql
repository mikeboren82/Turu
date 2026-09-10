-- TuRu - מעקב "נעלם מהמקור" עבור פעילויות שנוצרו דרך מערכת הסריקה האוטומטית. שני השדות
-- לא גורמים לשום מחיקה/שינוי אוטומטי בעצמם - הם רק מזינים את הלוגיקה ב-scan-source
-- (Edge Function) שיוצרת שורת incoming_activities עם match_type='missing' אחרי שהסף נחצה,
-- כדי שמנהל יחליט (בדוק/עדכן/השאר/ארכב). לפעילויות שלא מקושרות למקור (הוזנו ידנית) שני
-- השדות פשוט נשארים null/0 ולא נבדקים בכלל.
alter table public.activities
  add column if not exists last_seen_at timestamptz,
  add column if not exists consecutive_missing_scans integer not null default 0;
