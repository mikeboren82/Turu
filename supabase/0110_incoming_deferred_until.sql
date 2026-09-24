-- TuRu - Human Review Queue Phase A: far-future candidates wait OUTSIDE the inbox (2026-09-24).
--
-- A valid one-time event more than event_max_days_ahead (180) days away cannot auto-publish yet, and before this
-- column it sat in the review queue as human work for months. It is now kept (never rejected) with the day its
-- date enters the auto-publish window: scan-source sets it at intake, the admin inbox hides the row until then,
-- and on that day a rescan re-evaluates it through the full pipeline (or the pending lifecycle releases it).
-- Pure DDL: no row changes.
alter table public.incoming_activities
  add column if not exists deferred_until date;

comment on column public.incoming_activities.deferred_until is
  'Far-future candidate: hidden from human review until this date (its first date minus event_max_days_ahead). Null = not deferred.';

create index if not exists idx_incoming_activities_deferred
  on public.incoming_activities (deferred_until)
  where deferred_until is not null and status in ('new', 'needs_review');
