-- WABBIT - מאפשר למי שיצר פעילות (כולל בוט הייבוא) למחוק אותה כל עוד היא עדיין
-- בסטטוס 'pending' (טרם אושרה). נועד לאפשר ניקוי כפילויות מכלי הייבוא בלי להפוך
-- את הבוט למנהל-על (admin) - מחיקה של פעילות שכבר אושרה עדיין דורשת הרשאת admin.
drop policy "activities_delete" on public.activities;
create policy "activities_delete" on public.activities for delete
  using (public.is_admin() or (created_by = auth.uid() and status = 'pending'));
