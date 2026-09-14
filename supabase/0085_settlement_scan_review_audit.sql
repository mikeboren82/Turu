-- TuRu - תשתית ה-DB לדשבורד הניהול החדש לבדיקת settlement_scan_review_cases (114 מקרים
-- שנצברו מהסריקה הארצית). settlement_scan_review_cases כבר יש לו עמודת status + RLS UPDATE
-- למנהל/importer (0073) - אין צורך במיגרציה בשביל זה. מה שחסר בפועל:
--
-- 1) שדות "מי/מתי" על ההחלטה האחרונה (reviewed_by/resolved_at/resolution_note) - מראה בדיוק
--    כמו incoming_activities (0045: reviewed_by/reviewed_at/reject_reason), אותה קונבנציה בדיוק
--    שכבר קיימת בפרויקט הזה - לא ממציאים תבנית חדשה.
-- 2) טבלת audit מלאה (settlement_scan_review_decisions) - בניגוד ל-incoming_activities,
--    כאן המשתמש ביקש במפורש "previous status, new status" בכל החלטה, לא רק את המצב האחרון -
--    זה דורש רשומה append-only נפרדת (status על review_cases עצמו יכול להכיל רק ערך אחד בכל
--    רגע, מחליף את הקודם). זו לא כפילות של settlement_scan_candidates (יומן-detections, לא
--    יומן-החלטות-אדם) ולא של incoming_activities (טבלה אחרת לגמרי, match_type/extracted_data
--    שלא רלוונטיים כאן) - אין טבלת audit גנרית קיימת בפרויקט לשימוש חוזר (נבדק: אין
--    admin_actions/audit_log בשום מיגרציה).

alter table public.settlement_scan_review_cases
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists resolved_at timestamptz,
  add column if not exists resolution_note text;

create table if not exists public.settlement_scan_review_decisions (
  id uuid primary key default gen_random_uuid(),
  review_case_id uuid not null references public.settlement_scan_review_cases(id) on delete cascade,
  decided_by uuid references auth.users(id) on delete set null,
  decision text not null check (decision in ('approved_duplicate', 'approved_distinct', 'dismissed')),
  previous_status text not null,
  new_status text not null,
  note text,
  decided_at timestamptz not null default now()
);
create index if not exists idx_settlement_scan_review_decisions_case on public.settlement_scan_review_decisions(review_case_id);

alter table public.settlement_scan_review_decisions enable row level security;
-- קריאה+הוספה בלבד למנהל/importer - אותו זוג-תפקידים בדיוק שכבר יכול לקרוא/לעדכן
-- settlement_scan_review_cases עצמו (0073). בכוונה בלי update/delete policy בכלל - יומן
-- audit הוא append-only במפורש, אסור לאף אחד (כולל מנהל) לשכתב/למחוק רשומת-החלטה שכבר נכתבה.
create policy "settlement_scan_review_decisions_read" on public.settlement_scan_review_decisions for select
  using (public.is_admin() or public.is_trusted_uploader());
create policy "settlement_scan_review_decisions_insert" on public.settlement_scan_review_decisions for insert
  with check (public.is_admin() or public.is_trusted_uploader());
