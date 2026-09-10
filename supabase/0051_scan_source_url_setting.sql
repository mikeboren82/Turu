-- TuRu - תיקון: `alter database postgres set app.settings.scan_source_function_url = ...` (השלב
-- הידני שתועד ב-0049) נכשל בפועל בסביבת Supabase המנוהלת עם "permission denied to set parameter" -
-- ה-role שמריץ את ה-SQL Editor (postgres) אינו הבעלים האמיתי של מסד הנתונים שם ואין לו הרשאה
-- לשנות הגדרת GUC ברמת-database. הפתרון: שומרים את כתובת ה-Edge Function בתוך automation_settings
-- (טבלה קיימת, 0048 - בדיוק בשביל קונפיגורציה כזו) במקום GUC מותאם-אישית. הסוד עצמו (service_role
-- key) ממשיך לשבת אך ורק ב-Vault - זה לא שינוי אבטחתי, רק שינוי מנגנון-אחסון לכתובת ה-URL עצמה
-- (לא סודית, רק הייתה צריכה מקום-אחסון שלא דורש הרשאת superuser).

insert into public.automation_settings (key, value)
values ('scan_source_function_url', '""')
on conflict (key) do nothing;

create or replace function public._dispatch_source_scan(p_source_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  svc_key text;
  fn_url text;
begin
  select decrypted_secret into svc_key
    from vault.decrypted_secrets where name = 'edge_function_service_role_key' limit 1;

  select value #>> '{}' into fn_url
    from public.automation_settings where key = 'scan_source_function_url';

  if svc_key is null or fn_url is null or fn_url = '' then
    raise warning 'sources scheduler: missing service role key or function URL setting, skipping source %', p_source_id;
    return;
  end if;

  perform net.http_post(
    url := fn_url,
    headers := jsonb_build_object('Authorization', 'Bearer ' || svc_key, 'Content-Type', 'application/json'),
    body := jsonb_build_object('source_id', p_source_id)
  );

  update public.sources set next_scan_at = now() + interval '1 hour' where id = p_source_id;
end;
$$;

revoke all on function public._dispatch_source_scan(uuid) from public, anon, authenticated;
