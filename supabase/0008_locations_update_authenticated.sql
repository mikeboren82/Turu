-- TuRu - מאפשר לכל משתמש מחובר לעדכן מיקומים (כמו שכבר מותר ליצור מיקומים חדשים),
-- כדי שכלי הייבוא יוכל להשלים עיר/אזור על מיקום קיים שנוצר בלי הפרטים האלה.
-- מיקומים אינם מידע רגיש/אישי, אז זו אותה רמת אמון כמו יצירה (locations_insert) שכבר פתוחה לכולם.
-- מחיקת מיקום (locations_delete) נשארת מוגבלת למנהלים בלבד.
drop policy "locations_update" on public.locations;
create policy "locations_update" on public.locations for update using (auth.uid() is not null);
