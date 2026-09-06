-- WABBIT - מאפשר לחסום/להסיר משתמש (הפיך - לא מוחק נתונים, רק חוסם כניסה).
-- אכיפת החסימה עצמה נעשית באפליקציה בזמן ההתחברות (client-side check, ראו lib/checkBanned.js).
alter table public.profiles add column if not exists banned boolean not null default false;

-- כלי הניהול (מסך חברים חדש) רץ תחת role='importer' לא 'admin' - אותו עיקרון בדיוק כמו
-- reports_read/reports_update ב-0015: מרחיבים את profiles_read/profiles_update לכלול
-- is_trusted_uploader, כדי שהכלי יוכל לראות את רשימת המשתמשים ולעדכן banned, בלי להפוך
-- את הבוט למנהל-על.
drop policy if exists "profiles_read" on public.profiles;
create policy "profiles_read" on public.profiles for select using (id = auth.uid() or public.is_admin() or public.is_trusted_uploader());

drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_update" on public.profiles for update using (id = auth.uid() or public.is_admin() or public.is_trusted_uploader());

-- חשבון האדמין המרכזי "אבישי & נאיה" - נוצר כבר דרך auth.signUp (id: e00c1cd1-1003-43c2-87b3-7a8a0c0478e1),
-- כאן רק מקדמים אותו לתפקיד admin ומאשרים את המייל שלו ידנית (הפרויקט דורש אימות מייל, ולחשבון הזה
-- אין צורך לעבור את זרימת האימות הרגילה - הוא נכנס תמיד עם אימייל+סיסמה דרך app/admin-login.js).
update public.profiles set role = 'admin' where id = 'e00c1cd1-1003-43c2-87b3-7a8a0c0478e1';
update auth.users set email_confirmed_at = now() where id = 'e00c1cd1-1003-43c2-87b3-7a8a0c0478e1' and email_confirmed_at is null;
