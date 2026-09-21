// TuRu - bounded duplicate-candidate generator for the dedicated review queue (supabase/0104).
//
// This is a DETECTION layer, deliberately parallel to and independent of the live ingestion scorer
// (matching.ts computeConfidence). It never suppresses, archives, merges or edits an activity. Its
// only write, when explicitly enabled, is a row in public.duplicate_candidates for a person to judge.
// A false positive here costs one review glance; the live scorer's false positive costs a silently
// lost offering. That asymmetry is the whole reason this layer exists.
//
// BOUNDING (measured on production 2026-09-21): 5,698 approved rows with coordinates would be
// 16,230,753 naive pairs. Bucketing by coordinates rounded to 3 decimals (~111m x ~95m) leaves only
// 294 of 4,880 cells with 2+ rows, max 48, and 5,572 intra-cell pairs. Each row is compared against
// its own cell AND the 8 neighbouring cells, so two rows straddling a cell edge are still compared:
// the 60m radius is smaller than one cell, so a neighbour sweep cannot miss anything the radius
// would accept. A per-neighbourhood cap is a safety valve, not a tuning knob.
const { coordinateDuplicateSignal, COORDINATE_DUPLICATE_RADIUS_M, entityKind } = require('./duplicateSignal');

const GENERATOR_VERSION = 'dup-candidates/v2-2026-09-21';
const CELL_DEG = 0.001;            // ~111m latitude, ~95m longitude at Israel's latitude
const MAX_NEIGHBOURHOOD_ROWS = 200; // safety valve: a 3x3 neighbourhood beyond this is reported, not scanned
const ELIGIBLE_STATUS = 'approved';

// The minimum an activity row must carry. Callers select exactly these; no description, no images.
// { id, name, status, entity_type, venue_id, source_url, lat, lng, address, city }
function toSide(row) {
  return { name: row.name, lat: row.lat, lon: row.lng, address: row.address, sourceUrl: row.source_url, entityType: row.entity_type, venueId: row.venue_id, city: row.city };
}

// ROUTING (2026-09-21, first production dry-run: 300 of 359 candidates were event<->event pairs,
// 260 with IDENTICAL names, 190 from one ticketing source - repeated OCCURRENCES of one recurring
// listing, not the destination-duplicate problem this queue exists to review). This queue is about
// DESTINATION/ENTITY duplicates: a pair where NEITHER side is a physical place (entityKind !==
// 'place' on both) is out of scope here and is never written to duplicate_candidates, however the
// signal itself scored it. This is a ROUTING decision, not a semantic one: coordinateDuplicateSignal
// is untouched and still correctly reports such pairs as POSSIBLE_DUPLICATE (proven in
// tests/placesDiscoverySemantics.test.js) - that capability stays available for a future, separate
// occurrence-reconciliation subsystem, which is NOT built in this task. The place<->offering hard
// gate inside the signal itself is a different, unrelated protection and is not touched by this.
function isOfferingOfferingPair(a, b) {
  return entityKind(a.entity_type) === 'offering' && entityKind(b.entity_type) === 'offering';
}

function cellKey(lat, lng) {
  return `${Math.floor(lat / CELL_DEG)}:${Math.floor(lng / CELL_DEG)}`;
}

// Build the spatial index once. Only rows with coordinates are indexable; only eligible rows are
// proposed as NEW pairs (archived rows keep their existing pair history, they just stop generating).
function buildIndex(rows) {
  const cells = new Map();
  let indexed = 0, skippedNoCoords = 0, skippedIneligible = 0;
  for (const r of rows) {
    if (r.status !== ELIGIBLE_STATUS) { skippedIneligible++; continue; }
    if (r.lat == null || r.lng == null) { skippedNoCoords++; continue; }
    const k = cellKey(r.lat, r.lng);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(r);
    indexed++;
  }
  return { cells, stats: { indexed, skippedNoCoords, skippedIneligible, cellCount: cells.size } };
}

function neighbourhood(index, lat, lng) {
  const cy = Math.floor(lat / CELL_DEG), cx = Math.floor(lng / CELL_DEG);
  const out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const rows = index.cells.get(`${cy + dy}:${cx + dx}`);
    if (rows) out.push(...rows);
  }
  return out;
}

// canonical pair ordering: (a,b) === (b,a). Same rule the DB CHECK enforces.
function pairKey(idA, idB) { return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`; }
function orderPair(x, y) { return x.id < y.id ? [x, y] : [y, x]; }

// stable digest of what a reviewer would be judging; drives evidence_changed_at on resolved pairs
function evidenceFingerprint(signal) {
  return `${signal.relationship}|${[...signal.identityEvidence].sort().join(',')}`;
}

function toCandidateRow(a, b, signal) {
  const [lo, hi] = orderPair(a, b);
  return {
    activity_id_a: lo.id, activity_id_b: hi.id,
    relationship: signal.relationship,
    venue_relatedness: signal.venueRelatedness,
    identity_evidence: signal.identityEvidence,
    distance_m: signal.distanceM == null ? null : Math.round(signal.distanceM * 10) / 10,
    evidence_fingerprint: evidenceFingerprint(signal),
    generator_version: GENERATOR_VERSION,
    // for the human reading a report; never stored as identity
    _names: [lo.name, hi.name], _kinds: [lo.entity_type, hi.entity_type],
    _sources: [lo.source_url, hi.source_url], _venues: [lo.venue_id, hi.venue_id],
  };
}

// FUTURE SINGLE-ROW DETECTION. One activity against only its 3x3 neighbourhood. Output is a list of
// candidate rows for the queue - NEVER a verdict on whether the activity may be created.
function candidatesForActivity(row, index, opts = {}) {
  const out = []; const notes = [];
  if (row.lat == null || row.lng == null) return { candidates: out, notes: ['no coordinates'], excludedOfferingOffering: 0 };
  const near = neighbourhood(index, row.lat, row.lng);
  if (near.length > MAX_NEIGHBOURHOOD_ROWS) { notes.push(`neighbourhood of ${near.length} rows exceeds cap ${MAX_NEIGHBOURHOOD_ROWS} - skipped`); return { candidates: out, notes, excludedOfferingOffering: 0 }; }
  const seen = opts.seen || new Set();
  let excludedOfferingOffering = 0;
  for (const other of near) {
    if (other.id === row.id) continue;
    const k = pairKey(row.id, other.id);
    if (seen.has(k)) continue;
    const s = coordinateDuplicateSignal(toSide(row), toSide(other), { radiusM: opts.radiusM });
    if (!s.isCandidate) continue;
    seen.add(k);
    // ROUTING: destination duplicates only - see isOfferingOfferingPair above. The signal already
    // said POSSIBLE_DUPLICATE; this queue simply declines to carry an offering<->offering pair.
    if (isOfferingOfferingPair(row, other)) { excludedOfferingOffering++; continue; }
    out.push(toCandidateRow(row, other, s));
  }
  return { candidates: out, notes, excludedOfferingOffering };
}

// HISTORICAL SWEEP. Every eligible row through candidatesForActivity with one shared `seen` set, so
// each pair is emitted exactly once regardless of which side's neighbourhood found it.
function sweep(rows, opts = {}) {
  const index = buildIndex(rows);
  const seen = new Set();
  const candidates = []; const skippedNeighbourhoods = [];
  let comparisons = 0; let excludedOfferingOffering = 0;
  for (const rowsInCell of index.cells.values()) {
    for (const row of rowsInCell) {
      const near = neighbourhood(index, row.lat, row.lng);
      comparisons += Math.max(0, near.length - 1);
      const { candidates: c, notes, excludedOfferingOffering: ex } = candidatesForActivity(row, index, { seen, radiusM: opts.radiusM });
      candidates.push(...c);
      excludedOfferingOffering += ex;
      if (notes.length && notes[0].includes('exceeds cap')) skippedNeighbourhoods.push({ id: row.id, name: row.name, note: notes[0] });
    }
  }
  // comparisons counts ordered visits; each unordered pair is visited from both sides
  const stats = { ...index.stats, pairComparisons: comparisons / 2, candidates: candidates.length,
    candidateRate: index.stats.indexed ? candidates.length / index.stats.indexed : 0, skippedNeighbourhoods: skippedNeighbourhoods.length,
    excludedOfferingOfferingPairs: excludedOfferingOffering };
  return { candidates, stats, skippedNeighbourhoods };
}

// Aggregate breakdowns for a dry-run report. Pure.
function summarize(candidates) {
  const by = (fn) => { const m = {}; for (const c of candidates) { const k = fn(c); m[k] = (m[k] || 0) + 1; } return m; };
  const dom = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
  return {
    byEntityKindPair: by((c) => [...c._kinds].sort().join(' + ')),
    bySourceRelation: by((c) => (dom(c._sources[0]) && dom(c._sources[0]) === dom(c._sources[1])) ? 'same_source' : 'cross_source'),
    byVenueRelation: by((c) => (c._venues[0] && c._venues[0] === c._venues[1]) ? 'same_venue' : (c._venues[0] && c._venues[1] ? 'different_venue' : 'venue_unknown')),
    byIdentityKind: by((c) => c.identity_evidence.map((e) => e.split(':')[0]).sort().join('+')),
  };
}

// WRITE PATH (opt-in only). Idempotent upsert against the ordered-pair unique constraint, applying
// the rediscovery policy documented in 0104:
//   unknown pair         -> insert as needs_review
//   needs_review         -> refresh evidence, bump last_seen_at / detection_count; status untouched
//   resolved (any)       -> bump last_seen_at / detection_count only; if the evidence fingerprint
//                           changed, stamp evidence_changed_at; NEVER reopen, NEVER touch the verdict
// Requires an explicit opts.apply === true; otherwise it is a no-op that reports what it would do.
async function upsertCandidates(client, candidates, opts = {}) {
  const now = new Date().toISOString();
  const result = { inserted: 0, refreshed: 0, seenResolved: 0, evidenceChanged: 0, dryRun: opts.apply !== true };
  if (result.dryRun) return { ...result, wouldInsertOrRefresh: candidates.length };
  for (const c of candidates) {
    // Supabase returns plain error objects, not Error instances; wrap them so callers and tests see a
    // real stack and message (same convention as discover.js's all()).
    const fail = (e) => { throw new Error(e.message || String(e)); };
    const { data: existing, error: rErr } = await client.from('duplicate_candidates')
      .select('id, status, evidence_fingerprint, detection_count').eq('activity_id_a', c.activity_id_a).eq('activity_id_b', c.activity_id_b).maybeSingle();
    if (rErr) fail(rErr);
    const row = { activity_id_a: c.activity_id_a, activity_id_b: c.activity_id_b, relationship: c.relationship,
      venue_relatedness: c.venue_relatedness, identity_evidence: c.identity_evidence, distance_m: c.distance_m,
      evidence_fingerprint: c.evidence_fingerprint, generator_version: c.generator_version };
    if (!existing) {
      const { error } = await client.from('duplicate_candidates').insert({ ...row, status: 'needs_review', first_seen_at: now, last_seen_at: now });
      if (error) fail(error); result.inserted++; continue;
    }
    const bump = { last_seen_at: now, updated_at: now, detection_count: (existing.detection_count || 0) + 1 };
    if (existing.status === 'needs_review') {
      const { error } = await client.from('duplicate_candidates').update({ ...row, ...bump }).eq('id', existing.id).eq('status', 'needs_review');
      if (error) fail(error); result.refreshed++; continue;
    }
    result.seenResolved++;
    const patch = { ...bump };
    if (existing.evidence_fingerprint !== c.evidence_fingerprint) { patch.evidence_changed_at = now; result.evidenceChanged++; }
    const { error } = await client.from('duplicate_candidates').update(patch).eq('id', existing.id);
    if (error) fail(error);
  }
  return result;
}

module.exports = { GENERATOR_VERSION, CELL_DEG, MAX_NEIGHBOURHOOD_ROWS, ELIGIBLE_STATUS, COORDINATE_DUPLICATE_RADIUS_M,
  buildIndex, neighbourhood, cellKey, pairKey, candidatesForActivity, sweep, summarize, upsertCandidates, evidenceFingerprint, toSide, isOfferingOfferingPair };
