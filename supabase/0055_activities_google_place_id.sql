-- TuRu - עמודה חדשה, אופציונלית: google_place_id על activities. נדרשת עבור
-- tools/playground-discovery (גילוי גני שעשועים/פארקים חדשים דרך Google Places
-- API) כדי לזהות MATCH_CONFIRMED (section 26 בבקשה) בלי להסתמך על התאמת-שם/
-- קרבה בלבד. Google Maps Platform Terms מתירים אחסון-קבע של Place ID (בניגוד
-- לתמונות/photo name - ראו lib/... העתידי לאינטגרציית התמונות, אם/כשתיבנה) -
-- זה השדה היחיד מ-Google שבטוח לשמור לתמיד.
alter table public.activities
  add column if not exists google_place_id text;

-- ייחודי כשלא null - מונע ייבוא כפול של אותו מקום פיזי פעמיים (idempotency
-- ברמת ה-DB, לא רק ברמת הסקריפט - הגנה כפולה, אותו עיקרון כמו source_url
-- ב-scraped_sources הקיים).
create unique index if not exists idx_activities_google_place_id
  on public.activities (google_place_id)
  where google_place_id is not null;
