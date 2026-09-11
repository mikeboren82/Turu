-- TuRu - scan-settlement-gaps עכשיו מכבה את עצמו (settlement_scan_enabled=false) אחרי סבב
-- מלא אחד על כל היישובים (בקשת המשתמש המפורשת, 2026-09-11: "אין סיבה שזה ירוץ לנצח... ירוץ
-- עד שיכסה את כל הארץ לחלוטין ואז יסיים") - לא רץ שוב מעצמו לעולם. settlement_scan_completed_at
-- מבדיל "הסתיים בהצלחה" מ"מנהל כיבה ידנית". reset_settlement_scan() מאפשר סבב נוסף בעתיד
-- (למשל אחרי שהרבה יישובים חדשים נוספו) בלי migration/deploy נוספים - אותה הגנת-הרשאה
-- בדיוק כמו run_settlement_scan_now (0060).

insert into public.automation_settings (key, value) values
  ('settlement_scan_completed_at', 'null')
on conflict (key) do nothing;

create or replace function public.reset_settlement_scan()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (public.is_admin() or public.is_trusted_uploader()) then
    raise exception 'permission denied: admin or trusted uploader only';
  end if;
  update public.automation_settings set value = '0' where key = 'settlement_scan_cursor';
  update public.automation_settings set value = 'true' where key = 'settlement_scan_enabled';
  update public.automation_settings set value = 'null' where key = 'settlement_scan_completed_at';
end;
$$;

grant execute on function public.reset_settlement_scan() to authenticated;
