// A candidate already waiting in review still proves its live activity is present: refresh seen-state, never apply the pending row.
import { recordProvenance } from './provenance.ts';

// deno-lint-ignore no-explicit-any
type Client = any;

export type PendingReviewRow = {
  id: string;
  match_type: string | null;
  existing_activity_id: string | null;
  confidence_score: number | string | null;
};

export type ReconfirmationDecision =
  | { refresh: true; activityId: string; pendingId: string }
  | { refresh: false; reason: 'no_pending' | 'unlinked_pending' | 'ambiguous_link' | 'low_confidence_link' };

// Below the duplicate threshold the pending row is itself asking "same activity?", so it vouches for nothing.
export function reconfirmationTarget(rows: PendingReviewRow[], duplicateThreshold: number): ReconfirmationDecision {
  if (!rows.length) return { refresh: false, reason: 'no_pending' };
  const linked = rows.filter((r) => r.match_type === 'update' && r.existing_activity_id);
  if (!linked.length) return { refresh: false, reason: 'unlinked_pending' };
  const activityIds = new Set(linked.map((r) => r.existing_activity_id));
  if (activityIds.size > 1 || linked.length !== rows.length) return { refresh: false, reason: 'ambiguous_link' };
  const confident = linked.find((r) => Number(r.confidence_score ?? 0) >= duplicateThreshold);
  if (!confident) return { refresh: false, reason: 'low_confidence_link' };
  return { refresh: true, activityId: confident.existing_activity_id as string, pendingId: confident.id };
}

export type ReconfirmationOutcome =
  | { outcome: 'RECONFIRMED_EXISTING_PENDING_REVIEW'; activityId: string; pendingId: string }
  | { outcome: 'PENDING_REVIEW_ONLY'; reason: string };

export async function reconfirmExistingFromPending(client: Client, p: {
  rows: PendingReviewRow[]; duplicateThreshold: number; sourceId: string; pageUrl: string; detailUrl?: string | null;
}): Promise<ReconfirmationOutcome> {
  const decision = reconfirmationTarget(p.rows, p.duplicateThreshold);
  if (!decision.refresh) return { outcome: 'PENDING_REVIEW_ONLY', reason: decision.reason };
  const { data: live } = await client.from('activities')
    .update({ last_seen_at: new Date().toISOString(), consecutive_missing_scans: 0, missing_verified_streak: 0 })
    .eq('id', decision.activityId).eq('status', 'approved').select('id');
  if (!live || !live.length) return { outcome: 'PENDING_REVIEW_ONLY', reason: 'activity_not_approved' };
  await recordProvenance(client, { activityId: decision.activityId, sourceId: p.sourceId, pageUrl: p.pageUrl, incomingId: decision.pendingId, relation: 'seen', urlRole: 'listing', preserveRelation: true });
  if (p.detailUrl) await recordProvenance(client, { activityId: decision.activityId, sourceId: p.sourceId, pageUrl: p.detailUrl, incomingId: decision.pendingId, relation: 'seen', urlRole: 'detail', preserveRelation: true });
  return { outcome: 'RECONFIRMED_EXISTING_PENDING_REVIEW', activityId: decision.activityId, pendingId: decision.pendingId };
}
