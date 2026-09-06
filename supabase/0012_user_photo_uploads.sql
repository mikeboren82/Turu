-- TuRu - מאפשר למשתמשי הקצה להעלות תמונות משלהם לפעילות (מהגלריה או מצלמה),
-- בכפוף לאישור מנהל לפני שהתמונה מוצגת באפליקציה. תמונות שמעלה כלי הייבוא (הבוט) ממשיכות
-- להיות מאושרות אוטומטית כמו היום - לכן מוסיפים תפקיד "importer" נפרד מ-admin (לא מרחיבים
-- הרשאות-על לבוט, בדיוק לפי ההיגיון שכבר נקבע ב-0005).

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('user', 'admin', 'importer'));

update public.profiles set role = 'importer'
where id = (select id from auth.users where email = 'import-bot@wabbit.com') and role = 'user';

create or replace function public.is_trusted_uploader()
returns boolean language sql stable as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'importer'));
$$;

alter table public.activity_images add column if not exists status text not null default 'approved'
  check (status in ('pending', 'approved', 'rejected'));
-- כל התמונות הקיימות (כולן הועלו דרך כלי הייבוא) נשארות 'approved' - לא נפגעות.

drop policy "images_read" on public.activity_images;
create policy "images_read" on public.activity_images for select using (
  exists (select 1 from public.activities a where a.id = activity_id
    and (a.status = 'approved' or a.created_by = auth.uid() or public.is_admin()))
  -- is_trusted_uploader (לא רק is_admin) כדי שכלי הייבוא יוכל גם לסקור ולאשר/לדחות
  -- תמונות שהעלו משתמשי קצה, לא רק לראות את מה שהוא עצמו העלה.
  and (status = 'approved' or uploaded_by = auth.uid() or public.is_trusted_uploader())
);

drop policy "images_insert" on public.activity_images;
create policy "images_insert" on public.activity_images for insert
  with check (
    auth.uid() is not null and uploaded_by = auth.uid()
    and (status = 'pending' or public.is_trusted_uploader())
  );

-- לא היתה מדיניות update בכלל עד עכשיו - נדרשת כדי לאשר/לדחות תמונות שהמשתמשים מעלים.
drop policy if exists "images_update" on public.activity_images;
create policy "images_update" on public.activity_images for update
  using (public.is_trusted_uploader())
  with check (public.is_trusted_uploader());

-- ============ Storage bucket לקבצי התמונות עצמם ============
-- ציבורי (כמו כתובות התמונות הסרוקות שכבר מוצגות היום) - הבקרה האמיתית על "מי רואה מה"
-- היא ברמת activity_images.status/RLS למעלה, לא ברמת קובץ.
insert into storage.buckets (id, name, public)
values ('activity-photos', 'activity-photos', true)
on conflict (id) do nothing;

drop policy if exists "activity_photos_insert" on storage.objects;
create policy "activity_photos_insert" on storage.objects for insert
  with check (bucket_id = 'activity-photos' and auth.uid() is not null);

drop policy if exists "activity_photos_delete" on storage.objects;
create policy "activity_photos_delete" on storage.objects for delete
  using (bucket_id = 'activity-photos' and (owner = auth.uid() or public.is_admin()));
