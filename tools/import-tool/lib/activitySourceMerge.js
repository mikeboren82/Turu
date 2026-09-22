// TuRu - the ONE safe door for writing an activity_sources row onto an activity that MIGHT already
// have a row for that exact page_url (2026-09-22, "Harden activity_sources Merge" task).
//
// WHY THIS EXISTS. Every duplicate-merge/attach call site in this codebase wrote provenance with
// `.upsert({...}, { onConflict: 'activity_id,page_url' })` and `relation` forced to a fixed value
// (usually 'seen') - a straight REPLACE of the conflicting row's columns. That is safe ONLY when the
// two sides never share a page_url. Cleanup Batch C (2026-09-22) hit exactly that collision: a keeper
// already held `relation:'seen', url_role:'listing'` for a bare homepage URL, and the loser carried
// the SAME page_url with weaker metadata (no url_role) - the blind upsert pattern used by
// cleanup-batch-b-series-2026-09-21.js would have silently downgraded the keeper's role tag. Batch C
// worked around it ad hoc (skip any page_url the keeper already has); this module generalises that
// into the one primitive every reusable merge/attach caller should use instead of hand-rolling upserts.
//
// THE PRECEDENCE RULES ARE NOT INVENTED HERE - they are the exact rules supabase/functions/scan-source
// /index.ts#recordProvenance already enforces for the SAME-activity re-detection case (the ONLY place
// in the codebase that already had documented relation/url_role precedence before this task):
//   relation: 'created' is sticky and authoritative - once true, never downgraded to 'seen'/'updated'.
//             No rule ranks 'seen' vs 'updated' against each other - preserve-existing when neither
//             side is 'created' (Section 4 of the task: "do NOT invent a complex strength hierarchy").
//   url_role: fill-if-null only. An existing non-null role (listing/detail/booking/other) is NEVER
//             replaced by a different role - there is no documented ranking AMONG the four roles for
//             merge purposes (0091's "a listing/null URL is never event identity" is about identity
//             matching, not provenance strength).
//   first_seen_at / last_seen_at: min/max respectively - purely additive, matches the exact
//             `greatest(existing, excluded)` precedent already in supabase/0078_activity_sources.sql's
//             own backfill SQL (and recordProvenance's "bump last_seen_at on every re-detection").
//   source_id / incoming_activity_id: NEVER touched on an existing row. A page_url already
//             determines its source by construction, so there is nothing to reconcile, and
//             incoming_activity_id is itself an audit pointer to whichever candidate first created
//             the link - overwriting it would erase, not add, information.
//
// SCOPE: activity_sources only. Does not touch activities.detail_url (a related but separate 0097
// concern with its own fill-null rule) - a caller that needs that side effect keeps doing it itself,
// exactly as scan-source's recordProvenance and server.js's admin endpoints already do.

const OUTCOME = Object.freeze({
  ADDED: 'ADDED',                       // genuinely new (activity_id, page_url) row inserted
  ALREADY_PRESENT: 'ALREADY_PRESENT',   // row existed and the incoming data had nothing to add
  PRESERVED_EXISTING: 'PRESERVED_EXISTING', // row existed with different data; keeper's stronger fields kept (never downgraded)
  FAILED: 'FAILED',
});

const RELATION_RANK = { created: 1, seen: 0, updated: 0 };

/**
 * Write ONE provenance row without ever downgrading an existing one.
 * incoming: { sourceId, pageUrl, incomingActivityId, relation, urlRole, firstSeenAt, lastSeenAt }
 * Returns { outcome, pageUrl, changed: string[] } - `changed` lists which fields were written
 * (empty for ALREADY_PRESENT/PRESERVED_EXISTING with no safe extension applied).
 */
async function upsertProvenanceSafe(client, activityId, incoming) {
  const { sourceId = null, pageUrl, incomingActivityId = null, relation = 'seen', urlRole = null, firstSeenAt = null, lastSeenAt = null } = incoming;
  if (!pageUrl) return { outcome: OUTCOME.FAILED, pageUrl, error: 'pageUrl is required', changed: [] };

  let existing, selErr;
  try {
    ({ data: existing, error: selErr } = await client.from('activity_sources').select('id, relation, url_role, first_seen_at, last_seen_at')
      .eq('activity_id', activityId).eq('page_url', pageUrl).maybeSingle());
  } catch (e) { return { outcome: OUTCOME.FAILED, pageUrl, error: e.message || String(e), changed: [] }; }
  if (selErr) return { outcome: OUTCOME.FAILED, pageUrl, error: selErr.message, changed: [] };

  const now = new Date().toISOString();
  if (!existing) {
    const { error } = await client.from('activity_sources').insert({
      activity_id: activityId, source_id: sourceId, page_url: pageUrl, incoming_activity_id: incomingActivityId,
      relation, url_role: urlRole || null, first_seen_at: firstSeenAt || now, last_seen_at: lastSeenAt || now,
    });
    if (error) return { outcome: OUTCOME.FAILED, pageUrl, error: error.message, changed: [] };
    return { outcome: OUTCOME.ADDED, pageUrl, changed: ['inserted'] };
  }

  // existing row: apply only the documented, never-downgrading rules above
  const patch = {}; const changed = [];
  const keeperRank = RELATION_RANK[existing.relation] ?? 0;
  const incomingRank = RELATION_RANK[relation] ?? 0;
  if (incomingRank > keeperRank) { patch.relation = relation; changed.push('relation'); } // only 'created' ever outranks - preserve-existing otherwise
  if (!existing.url_role && urlRole) { patch.url_role = urlRole; changed.push('url_role'); } // fill-if-null only, never replace a non-null role
  const newFirst = firstSeenAt && (!existing.first_seen_at || firstSeenAt < existing.first_seen_at) ? firstSeenAt : null;
  if (newFirst) { patch.first_seen_at = newFirst; changed.push('first_seen_at'); }
  const newLast = lastSeenAt && (!existing.last_seen_at || lastSeenAt > existing.last_seen_at) ? lastSeenAt : null;
  if (newLast) { patch.last_seen_at = newLast; changed.push('last_seen_at'); }

  if (!Object.keys(patch).length) return { outcome: OUTCOME.ALREADY_PRESENT, pageUrl, changed: [] };

  const { error } = await client.from('activity_sources').update(patch).eq('id', existing.id);
  if (error) return { outcome: OUTCOME.FAILED, pageUrl, error: error.message, changed: [] };
  return { outcome: OUTCOME.PRESERVED_EXISTING, pageUrl, changed };
}

/**
 * Merge every activity_sources row of `loserActivityId` onto `keeperActivityId`, non-destructively.
 * Idempotent: running it twice (or against the same loser rows again) produces no duplicate rows and
 * no further downgrades - the second run's outcomes are ALREADY_PRESENT/PRESERVED_EXISTING throughout.
 * Does NOT delete or modify the loser's own activity_sources rows - callers archive the loser
 * separately (via lib/activityArchive.js), which is what actually retires it; leaving its provenance
 * in place until then means it is never orphaned mid-merge if a later step fails.
 * Returns { results: [{ pageUrl, outcome, changed }], counts: { ADDED, ALREADY_PRESENT, PRESERVED_EXISTING, FAILED } }.
 */
async function mergeActivitySources(client, { keeperActivityId, loserActivityId }) {
  if (!keeperActivityId || !loserActivityId) {
    return { results: [], counts: { ADDED: 0, ALREADY_PRESENT: 0, PRESERVED_EXISTING: 0, FAILED: 1 }, error: 'keeperActivityId and loserActivityId are required' };
  }
  const { data: loserSources, error } = await client.from('activity_sources')
    .select('source_id, page_url, incoming_activity_id, relation, url_role, first_seen_at, last_seen_at')
    .eq('activity_id', loserActivityId);
  if (error) return { results: [], counts: { ADDED: 0, ALREADY_PRESENT: 0, PRESERVED_EXISTING: 0, FAILED: 1 }, error: error.message };

  const results = [];
  for (const s of loserSources || []) {
    const r = await upsertProvenanceSafe(client, keeperActivityId, {
      sourceId: s.source_id, pageUrl: s.page_url, incomingActivityId: s.incoming_activity_id,
      relation: s.relation, urlRole: s.url_role, firstSeenAt: s.first_seen_at, lastSeenAt: s.last_seen_at,
    });
    results.push(r);
  }
  const counts = { ADDED: 0, ALREADY_PRESENT: 0, PRESERVED_EXISTING: 0, FAILED: 0 };
  for (const r of results) counts[r.outcome]++;
  return { results, counts };
}

const describe = (r) => `${r.outcome} ${r.pageUrl}${r.changed && r.changed.length ? ' (' + r.changed.join(',') + ')' : ''}${r.error ? ' - ' + r.error : ''}`;

module.exports = { OUTCOME, upsertProvenanceSafe, mergeActivitySources, describe };
