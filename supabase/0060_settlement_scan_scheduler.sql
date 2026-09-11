-- TuRu - מתזמן ל-scan-settlement-gaps (הגרסה האוטומטית-יומית של הבדיקה/מילוי הידניים
-- שהופעלו ב-2026-09-11 - ראו tools/playground-discovery/settlement_gap_check.py +
-- settlement_gap_fill.py). אותה תבנית מפוצלת בדיוק כמו 0049/0051 (sources scheduler):
-- RPC ציבורי מאומת-הרשאות (run_settlement_scan_now, להרצה ידנית מכלי הניהול בעתיד) + פונקציה
-- פנימית ל-cron (revoked מכל התפקידים).
--
-- *** שלב הגדרה ידני *** (בדיוק כמו scan-source, ראו 0049/0051):
--   1. ה-service_role key וה-Edge Function URL של scan-source כבר מוגדרים בעקבות 0049/0051 -
--      זה אותו secret ('edge_function_service_role_key' ב-Vault), רק ה-URL עצמו שונה
--      (Function שונה) ונשמר במפתח settlement_scan_function_url למטה.
--   2. אחרי deploy ל-scan-settlement-gaps:
--        update public.automation_settings set value = '"https://<project-ref>.supabase.co/functions/v1/scan-settlement-gaps"'
--        where key = 'settlement_scan_function_url';
-- בלי זה, _dispatch_settlement_scan פשוט תדלג עם אזהרה - לא תיכשל בצורה מסוכנת, אבל גם לא
-- תסרוק שום דבר עד שהערך יוגדר.

insert into public.automation_settings (key, value) values
  ('settlement_scan_enabled', 'true'),
  ('settlement_scan_function_url', '""'),
  ('settlement_scan_cursor', '0'),
  -- batch_size=40: בדיקה זולה (Essentials SKU, ~$0.005/יישוב) על 40 יישובים/יום - מחזור מלא
  -- על כל הרשימה (~400+ יישובים) בערך כל 10 ימים, לא חד-פעמי. עלות: ~$0.20/יום.
  ('settlement_scan_batch_size', '40'),
  -- daily_pro_budget=8: חיפוש-טקסט אמיתי (Pro-tier, ~$0.03/יישוב) על עד 8 מהיישובים עם הפער
  -- הכי-גדול שנמצא בבדיקה הזולה של היום - חוסם את העלות היקרה לתקציב קבוע (~$0.24/יום נוסף)
  -- גם אם יום מסוים מגלה הרבה פערים בבת אחת.
  ('settlement_scan_daily_pro_budget', '8'),
  ('settlement_scan_gap_threshold', '3'),
  ('settlement_scan_radius_m', '3000'),
  -- Qalqilya - עיר פלסטינית בגדה המערבית שנמצאה ברשימת-היישובים ב-2026-09-11 (בתוך התיבה
  -- הגיאוגרפית הרחבה של ISRAEL_BOUNDS, אבל לא שוק-מטרה של TuRu) - הוחרגה במפורש, לא פוספסה.
  ('settlement_scan_excluded_cities', '["Qalqilya"]')
on conflict (key) do nothing;

create or replace function public._dispatch_settlement_scan()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  svc_key text;
  fn_url text;
  scanning_on boolean;
begin
  select coalesce((value)::boolean, true) into scanning_on
    from public.automation_settings where key = 'settlement_scan_enabled';
  if scanning_on is false then
    return;
  end if;

  select decrypted_secret into svc_key
    from vault.decrypted_secrets where name = 'edge_function_service_role_key' limit 1;
  select value #>> '{}' into fn_url
    from public.automation_settings where key = 'settlement_scan_function_url';

  if svc_key is null or fn_url is null or fn_url = '' then
    raise warning 'settlement scan scheduler: missing service role key or function URL setting, skipping';
    return;
  end if;

  perform net.http_post(
    url := fn_url,
    headers := jsonb_build_object('Authorization', 'Bearer ' || svc_key, 'Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
end;
$$;

revoke all on function public._dispatch_settlement_scan() from public, anon, authenticated;

create or replace function public.run_settlement_scan_now()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (public.is_admin() or public.is_trusted_uploader()) then
    raise exception 'permission denied: admin or trusted uploader only';
  end if;
  perform public._dispatch_settlement_scan();
end;
$$;

grant execute on function public.run_settlement_scan_now() to authenticated;

select cron.schedule('scan-settlement-gaps', '0 3 * * *', $$ select public._dispatch_settlement_scan(); $$);
