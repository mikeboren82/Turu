-- WABBIT - תיקון באג אמיתי: מסך הניהול (tools/import-tool) רץ תחת role='importer', לא
-- 'admin' (ראו 0016/0015 - אותו עיקרון בדיוק כבר קיים ל-reports). app_feedback_read
-- (מ-0022) בדקה רק is_admin(), אז הבוט לא הצליח לראות אף דיווח למרות שההגשות עצמן הצליחו
-- (אומת ישירות מול ה-DB: insert בלי select() חוזר מצליח, is_admin() הוא הבלוקר על הקריאה).
drop policy if exists "app_feedback_read" on public.app_feedback;
create policy "app_feedback_read" on public.app_feedback for select
  to authenticated
  using (public.is_admin() or public.is_trusted_uploader());
