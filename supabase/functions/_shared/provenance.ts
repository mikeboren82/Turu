// Provenance row for every detection (created / seen / updated) - idempotent on (activity, page_url).
// url_role (0091) says WHAT the page is: 'listing' (discovery/calendar page), 'detail' (the event's own
// page), 'booking', 'other'. A listing URL is never event identity; only a verified detail URL may be.
// deno-lint-ignore no-explicit-any
type Client = any;
export type UrlRole = 'listing' | 'detail' | 'booking' | 'other';

export async function recordProvenance(client: Client, params: {
  activityId: string; sourceId: string; pageUrl: string; incomingId: string | null;
  relation: 'created' | 'seen' | 'updated'; urlRole?: UrlRole;
  // freshness-only: keep the row's relation (lib/activitySourceMerge.js rule), just bump last_seen_at
  preserveRelation?: boolean;
}) {
  const now = new Date().toISOString();
  // URL ROLES reach the product (0097): provenance is admin-only, so the VERIFIED event-detail page is also
  // kept on the canonical record, fill-null. It is what the app opens when no explicit booking action is
  // known (official_url > detail_url > source_url) - never the listing, and never written into official_url.
  if (params.urlRole === 'detail' && /^https?:\/\//i.test(params.pageUrl)) {
    await client.from('activities').update({ detail_url: params.pageUrl }).eq('id', params.activityId).is('detail_url', null);
  }
  const { data: existing } = await client.from('activity_sources').select('id, relation, url_role')
    .eq('activity_id', params.activityId).eq('page_url', params.pageUrl).maybeSingle();
  if (existing) {
    const prior = (existing as { relation: string }).relation;
    // never downgrade the historical 'created' relation when the same page re-detects the activity
    const rel = prior === 'created' ? 'created' : params.preserveRelation ? prior : params.relation;
    const patch: Record<string, unknown> = { last_seen_at: now, relation: rel, source_id: params.sourceId };
    if (params.urlRole && !(existing as { url_role: string | null }).url_role) patch.url_role = params.urlRole;
    await client.from('activity_sources').update(patch).eq('id', (existing as { id: string }).id);
    return;
  }
  await client.from('activity_sources').insert({
    activity_id: params.activityId, source_id: params.sourceId, page_url: params.pageUrl,
    incoming_activity_id: params.incomingId, relation: params.relation, url_role: params.urlRole || null, first_seen_at: now, last_seen_at: now,
  });
}
