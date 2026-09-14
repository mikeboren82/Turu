// TuRu Cleaner - APPLY a resolution to its subject and hand it back to the normal pipeline
// (THE-CLEANER.md §7-9, 15). Merge rule: NEWER / STRONGER VERIFIED DATA WINS - the Cleaner fills
// nulls and may replace explicitly weak data (address_confidence='LOW', e.g. a city-centroid geocode)
// with HIGH/MEDIUM evidence; it never overwrites a verified address/venue/coordinates.
// Stale-write protection: every write re-reads nothing but is CONDITIONAL in SQL (`.is(col, null)` /
// `.eq(address_confidence,'LOW')`), so an admin or the Monster filling the same field between the
// case's claim and this write wins, and the Cleaner reports `already_filled` instead of clobbering.
// A repaired incoming row is deduplicated with the ingestion matcher and then published ONLY through
// POST /api/incoming/:id/approve (fingerprint + place-id guards, venue resolution, provenance, image
// handling live there).
const { normalizeCityName } = require('../cityNaming');
const { assessChildRelevance } = require('../childRelevance');
const { computeEventFingerprint } = require('../eventFingerprint');
const { bestMatch } = require('./matching');

const SOFT = new Set(['מחיר']);
const ADMIN_BASE = process.env.ADMIN_BASE || 'http://localhost:4321';
const OPEN_INCOMING = ['new', 'needs_review', 'failed'];
const hasHouseNumber = (a) => /\d/.test(a || '');

async function adminUp() { try { const r = await fetch(`${ADMIN_BASE}/api/automation-settings`, { signal: AbortSignal.timeout(4000) }); return r.ok; } catch { return false; } }

// ---- incoming rows ----
// -> patched row, or null when the row is no longer open (admin decided meanwhile => resolved_externally)
async function patchIncomingLocation(client, row, loc) {
  const ed = { ...(row.extracted_data || {}) };
  if (loc.location_name && !ed.location_name) ed.location_name = loc.location_name;
  if (loc.city) ed.city = normalizeCityName(loc.city);
  if (loc.lat != null) { ed.lat = loc.lat; ed.lng = loc.lng; }
  if (loc.address && !ed.formatted_address && !ed.address) ed.address = loc.address;
  if (loc.venue_id && !ed.venue_id) ed.venue_id = loc.venue_id;
  ed.cleaner_location = { method: loc.method, confidence: loc.confidence, evidence: loc.evidence, resolved_at: new Date().toISOString() };
  const issues = (row.validation_issues || []).filter((i) => i !== 'עיר');
  const gating = issues.filter((i) => !SOFT.has(i));
  const status = row.status === 'failed' ? 'needs_review' : (gating.length ? 'needs_review' : 'new');
  const { data, error } = await client.from('incoming_activities').update({ extracted_data: ed, validation_issues: issues, status }).eq('id', row.id).in('status', OPEN_INCOMING).select('id');
  if (error) throw error;
  if (!data || !data.length) return null;
  return { ...row, extracted_data: ed, validation_issues: issues, status };
}

// -> { outcome: 'published'|'duplicate_merged'|'possible_update'|'awaiting_policy'|'error', ... }
async function handBackIncoming(client, row, { settings, userId, cache, today, counters }) {
  const c = row.extracted_data || {};
  const candidate = { name: c.name, city: c.city, pageUrl: row.page_url, venue_id: c.venue_id || null, lat: c.lat ?? null, lng: c.lng ?? null, one_time_date: c.one_time_date || null, recurring_days: c.recurring_days || [], event_fingerprint: c.event_fingerprint || computeEventFingerprint({ name: c.name, venueId: c.venue_id || null, city: c.city, scheduleType: c.schedule_type, oneTimeDate: c.one_time_date, recurringDays: c.recurring_days, startTime: c.start_time }) };
  const match = await bestMatch(client, candidate, settings.thresholds, cache);
  const now = new Date().toISOString();
  if (match && match.confidence.score >= settings.thresholds.duplicate) {
    const { data } = await client.from('incoming_activities').update({ status: 'rejected', match_type: 'duplicate', existing_activity_id: match.activity.id, confidence_score: match.confidence.score, confidence_breakdown: match.confidence.breakdown, archive_reason: 'duplicate_of_existing_activity', reject_reason: `כפילות של פעילות קיימת (THE CLEANER, ציון ${match.confidence.score})`, reviewed_at: now }).eq('id', row.id).in('status', OPEN_INCOMING).select('id');
    if (!data || !data.length) return { outcome: 'resolved_externally' };
    await client.from('activity_sources').upsert({ activity_id: match.activity.id, source_id: row.source_id, page_url: row.page_url, incoming_activity_id: row.id, relation: 'seen', last_seen_at: now }, { onConflict: 'activity_id,page_url' });
    const gain = await enrichExistingFromCandidate(client, match.activity.id, c);
    if (counters && gain.length) { counters.existingEnriched = (counters.existingEnriched || 0) + 1; for (const g of gain) counters.gain[g] = (counters.gain[g] || 0) + 1; }
    return { outcome: 'duplicate_merged', activity_id: match.activity.id, score: match.confidence.score, enriched: gain };
  }
  if (match && match.confidence.score >= settings.thresholds.needsReview) {
    await client.from('incoming_activities').update({ match_type: 'update', existing_activity_id: match.activity.id, confidence_score: match.confidence.score, confidence_breakdown: match.confidence.breakdown, status: 'needs_review' }).eq('id', row.id).in('status', OPEN_INCOMING);
    return { outcome: 'possible_update', activity_id: match.activity.id, score: match.confidence.score };
  }
  // policy = the same gate reprocess-review-queue.js / the scanner use
  const { data: src } = await client.from('sources').select('is_trusted, source_trust_score').eq('id', row.source_id).maybeSingle();
  const trusted = !!src?.is_trusted || (src?.source_trust_score != null && Number(src.source_trust_score) >= settings.minTrust);
  const gating = (row.validation_issues || []).filter((i) => !SOFT.has(i));
  const maxDate = new Date(Date.now() + settings.maxDaysAhead * 86400000).toISOString().slice(0, 10);
  const dateOk = c.schedule_type !== 'one_time' || (c.one_time_date && c.one_time_date >= today && c.one_time_date <= maxDate);
  const rel = assessChildRelevance(c);
  if (rel === 'reject') { await client.from('incoming_activities').update({ status: 'rejected', archive_reason: 'invalid_event', reject_reason: 'קהל יעד למבוגרים (THE CLEANER)', reviewed_at: now }).eq('id', row.id).in('status', OPEN_INCOMING); return { outcome: 'archived', reason: 'invalid_event' }; }
  if (!(trusted && gating.length === 0 && dateOk && rel === 'ok')) return { outcome: 'awaiting_policy', why: !trusted ? 'untrusted_source' : gating.length ? 'issues:' + gating.join(',') : !dateOk ? 'date' : 'relevance_' + rel };
  if (!(await adminUp())) return { outcome: 'error', error: 'admin server not reachable at ' + ADMIN_BASE + ' - publish deferred' };
  let res;
  try { res = await fetch(`${ADMIN_BASE}/api/incoming/${row.id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000) }); }
  catch (e) { return { outcome: 'error', error: 'approve call failed (' + (e.message || e) + ') - publish deferred' }; } // transient network error: defer, the location is already patched
  const body = await res.json().catch(() => ({}));
  if (res.status === 409) return { outcome: 'duplicate_merged', activity_id: body.duplicateOf || null, via: 'approve_guard' };
  if (!res.ok) return { outcome: 'error', error: body.error || ('approve HTTP ' + res.status) };
  return { outcome: 'published', activity_id: body.activityId };
}

// fill-null enrichment of an existing activity from a candidate (never overwrites) -> list of gained fields
async function enrichExistingFromCandidate(client, activityId, c) {
  const { data: a } = await client.from('activities').select('id, venue_id, description, min_age, max_age, price_type, price_amount, location_id, locations(address, address_confidence)').eq('id', activityId).maybeSingle();
  if (!a) return [];
  const gained = [];
  const fill = async (col, value, gainKey) => {
    if (value == null || value === '') return;
    const { data } = await client.from('activities').update({ [col]: value }).eq('id', a.id).is(col, null).select('id');
    if (data && data.length) gained.push(gainKey);
  };
  await fill('venue_id', c.venue_id, 'venuesLinked');
  await fill('description', c.description, 'metadataFieldsAdded');
  await fill('min_age', c.min_age, 'metadataFieldsAdded');
  await fill('max_age', c.max_age, 'metadataFieldsAdded');
  if (!a.price_type && c.price_type) { const { data } = await client.from('activities').update({ price_type: c.price_type, price_amount: c.price_amount ?? null }).eq('id', a.id).is('price_type', null).select('id'); if (data && data.length) gained.push('metadataFieldsAdded'); }
  if (a.location_id && c.address) {
    const { data } = await client.from('locations').update({ address: c.address, address_source: 'cleaner:candidate', address_confidence: 'MEDIUM', address_resolved_at: new Date().toISOString() }).eq('id', a.location_id).is('address', null).select('id');
    if (data && data.length) gained.push(hasHouseNumber(c.address) ? 'streetAddressesAdded' : 'addressesAdded');
  }
  return gained;
}

// ---- live activities ----
// Conditional fill-null writes (+ replace explicitly LOW data with HIGH/MEDIUM). -> { wrote: [gainKeys], skipped: [fields] }
async function applyAddressToActivity(client, activity, loc) {
  const wrote = [], skipped = [];
  const locId = activity.location_id;
  const now = new Date().toISOString();
  const strong = ['HIGH', 'MEDIUM'].includes(loc.confidence);
  if (loc.address) {
    const { data } = await client.from('locations').update({ address: loc.address, address_source: 'cleaner:' + loc.method, address_confidence: loc.confidence, address_resolved_at: now }).eq('id', locId).is('address', null).select('id');
    if (data && data.length) wrote.push(hasHouseNumber(loc.address) ? 'streetAddressesAdded' : 'addressesAdded'); else skipped.push('address');
  }
  if (loc.lat != null && strong) {
    // fill missing coordinates, or replace a LOW (city-centroid) position with a verified one
    const { data } = await client.from('locations').update({ lat: loc.lat, lng: loc.lng, address_source: 'cleaner:' + loc.method, address_confidence: loc.confidence, address_resolved_at: now }).eq('id', locId).or('lat.is.null,address_confidence.eq.LOW').select('id, address');
    if (data && data.length) wrote.push(activity.locations?.lat == null ? 'coordsAdded' : 'coordsImproved'); else if (activity.locations?.lat == null) skipped.push('coords');
  }
  if (loc.city && !activity.locations?.city) {
    const { data } = await client.from('locations').update({ city: loc.city }).eq('id', locId).is('city', null).select('id');
    if (data && data.length) wrote.push('metadataFieldsAdded');
  }
  if (loc.venue_id) {
    const { data: l } = await client.from('locations').update({ venue_id: loc.venue_id }).eq('id', locId).is('venue_id', null).select('id');
    const { data: a } = await client.from('activities').update({ venue_id: loc.venue_id }).eq('id', activity.id).is('venue_id', null).select('id');
    if ((a && a.length) || (l && l.length)) wrote.push('venuesLinked'); else skipped.push('venue');
  }
  return { wrote, skipped };
}

// insert only when the activity still has no image (a second worker / the scanner may have added one)
async function applyImageToActivity(client, activity, img, userId) {
  const { count } = await client.from('activity_images').select('id', { count: 'exact', head: true }).eq('activity_id', activity.id);
  if (count && count > 0) return { wrote: false, why: 'already_has_image' };
  const { error } = await client.from('activity_images').insert({ activity_id: activity.id, url: img.url, uploaded_by: userId || null, status: 'approved', image_source_url: img.url, image_source_type: img.image_source_type, needs_rights_review: img.needs_rights_review, image_kind: img.kind, image_page_url: img.page_url || null, retrieved_at: new Date().toISOString() });
  if (error) throw error;
  if (activity.placeholder_group) await client.from('activities').update({ placeholder_group: null }).eq('id', activity.id);
  return { wrote: true };
}

module.exports = { patchIncomingLocation, handBackIncoming, enrichExistingFromCandidate, applyAddressToActivity, applyImageToActivity, adminUp, OPEN_INCOMING };
