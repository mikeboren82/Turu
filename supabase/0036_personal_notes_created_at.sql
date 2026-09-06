-- TuRu - personal_notes.created_at (חסר עד כה - הטבלה נוצרה עם updated_at בלבד). נדרש
-- כדי להציג "נכתב לפני X ימים" ולמיין הכי-חדשות-קודם באזור "ההערות האישיות שלי" בעמוד האישי.
-- שורות קיימות מקבלות now() כבסיס סביר (כמו last_verified_at במיגרציה 0031); הערות חדשות
-- מקבלות created_at נכון אוטומטית כי savePersonalNote לא שולח את השדה הזה ב-upsert.
alter table public.personal_notes
  add column if not exists created_at timestamptz not null default now();
