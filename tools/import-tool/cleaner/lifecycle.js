// TuRu Cleaner - retry / backoff / archive / reopen rules (THE-CLEANER.md §16-19). Pure helpers +
// the DB writes that move a case (and its subject) to a terminal state. Archive reasons are
// machine-readable codes; an archived subject is never deleted and can be reopened by reopen().
//
// ATTEMPT = INFORMATION GAIN. Each attempt runs `existing` (cheap; new canonical knowledge shows up
// there) plus the next evidence stages that were never tried for this case. A stage that cannot run
// for this subject is recorded as unavailable with the reason. A case becomes terminal only when
// attempts >= cleaner_max_attempts AND every stage is either tried or recorded unavailable.
// Every archive carries a structured explanation (what was missing, what was tried, what was
// unavailable, what evidence existed, why it was insufficient, external limits, what would reopen it).
// Leases (0088): every terminal/retry write also releases the case's claim.
const venueNaming = require('../venueNaming'); // called through the module so tests can inject
const { STAGES, EVIDENCE_STAGES, EXTERNAL_LIMIT } = require('./locationResolver');

const ARCHIVE_REASON_BY_ISSUE = {
  missing_location: 'missing_address_unresolved', rejected_missing_address: 'missing_address_unresolved', unverified_location: 'missing_address_unresolved',
  missing_coordinates: 'missing_address_unresolved', incomplete_address: 'address_unresolved_nonblocking', missing_venue: 'venue_not_found',
  missing_image: 'image_unavailable_only', broken_image: 'image_unavailable_only', missing_schedule: 'insufficient_required_data',
  missing_region: 'other', missing_required_metadata: 'insufficient_required_data', low_quality_description: 'other',
  settlement_review: 'insufficient_required_data', missing_city: 'city_unresolved', misclassified: 'requires_human_judgment',
};
// issues whose archive also archives/rejects the SUBJECT (blocking); the rest archive only the case
const BLOCKING_FOR_INCOMING = new Set(['missing_location', 'rejected_missing_address', 'unverified_location', 'missing_required_metadata', 'missing_coordinates']);
const REOPENABLE_REASONS = new Set(['missing_address_unresolved', 'ambiguous_location', 'venue_not_found', 'source_unreachable', 'insufficient_required_data', 'ambiguous_audience', 'address_unresolved_nonblocking', 'city_unresolved']);
const LOCATION_ISSUES = new Set(['missing_location', 'rejected_missing_address', 'unverified_location', 'missing_coordinates', 'incomplete_address', 'missing_venue']);

// what each issue is missing, and which evidence would justify reopening its archive
const MISSING_BY_ISSUE = {
  missing_location: 'verified location (city + place + coordinates)', unverified_location: 'street-level verified coordinates (only a city centroid known)',
  incomplete_address: 'street address (coordinates known)', missing_coordinates: 'coordinates', missing_venue: 'canonical venue link',
  missing_image: 'usable image', broken_image: 'usable image (current one broken)', missing_schedule: 'schedule rows', missing_region: 'region',
  missing_required_metadata: 'required metadata (category/date/entity type/audience)', low_quality_description: 'description',
  settlement_review: 'identity decision for a legacy settlement candidate (duplicate / new / invalid)',
  missing_city: 'canonical city (coordinates known)',
  misclassified: 'correct venue type (filed as a public playground)',
};
const REOPEN_WHEN_BY_ISSUE = {
  missing_location: ['a venue/alias resolves the location label or organizer', 'the source page or its detail page changes', 'the same event fingerprint reappears with location data', 'a single-venue detail page for the event appears (touring shows)'],
  unverified_location: ['a venue/alias resolves the label', 'the source page changes'], incomplete_address: ['the linked venue gains an address', 'the source page changes'],
  missing_coordinates: ['a venue/alias resolves the label'], missing_venue: ['a venue/alias is created for the label'],
  missing_image: ['the source page or detail page gains an image', 'the venue gains a site image'], broken_image: ['the source page gains an image'],
  missing_schedule: ['the source page exposes a schedule (JSON-LD/text)'], missing_region: ['the city gains a region mapping'],
  missing_required_metadata: ['the source page exposes the missing field (JSON-LD)'], low_quality_description: ['the source page changes'],
  misclassified: ['an admin confirms the venue type', 'the official site / a canonical venue states the venue type'],
  missing_city: ['a canonical venue is linked to the activity', 'a settlement alias is added for the geocoder locality (public.settlement_aliases)', 'the coordinates are corrected'],
  settlement_review: ['Google Place details become available (types/photos)', 'a canonical record appears with the same place id or street', 'an admin adds venue/category evidence'],
};

function settingsFrom(rows) {
  const s = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
  return {
    enabled: s.cleaner_enabled !== false,
    maxAttempts: Number(s.cleaner_max_attempts ?? 3),
    backoffHours: Array.isArray(s.cleaner_backoff_hours) ? s.cleaner_backoff_hours.map(Number) : [6, 24, 72],
    batchSize: Number(s.cleaner_batch_size ?? 40),
    clusterMinSize: Number(s.cleaner_cluster_min_size ?? 3),
    leaseSeconds: Number(s.cleaner_lease_seconds ?? 900),
    minTrust: Number(s.auto_approve_min_trust_score ?? 80),
    maxDaysAhead: Number(s.event_max_days_ahead ?? 180),
    thresholds: { duplicate: Number(s.duplicate_confidence_threshold ?? 0.9), needsReview: Number(s.needs_review_confidence_threshold ?? 0.6), proximityKm: Number(s.proximity_km ?? 0.15) },
  };
}

function nextAttemptAt(attemptsDone, backoffHours, now = new Date()) {
  const h = backoffHours[Math.min(attemptsDone - 1, backoffHours.length - 1)] ?? 72;
  return new Date(now.getTime() + h * 3600 * 1000).toISOString();
}

// Stages this attempt should consider: `existing` first, then every evidence stage never tried and
// not already recorded unavailable (unavailability is re-evaluated each attempt - a venue may exist now).
function stagesForAttempt(c) {
  const triedBefore = new Set(c.methods_tried || []);
  return ['existing', ...EVIDENCE_STAGES.filter((s) => !triedBefore.has(s))];
}
const unavailableOf = (c) => (c.resolution && Array.isArray(c.resolution.unavailable)) ? c.resolution.unavailable : [];

// Evidence stages neither tried nor recorded unavailable (for location issues). Empty => exhausted.
function remainingStages(c, skippedNow = []) {
  if (!LOCATION_ISSUES.has(c.issue)) return [];
  const tried = new Set(c.methods_tried || []);
  const unavailable = new Set([...unavailableOf(c), ...skippedNow].map((x) => x.stage));
  return EVIDENCE_STAGES.filter((s) => !tried.has(s) && !unavailable.has(s));
}

const RELEASE = { claimed_by: null, claimed_at: null, lease_until: null };

// method: stages actually run this attempt; skipped: [{stage, why}] configured but unavailable
async function markAttemptFailed(client, c, { method, error, settings, evidence, skipped = [] }) {
  const attempts = c.attempts + 1;
  const now = new Date().toISOString();
  const methods = [...new Set([...(c.methods_tried || []), ...(Array.isArray(method) ? method : [method]).filter(Boolean)])];
  const unavailable = mergeUnavailable(unavailableOf(c), skipped);
  const remaining = remainingStages({ ...c, methods_tried: methods, resolution: { unavailable } });
  const exhausted = remaining.length === 0;
  if (attempts >= settings.maxAttempts && exhausted) {
    return archiveCase(client, c, { reason: evidence?.ambiguous ? 'ambiguous_location' : ARCHIVE_REASON_BY_ISSUE[c.issue] || 'other', methods, evidence, attempts, unavailable, lastError: error });
  }
  const resolution = { outcome: 'retry', evidence: evidence || null, unavailable, remaining_stages: remaining, next_strategy: remaining[0] || (exhausted ? 'existing (await new canonical evidence)' : null) };
  const { error: e } = await client.from('cleaner_cases').update({ attempts, methods_tried: methods, last_attempt_at: now, next_attempt_at: nextAttemptAt(attempts, settings.backoffHours), last_error: error || null, resolution, updated_at: now, ...RELEASE }).eq('id', c.id);
  if (e) throw e;
  return { outcome: 'retry', attempts, remaining, unavailable };
}
function mergeUnavailable(prev, now) {
  const m = new Map(prev.map((x) => [x.stage, x]));
  for (const x of now || []) m.set(x.stage, x);
  return [...m.values()];
}

// give a claimed case back untouched (controlled runs that only apply one outcome class)
async function releaseCase(client, c) {
  const { error } = await client.from('cleaner_cases').update({ ...RELEASE, updated_at: new Date().toISOString() }).eq('id', c.id);
  if (error) throw error;
  return { outcome: 'released' };
}

async function resolveCase(client, c, resolution) {
  const now = new Date().toISOString();
  const { error } = await client.from('cleaner_cases').update({ status: 'resolved', attempts: c.attempts + 1, last_attempt_at: now, resolution, resolved_at: now, updated_at: now, last_error: null, ...RELEASE }).eq('id', c.id);
  if (error) throw error;
  return { outcome: 'resolved', ...resolution };
}

// The structured "why" every archive must be able to answer (brief §4/§7).
function buildExplanation(c, { reason, methods, unavailable, evidence, note, lastError }) {
  const evidenceFound = evidence ? (evidence.low || evidence.rejected || evidence.remaining || evidence.event_date || evidence) : null;
  const multi = evidence?.low?.evidence?.multi_venue ? evidence.low.evidence.venues : null;
  const why = note
    || (multi ? `the listing names ${multi.length} venues/cities as one address (touring show) - no single place to resolve` : null)
    || (evidence?.ambiguous ? 'several places match the label - no single verified candidate' : null)
    || (evidence?.low ? `only LOW-confidence evidence (${evidence.low.method}): not publishable without city/street agreement` : null)
    || (evidence?.rejected ? 'every candidate image failed validation (' + [...new Set(evidence.rejected.map((r) => r.reason))].join(', ') + ')' : null)
    || (lastError ? lastError.slice(0, 200) : 'no evidence found in any available stage');
  return {
    missing: MISSING_BY_ISSUE[c.issue] || c.issue,
    methods_tried: methods || c.methods_tried || [],
    methods_unavailable: unavailable || [],
    evidence_found: evidenceFound,
    why_insufficient: why,
    external_limit: LOCATION_ISSUES.has(c.issue) ? EXTERNAL_LIMIT : null,
    reopen_when: REOPEN_WHEN_BY_ISSUE[c.issue] || ['new evidence for the subject'],
  };
}

// terminal: case archived with reason; a BLOCKING issue on an incoming row also rejects the row
// (status rejected + archive_reason code + human-readable reject_reason). Live activities keep their
// published state for non-blocking issues (missing image/address-string/venue never unpublish).
async function archiveCase(client, c, { reason, methods, evidence, attempts, note, unavailable, lastError }) {
  const now = new Date().toISOString();
  const explanation = buildExplanation(c, { reason, methods, unavailable: unavailable || unavailableOf(c), evidence, note, lastError });
  const { error } = await client.from('cleaner_cases').update({ status: 'archived', archive_reason: reason, attempts: attempts ?? c.attempts, methods_tried: methods || c.methods_tried, last_attempt_at: now, resolution: { outcome: 'archived', reason, explanation, evidence: evidence || null, note: note || null, unavailable: explanation.methods_unavailable }, updated_at: now, ...RELEASE }).eq('id', c.id);
  if (error) throw error;
  if (c.subject_kind === 'incoming' && BLOCKING_FOR_INCOMING.has(c.issue)) {
    await client.from('incoming_activities').update({ status: 'rejected', archive_reason: reason, reject_reason: `הפריט הועבר לארכיון ע"י THE CLEANER (${reason})${note ? ' - ' + note : ''}`, reviewed_at: now }).eq('id', c.subject_id).in('status', ['new', 'needs_review', 'failed']);
  }
  if (c.subject_kind === 'activity' && c.issue === 'missing_coordinates') {
    await client.from('activities').update({ status: 'archived', archive_reason: reason, archived_at: now }).eq('id', c.subject_id).eq('status', 'approved');
  }
  return { outcome: 'archived', reason, explanation };
}

async function archiveExpired(client, c, eventDate) {
  return archiveCase(client, c, { reason: 'activity_expired_before_resolution', note: `תאריך האירוע ${eventDate} עבר`, evidence: { event_date: eventDate } });
}

// Reopen archived cases when new evidence exists: the location label now resolves to a venue
// (new venue/alias), or the subject re-appeared. Never creates a second activity - the reopened case
// goes through the same dedup + publish path again.
async function reopenWhereEvidenceChanged(client, { limit = 200 } = {}) {
  const { data: cases } = await client.from('cleaner_cases').select('id, subject_kind, subject_id, issue, archive_reason, reopened_count').eq('status', 'archived').in('archive_reason', [...REOPENABLE_REASONS]).order('updated_at', { ascending: true }).limit(limit);
  let reopened = 0;
  for (const c of cases || []) {
    let evidence = null;
    if (c.subject_kind === 'incoming') {
      const { data: row } = await client.from('incoming_activities').select('status, location_name:extracted_data->>location_name, city:extracted_data->>city, name:extracted_data->>name, organizer_name:extracted_data->>organizer_name, one_time_date:extracted_data->>one_time_date, schedule_type:extracted_data->>schedule_type').eq('id', c.subject_id).maybeSingle();
      if (!row) continue;
      if (row.schedule_type === 'one_time' && row.one_time_date && row.one_time_date < new Date().toISOString().slice(0, 10)) continue;
      for (const label of [row.location_name, row.organizer_name, row.name]) { if (!label) continue; const v = await venueNaming.resolveVenue(client, { locationName: label, city: row.city }); if (v) { evidence = { venue_now_resolves: v.name_he, label }; break; } }
    } else {
      const { data: a } = await client.from('activities').select('name, venue_id, organizer_name, locations(name, city, address)').eq('id', c.subject_id).maybeSingle();
      if (a && !a.venue_id) { for (const label of [a.locations?.name, a.organizer_name]) { if (!label) continue; const v = await venueNaming.resolveVenue(client, { locationName: label, city: a.locations?.city }); if (v) { evidence = { venue_now_resolves: v.name_he, label }; break; } } }
      else if (a && a.venue_id && c.issue === 'incomplete_address' && !a.locations?.address) { const { data: v } = await client.from('venues').select('address').eq('id', a.venue_id).maybeSingle(); if (v?.address) evidence = { venue_now_has_address: v.address }; }
    }
    if (!evidence) continue;
    const now = new Date().toISOString();
    await client.from('cleaner_cases').update({ status: 'open', attempts: 0, methods_tried: [], next_attempt_at: now, archive_reason: null, reopened_count: (c.reopened_count || 0) + 1, opened_reason: 'reopened: ' + JSON.stringify(evidence), resolution: { outcome: 'reopened', evidence }, updated_at: now, last_error: null, ...RELEASE }).eq('id', c.id);
    if (c.subject_kind === 'incoming') await client.from('incoming_activities').update({ status: 'needs_review', archive_reason: null, reject_reason: null }).eq('id', c.subject_id).eq('status', 'rejected').not('archive_reason', 'is', null);
    reopened++;
  }
  return { reopened, scanned: (cases || []).length };
}

module.exports = { settingsFrom, nextAttemptAt, markAttemptFailed, resolveCase, releaseCase, archiveCase, archiveExpired, reopenWhereEvidenceChanged, stagesForAttempt, remainingStages, buildExplanation, STAGES, EVIDENCE_STAGES, ARCHIVE_REASON_BY_ISSUE, BLOCKING_FOR_INCOMING, REOPENABLE_REASONS, LOCATION_ISSUES, RELEASE };
