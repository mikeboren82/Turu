-- TuRu - שמירת מקור התמונה עבור תמונות שהגיעו דרך מערכת הסריקה האוטומטית (או ייבוא ידני
-- עתידי שירצה לנצל את זה) - "לא להעתיק תמונות בעיוורת, ולא להניח שמותר להשתמש בכל תמונה
-- שנמצאת באינטרנט". תמונות שהועלו ע"י משתמש/מנהל כרגיל (הזרימה הקיימת) פשוט משאירות את
-- העמודות האלה null - אין שינוי התנהגות לזרימה הקיימת.
alter table public.activity_images
  add column if not exists image_source_url text,
  add column if not exists image_source_type text
    check (image_source_type in ('ORIGINAL_SOURCE', 'EXTERNAL_SOURCE', 'PROVIDER', 'UNKNOWN')),
  add column if not exists needs_rights_review boolean not null default false;
