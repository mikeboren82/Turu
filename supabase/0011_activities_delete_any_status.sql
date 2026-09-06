-- WABBIT - מסך ניהול הפעילויות המלא מאפשר למחוק כל פעילות (בכל סטטוס), לא רק pending.
-- מאחר וכלי הייבוא שומר פעילויות ישירות כ-approved (ראו 0005/0010 להקשר), מי שיצר פעילות
-- צריך גם יכולת למחוק אותה בכל סטטוס - בדיוק כמו activities_update שכבר מאפשרת לבעלים
-- לערוך ללא הגבלת סטטוס.
drop policy "activities_delete" on public.activities;
create policy "activities_delete" on public.activities for delete
  using (public.is_admin() or created_by = auth.uid());
