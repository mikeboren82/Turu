// TuRu - venues.google_place_id is EXTERNAL IDENTITY: at most one venues row owns a non-null id, active or merged
// (supabase/0114_venues_place_id_unique.sql, a NON-partial unique index - NULLs stay distinct, and the index is
// directly inferable by PostgREST's `on_conflict=google_place_id`).
//
// The only doors to that column:
//   ensureVenueByPlaceId - every venue CREATE that carries a place id (admin POST /api/venues, the future coverage
//                          venue writer). Insert-or-nothing, then re-select: idempotent under retries and concurrency.
//   mergeVenuePlaceId    - the venue merge's id transfer (clear loser FIRST, then set keeper - the only order a
//                          unique index allows), run before anything else in the merge is touched.
// A null place id never enters here: without an external id, identity stays with the name/alias rules.
const { verifiedConditionalUpdate, isSuccess, describe } = require('./verifiedWrite');

const CODES = Object.freeze({
  PLACE_ID_REQUIRED: 'VENUE_PLACE_ID_REQUIRED',
  INDEX_MISSING: 'VENUE_PLACE_ID_INDEX_MISSING', // 42P10: 0114 not applied (or rolled back) - refuse, never duplicate
  UNRESOLVED: 'VENUE_PLACE_ID_UNRESOLVED',
  MERGE_CHAIN_BROKEN: 'VENUE_MERGE_CHAIN_BROKEN',
  EXTERNAL_ID_CONFLICT: 'VENUE_MERGE_EXTERNAL_ID_CONFLICT',
  TRANSFER_FAILED: 'VENUE_MERGE_PLACE_ID_TRANSFER_FAILED',
});

// real venues columns (0076); anything else on a candidate (coverage plan's kind / 'new:' id / aliases / branch) is dropped
const VENUE_INSERT_COLUMNS = Object.freeze(['name_he', 'venue_type', 'city', 'neighborhood', 'address', 'lat', 'lng', 'region', 'chain',
  'website_url', 'events_url', 'facebook_url', 'instagram_url', 'google_place_id', 'is_active', 'notes', 'created_by']);
const MAX_MERGE_HOPS = 5;

// '' / whitespace is not an id - two unrelated venues must never "share" a blank one (0114 CHECK enforces trimmed, non-empty)
function normalizePlaceId(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t || null;
}

function toVenueInsertRow(candidate) {
  const row = {};
  for (const k of VENUE_INSERT_COLUMNS) if (candidate[k] !== undefined) row[k] = candidate[k];
  return row;
}

// owner of placeId -> the canonical venue: follows merged_into (a legacy merged loser still holding the id) to its keeper.
// -> { venue, created: false, inactive, followed: [ids] } | { error, code }
async function canonicalVenueByPlaceId(client, placeId) {
  const { data: owner, error } = await client.from('venues').select('*').eq('google_place_id', placeId).maybeSingle();
  if (error) return { error: error.message, code: error.code || CODES.UNRESOLVED };
  if (!owner) return { error: `no venue owns google_place_id ${placeId}`, code: CODES.UNRESOLVED };
  let venue = owner; const followed = [];
  while (venue.merged_into) {
    if (followed.length >= MAX_MERGE_HOPS || followed.includes(venue.merged_into) || venue.merged_into === owner.id) {
      return { error: `merged_into chain from ${owner.id} does not end at a keeper`, code: CODES.MERGE_CHAIN_BROKEN, owner };
    }
    followed.push(venue.merged_into);
    const { data: next, error: nErr } = await client.from('venues').select('*').eq('id', venue.merged_into).maybeSingle();
    if (nErr) return { error: nErr.message, code: nErr.code || CODES.MERGE_CHAIN_BROKEN, owner };
    if (!next) return { error: `merged_into ${venue.merged_into} not found`, code: CODES.MERGE_CHAIN_BROKEN, owner };
    venue = next;
  }
  return { venue, created: false, inactive: !venue.is_active, followed };
}

// The one create-by-external-id door. INSERT ... ON CONFLICT (google_place_id) DO NOTHING RETURNING *: a returned row is
// ours; an empty result means the id already has an owner, whose descriptive fields are NEVER overwritten by a second
// discovery - re-select it instead. Retrying the identical call after an uncertain response is therefore safe.
// -> { venue, created: true } | { venue, created: false, inactive, followed } | { error, code }
async function ensureVenueByPlaceId(client, candidate) {
  const placeId = normalizePlaceId(candidate && candidate.google_place_id);
  if (!placeId) return { error: 'google_place_id is required on the external-identity path', code: CODES.PLACE_ID_REQUIRED };
  const row = { ...toVenueInsertRow(candidate), google_place_id: placeId };
  const { data, error } = await client.from('venues').upsert(row, { onConflict: 'google_place_id', ignoreDuplicates: true }).select('*');
  if (error) {
    if (error.code === '42P10') return { error: 'venues.google_place_id has no unique index (migration 0114 not applied)', code: CODES.INDEX_MISSING };
    return { error: error.message, code: error.code || 'VENUE_INSERT_FAILED' };
  }
  if (Array.isArray(data) && data.length === 1) return { venue: data[0], created: true };
  return canonicalVenueByPlaceId(client, placeId);
}

const hasId = (v) => normalizePlaceId(v) !== null;

// pure: what a merge loser -> keeper must do with google_place_id so exactly one row owns it afterwards
function planPlaceIdMerge(keeper, loser) {
  const k = keeper.google_place_id, l = loser.google_place_id;
  if (!hasId(l)) return { action: 'NONE' };
  if (hasId(k) && normalizePlaceId(k) === normalizePlaceId(l)) return { action: 'CLEAR_LOSER', loserRaw: l, placeId: normalizePlaceId(l) };
  if (!hasId(k)) return { action: 'TRANSFER', loserRaw: l, placeId: normalizePlaceId(l) };
  return { action: 'CONFLICT', keeperPlaceId: k, loserPlaceId: l };
}

// Run BEFORE the merge re-points anything: a refusal or failure here leaves the merge wholly un-started.
// Not atomic (separate PostgREST calls): between "clear loser" and "set keeper" no row owns the id. A failed keeper
// assignment is compensated by restoring the loser; if even that fails the error names the id for manual repair.
// Every intermediate state has AT MOST one owner - the unique index makes a duplicate impossible, not just unlikely.
// -> { outcome: 'NONE' | 'CLEARED_LOSER' | 'TRANSFERRED', placeId? } | { error, code, ... }
async function mergeVenuePlaceId(client, { keeper, loser }) {
  const plan = planPlaceIdMerge(keeper, loser);
  if (plan.action === 'NONE') return { outcome: 'NONE' };
  if (plan.action === 'CONFLICT') {
    return { error: `keeper and loser carry different google_place_id values (${plan.keeperPlaceId} / ${plan.loserPlaceId}) - resolve by hand before merging`,
      code: CODES.EXTERNAL_ID_CONFLICT, keeperPlaceId: plan.keeperPlaceId, loserPlaceId: plan.loserPlaceId };
  }
  const clear = await verifiedConditionalUpdate(client, { table: 'venues', id: loser.id, patch: { google_place_id: null }, expectedOld: { google_place_id: plan.loserRaw } });
  if (!isSuccess(clear)) return { error: `clearing loser google_place_id: ${describe(clear)}`, code: CODES.TRANSFER_FAILED, stage: 'clear_loser', placeId: plan.placeId };
  if (plan.action === 'CLEAR_LOSER') return { outcome: 'CLEARED_LOSER', placeId: plan.placeId };

  const assign = await verifiedConditionalUpdate(client, { table: 'venues', id: keeper.id, patch: { google_place_id: plan.placeId }, expectedOld: { google_place_id: null } });
  if (isSuccess(assign)) return { outcome: 'TRANSFERRED', placeId: plan.placeId };
  const restore = await verifiedConditionalUpdate(client, { table: 'venues', id: loser.id, patch: { google_place_id: plan.loserRaw }, expectedOld: { google_place_id: null } });
  return {
    error: `assigning google_place_id ${plan.placeId} to keeper ${keeper.id}: ${describe(assign)}; loser ${isSuccess(restore) ? 'restored' : `NOT restored (${describe(restore)}) - set it back by hand`}`,
    code: CODES.TRANSFER_FAILED, stage: 'assign_keeper', placeId: plan.placeId, compensation: isSuccess(restore) ? 'RESTORED' : 'FAILED',
  };
}

module.exports = { CODES, VENUE_INSERT_COLUMNS, normalizePlaceId, toVenueInsertRow, canonicalVenueByPlaceId, ensureVenueByPlaceId, planPlaceIdMerge, mergeVenuePlaceId };
