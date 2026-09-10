-- TuRu - תיבת-הכניסה של מערכת "מקורות מידע": כל פעילות/עדכון/חשד-כפילות/דיווח-היעלמות שנמצא
-- ע"י סריקה אוטומטית ממתין כאן לבדיקת מנהל - שום דבר לא נכתב ל-activities בלי אישור מפורש.
--
-- source_id/scan_log_id/existing_activity_id/created_activity_id הם "on delete set null" (לא
-- cascade) - היסטוריה נשמרת גם אם מקור/סריקה/פעילות נמחקים אחר-כך. page_url/extracted_data
-- נשמרים כפולים (גם אם ניתן היה להגיע אליהם רק דרך FK) - "לשמור את המידע המקורי ככל שניתן
-- לצורך debugging ובדיקה" גם אם ה-source עצמו יימחק בעתיד.
create table public.incoming_activities (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.sources(id) on delete set null,
  scan_log_id uuid references public.source_scan_logs(id) on delete set null,
  page_url text not null,
  match_type text not null default 'new' check (match_type in ('new', 'update', 'duplicate', 'missing', 'expired')),
  existing_activity_id uuid references public.activities(id) on delete set null,
  confidence_score numeric not null default 0 check (confidence_score >= 0 and confidence_score <= 1),
  confidence_breakdown jsonb not null default '{}',
  -- העתק-בזמן-הגילוי של ציון-האמון של המקור (לא reference חי) - כדי שתצוגת הכרטיס תישאר
  -- עקבית גם אם המנהל ישנה את ציון המקור אחר-כך; שינויים עתידיים ב-sources.source_trust_score
  -- משפיעים רק על סריקות הבאות, לא על שורות שכבר נוצרו.
  source_trust_score numeric,
  extracted_data jsonb not null default '{}',
  diff jsonb not null default '{}',
  validation_issues text[] not null default '{}',
  raw_source_snapshot text,
  status text not null default 'new' check (status in (
    'new', 'processing', 'needs_review', 'approved', 'rejected', 'duplicate', 'updated', 'failed',
    'missing_flagged', 'archived_expired'
  )),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  reject_reason text,
  created_activity_id uuid references public.activities(id) on delete set null,
  found_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_incoming_activities_status on public.incoming_activities(status);
create index idx_incoming_activities_source on public.incoming_activities(source_id, found_at desc);
-- מונע יצירת שורת 'missing' כפולה לאותה פעילות בזמן שהקודמת עדיין ממתינה לבדיקה (ראו scan-source).
create unique index idx_incoming_activities_missing_unique on public.incoming_activities(existing_activity_id)
  where match_type = 'missing' and status = 'missing_flagged';

alter table public.incoming_activities enable row level security;
create policy "incoming_activities_read" on public.incoming_activities for select
  using (public.is_admin() or public.is_trusted_uploader());
create policy "incoming_activities_update" on public.incoming_activities for update
  using (public.is_admin() or public.is_trusted_uploader())
  with check (public.is_admin() or public.is_trusted_uploader());
