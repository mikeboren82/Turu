-- WABBIT/TuRu - "הטבות והנחות" (benefits/discounts) שכבת מידע נוספת על פעילויות. הטבה לעולם
-- לא חוסמת הצגת פעילות (זה נאכף באפליקציה, ב-lib/filterActivities.js) - הטבלה כאן רק מאחסנת
-- את הנתון עצמו. טבלת-בת ל-activities (כמו activity_images/activity_schedules), פעילות יכולה
-- להחזיק כמה שורות (ישראכרט + MAX + מבצע מקומי וכו').
create table if not exists public.activity_benefits (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activities(id) on delete cascade,
  provider text not null check (provider in ('ישראכרט','MAX','חבר','בהצדעה','מפעל הפיס','העסק עצמו','אחר')),
  benefit_type text not null check (benefit_type in ('percent','special_price','one_plus_one','second_ticket_discount','coupon_code','other')),
  value text,                    -- טקסט חופשי לתצוגה: "20%", "1+1", "50% לילד שני"
  special_price numeric,
  valid_from date,
  valid_until date,
  redemption_method text check (redemption_method in ('link','coupon_code','show_card','automatic','other')),
  redemption_url text,
  coupon_code text,
  terms text,
  status text not null default 'active' check (status in ('active','needs_review','expired')),
  last_verified_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_activity_benefits_activity on public.activity_benefits(activity_id);

alter table public.activity_benefits enable row level security;

-- קריאה: כמו activity_images/activity_schedules - כל מי שרואה את הפעילות-אב רואה את ההטבות שלה.
create policy "activity_benefits_read" on public.activity_benefits for select using (
  exists (select 1 from public.activities a where a.id = activity_id
    and (a.status = 'approved' or a.created_by = auth.uid() or public.is_admin()))
);

-- כתיבה: כמו dismissed_issues/dismissed_duplicates - is_admin() OR is_trusted_uploader() (קריטי:
-- לא is_admin() לבד - בוט הייבוא של כלי הניהול הוא role='importer', לא 'admin').
create policy "activity_benefits_insert" on public.activity_benefits for insert
  with check (public.is_admin() or public.is_trusted_uploader());
create policy "activity_benefits_update" on public.activity_benefits for update
  using (public.is_admin() or public.is_trusted_uploader());
create policy "activity_benefits_delete" on public.activity_benefits for delete
  using (public.is_admin() or public.is_trusted_uploader());

-- אילו מועדונים/כרטיסים יש למשתמש - אופציונלי לגמרי, לא חוסם שום פונקציונליות אם ריק.
alter table public.profiles add column if not exists benefit_clubs text[] not null default '{}';
