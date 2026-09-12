-- TuRu - incoming_activities היה חסר מדיניות INSERT לגמרי (רק read/update, ראו
-- 0045_incoming_activities.sql) - RLS מופעל בלי מדיניות INSERT תואמת פירושו "חסום לכולם",
-- לא "פתוח למי שעומד ב-read/update". זה לא בעיה עד היום כי הכותב היחיד היה scan-source
-- (Edge Function עם service_role, עוקף RLS לחלוטין). tools/playground-discovery (Python,
-- 2026-09-11 fix - ראו insert_incoming_activity ב-supabase_client.py) מתחבר כמשתמש-בוט
-- מאומת (role='importer') דרך ה-REST API הרגיל, ולכן כן כפוף ל-RLS - היה נכשל בשקט (403)
-- בלי המדיניות הזו. אותה בדיקת-הרשאה בדיוק כמו incoming_activities_read/update הקיימות.
create policy "incoming_activities_insert" on public.incoming_activities for insert
  with check (public.is_admin() or public.is_trusted_uploader());
