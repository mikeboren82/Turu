// TuRu - the duplicate-candidate review queue's generator + single-row live detector. Deno port of
// tools/import-tool/lib/duplicateCandidates.js (which the Node import-tool uses for its own live
// wiring and the historical backfill) - same deliberate-duplication arrangement as duplicateSignal.js
// / placesDiscovery.ts: two runtimes cannot share one module, so the pair must change together.
// Unlike the low-level signal (coordinateDuplicateSignal, drift-tested against a shared corpus),
// this file has no Node twin with a shared fixture, because only scan-source (this runtime) needs
// live single-row detection wired into ingestion - the Node side's own live wiring
// (tools/import-tool/lib/futureDuplicateDetection.js) is a THIN CALLER of duplicateCandidates.js,
// not a second port. Constants below are asserted to match the Node file's values by
// tools/import-tool/tests/duplicateCandidates.test.js (reads this file's source as text - the
// established convention in this repo, see that test's "DRIFT: constants..." case).
import { coordinateDuplicateSignal, entityKind, type DuplicateSide, type DuplicateCandidateSignal } from './placesDiscovery.ts';

// deno-lint-ignore no-explicit-any
type Client = any;

export const GENERATOR_VERSION = 'dup-candidates/v2-2026-09-21';
export const CELL_DEG = 0.001; // ~111m latitude, ~95m longitude at Israel's latitude
export const MAX_NEIGHBOURHOOD_ROWS = 200;
export const ELIGIBLE_STATUS = 'approved';
// LIVE DETECTION ONLY: the bounding-box query's padding around one arriving row's coordinates. Not
// the 60m signal radius (COORDINATE_DUPLICATE_RADIUS_M in placesDiscovery.ts) - this bounds the DB
// query, the signal's own haversine check remains the real authority. CELL_DEG*2 is the exact worst
// case for neighbourhood()'s 3x3-cell scan below: the arriving row can sit anywhere inside its own
// cell, so a neighbouring cell's far edge can be up to 2*CELL_DEG away. See the Node twin
// (tools/import-tool/lib/futureDuplicateDetection.js) for the identical reasoning, kept in sync.
export const NEIGHBOURHOOD_PAD_DEG = CELL_DEG * 2;

export interface CandidateRow {
  id: string; name: string | null; status: string | null; entity_type: string | null;
  venue_id: string | null; source_url: string | null; lat: number | null; lng: number | null;
  address: string | null; city: string | null;
}

function toSide(row: CandidateRow): DuplicateSide {
  return { name: row.name, lat: row.lat, lon: row.lng, address: row.address, sourceUrl: row.source_url, entityType: row.entity_type, venueId: row.venue_id, city: row.city };
}

// ROUTING (ported verbatim from duplicateCandidates.js - see that file for the full 2026-09-21
// production-dry-run rationale): this queue is DESTINATION/ENTITY duplicates only. A pair where
// neither side is a physical place is out of scope here, however the signal itself scored it.
export function isOfferingOfferingPair(a: { entity_type: string | null }, b: { entity_type: string | null }): boolean {
  return entityKind(a.entity_type) === 'offering' && entityKind(b.entity_type) === 'offering';
}

function cellKey(lat: number, lng: number): string {
  return `${Math.floor(lat / CELL_DEG)}:${Math.floor(lng / CELL_DEG)}`;
}

export interface Index { cells: Map<string, CandidateRow[]>; stats: { indexed: number; skippedNoCoords: number; skippedIneligible: number; cellCount: number } }

export function buildIndex(rows: CandidateRow[]): Index {
  const cells = new Map<string, CandidateRow[]>();
  let indexed = 0, skippedNoCoords = 0, skippedIneligible = 0;
  for (const r of rows) {
    if (r.status !== ELIGIBLE_STATUS) { skippedIneligible++; continue; }
    if (r.lat == null || r.lng == null) { skippedNoCoords++; continue; }
    const k = cellKey(r.lat, r.lng);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k)!.push(r);
    indexed++;
  }
  return { cells, stats: { indexed, skippedNoCoords, skippedIneligible, cellCount: cells.size } };
}

function neighbourhood(index: Index, lat: number, lng: number): CandidateRow[] {
  const cy = Math.floor(lat / CELL_DEG), cx = Math.floor(lng / CELL_DEG);
  const out: CandidateRow[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const rows = index.cells.get(`${cy + dy}:${cx + dx}`);
    if (rows) out.push(...rows);
  }
  return out;
}

function pairKey(idA: string, idB: string): string { return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`; }
function orderPair(x: CandidateRow, y: CandidateRow): [CandidateRow, CandidateRow] { return x.id < y.id ? [x, y] : [y, x]; }

function evidenceFingerprint(signal: DuplicateCandidateSignal): string {
  return `${signal.relationship}|${[...signal.identityEvidence].sort().join(',')}`;
}

export interface CandidateOut {
  activity_id_a: string; activity_id_b: string; relationship: string; venue_relatedness: string[];
  identity_evidence: string[]; distance_m: number | null; evidence_fingerprint: string; generator_version: string;
  _names: [string | null, string | null]; _kinds: [string | null, string | null];
}

function toCandidateRow(a: CandidateRow, b: CandidateRow, signal: DuplicateCandidateSignal): CandidateOut {
  const [lo, hi] = orderPair(a, b);
  return {
    activity_id_a: lo.id, activity_id_b: hi.id,
    relationship: signal.relationship,
    venue_relatedness: signal.venueRelatedness,
    identity_evidence: signal.identityEvidence,
    distance_m: signal.distanceM == null ? null : Math.round(signal.distanceM * 10) / 10,
    evidence_fingerprint: evidenceFingerprint(signal),
    generator_version: GENERATOR_VERSION,
    _names: [lo.name, hi.name], _kinds: [lo.entity_type, hi.entity_type],
  };
}

// FUTURE SINGLE-ROW DETECTION. One activity against only its 3x3 neighbourhood, ported verbatim
// from duplicateCandidates.js's candidatesForActivity. Output is a list of candidate rows for the
// queue - NEVER a verdict on whether the activity may be created.
export function candidatesForActivity(row: CandidateRow, index: Index, opts: { seen?: Set<string>; radiusM?: number } = {}): { candidates: CandidateOut[]; notes: string[] } {
  const out: CandidateOut[] = []; const notes: string[] = [];
  if (row.lat == null || row.lng == null) return { candidates: out, notes: ['no coordinates'] };
  const near = neighbourhood(index, row.lat, row.lng);
  if (near.length > MAX_NEIGHBOURHOOD_ROWS) { notes.push(`neighbourhood of ${near.length} rows exceeds cap ${MAX_NEIGHBOURHOOD_ROWS} - skipped`); return { candidates: out, notes }; }
  const seen = opts.seen || new Set<string>();
  for (const other of near) {
    if (other.id === row.id) continue;
    const k = pairKey(row.id, other.id);
    if (seen.has(k)) continue;
    const s = coordinateDuplicateSignal(toSide(row), toSide(other), { radiusM: opts.radiusM });
    if (!s.isCandidate) continue;
    seen.add(k);
    if (isOfferingOfferingPair(row, other)) continue;
    out.push(toCandidateRow(row, other, s));
  }
  return { candidates: out, notes };
}

// WRITE PATH. Idempotent upsert against the ordered-pair unique constraint (0104), ported verbatim
// from duplicateCandidates.js's upsertCandidates - same rediscovery policy:
//   unknown pair    -> insert as needs_review
//   needs_review    -> refresh evidence, bump last_seen_at/detection_count; status untouched
//   resolved (any)  -> bump last_seen_at/detection_count only; NEVER reopen, NEVER touch the verdict
export async function upsertCandidates(client: Client, candidates: CandidateOut[]): Promise<{ inserted: number; refreshed: number; seenResolved: number; evidenceChanged: number }> {
  const now = new Date().toISOString();
  const result = { inserted: 0, refreshed: 0, seenResolved: 0, evidenceChanged: 0 };
  for (const c of candidates) {
    const { data: existing, error: rErr } = await client.from('duplicate_candidates')
      .select('id, status, evidence_fingerprint, detection_count').eq('activity_id_a', c.activity_id_a).eq('activity_id_b', c.activity_id_b).maybeSingle();
    if (rErr) throw new Error(rErr.message || String(rErr));
    const row = { activity_id_a: c.activity_id_a, activity_id_b: c.activity_id_b, relationship: c.relationship,
      venue_relatedness: c.venue_relatedness, identity_evidence: c.identity_evidence, distance_m: c.distance_m,
      evidence_fingerprint: c.evidence_fingerprint, generator_version: c.generator_version };
    if (!existing) {
      const { error } = await client.from('duplicate_candidates').insert({ ...row, status: 'needs_review', first_seen_at: now, last_seen_at: now });
      if (error) throw new Error(error.message || String(error));
      result.inserted++; continue;
    }
    const bump = { last_seen_at: now, updated_at: now, detection_count: (existing.detection_count || 0) + 1 };
    if (existing.status === 'needs_review') {
      const { error } = await client.from('duplicate_candidates').update({ ...row, ...bump }).eq('id', existing.id).eq('status', 'needs_review');
      if (error) throw new Error(error.message || String(error));
      result.refreshed++; continue;
    }
    result.seenResolved++;
    // deno-lint-ignore no-explicit-any
    const patch: Record<string, any> = { ...bump };
    if (existing.evidence_fingerprint !== c.evidence_fingerprint) { patch.evidence_changed_at = now; result.evidenceChanged++; }
    const { error } = await client.from('duplicate_candidates').update(patch).eq('id', existing.id);
    if (error) throw new Error(error.message || String(error));
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// LIVE WIRING (2026-09-21). Best-effort, non-destructive detection for ONE activity right after it
// commits via autoApproveNewActivity in scan-source/index.ts. See the Node twin
// (tools/import-tool/lib/futureDuplicateDetection.js) for the full design rationale - same
// bounded-bounding-box approach (no full-catalogue load), same failure-isolation guarantee (never
// throws), same eligibility gate (ELIGIBLE_STATUS + coordinates present).

async function loadRow(client: Client, activityId: string): Promise<CandidateRow | null> {
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

async function loadNeighbourhood(client: Client, lat: number, lng: number, excludeActivityId: string): Promise<CandidateRow[]> {
  const { data: locs, error: locErr } = await client.from('locations')
    .select('id, lat, lng, address, city')
    .not('lat', 'is', null).not('lng', 'is', null)
    .gte('lat', lat - NEIGHBOURHOOD_PAD_DEG).lte('lat', lat + NEIGHBOURHOOD_PAD_DEG)
    .gte('lng', lng - NEIGHBOURHOOD_PAD_DEG).lte('lng', lng + NEIGHBOURHOOD_PAD_DEG);
  if (locErr) throw new Error(locErr.message || String(locErr));
  // deno-lint-ignore no-explicit-any
  const locations = (locs || []) as any[];
  if (!locations.length) return [];
  const { data: acts, error: actErr } = await client.from('activities')
    .select('id, name, status, entity_type, venue_id, source_url, location_id')
    .in('location_id', locations.map((l) => l.id)).eq('status', ELIGIBLE_STATUS).neq('id', excludeActivityId);
  if (actErr) throw new Error(actErr.message || String(actErr));
  const byLoc = new Map(locations.map((l) => [l.id, l]));
  // deno-lint-ignore no-explicit-any
  return ((acts || []) as any[]).map((a) => {
    const l = byLoc.get(a.location_id) || {};
    return { id: a.id, name: a.name, status: a.status, entity_type: a.entity_type, venue_id: a.venue_id,
      source_url: a.source_url, lat: l.lat ?? null, lng: l.lng ?? null, address: l.address ?? null, city: l.city ?? null };
  });
}

export interface DetectionResult {
  invoked: true; activityId: string; reason: string; skippedReason: string | null;
  neighbourhoodSize: number; candidatesFound: number; inserted: number; refreshed: number;
  elapsedMs: number; error: string | null;
}

// The one public entry point. NEVER throws - see the module header. `reason` is observability-only.
export async function detectFutureDuplicates(client: Client, activityId: string, opts: { reason?: string } = {}): Promise<DetectionResult> {
  const reason = opts.reason || 'unspecified';
  const startedAt = Date.now();
  const result: DetectionResult = {
    invoked: true, activityId, reason, skippedReason: null,
    neighbourhoodSize: 0, candidatesFound: 0, inserted: 0, refreshed: 0, elapsedMs: 0, error: null,
  };
  try {
    const row = await loadRow(client, activityId);
    if (!row) { result.skippedReason = 'activity_not_found'; return result; }
    if (row.status !== ELIGIBLE_STATUS) { result.skippedReason = `status:${row.status}`; return result; }
    if (row.lat == null || row.lng == null) { result.skippedReason = 'no_coordinates'; return result; }

    const near = await loadNeighbourhood(client, row.lat, row.lng, row.id);
    result.neighbourhoodSize = near.length;
    const index = buildIndex(near);
    const { candidates } = candidatesForActivity(row, index, {});
    result.candidatesFound = candidates.length;
    if (candidates.length) {
      const w = await upsertCandidates(client, candidates);
      result.inserted = w.inserted; result.refreshed = w.refreshed;
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    console.error(`[duplicate-detection] best-effort detection failed for activity ${activityId} (reason=${reason}); the activity itself is unaffected: ${result.error}`);
  } finally {
    result.elapsedMs = Date.now() - startedAt;
  }
  if (!result.error) {
    if (result.skippedReason) console.log(`[duplicate-detection] skipped (${result.skippedReason}) reason=${reason} activity=${activityId}`);
    else console.log(`[duplicate-detection] invoked reason=${reason} activity=${activityId} neighbourhood=${result.neighbourhoodSize} candidates=${result.candidatesFound} inserted=${result.inserted} refreshed=${result.refreshed} ${result.elapsedMs}ms`);
  }
  return result;
}
