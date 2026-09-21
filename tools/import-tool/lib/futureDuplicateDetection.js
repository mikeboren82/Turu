// TuRu - bounded duplicate-candidate detection for a SINGLE arriving/updated activity, run right
// after that activity commits to the catalogue. This wires the historical generator's own
// single-row detector (duplicateCandidates.js's candidatesForActivity, unmodified - see its own
// "FUTURE SINGLE-ROW DETECTION" comment) into live ingestion, closing the gap the 2026-09-21
// activation left open: recurrence like the Safari aggregator copy was only caught by the manual
// backfill, never by a NEW arrival.
//
// NON-DESTRUCTIVE BY CONSTRUCTION. This module only ever writes to duplicate_candidates (via the
// same upsertCandidates used by the historical backfill). It never touches the activities table,
// never suppresses or blocks an ingestion, and its own failure can never fail the caller: every
// public entry point catches internally and returns a result object instead of throwing. Ingestion
// callers are expected to invoke this AFTER their own write has already committed and to ignore
// the return value beyond logging it (see server.js's saveNewActivity/applyIncomingUpdate).
//
// BOUNDING WITHOUT THE FULL CATALOGUE (measured 2026-09-21, see report below). The historical sweep
// loads all ~6,180 activities once and buckets them into ~0.001deg cells to make one full pass over
// the catalogue tractable. That bucketing is a SWEEP-ONLY optimisation; a single arriving activity
// does not need it; the DB itself can return "everything within a bounding box" in one query. The
// pad below is not arbitrary: NEIGHBOURHOOD_PAD_DEG = CELL_DEG * 2 is the exact worst case for
// candidatesForActivity's own 3x3-cell neighbourhood() - the arriving row can sit anywhere inside
// its own cell, so the farthest edge of a neighbouring cell's neighbour is up to 2*CELL_DEG away.
// Padding to that exact bound (not to the far smaller 60m signal radius) guarantees this bounded
// query returns every row neighbourhood() would have found via the full in-memory index - same
// candidates, same order-independent result, just without touching the other ~6,000 rows.
const {
  ELIGIBLE_STATUS, CELL_DEG, GENERATOR_VERSION, buildIndex, candidatesForActivity, upsertCandidates,
} = require('./duplicateCandidates');

const NEIGHBOURHOOD_PAD_DEG = CELL_DEG * 2;

// The subset of a diff (supabase/functions/_shared/matching.ts's computeFieldDiff shape, {key:
// {before, after}}) that can change whether an activity duplicates another one: name/location/
// entity_type feed coordinateDuplicateSignal directly (see duplicateSignal.js's DuplicateSide
// shape). price/age/description/booking/occurrences etc. cannot move the signal, so an update
// carrying only those must not re-trigger detection ("do not rerun detection on every trivial
// update"). Coordinates themselves are never a diff key - they move only via a city change
// (geocodeAndFillLocation) or an address change, both already listed here.
const MATERIAL_IDENTITY_DIFF_KEYS = new Set(['name', 'location_name', 'city', 'address', 'entity_type']);
function isMaterialIdentityChange(diff) {
  return Object.keys(diff || {}).some((k) => MATERIAL_IDENTITY_DIFF_KEYS.has(k));
}

async function loadRow(client, activityId) {
  const { data, error } = await client.from('activities')
    .select('id, name, status, entity_type, venue_id, source_url, location_id, locations(lat, lng, address, city)')
    .eq('id', activityId).maybeSingle();
  if (error) throw new Error(error.message || String(error));
  if (!data) return null;
  return {
    id: data.id, name: data.name, status: data.status, entity_type: data.entity_type,
    venue_id: data.venue_id, source_url: data.source_url,
    lat: data.locations?.lat ?? null, lng: data.locations?.lng ?? null,
    address: data.locations?.address ?? null, city: data.locations?.city ?? null,
  };
}

// One bounded pair of queries (locations bounding box -> their eligible activities), never the
// full catalogue. Mirrors buildIndex's own row shape so the fetched set can feed straight into it.
async function loadNeighbourhood(client, lat, lng, excludeActivityId) {
  const { data: locs, error: locErr } = await client.from('locations')
    .select('id, lat, lng, address, city')
    .not('lat', 'is', null).not('lng', 'is', null)
    .gte('lat', lat - NEIGHBOURHOOD_PAD_DEG).lte('lat', lat + NEIGHBOURHOOD_PAD_DEG)
    .gte('lng', lng - NEIGHBOURHOOD_PAD_DEG).lte('lng', lng + NEIGHBOURHOOD_PAD_DEG);
  if (locErr) throw new Error(locErr.message || String(locErr));
  if (!locs || !locs.length) return [];
  const { data: acts, error: actErr } = await client.from('activities')
    .select('id, name, status, entity_type, venue_id, source_url, location_id')
    .in('location_id', locs.map((l) => l.id)).eq('status', ELIGIBLE_STATUS).neq('id', excludeActivityId);
  if (actErr) throw new Error(actErr.message || String(actErr));
  const byLoc = new Map(locs.map((l) => [l.id, l]));
  return (acts || []).map((a) => {
    const l = byLoc.get(a.location_id) || {};
    return { id: a.id, name: a.name, status: a.status, entity_type: a.entity_type, venue_id: a.venue_id,
      source_url: a.source_url, lat: l.lat ?? null, lng: l.lng ?? null, address: l.address ?? null, city: l.city ?? null };
  });
}

// The one public entry point. NEVER throws - detection failure must never fail the ingestion that
// already committed the activity this is evaluating. `reason` is observability-only (see FUTURE
// EVENT below): which caller/trigger invoked detection, e.g. 'new-activity', 'material-update'.
async function detectFutureDuplicates(client, activityId, opts = {}) {
  const reason = opts.reason || 'unspecified';
  const startedAt = Date.now();
  const result = {
    invoked: true, activityId, reason, skippedReason: null,
    neighbourhoodSize: 0, candidatesEvaluated: 0, candidatesFound: 0, inserted: 0, refreshed: 0,
    elapsedMs: 0, error: null,
  };
  try {
    const row = await loadRow(client, activityId);
    if (!row) { result.skippedReason = 'activity_not_found'; return result; }
    if (row.status !== ELIGIBLE_STATUS) { result.skippedReason = `status:${row.status}`; return result; }
    if (row.lat == null || row.lng == null) { result.skippedReason = 'no_coordinates'; return result; }

    const near = await loadNeighbourhood(client, row.lat, row.lng, row.id);
    result.neighbourhoodSize = near.length;
    const index = buildIndex(near);
    // reuses the exact same signal/routing/pair-identity logic as the historical sweep - no second
    // duplicate-detection algorithm, see the module header.
    const { candidates } = candidatesForActivity(row, index, {});
    result.candidatesEvaluated = near.length;
    result.candidatesFound = candidates.length;
    if (candidates.length) {
      const w = await upsertCandidates(client, candidates, { apply: true });
      result.inserted = w.inserted; result.refreshed = w.refreshed;
    }
  } catch (e) {
    result.error = e.message || String(e);
    // deliberately console.error, never re-thrown: see the failure-isolation note in the module header.
    console.error(`[duplicate-detection] best-effort detection failed for activity ${activityId} (reason=${reason}); the activity itself is unaffected: ${result.error}`);
  } finally {
    result.elapsedMs = Date.now() - startedAt;
  }
  if (result.error) return result;
  const parts = [`invoked reason=${reason} activity=${activityId}`, `neighbourhood=${result.neighbourhoodSize}`,
    `candidates=${result.candidatesFound}`, `inserted=${result.inserted}`, `refreshed=${result.refreshed}`, `${result.elapsedMs}ms`];
  if (result.skippedReason) console.log(`[duplicate-detection] skipped (${result.skippedReason}) reason=${reason} activity=${activityId}`);
  else console.log(`[duplicate-detection] ${parts.join(' ')}`);
  return result;
}

module.exports = {
  detectFutureDuplicates, loadRow, loadNeighbourhood, NEIGHBOURHOOD_PAD_DEG, GENERATOR_VERSION,
  MATERIAL_IDENTITY_DIFF_KEYS, isMaterialIdentityChange,
};
