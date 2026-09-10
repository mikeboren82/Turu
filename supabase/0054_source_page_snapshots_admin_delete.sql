-- TuRu - מוסיף מדיניות DELETE ל-source_page_snapshots (0044) עבור admin/trusted_uploader, כמו
-- כל טבלת-ניהול אחרת בסכימה (sources, dismissed_duplicates וכו') - עד כה הייתה קריאה בלבד,
-- בלי שום דרך (אפילו למנהל) לאפס ידנית snapshot תקוע (לדוגמה: דף שנכשל בחילוץ-AI לפני התיקון
-- ב-scan-source ל-hash-לפני-הצלחה, ונשאר מסומן "לא השתנה" לצמיתות עד שהתוכן באתר עצמו משתנה).
-- כתיבה רגילה (insert/update מ-הסריקה עצמה) ממשיכה להיות רק מ-Edge Function (service role,
-- עוקף RLS) - זה לא משתנה; זו רק תוספת ליכולת איפוס ידני-מבוקר של מנהל.
create policy "source_page_snapshots_delete" on public.source_page_snapshots for delete
  using (public.is_admin() or public.is_trusted_uploader());
