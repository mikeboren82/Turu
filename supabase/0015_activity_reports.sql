-- TuRu - מאפשר לדווח גם על פעילויות עצמן (target_type='activity'), ומאפשר לכלי הייבוא
-- (מסך הניהול, שרץ תחת role='importer' לא 'admin') לראות ולעדכן דיווחים - אותו עיקרון
-- כמו is_trusted_uploader שכבר בשימוש לתמונות (ראו 0012).
alter table public.reports drop constraint if exists reports_target_type_check;
alter table public.reports add constraint reports_target_type_check
  check (target_type in ('community_note', 'chat_message', 'user', 'activity'));

drop policy "reports_read" on public.reports;
create policy "reports_read" on public.reports for select using (public.is_admin() or public.is_trusted_uploader());

drop policy "reports_update" on public.reports;
create policy "reports_update" on public.reports for update using (public.is_admin() or public.is_trusted_uploader());
