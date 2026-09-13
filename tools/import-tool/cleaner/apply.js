// TuRu Cleaner - APPLY a resolution to its subject and hand it back to the normal pipeline
// (THE-CLEANER.md §7-9, 15). Merge rule: never overwrite a stronger/existing value with a weaker one -
// only nulls are filled on live records; locations get address provenance; a repaired incoming row
// is deduplicated with the ingestion matcher and then published ONLY through POST /api/incoming/:id/
// approve (fingerprint + place-id guards, venue resolution, provenance, image handling live there).
const { normalizeCityName } = require('../cityNaming');
const { assessChildRelevance } = require('../childRelevance');
const { computeEventFingerprint } = require('../eventFingerprint');
const { bestMatch } = require('./matching');

const SOFT = new Set(['מחיר']);
const ADMIN_BASE = process.env.ADMIN_BASE || 'http://localhost:4321';

async function adminUp() { try { const r = await fetch(`${ADMIN_BASE}/api/automation-settings`, { signal: AbortSignal.timeout(4000) }); return r.ok; } catch { return false; } }

// ---- incoming rows ----
async function patchIncomingLocation(client, row, loc) {
  const ed = { ...(row.extracted_data || {}) };
  if (loc.location_name && !ed.location_name) ed.location_name = loc.location_name;
  if (loc.city) ed.city = normalizeCityName(loc.city);
  if (loc.lat != null) { ed.lat = loc.lat; ed.lng = loc.lng; }
  if (loc.address && !ed.formatted_address) ed.address = loc.address;
  if (loc.venue_id && !ed.venue_id) ed.venue_id = loc.venue_id;
  ed.cleaner_location = { method: loc.method, confidence: loc.confidence, evidence: loc.evidence, resolved_at: new Date().toISOString() };
  const issues = (row.validation_issues || []).filter((i) => i !== 'עיר');
  const gating = issues.filter((i) => !SOFT.has(i));
  const status = row.status === 'failed' ? 'needs_review' : (gating.length ? 'needs_review' : 'new');
  const { error } = await client.from('incoming_activities').update({ extracted_data: ed, validation_issues: issues, status }).eq('id', row.id);
  if (error) throw error;
  return { ...row, extracted_data: ed, validation_issues: issues, status };
}

// -> { outcome: 'published'|'duplicate_merged'|'possible_update'|'awaiting_policy'|'error', ... }
async function handBackIncoming(client, row, { settings, userId, cache, today }) {
  const c = row.extracted_data || {};
  const candidate = { name: c.name, city: c.city, pageUrl: row.page_url, venue_id: c.venue_id || null, lat: c.lat ?? null, lng: c.lng ?? null, one_time_date: c.one_time_date || null, recurring_days: c.recurring_days || [], event_fingerprint: c.event_fingerprint || computeEventFingerprint({ name: c.name, venueId: c.venue_id || null, city: c.city, scheduleType: c.schedule_type, oneTimeDate: c.one_time_date, recurringDays: c.recurring_days, startTime: c.start_time }) };
  const match = await bestMatch(client, candidate, settings.thresholds, cache);
  const now = new Date().toISOString();
  if (match && match.confidence.score >= settings.thresholds.duplicate) {
    await client.from('incoming_activities').update({ status: 'rejected', match_type: 'duplicate', existing_activity_id: match.activity.id, confidence_score: match.confidence.score, confidence_breakdown: match.confidence.breakdown, archive_reason: 'duplicate_of_existing_activity', reject_reason: `כפילות של פעילות קיימת (THE CLEANER, ציון ${match.confidence.score})`, reviewed_at: now }).eq('id', row.id);
    await client.from('activity_sources').upsert({ activity_id: match.activity.id, source_id: row.source_id, page_url: row.page_url, incoming_activity_id: row.id, relation: 'seen', last_seen_at: now }, { onConflict: 'activity_id,page_url' });
    await enrichExistingFromCandidate(client, match.activity.id, c);
    return { outcome: 'duplicate_merged', activity_id: match.activity.id, score: match.confidence.score };
  }
  if (match && match.confidence.score >= settings.thresholds.needsReview) {
    await client.from('incoming_activities').update({ match_type: 'update', existing_activity_id: match.activity.id, confidence_score: match.confidence.score, confidence_breakdown: match.confidence.breakdown, status: 'needs_review' }).eq('id', row.id);
    return { outcome: 'possible_update', activity_id: match.activity.id, score: match.confidence.score };
  }
  // policy = the same gate reprocess-review-queue.js / the scanner use
  const { data: src } = await client.from('sources').select('is_trusted, source_trust_score').eq('id', row.source_id).maybeSingle();
  const trusted = !!src?.is_trusted || (src?.source_trust_score != null && Number(src.source_trust_score) >= settings.minTrust);
  const gating = (row.validation_issues || []).filter((i) => !SOFT.has(i));
  const maxDate = new Date(Date.now() + settings.maxDaysAhead * 86400000).toISOString().slice(0, 10);
  const dateOk = c.schedule_type !== 'one_time' || (c.one_time_date && c.one_time_date >= today && c.one_time_date <= maxDate);
  const rel = assessChildRelevance(c);
  if (rel === 'reject') { await client.from('incoming_activities').update({ status: 'rejected', archive_reason: 'invalid_event', reject_reason: 'קהל יעד למבוגרים (THE CLEANER)', reviewed_at: now }).eq('id', row.id); return { outcome: 'archived', reason: 'invalid_event' }; }
  if (!(trusted && gating.length === 0 && dateOk && rel === 'ok')) return { outcome: 'awaiting_policy', why: !trusted ? 'untrusted_source' : gating.length ? 'issues:' + gating.join(',') : !dateOk ? 'date' : 'relevance_' + rel };
  if (!(await adminUp())) return { outcome: 'error', error: 'admin server not reachable at ' + ADMIN_BASE + ' - publish deferred' };
  const res = await fetch(`${ADMIN_BASE}/api/incoming/${row.id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (res.status === 409) return { outcome: 'duplicate_merged', activity_id: body.duplicateOf || null, via: 'approve_guard' };
  if (!res.ok) return { outcome: 'error', error: body.error || ('approve HTTP ' + res.status) };
  return { outcome: 'published', activity_id: body.activityId };
}

// fill-null enrichment of an existing activity from a candidate (never overwrites)
async function enrichExistingFromCandidate(client, activityId, c) {
  const { data: a } = await client.from('activities').select('id, venue_id, description, min_age, max_age, price_type, price_amount, location_id, locations(address)').eq('id', activityId).maybeSingle();
  if (!a) return;
  const patch = {};
  if (!a.venue_id && c.venue_id) patch.venue_id = c.venue_id;
  if (!a.description && c.description) patch.description = c.description;
  if (a.min_age == null && c.min_age != null) patch.min_age = c.min_age;
  if (a.max_age == null && c.max_age != null) patch.max_age = c.max_age;
  if (!a.price_type && c.price_type) { patch.price_type = c.price_type; if (c.price_amount != null) patch.price_amount = c.price_amount; }
  if (Object.keys(patch).length) await client.from('activities').update(patch).eq('id', a.id);
  if (a.location_id && !a.locations?.address && c.address) await client.from('locations').update({ address: c.address, address_source: 'cleaner:candidate', address_confidence: 'MEDIUM', address_resolved_at: new Date().toISOString() }).eq('id', a.location_id);
}

// ---- live activities ----
async function applyAddressToActivity(client, activity, loc) {
  const patch = { address: activity.locations?.address || loc.address || null, address_source: 'cleaner:' + loc.method, address_confidence: loc.confidence, address_resolved_at: new Date().toISOString() };
  if (activity.locations?.lat == null && loc.lat != null) { patch.lat = loc.lat; patch.lng = loc.lng; }
  if (!activity.locations?.city && loc.city) patch.city = loc.city;
  if (loc.venue_id && !activity.locations?.venue_id) patch.venue_id = loc.venue_id;
  const { error } = await client.from('locations').update(patch).eq('id', activity.location_id);
  if (error) throw error;
  if (loc.venue_id && !activity.venue_id) await client.from('activities').update({ venue_id: loc.venue_id }).eq('id', activity.id);
}

async function applyImageToActivity(client, activity, img, userId) {
  const { error } = await client.from('activity_images').insert({ activity_id: activity.id, url: img.url, uploaded_by: userId || null, status: 'approved', image_source_url: img.url, image_source_type: img.image_source_type, needs_rights_review: img.needs_rights_review, image_kind: img.kind, image_page_url: img.page_url || null, retrieved_at: new Date().toISOString() });
  if (error) throw error;
  if (activity.placeholder_group) await client.from('activities').update({ placeholder_group: null }).eq('id', activity.id);
}

module.exports = { patchIncomingLocation, handBackIncoming, enrichExistingFromCandidate, applyAddressToActivity, applyImageToActivity, adminUp };
