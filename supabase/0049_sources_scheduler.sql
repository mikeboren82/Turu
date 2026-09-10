-- TuRu - Scheduler למערכת "מקורות מידע": pg_cron (כבר מופעל מ-0029) + pg_net כדי לקרוא ל-Edge
-- Function scan-source. עוקב אחרי אותה תבנית מפוצלת בדיוק כמו cleanup_expired_activities:
-- RPC ציבורי מאומת-הרשאות (scan_source_now, לכפתור "סרוק עכשיו" בכלי הניהול) + פונקציה פנימית
-- (_scan_due_sources_cron, בלי בדיקת auth.uid() כי אין הקשר-בקשה אמיתי בהרצת cron, אבל revoked
-- מכל התפקידים כדי שלא תהיה נגישה גם דרך RPC ישיר).
--
-- *** שלב הגדרה ידני *** (ראו גם 0051 - תיקון עבור app.settings.* שדורש הרשאת superuser שלא
-- קיימת ב-Supabase המנוהל; הכתובת עצמה נשמרת היום ב-automation_settings, לא ב-GUC. ההוראות
-- העדכניות המלאות בהערת הכותרת של 0051):
--
--   select vault.create_secret('<ה-service_role key מ-Project Settings -> API>', 'edge_function_service_role_key');
--   (כתובת ה-Edge Function נקבעת דרך automation_settings אחרי 0051, לא כאן)
--
-- בלי שני אלה, _dispatch_source_scan פשוט תדלג עם אזהרה (raise warning) ולא תעשה כלום - לא תיכשל
-- בצורה מסוכנת, אבל גם לא תסרוק שום דבר עד שהערכים יוגדרו.

create extension if not exists pg_net with schema extensions;

create or replace function public._dispatch_source_scan(p_source_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  svc_key text;
  fn_url text := current_setting('app.settings.scan_source_function_url', true);
begin
  select decrypted_secret into svc_key
    from vault.decrypted_secrets where name = 'edge_function_service_role_key' limit 1;

  if svc_key is null or fn_url is null then
    raise warning 'sources scheduler: missing service role key or function URL setting, skipping source %', p_source_id;
    return;
  end if;

  perform net.http_post(
    url := fn_url,
    headers := jsonb_build_object('Authorization', 'Bearer ' || svc_key, 'Content-Type', 'application/json'),
    body := jsonb_build_object('source_id', p_source_id)
  );

  -- מגן זמני בלבד - scan-source עצמה קובעת את next_scan_at האמיתי (now()+scan_frequency_hours)
  -- בסיום הסריקה. זה רק מונע דיפוץ כפול של אותו מקור אם קריאת ה-HTTP איטית/נכשלת ותקתוק-cron
  -- נוסף קורה בינתיים.
  update public.sources set next_scan_at = now() + interval '1 hour' where id = p_source_id;
end;
$$;

revoke all on function public._dispatch_source_scan(uuid) from public, anon, authenticated;

create or replace function public.scan_source_now(p_source_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  dispatched integer := 0;
  src record;
begin
  if not (public.is_admin() or public.is_trusted_uploader()) then
    raise exception 'permission denied: admin or trusted uploader only';
  end if;

  if p_source_id is not null then
    perform public._dispatch_source_scan(p_source_id);
    return 1;
  end if;

  for src in select id from public.sources where is_active and next_scan_at <= now() loop
    perform public._dispatch_source_scan(src.id);
    dispatched := dispatched + 1;
  end loop;
  return dispatched;
end;
$$;

grant execute on function public.scan_source_now(uuid) to authenticated;

create or replace function public._scan_due_sources_cron()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  src record;
  scanning_on boolean;
begin
  select coalesce((value)::boolean, true) into scanning_on
    from public.automation_settings where key = 'scanning_enabled';

  if scanning_on is false then
    return;
  end if;

  for src in
    select id from public.sources
    where is_active and next_scan_at <= now()
    order by next_scan_at asc
    limit 20
  loop
    perform public._dispatch_source_scan(src.id);
  end loop;
end;
$$;

revoke all on function public._scan_due_sources_cron() from public, anon, authenticated;

select cron.schedule('scan-due-sources', '*/15 * * * *', $$ select public._scan_due_sources_cron(); $$);
