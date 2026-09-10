-- TuRu - הגדרות-קונפיגורציה גלובליות למערכת "מקורות מידע" - key/value כדי שכל הגבולות/ספים
-- (MAX_DISCOVERED_PAGES, ספי-confidence וכו') יהיו ניתנים לשינוי ע"י מנהל בלי deploy קוד.
-- כולל גם scanning_enabled - ה-Kill Switch הגלובלי שנבדק ע"י _scan_due_sources_cron() לפני
-- שהיא מדפחת סריקה כלשהי.
create table public.automation_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

alter table public.automation_settings enable row level security;
create policy "automation_settings_all" on public.automation_settings for all
  using (public.is_admin() or public.is_trusted_uploader())
  with check (public.is_admin() or public.is_trusted_uploader());

insert into public.automation_settings (key, value) values
  ('scanning_enabled', 'true'),
  ('max_discovered_pages_per_source', '8'),
  ('max_activities_per_scan', '50'),
  ('max_ai_requests_per_scan', '20'),
  ('fetch_timeout_ms', '15000'),
  ('page_retry_count', '1'),
  ('missing_scan_threshold', '3'),
  ('duplicate_confidence_threshold', '0.9'),
  ('needs_review_confidence_threshold', '0.6'),
  ('proximity_km', '0.15');
