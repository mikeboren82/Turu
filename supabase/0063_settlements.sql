-- TuRu - רשימת יישובים ארצית אמיתית (סעיף 4 בבקשת מערכת-גני-השעשועים, 2026-09-11): לא רשימת
-- UI-אוטוקומפליט (constants/israeliCities.js, ~150 ערך, מודה בעצמו "לא רשימה ממצה") ולא רשימה
-- שנגזרת מ-activities קיימות (fetch_settlement_centroids ב-tools/playground-discovery,
-- scan-settlement-gaps - "רואה" רק יישוב שיש לו כבר פעילות אחת לפחות) - אלא מקור-אמת עצמאי:
-- Population and Immigration Authority / CBS דרך data.gov.il (dataset "citiesandsettelments",
-- resource 5c78e9fa..., 1316 יישובים, מעודכן 2026-09-06) - כולל יישובים עם 0 פעילויות היום,
-- קיבוצים/מושבים/כפרים ערביים-דרוזיים-בדואיים קטנים, לא רק ערים. settlement_id הוא סמל-הישוב
-- הרשמי (סמל_ישוב) - מפתח טבעי-יציב, לא UUID מומצא. lat/lng לא קיימים במקור הזה - ממולאים
-- בנפרד ע"י Nominatim (חינמי, אותו דפוס geocoding שכבר קיים בפרויקט).
create table public.settlements (
  settlement_id text primary key,
  name_he text not null,
  name_en text,
  council text,
  sub_district text,
  region text,
  population integer,
  lat double precision,
  lng double precision,
  geocode_source text check (geocode_source in ('nominatim', 'manual', null)),
  source text not null default 'data.gov.il/citiesandsettelments',
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_settlements_name_he on public.settlements(name_he);

alter table public.settlements enable row level security;
-- מידע ציבורי-ממשלתי גולמי (לא נתוני-משתמשים) - קריאה פתוחה לכל מי שמחובר, בדיוק כמו
-- constants/israeliCities.js הסטטי היום; כתיבה רק לאדמין/בוט-ייבוא, אותו דפוס כמו שאר הפרויקט.
create policy "settlements_read" on public.settlements for select using (true);
create policy "settlements_write" on public.settlements for all
  using (public.is_admin() or public.is_trusted_uploader())
  with check (public.is_admin() or public.is_trusted_uploader());
