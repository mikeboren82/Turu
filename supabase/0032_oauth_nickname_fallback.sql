-- WABBIT/TuRu - הרחבת handle_new_user() כדי שמשתמשי Google/Apple יקבלו כינוי התחלתי סביר.
-- הזרימה הקיימת (הרשמה בטלפון, ראו lib/submitActivity.js וכו') תמיד שולחת nickname מפורש
-- ב-raw_user_meta_data, אז הפונקציה הזו לא משנה עבורם כלום. לספקי OAuth (Google/Apple) אין
-- מפתח nickname, אבל בדרך כלל יש full_name/name - נופלים אליהם קודם, ורק אם גם אלה חסרים
-- חוזרים לפריפיקס-אימייל כמו קודם. המשתמש תמיד יכול לערוך את הכינוי אחר כך בעמוד הפרופיל.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, nickname)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'nickname',
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'name',
      split_part(new.email, '@', 1)
    )
  );
  return new;
end;
$$;
