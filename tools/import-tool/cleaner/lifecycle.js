// TuRu Cleaner - retry / backoff / archive / reopen rules (THE-CLEANER.md §16-19). Pure helpers +
// the DB writes that move a case (and its subject) to a terminal state. Archive reasons are
// machine-readable codes; an archived subject is never deleted and can be reopened by reopen().
const { resolveVenue } = require('../venueNaming');

const ARCHIVE_REASON_BY_ISSUE = {
  missing_location: 'missing_address_unresolved', rejected_missing_address: 'missing_address_unresolved', unverified_location: 'missing_address_unresolved',
  missing_coordinates: 'missing_address_unresolved', incomplete_address: 'address_unresolved_nonblocking', missing_venue: 'venue_not_found',
  missing_image: 'image_unavailable_only', broken_image: 'image_unavailable_only', missing_schedule: 'insufficient_required_data',
  missing_region: 'other', missing_required_metadata: 'insufficient_required_data', low_quality_description: 'other',
};
// issues whose archive also archives/rejects the SUBJECT (blocking); the rest archive only the case
const BLOCKING_FOR_INCOMING = new Set(['missing_location', 'rejected_missing_address', 'unverified_location', 'missing_required_metadata', 'missing_coordinates']);
const REOPENABLE_REASONS = new Set(['missing_address_unresolved', 'ambiguous_location', 'venue_not_found', 'source_unreachable', 'insufficient_required_data', 'ambiguous_audience']);

// which resolution stages each attempt runs (never the same failed method endlessly)
const STAGES_BY_ATTEMPT = [
  ['existing_venue', 'existing_source_venue', 'prior_activity', 'existing_location', 'source_page'],
  ['existing_venue', 'existing_source_venue', 'prior_activity', 'existing_location', 'venue_site', 'source_page'],
  ['existing_venue', 'existing_source_venue', 'prior_activity', 'existing_location', 'place_lookup', 'venue_site'],
];

function settingsFrom(rows) {
  const s = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
  return {
    enabled: s.cleaner_enabled !== false,
    maxAttempts: Number(s.cleaner_max_attempts ?? 3),
    backoffHours: Array.isArray(s.cleaner_backoff_hours) ? s.cleaner_backoff_hours.map(Number) : [6, 24, 72],
    batchSize: Number(s.cleaner_batch_size ?? 40),
    minTrust: Number(s.auto_approve_min_trust_score ?? 80),
    maxDaysAhead: Number(s.event_max_days_ahead ?? 180),
    thresholds: { duplicate: Number(s.duplicate_confidence_threshold ?? 0.9), needsReview: Number(s.needs_review_confidence_threshold ?? 0.6), proximityKm: Number(s.proximity_km ?? 0.15) },
  };
}

function nextAttemptAt(attemptsDone, backoffHours, now = new Date()) {
  const h = backoffHours[Math.min(attemptsDone - 1, backoffHours.length - 1)] ?? 72;
  return new Date(now.getTime() + h * 3600 * 1000).toISOString();
}

async function markAttemptFailed(client, c, { method, error, settings, evidence }) {
  const attempts = c.attempts + 1;
  const now = new Date().toISOString();
  const methods = [...new Set([...(c.methods_tried || []), ...(Array.isArray(method) ? method : [method]).filter(Boolean)])];
  if (attempts >= settings.maxAttempts) return archiveCase(client, c, { reason: evidence?.ambiguous ? 'ambiguous_location' : ARCHIVE_REASON_BY_ISSUE[c.issue] || 'other', methods, evidence, attempts });
  const { error: e } = await client.from('cleaner_cases').update({ attempts, methods_tried: methods, last_attempt_at: now, next_attempt_at: nextAttemptAt(attempts, settings.backoffHours), last_error: error || null, resolution: evidence ? { outcome: 'retry', evidence } : c.resolution, updated_at: now }).eq('id', c.id);
  if (e) throw e;
  return { outcome: 'retry', attempts };
}

async function resolveCase(client, c, resolution) {
  const now = new Date().toISOString();
  const { error } = await client.from('cleaner_cases').update({ status: 'resolved', attempts: c.attempts + 1, last_attempt_at: now, resolution, resolved_at: now, updated_at: now, last_error: null }).eq('id', c.id);
  if (error) throw error;
  return { outcome: 'resolved', ...resolution };
}

// terminal: case archived with reason; a BLOCKING issue on an incoming row also rejects the row
// (status rejected + archive_reason code + human-readable reject_reason). Live activities keep their
// published state for non-blocking issues (missing image/address-string/venue never unpublish).
async function archiveCase(client, c, { reason, methods, evidence, attempts, note }) {
  const now = new Date().toISOString();
  const { error } = await client.from('cleaner_cases').update({ status: 'archived', archive_reason: reason, attempts: attempts ?? c.attempts, methods_tried: methods || c.methods_tried, last_attempt_at: now, resolution: { outcome: 'archived', reason, evidence: evidence || null, note: note || null }, updated_at: now }).eq('id', c.id);
  if (error) throw error;
  if (c.subject_kind === 'incoming' && BLOCKING_FOR_INCOMING.has(c.issue)) {
    await client.from('incoming_activities').update({ status: 'rejected', archive_reason: reason, reject_reason: `הפריט הועבר לארכיון ע"י THE CLEANER (${reason})${note ? ' - ' + note : ''}`, reviewed_at: now }).eq('id', c.subject_id).in('status', ['new', 'needs_review', 'failed']);
  }
  if (c.subject_kind === 'activity' && c.issue === 'missing_coordinates') {
    await client.from('activities').update({ status: 'archived', archive_reason: reason, archived_at: now }).eq('id', c.subject_id).eq('status', 'approved');
  }
  return { outcome: 'archived', reason };
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
      const { data: row } = await client.from('incoming_activities').select('status, location_name:extracted_data->>location_name, city:extracted_data->>city, name:extracted_data->>name, one_time_date:extracted_data->>one_time_date, schedule_type:extracted_data->>schedule_type').eq('id', c.subject_id).maybeSingle();
      if (!row) continue;
      if (row.schedule_type === 'one_time' && row.one_time_date && row.one_time_date < new Date().toISOString().slice(0, 10)) continue;
      for (const label of [row.location_name, row.name]) { if (!label) continue; const v = await resolveVenue(client, { locationName: label, city: row.city }); if (v) { evidence = { venue_now_resolves: v.name_he, label }; break; } }
    } else {
      const { data: a } = await client.from('activities').select('name, venue_id, locations(name, city)').eq('id', c.subject_id).maybeSingle();
      if (a && !a.venue_id && a.locations?.name) { const v = await resolveVenue(client, { locationName: a.locations.name, city: a.locations.city }); if (v) evidence = { venue_now_resolves: v.name_he }; }
    }
    if (!evidence) continue;
    const now = new Date().toISOString();
    await client.from('cleaner_cases').update({ status: 'open', attempts: 0, methods_tried: [], next_attempt_at: now, archive_reason: null, reopened_count: (c.reopened_count || 0) + 1, opened_reason: 'reopened: ' + JSON.stringify(evidence), updated_at: now, last_error: null }).eq('id', c.id);
    if (c.subject_kind === 'incoming') await client.from('incoming_activities').update({ status: 'needs_review', archive_reason: null, reject_reason: null }).eq('id', c.subject_id).eq('status', 'rejected').not('archive_reason', 'is', null);
    reopened++;
  }
  return { reopened, scanned: (cases || []).length };
}

module.exports = { settingsFrom, nextAttemptAt, markAttemptFailed, resolveCase, archiveCase, archiveExpired, reopenWhereEvidenceChanged, STAGES_BY_ATTEMPT, ARCHIVE_REASON_BY_ISSUE, BLOCKING_FOR_INCOMING, REOPENABLE_REASONS };
