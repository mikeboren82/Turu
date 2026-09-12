-- TuRu - per-candidate audit trail for scan-settlement-gaps (בקשת המשתמש, 2026-09-12 batch-3
-- validation round): "עבור כל candidate חדש או rejected/duplicate משמעותי, שמור source
-- settlement ID/name... כי כרגע אי אפשר לשחזור בדיעבד איזה settlement גרם לכל תוצאה" - בדיוק
-- הפער שגילינו בעת ניתוח Batch 1/2 (נאלצתי לשחזר-בדיעבד מתוך city בכתובת, לא settlement
-- אמיתי). שורה אחת לכל מועמד גולמי שעבר את שלב ה-fill היקר (לא לשלב הזול - שם אין "מועמדים",
-- רק ספירת-IDs). אותו דפוס בדיוק כמו settlement_scan_runs (0064): כתיבה רק מ-Edge Function
-- (service_role) - בלי insert/update policy בכלל, רק select ל-admin/trusted_uploader.
create table public.settlement_scan_candidates (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references public.settlement_scan_runs(id) on delete cascade,
  settlement_id text not null,
  settlement_name text,
  google_place_id text,
  name text,
  formatted_address text,
  lat numeric,
  lon numeric,
  place_kind text,
  distance_from_settlement_m numeric,
  page_number integer not null default 1,
  -- outcome מכסה את כל שלבי-הסינון (funnel) בסדר שהם רצים בפועל בקוד: מרחק -> סוג -> כפילות.
  outcome text not null check (outcome in (
    'new', 'duplicate_confirmed', 'strong_match', 'needs_review_uncertain_type',
    'needs_review_missing_address', 'rejected_distance', 'rejected_not_relevant',
    'rejected_out_of_bounds', 'rejected_missing_place_id'
  )),
  matched_existing_activity_id uuid,
  created_activity_id uuid,
  created_at timestamptz not null default now()
);
create index idx_settlement_scan_candidates_batch on public.settlement_scan_candidates(batch_id);
create index idx_settlement_scan_candidates_settlement on public.settlement_scan_candidates(settlement_id);
create index idx_settlement_scan_candidates_place on public.settlement_scan_candidates(google_place_id);

alter table public.settlement_scan_candidates enable row level security;
create policy "settlement_scan_candidates_read" on public.settlement_scan_candidates for select
  using (public.is_admin() or public.is_trusted_uploader());

-- הרחבת settlement_scan_runs (0064) עם עמודות-funnel ועם settlements_with_expensive_fill -
-- בקשת המשתמש המפורשת (רשימת השדות ל-batch-3 validation): לדעת לא רק "כמה נדחו בסך הכל" אלא
-- כמה שרדו כל שלב סינון בנפרד (מרחק/סוג/כפילות), וכמה יישובים בכלל עברו את שלב ה-fill היקר
-- (מתוך ה-40 שעברו רק את הבדיקה הזולה).
alter table public.settlement_scan_runs
  add column if not exists settlements_with_expensive_fill integer,
  add column if not exists candidates_after_distance_filter integer,
  add column if not exists candidates_after_type_filter integer,
  add column if not exists candidates_after_duplicate_filter integer,
  add column if not exists text_search_pages integer,
  add column if not exists settlements_with_extra_pages integer;
