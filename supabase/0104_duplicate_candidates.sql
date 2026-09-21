-- 0104 - Dedicated duplicate-candidate review queue (2026-09-21).
--
-- *** APPLIED to production 2026-09-21 (constraint + RLS canaries verified, 22 historical rows
-- backfilled). *** Additive only: one new table with its own RLS. It touches no existing table and
-- no existing row. Applying it changes zero runtime behaviour until a generator writes to it, and
-- the generator (tools/import-tool/lib/duplicateCandidates.js) refuses to write unless explicitly
-- told to.
--
-- WHY A DEDICATED TABLE AND NOT cleaner_cases. The 2026-09-21 activation design measured four
-- properties of cleaner_cases that make it the wrong home for a duplicate PAIR:
--   1. identity is (subject_kind, subject_id, issue) - one subject, not two
--   2. an issue with no handler is auto-RESOLVED as 'unsupported_issue' on the next Cleaner pass
--   3. an existing key is never regenerated, so "not a duplicate of B" would blind A to C forever
--   4. every discovery run auto-closes open cases it did not regenerate
-- The project's own precedent for a human-review queue is a dedicated table with a dashboard
-- (settlement_scan_review_cases, 0073). This follows that shape and fixes the one gap in the older
-- pair table dismissed_duplicates (0031), which has no canonical ordering and so admits A/B AND B/A.
--
-- PAIR IDENTITY. activity_id_a < activity_id_b is a CHECK constraint, so (A,B) and (B,A) collapse
-- to one row at the database level, not by application discipline. The unique constraint on the
-- ordered pair therefore cannot be bypassed by reversing the arguments. One activity may appear in
-- any number of pairs (A/B, A/C, A/D) - that is what makes "A is not a duplicate of B" unable to
-- suppress the later discovery of A/C.
--
-- STATUS VOCABULARY mirrors settlement_scan_review_cases exactly, so a future dashboard can reuse
-- the same mental model:
--   needs_review        pending human/Cleaner judgement (the only state the generator ever creates)
--   approved_duplicate  a person confirmed it; keeper_activity_id records which side survives.
--                       Confirming here does NOT archive anything - that stays in the guarded
--                       maintenance path, which reads this verdict rather than acting on a score.
--   approved_distinct   a person judged them different records (the "not a duplicate" verdict)
--   dismissed           not worth deciding (expired, both archived, noise)
--
-- REDISCOVERY POLICY (deliberately simple). When the generator meets a pair it already knows:
--   needs_review        -> refresh evidence, bump last_seen_at / detection_count. Never touch status.
--   any resolved state  -> bump last_seen_at / detection_count only. NEVER reopen automatically.
--                          If the identity evidence now differs from what the reviewer judged
--                          (evidence_fingerprint changed) the generator stamps evidence_changed_at
--                          and leaves the verdict alone, so a dashboard can list "resolved, but the
--                          evidence moved" without an invalidation engine second-guessing people.
--
-- ARCHIVING. TuRu archives rather than deletes. An archive is a status change, so pair rows survive
-- it as audit history; the generator simply stops proposing NEW pairs for a side that is no longer
-- approved. A true hard delete cascades, exactly like all 13 existing activity-linked tables, because
-- a pair with a missing side is corrupt, not history.
--
-- ROLLBACK: drop table public.duplicate_candidates; (no other object depends on it)
begin;

create table public.duplicate_candidates (
  id uuid primary key default gen_random_uuid(),
  activity_id_a uuid not null references public.activities(id) on delete cascade,
  activity_id_b uuid not null references public.activities(id) on delete cascade,

  status text not null default 'needs_review' check (status in (
    'needs_review', 'approved_duplicate', 'approved_distinct', 'dismissed'
  )),
  -- set only with approved_duplicate; which side the maintenance path should keep
  keeper_activity_id uuid references public.activities(id) on delete set null,

  -- explainability: the hardened signal's two axes, stored as-is, never a bare score
  relationship text not null,
  venue_relatedness text[] not null default '{}',
  identity_evidence text[] not null default '{}',
  distance_m numeric,
  -- stable digest of (relationship + identity_evidence) at last detection; drives evidence_changed_at
  evidence_fingerprint text not null,
  evidence_changed_at timestamptz,

  generator_version text not null,
  detection_count integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),

  resolved_at timestamptz,
  resolved_by uuid,
  resolution_note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint duplicate_candidates_ordered check (activity_id_a < activity_id_b),
  constraint duplicate_candidates_no_self check (activity_id_a <> activity_id_b),
  constraint duplicate_candidates_pair unique (activity_id_a, activity_id_b),
  constraint duplicate_candidates_keeper_is_a_side check (
    keeper_activity_id is null or keeper_activity_id = activity_id_a or keeper_activity_id = activity_id_b
  )
);

-- the review queue itself
create index idx_duplicate_candidates_status on public.duplicate_candidates(status);
-- "every candidate involving activity X" - both sides, because X may be the smaller or larger id
create index idx_duplicate_candidates_a on public.duplicate_candidates(activity_id_a);
create index idx_duplicate_candidates_b on public.duplicate_candidates(activity_id_b);
-- pair lookup and the generator's upsert are served by the unique constraint's own index

alter table public.duplicate_candidates enable row level security;
-- Same shape as cleaner_cases (the other Cleaner-owned queue): visible to and writable by
-- admin / trusted_uploader only. The generator runs as the Cleaner bot, which is trusted_uploader.
-- Deliberately NOT the broad system-maintenance policy of 0099. No anon or plain-user access.
create policy "duplicate_candidates_read" on public.duplicate_candidates for select
  using (public.is_admin() or public.is_trusted_uploader());
create policy "duplicate_candidates_write" on public.duplicate_candidates for all
  using (public.is_admin() or public.is_trusted_uploader())
  with check (public.is_admin() or public.is_trusted_uploader());

commit;
