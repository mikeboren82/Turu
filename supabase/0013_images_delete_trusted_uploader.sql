-- TuRu - מסך ניהול הפעילויות מאפשר גם למחוק תמונות ספציפיות מפעילות (לא רק תמונות
-- שהבוט עצמו העלה) - מרחיבים את images_delete לכלול is_trusted_uploader, לא רק is_admin,
-- באותה רוח כמו images_read/images_update שכבר משתמשות בה.
drop policy "images_delete" on public.activity_images;
create policy "images_delete" on public.activity_images for delete
  using (uploaded_by = auth.uid() or public.is_trusted_uploader());
