// TuRu Cleaner - APPLY a resolution to its subject and hand it back to the normal pipeline
// (THE-CLEANER.md §7-9, 15). Merge rule: NEWER / STRONGER VERIFIED DATA WINS - the Cleaner fills
// nulls and may replace explicitly weak data (address_confidence='LOW', e.g. a city-centroid geocode)
// with HIGH/MEDIUM evidence; it never overwrites a verified address/venue/coordinates.
// Stale-write protection: every write on a live record is CONDITIONAL in SQL (`.is(col, null)` /
// `.eq(address_confidence,'LOW')`), so an admin or the Monster filling the same field between the
// case's claim and this write wins, and the Cleaner reports `already_filled` instead of clobbering.
// ZERO-ROW WRITE PROTECTION (2026-09-19): a conditional UPDATE that touches 0 rows has TWO possible
// causes - the guard no longer holds (someone filled the field: honest `already_filled`) or the row
// was filtered out by RLS (the bot may not update it: a SILENT failure that used to be reported as
// success). Every 0-row write is now followed by a re-read of the target row; when the field still
// needs the write the outcome is `write_denied` and the case must NOT resolve (cleaner.js retries /
// archives it with that error). Repair = actual success or explicit failure, never apparent success.
// A repaired incoming row is deduplicated with the ingestion matcher and then published ONLY through
// POST /api/incoming/:id/approve (fingerprint + place-id guards, venue resolution, provenance, image
// handling live there).
const { normalizeCityName } = require('../cityNaming');
const { assessChildRelevance } = require('../childRelevance');
const { computeEventFingerprint } = require('../eventFingerprint');
const { bestMatch } = require('./matching');
const { isMissingCity } = require('../lib/canonicalSettlement');
const { missingTemporalEvidence } = require('../lib/temporalEvidence');
const { assessAccessType, blocksAutoPublish } = require('../lib/accessType');

const SOFT = new Set(['מחיר']);
const ADMIN_BASE = process.env.ADMIN_BASE || 'http://localhost:4321';
const OPEN_INCOMING = ['new', 'needs_review', 'failed'];
const hasHouseNumber = (a) => /\d/.test(a || '');

async function adminUp() { try { const r = await fetch(`${ADMIN_BASE}/api/automation-settings`, { signal: AbortSignal.timeout(4000) }); return r.ok; } catch { return false; } }

// After a 0-row conditional UPDATE: re-read the row and decide whether the write was genuinely
// unnecessary (guard no longer true -> 'already_filled') or was DENIED (guard still true -> the row
// was invisible to the UPDATE, i.e. an authorization / RLS no-op). 'row_gone' when the row vanished.
async function classifyZeroRowWrite(client, table, id, stillNeeds) {
  const { data: row, error } = await client.from(table).select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!row) return 'row_gone';
  return stillNeeds(row) ? 'write_denied' : 'already_filled';
}
// one guarded UPDATE with verification: -> { wrote: boolean, why?: 'already_filled'|'write_denied'|'row_gone' }
async function verifiedUpdate(client, table, id, patch, applyGuard, stillNeeds) {
  let q = client.from(table).update(patch).eq('id', id);
  q = applyGuard ? applyGuard(q) : q;
  const { data, error } = await q.select('id');
  if (error) throw error;
  if (data && data.length) return { wrote: true };
  return { wrote: false, why: await classifyZeroRowWrite(client, table, id, stillNeeds) };
}
const deniedError = (table, fields) => `write_denied: 0 rows updated on ${table} (${fields.join(',')}) while the guard still holds - the bot is not authorized to update this row (RLS)`;

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
// trustedOverride: the Cleaner itself vetted the candidate (settlement_review HIGH decisions) - the
// source-trust gate does not apply; every other guard (matcher, date, relevance, /approve dedup) does
async function handBackIncoming(client, row, { settings, userId, cache, today, counters, trustedOverride = false }) {
  const c = row.extracted_data || {};
  const candidate = { name: c.name, city: c.city, location_name: c.location_name || null, pageUrl: row.page_url, venue_id: c.venue_id || null, lat: c.lat ?? null, lng: c.lng ?? null, one_time_date: c.one_time_date || null, recurring_days: c.recurring_days || [], event_fingerprint: c.event_fingerprint || computeEventFingerprint({ name: c.name, venueId: c.venue_id || null, city: c.city, scheduleType: c.schedule_type, oneTimeDate: c.one_time_date, recurringDays: c.recurring_days, startTime: c.start_time }) };
  const match = await bestMatch(client, candidate, settings.thresholds, cache);
  const now = new Date().toISOString();
  if (match && match.confidence.score >= settings.thresholds.duplicate) {
    const { data } = await client.from('incoming_activities').update({ status: 'rejected', match_type: 'duplicate', existing_activity_id: match.activity.id, confidence_score: match.confidence.score, confidence_breakdown: match.confidence.breakdown, archive_reason: 'duplicate_of_existing_activity', reject_reason: `כפילות של פעילות קיימת (THE CLEANER, ציון ${match.confidence.score})`, reviewed_at: now }).eq('id', row.id).in('status', OPEN_INCOMING).select('id');
    if (!data || !data.length) return { outcome: 'resolved_externally' };
    await client.from('activity_sources').upsert({ activity_id: match.activity.id, source_id: row.source_id, page_url: row.page_url, incoming_activity_id: row.id, relation: 'seen', last_seen_at: now }, { onConflict: 'activity_id,page_url' });
    const gain = await enrichExistingFromCandidate(client, match.activity.id, c);
    if (counters && gain.gained.length) { counters.existingEnriched = (counters.existingEnriched || 0) + 1; for (const g of gain.gained) counters.gain[g] = (counters.gain[g] || 0) + 1; }
    if (counters && gain.denied.length) counters.writeDenied = (counters.writeDenied || 0) + 1;
    return { outcome: 'duplicate_merged', activity_id: match.activity.id, score: match.confidence.score, enriched: gain.gained, denied: gain.denied };
  }
  if (match && match.confidence.score >= settings.thresholds.needsReview) {
    await client.from('incoming_activities').update({ match_type: 'update', existing_activity_id: match.activity.id, confidence_score: match.confidence.score, confidence_breakdown: match.confidence.breakdown, status: 'needs_review' }).eq('id', row.id).in('status', OPEN_INCOMING);
    return { outcome: 'possible_update', activity_id: match.activity.id, score: match.confidence.score };
  }
  // policy = the same gate reprocess-review-queue.js / the scanner use
  const { data: src } = await client.from('sources').select('is_trusted, source_trust_score').eq('id', row.source_id).maybeSingle();
  const trusted = trustedOverride || !!src?.is_trusted || (src?.source_trust_score != null && Number(src.source_trust_score) >= settings.minTrust);
  const gating = (row.validation_issues || []).filter((i) => !SOFT.has(i));
  const maxDate = new Date(Date.now() + settings.maxDaysAhead * 86400000).toISOString().slice(0, 10);
  const dateOk = c.schedule_type !== 'one_time' || (c.one_time_date && c.one_time_date >= today && c.one_time_date <= maxDate);
  // ENTITY-TYPE-AWARE gate (2026-09-19): a recurring event without weekdays / an "אירוע" without a
  // one-time date never becomes approved through the Cleaner's automated hand-back
  const temporal = missingTemporalEvidence(c);
  const rel = assessChildRelevance(c);
  if (rel === 'reject') { await client.from('incoming_activities').update({ status: 'rejected', archive_reason: 'invalid_event', reject_reason: 'קהל יעד למבוגרים (THE CLEANER)', reviewed_at: now }).eq('id', row.id).in('status', OPEN_INCOMING); return { outcome: 'archived', reason: 'invalid_event' }; }
  if (!(trusted && gating.length === 0 && dateOk && !temporal && rel === 'ok')) return { outcome: 'awaiting_policy', why: !trusted ? 'untrusted_source' : gating.length ? 'issues:' + gating.join(',') : !dateOk ? 'date' : temporal ? 'temporal:' + temporal : 'relevance_' + rel };
  // WHO MAY ATTEND (Phase 1): the automated hand-back never answers the access question. A row the
  // access assessment holds stays in the queue for a human (policy hold, same as temporal evidence).
  const accessA = assessAccessType(c);
  if (blocksAutoPublish(accessA)) return { outcome: 'awaiting_policy', why: 'access:' + accessA.access + (accessA.suspicious ? '_suspicious' : '') };
  if (!(await adminUp())) return { outcome: 'error', error: 'admin server not reachable at ' + ADMIN_BASE + ' - publish deferred' };
  let res;
  try { res = await fetch(`${ADMIN_BASE}/api/incoming/${row.id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000) }); }
  catch (e) { return { outcome: 'error', error: 'approve call failed (' + (e.message || e) + ') - publish deferred' }; } // transient network error: defer, the location is already patched
  const body = await res.json().catch(() => ({}));
  if (res.status === 409) return { outcome: 'duplicate_merged', activity_id: body.duplicateOf || null, via: 'approve_guard' };
  if (res.status === 428) return { outcome: 'awaiting_policy', why: 'access:needs_acknowledgement' };
  if (!res.ok) return { outcome: 'error', error: body.error || ('approve HTTP ' + res.status) };
  return { outcome: 'published', activity_id: body.activityId };
}

// fill-null enrichment of an existing activity from a candidate (never overwrites)
// -> { gained: [gainKeys], denied: [fields] }   (denied = 0-row writes whose field is still empty)
async function enrichExistingFromCandidate(client, activityId, c) {
  const { data: a } = await client.from('activities').select('id, venue_id, description, min_age, max_age, price_type, price_amount, location_id, locations(address, address_confidence)').eq('id', activityId).maybeSingle();
  if (!a) return { gained: [], denied: [] };
  const gained = [], denied = [];
  const fill = async (col, value, gainKey) => {
    if (value == null || value === '') return;
    const r = await verifiedUpdate(client, 'activities', a.id, { [col]: value }, (q) => q.is(col, null), (row) => row[col] == null);
    if (r.wrote) gained.push(gainKey); else if (r.why === 'write_denied') denied.push(col);
  };
  await fill('venue_id', c.venue_id, 'venuesLinked');
  await fill('description', c.description, 'metadataFieldsAdded');
  await fill('min_age', c.min_age, 'metadataFieldsAdded');
  await fill('max_age', c.max_age, 'metadataFieldsAdded');
  if (!a.price_type && c.price_type) {
    const r = await verifiedUpdate(client, 'activities', a.id, { price_type: c.price_type, price_amount: c.price_amount ?? null }, (q) => q.is('price_type', null), (row) => row.price_type == null);
    if (r.wrote) gained.push('metadataFieldsAdded'); else if (r.why === 'write_denied') denied.push('price_type');
  }
  if (a.location_id && c.address) {
    const r = await verifiedUpdate(client, 'locations', a.location_id, { address: c.address, address_source: 'cleaner:candidate', address_confidence: 'MEDIUM', address_resolved_at: new Date().toISOString() }, (q) => q.is('address', null), (row) => row.address == null);
    if (r.wrote) gained.push(hasHouseNumber(c.address) ? 'streetAddressesAdded' : 'addressesAdded'); else if (r.why === 'write_denied') denied.push('address');
  }
  return { gained, denied };
}

// ---- live activities ----
// Conditional fill-null writes (+ replace explicitly LOW data with HIGH/MEDIUM).
// -> { wrote: [gainKeys], skipped: [fields], denied: [fields] }
// opts.replaceWeak: the case itself asserts the current coordinates are weak (unverified_location);
// they are replaced only if they are STILL the exact values seen at claim time (optimistic guard).
async function applyAddressToActivity(client, activity, loc, { replaceWeak = false } = {}) {
  const wrote = [], skipped = [], denied = [];
  const locId = activity.location_id;
  const now = new Date().toISOString();
  const strong = ['HIGH', 'MEDIUM'].includes(loc.confidence);
  const note = (r, field) => { if (r.why === 'write_denied') denied.push(field); else skipped.push(field); };
  // coordinates FIRST: the address write below stamps the new provenance, which would hide the LOW
  // marker the coordinate replacement keys on (Phase B 2026-09-14: 7 cases kept centroid coords)
  if (loc.lat != null && strong) {
    const cur = activity.locations || {};
    const weak = replaceWeak || ['geocode:city_centroid', 'geocode:city_centroid_suspected'].includes(cur.address_source) || cur.address_confidence === 'LOW';
    if (cur.lat == null || weak) {
      const patch = { lat: loc.lat, lng: loc.lng, address_source: 'cleaner:' + loc.method, address_confidence: loc.confidence, address_resolved_at: now };
      const r = cur.lat == null
        ? await verifiedUpdate(client, 'locations', locId, patch, (q) => q.is('lat', null), (row) => row.lat == null)
        : await verifiedUpdate(client, 'locations', locId, patch, (q) => q.eq('lat', cur.lat).eq('lng', cur.lng), (row) => row.lat === cur.lat && row.lng === cur.lng);
      if (r.wrote) wrote.push(cur.lat == null ? 'coordsAdded' : 'coordsImproved'); else note(r, 'coords');
    } else skipped.push('coords_verified'); // verified coordinates: never replaced, no query issued
  }
  if (loc.address) {
    const r = await verifiedUpdate(client, 'locations', locId, { address: loc.address, address_source: 'cleaner:' + loc.method, address_confidence: loc.confidence, address_resolved_at: now }, (q) => q.is('address', null), (row) => row.address == null);
    if (r.wrote) wrote.push(hasHouseNumber(loc.address) ? 'streetAddressesAdded' : 'addressesAdded'); else note(r, 'address');
  }
  if (loc.city && !activity.locations?.city) {
    const r = await verifiedUpdate(client, 'locations', locId, { city: loc.city }, (q) => q.is('city', null), (row) => row.city == null);
    if (r.wrote) wrote.push('metadataFieldsAdded'); else if (r.why === 'write_denied') denied.push('city');
  }
  if (loc.venue_id) {
    const l = await verifiedUpdate(client, 'locations', locId, { venue_id: loc.venue_id }, (q) => q.is('venue_id', null), (row) => row.venue_id == null);
    const a = await verifiedUpdate(client, 'activities', activity.id, { venue_id: loc.venue_id }, (q) => q.is('venue_id', null), (row) => row.venue_id == null);
    if (a.wrote || l.wrote) wrote.push('venuesLinked');
    else if (a.why === 'write_denied' || l.why === 'write_denied') denied.push('venue');
    else skipped.push('venue');
  }
  return { wrote, skipped, denied };
}

// MISSING_CITY / CITY_NOT_CANONICAL write: only the canonical settlement value, only while the city is
// STILL the value the proposal was built on (re-read right before the write + that value as the SQL
// guard). A city changed meanwhile by an admin / the Monster wins -> already_fixed. Region is filled
// null-only from the same settlement. A 0-row write whose guard still holds is write_denied.
async function applyCityToActivity(client, activity, proposal) {
  const locId = activity.location_id || activity.locations?.id;
  const { data: cur } = await client.from('locations').select('id, city, region').eq('id', locId).maybeSingle();
  if (!cur) return { wrote: [], why: 'location_gone' };
  const replacing = proposal.previous_city != null && !isMissingCity(cur.city);
  if (!isMissingCity(cur.city) && !(replacing && cur.city === proposal.previous_city)) return { wrote: [], why: 'already_fixed', city: cur.city };
  const r = await verifiedUpdate(client, 'locations', locId, { city: proposal.city },
    (q) => (cur.city == null ? q.is('city', null) : q.eq('city', cur.city)),
    (row) => (cur.city == null ? row.city == null : row.city === cur.city));
  if (!r.wrote) return { wrote: [], why: r.why === 'write_denied' ? 'write_denied' : 'already_fixed', error: r.why === 'write_denied' ? deniedError('locations', ['city']) : undefined };
  const wrote = [replacing ? 'citiesCorrected' : 'citiesAdded'];
  if (!cur.region && proposal.region) { const { data: rr } = await client.from('locations').update({ region: proposal.region }).eq('id', locId).is('region', null).select('id'); if (rr && rr.length) wrote.push('regionsAdded'); }
  // a row that had NO city got its region from the importer's coordinate bounding-box fallback
  // (import-playgrounds-osm.js classifyRegion - documented there as wrong in several areas); the
  // canonical settlement's region replaces exactly that value, guarded by the value seen. A row whose
  // CITY is being corrected (city_not_canonical) keeps its region: the CBS district-office mapping is
  // coarser than Turu's product regions (the Golan is "הצפון והגליל" in the app, the Tiberias office is not).
  else if (!replacing && cur.region && proposal.region && cur.region !== proposal.region) { const { data: rr } = await client.from('locations').update({ region: proposal.region }).eq('id', locId).eq('region', cur.region).select('id'); if (rr && rr.length) { wrote.push('regionsCorrected'); return { wrote, regionWas: cur.region }; } }
  return { wrote };
}

// insert only when the activity still has no image (a second worker / the scanner may have added one).
// -> { wrote, why?, denied? }  denied: the image row exists but the placeholder flag could not be cleared
async function applyImageToActivity(client, activity, img, userId) {
  const { count } = await client.from('activity_images').select('id', { count: 'exact', head: true }).eq('activity_id', activity.id);
  if (count && count > 0) return { wrote: false, why: 'already_has_image' };
  const { error } = await client.from('activity_images').insert({ activity_id: activity.id, url: img.url, uploaded_by: userId || null, status: 'approved', image_source_url: img.url, image_source_type: img.image_source_type, needs_rights_review: img.needs_rights_review, image_kind: img.kind, image_page_url: img.page_url || null, retrieved_at: new Date().toISOString() });
  if (error) throw error;
  if (activity.placeholder_group) {
    const r = await verifiedUpdate(client, 'activities', activity.id, { placeholder_group: null }, (q) => q.not('placeholder_group', 'is', null), (row) => row.placeholder_group != null);
    if (!r.wrote && r.why === 'write_denied') return { wrote: true, denied: ['placeholder_group'], error: deniedError('activities', ['placeholder_group']) };
  }
  return { wrote: true };
}

// a status / category change on the activity row itself (misclassified, outside service area, archive
// of an unlocatable row) with the same verification -> { wrote, why? }
async function applyActivityPatch(client, activityId, patch, applyGuard, stillNeeds) {
  return verifiedUpdate(client, 'activities', activityId, patch, applyGuard, stillNeeds);
}

module.exports = { patchIncomingLocation, handBackIncoming, enrichExistingFromCandidate, applyAddressToActivity, applyCityToActivity, applyImageToActivity, applyActivityPatch, verifiedUpdate, classifyZeroRowWrite, deniedError, adminUp, OPEN_INCOMING };
