-- 0090: THE MONSTER - detail-traversal yield per scan (adapter-controlled bounded detail fetches in
-- scan-source, 2026-09-14). Additive: one jsonb column on the existing scan log, no new table.
alter table public.source_scan_logs add column if not exists detail_metrics jsonb;
comment on column public.source_scan_logs.detail_metrics is 'detail traversal yield: {links, attempted, fetched, failed, filled:{address,one_time_date,start_time,ages,audience,price,image,jsonld:*}, ms}';
