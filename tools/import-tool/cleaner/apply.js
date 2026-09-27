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
// A repaired incoming row is deduplicated with the ingestion matcher and then published ONLY through the
// single publication implementation publishIncoming (server.js: claim, policy re-evaluation, fingerprint +
// place-id guards, venue resolution, provenance, images) - called in-process since 2026-09-24, never over HTTP.
// Publish POLICY is not decided here: lib/incomingEligibility.js (the canonical evaluator) decides, 2026-09-24.
const { normalizeCityName } = require('../cityNaming');
const { computeEventFingerprint } = require('../eventFingerprint');
const { bestMatch, findStandingProgrammeMatch } = require('./matching');
const { isMissingCity } = require('../lib/canonicalSettlement');
const { assessGranularity } = require('../lib/granularity');
const { upsertProvenanceSafe } = require('../lib/activitySourceMerge');
const { evaluateIncomingRow } = require('../lib/incomingEligibility');
const { verifiedFieldUpdate, OUTCOME: WRITE_OUTCOME } = require('../lib/verifiedWrite');
const { occurrenceKnown } = require('../lib/intakePolicy');
const { placesPersistenceReason } = require('../lib/googlePlacesPolicy');

const SOFT = new Set(['מחיר']);
const OPEN_INCOMING = ['new', 'needs_review', 'failed'];
const hasHouseNumber = (a) => /\d/.test(a || '');


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

// -> { outcome, ... } with explicit outcome codes:
//   published | duplicate_merged | possible_update | archived (terminal: invalid_event / outside_service_area)
//   awaiting_policy (the canonical evaluator HELD it; `reasons` are its codes) | already_resolved (the write it
//   needed was already in place) | resolved_externally (a fresh read shows another process closed the row)
//   error (a write failed or was denied while the row is still open, or publish was unreachable - retry)
// trustedOverride: the Cleaner itself vetted the candidate (settlement_review HIGH decisions) - it satisfies
// the SOURCE-trust gate only; relevance, content safety, access, granularity, dates and dedup all still apply
async function handBackIncoming(client, row, { settings, userId, cache, today, counters, trustedOverride = false }) {
  // Google Places release policy (lib/googlePlacesPolicy.js): a Places-origin row is never matched, merged, enriched
  // from or published - no write at all (not even the duplicate link: that would store its Maps page_url as provenance)
  const googlePolicy = placesPersistenceReason(row.extracted_data, row.page_url);
  if (googlePolicy) return { outcome: 'awaiting_policy', decision: 'INELIGIBLE', why: googlePolicy.code, reasons: [googlePolicy.code], via: 'google_places_policy' };
  const c = row.extracted_data || {};
  const candidate = { name: c.name, city: c.city, location_name: c.location_name || null, entity_type: c.entity_type || null, schedule_type: c.schedule_type || null, category: c.category || null, address: c.address || c.formatted_address || null, pageUrl: row.page_url, venue_id: c.venue_id || null, lat: c.lat ?? null, lng: c.lng ?? null, one_time_date: c.one_time_date || null, recurring_days: c.recurring_days || [], event_fingerprint: c.event_fingerprint || computeEventFingerprint({ name: c.name, venueId: c.venue_id || null, city: c.city, scheduleType: c.schedule_type, oneTimeDate: c.one_time_date, recurringDays: c.recurring_days, startTime: c.start_time }),
    // Repertoire Phase 1 (2026-09-22): read by isStandingProgrammeMatch's field-conflict guard only
    price_type: c.price_type ?? null, price_amount: c.price_amount ?? null, min_age: c.min_age ?? null, max_age: c.max_age ?? null, organizer_name: c.organizer_name ?? null, duration_minutes: c.duration_minutes ?? null };
  const match = await bestMatch(client, candidate, settings.thresholds, cache);
  const now = new Date().toISOString();
  // NEW-OCCURRENCE GUARD (verify_location pilot re-run, 2026-09-24): the same show on a date / hour the activity does
  // not carry yet is a new PERFORMANCE of it. Rejecting the row as a duplicate drops that performance (the enrichment
  // below only fills null columns, never schedules) - it goes to review as an update instead, like every other change.
  const newOccurrence = match ? missingOccurrences(c, match.activity) : [];
  if (match && match.confidence.score >= settings.thresholds.duplicate && !newOccurrence.length) {
    const w = await guardedIncomingWrite(client, row, { status: 'rejected', match_type: 'duplicate', existing_activity_id: match.activity.id, confidence_score: match.confidence.score, confidence_breakdown: match.confidence.breakdown, archive_reason: 'duplicate_of_existing_activity', reject_reason: `כפילות של פעילות קיימת (THE CLEANER, ציון ${match.confidence.score})`, reviewed_at: now },
      (r) => r.status === 'rejected' && r.archive_reason === 'duplicate_of_existing_activity' && r.existing_activity_id === match.activity.id);
    if (!w.done) return w.result;
    if (w.code === 'already_satisfied') return { outcome: 'already_resolved', activity_id: match.activity.id, why: 'already linked as duplicate' };
    // non-destructive: never downgrades an existing row for this exact page_url on the matched
    // activity (2026-09-22, "Harden activity_sources Merge" - see lib/activitySourceMerge.js)
    await upsertProvenanceSafe(client, match.activity.id, { sourceId: row.source_id, pageUrl: row.page_url, incomingActivityId: row.id, relation: 'seen', lastSeenAt: now });
    const gain = await enrichExistingFromCandidate(client, match.activity.id, c);
    if (counters && gain.gained.length) { counters.existingEnriched = (counters.existingEnriched || 0) + 1; for (const g of gain.gained) counters.gain[g] = (counters.gain[g] || 0) + 1; }
    if (counters && gain.denied.length) counters.writeDenied = (counters.writeDenied || 0) + 1;
    return { outcome: 'duplicate_merged', activity_id: match.activity.id, score: match.confidence.score, enriched: gain.gained, denied: gain.denied };
  }
  if (match && match.confidence.score >= settings.thresholds.needsReview) {
    const w = await guardedIncomingWrite(client, row, { match_type: 'update', existing_activity_id: match.activity.id, confidence_score: match.confidence.score, confidence_breakdown: match.confidence.breakdown, status: 'needs_review' },
      (r) => r.match_type === 'update' && r.existing_activity_id === match.activity.id && r.status === 'needs_review');
    if (!w.done) return w.result;
    return { outcome: 'possible_update', activity_id: match.activity.id, score: match.confidence.score, write: w.code, ...(newOccurrence.length ? { new_occurrences: newOccurrence } : {}) };
  }
  // STANDING PROGRAMME MATCH (Repertoire Phase 1, 2026-09-22): a dated candidate whose generic
  // score falls short (the Train Theater fuzzy-subtitle shape scores ~0.50, below needsReview) but
  // whose title+venue identity strongly matches an existing standing programme (entity_type
  // אירוע_קבוע, no cadence of its own, no conflicting price/age/organizer/duration). Independently
  // excludes wrapper/zone-shaped rows via assessGranularity, WITHOUT the parent_sibling_exists DB
  // signal (Section 8: 17/59 legitimate standing rows are only flagged by that one signal - eligibility
  // here must not depend on it). Still only ever reaches needs_review, same as every other 'update'.
  if (!match) {
    const standingCandidates = await findStandingProgrammeMatch(client, candidate, cache);
    const standing = standingCandidates.find((existing) => {
      const shape = assessGranularity({ name: existing.name, description: existing.description, schedule_type: null, price_type: existing.price_type, registration_url: existing.official_url, booking_requirement: existing.booking_requirement });
      if (shape.reason === 'wrapper') return false;
      if (shape.reason === 'sub_entity' && shape.evidence.some((e) => e.code === 'zone_title' || e.code === 'zone_description')) return false;
      return true;
    });
    if (standing) {
      const STANDING_PROGRAMME_SCORE = 0.65; // fixed, documented rule-based score - not a weighted computeConfidence output
      const w = await guardedIncomingWrite(client, row, { match_type: 'update', existing_activity_id: standing.id, confidence_score: STANDING_PROGRAMME_SCORE, confidence_breakdown: { standing_programme_match: 1 }, status: 'needs_review' },
        (r) => r.match_type === 'update' && r.existing_activity_id === standing.id && r.status === 'needs_review');
      if (!w.done) return w.result;
      return { outcome: 'possible_update', activity_id: standing.id, score: STANDING_PROGRAMME_SCORE, via: 'standing_programme_match', write: w.code };
    }
  }
  // DECISION (2026-09-24): the Cleaner resolved evidence; whether the row is publishable NOW is answered by the
  // canonical evaluator (lib/incomingEligibility.js) on the CURRENT row, source and policy - the same one the
  // admin approve route re-runs at its write boundary. No trust / relevance / content / access / granularity /
  // date copy lives here any more. trustedOverride (settlement-review HIGH decisions) satisfies SOURCE trust only.
  let ev;
  try { ev = await evaluateIncomingRow(client, row.id, { trustOverride: trustedOverride ? 'cleaner_settlement_review' : null, today: today || undefined }); }
  catch (e) { return { outcome: 'error', error: 'eligibility evaluation failed: ' + (e.message || e) }; }
  if (!ev.found) return { outcome: 'resolved_externally', why: 'row_not_found' };
  const has = (code) => ev.reasons.find((r) => r.code === code);
  if (has('not_pending')) return { outcome: 'resolved_externally', why: 'status:' + ev.row.status };
  // terminal outcomes the Cleaner records (same writes as before, now verified)
  if (has('relevance_reject')) {
    const w = await guardedIncomingWrite(client, ev.row, { status: 'rejected', archive_reason: 'invalid_event', reject_reason: 'קהל יעד למבוגרים (THE CLEANER)', reviewed_at: now }, (r) => r.status === 'rejected' && r.archive_reason === 'invalid_event');
    return w.done ? { outcome: 'archived', reason: 'invalid_event', write: w.code } : w.result;
  }
  const outside = has('outside_service_area');
  if (outside) {
    const { classifyServiceArea } = require('../lib/serviceArea');
    const { loadSettlementIndex } = require('../lib/canonicalSettlement');
    let index = null; try { index = await loadSettlementIndex(client); } catch { index = null; }
    const v = classifyServiceArea({ lat: c.lat, lng: c.lng }, { index, reverse: c.cleaner_location?.evidence?.reverse || null, cityHint: c.city || null });
    const w = await guardedIncomingWrite(client, ev.row, { status: 'rejected', archive_reason: 'outside_service_area', reject_reason: 'מחוץ לאזור השירות של תורו (THE CLEANER: ' + v.reason + ')', extracted_data: { ...(ev.row.extracted_data || c), service_area: v }, reviewed_at: now }, (r) => r.status === 'rejected' && r.archive_reason === 'outside_service_area');
    return w.done ? { outcome: 'archived', reason: 'outside_service_area', verdict: v, write: w.code } : w.result;
  }
  const policyWhy = (reasons) => reasons.map((r) => r.code + (typeof r.detail === 'string' ? ':' + r.detail : r.detail && r.detail.code ? ':' + r.detail.code : '')).join(',');
  if (ev.decision !== 'ELIGIBLE' && !(ev.decision === 'INELIGIBLE' && ev.reasons.every((r) => r.code === 'exact_duplicate'))) {
    return { outcome: 'awaiting_policy', decision: ev.decision, why: policyWhy(ev.reasons), reasons: ev.reasons.map((r) => r.code) };
  }
  // ELIGIBLE (or an exact duplicate, which publication links instead of publishing): the ONE publication
  // implementation, called IN-PROCESS (2026-09-24) - no admin server, no HTTP. It claims the row, re-evaluates the
  // current policy under the claim, mode 'auto' (never 'human'), and answers with an explicit outcome.
  let pub;
  try { pub = await publishIncomingDirect(client, userId, row.id); }
  catch (e) { return { outcome: 'error', publish: 'TEMPORARY_INFRA_FAILURE', retryable: true, error: 'publication failed to run: ' + (e.message || e) }; }
  if (counters) { counters.publishOutcomes = counters.publishOutcomes || {}; counters.publishOutcomes[pub.outcome] = (counters.publishOutcomes[pub.outcome] || 0) + 1; }
  return handBackFromPublish(pub, policyWhy);
}

// publication outcome -> hand-back outcome. POLICY_* are decisions (the case resolves, nothing to retry);
// TEMPORARY_INFRA_FAILURE retries; LOCATION_INVALID / WRITE_DENIED / ERROR are execution failures that also
// retry (markFail, bounded by the case's attempt budget) and carry their code so a run report can tell them apart.
function handBackFromPublish(pub, policyWhy = (rs) => rs.map((r) => r.code).join(',')) {
  const b = pub.body || {};
  switch (pub.outcome) {
    case 'PUBLISHED': return { outcome: 'published', activity_id: b.activityId, publish: pub.outcome };
    case 'ALREADY_PUBLISHED': return { outcome: 'already_resolved', activity_id: b.activityId || null, publish: pub.outcome };
    case 'DUPLICATE_RESOLVED': return { outcome: 'duplicate_merged', activity_id: b.duplicateOf || null, via: 'publish_guard', publish: pub.outcome };
    case 'CONCURRENT_STATE_CHANGE': return { outcome: 'resolved_externally', why: 'status:' + (b.currentStatus || '?'), publish: pub.outcome };
    case 'POLICY_HELD': return { outcome: 'awaiting_policy', decision: b.decision, why: policyWhy(b.reasons || []), reasons: (b.reasons || []).map((r) => r.code), via: 'publish_boundary', publish: pub.outcome };
    case 'POLICY_INELIGIBLE':
      if (b.code === 'OUTSIDE_SERVICE_AREA') return { outcome: 'archived', reason: 'outside_service_area', verdict: b.verdict, via: 'publish_guard', publish: pub.outcome };
      return { outcome: 'awaiting_policy', decision: b.decision, why: policyWhy(b.reasons || []), reasons: (b.reasons || []).map((r) => r.code), via: 'publish_boundary', publish: pub.outcome };
    case 'NEEDS_ACKNOWLEDGEMENT': return { outcome: 'awaiting_policy', why: b.needs_granularity_acknowledgement ? 'granularity:needs_acknowledgement' : 'access:needs_acknowledgement', publish: pub.outcome };
    case 'TEMPORARY_INFRA_FAILURE': return { outcome: 'error', publish: pub.outcome, retryable: true, error: 'TEMPORARY_INFRA_FAILURE: ' + (b.error || '') };
    default: return { outcome: 'error', publish: pub.outcome, retryable: pub.outcome !== 'NOT_FOUND', error: pub.outcome + ': ' + (b.error || '') };
  }
}
// the publication implementation lives with the admin route (server.js); required lazily so loading the Cleaner
// never loads the whole admin module, and require('../server') never opens a port. Tests inject a stub.
let publishImpl = null;
function publishIncomingDirect(client, userId, id) {
  if (!publishImpl) publishImpl = require('../server').publishIncoming;
  return publishImpl(client, userId, id, { mode: 'auto' });
}
function setPublishImplForTests(fn) { publishImpl = fn; }

// A guarded write on an OPEN incoming row, fully classified (lib/verifiedWrite.js) - a 0-row result is never
// guessed at. -> { done: true, code } on SUCCESS / NO_CHANGE_ALREADY_SATISFIED, else { done: false, result }
// where result is the hand-back outcome: 'resolved_externally' (the fresh row is no longer open - another
// process decided it) or 'error' (the write failed or was denied while the row is still open: the case must
// retry, never close). Before 2026-09-24 every 0-row / errored write here read as 'resolved_externally'.
async function guardedIncomingWrite(client, row, patch, alreadySatisfied) {
  const r = await verifiedFieldUpdate(client, {
    table: 'incoming_activities', id: row.id, patch,
    applyGuard: (q) => q.in('status', OPEN_INCOMING),
    guardStillHolds: (fresh) => OPEN_INCOMING.includes(fresh.status),
    alreadySatisfied,
  });
  if (r.outcome === WRITE_OUTCOME.SUCCESS) return { done: true, code: 'written' };
  if (r.outcome === WRITE_OUTCOME.NO_CHANGE_ALREADY_SATISFIED) return { done: true, code: 'already_satisfied' };
  if (r.outcome === WRITE_OUTCOME.PRECONDITION_CHANGED || r.outcome === WRITE_OUTCOME.ROW_NOT_FOUND) return { done: false, result: { outcome: 'resolved_externally', why: r.outcome === WRITE_OUTCOME.ROW_NOT_FOUND ? 'row_not_found' : 'status:' + (r.row && r.row.status) } };
  return { done: false, result: { outcome: 'error', error: `incoming write not applied (${r.outcome})${r.error ? ': ' + r.error : ''}` } };
}

// fill-null enrichment of an existing activity from a candidate (never overwrites)
// -> { gained: [gainKeys], denied: [fields] }   (denied = 0-row writes whose field is still empty)
// the candidate's dated performances (date + hour, lib/intakePolicy occurrenceKnown) that the matched activity lacks
function missingOccurrences(c, activity) {
  const mine = Array.isArray(c.occurrences) && c.occurrences.length ? c.occurrences.filter((o) => o && o.date) : (c.one_time_date ? [{ date: c.one_time_date, start_time: c.start_time || null }] : []);
  if (!mine.length) return [];
  const have = (activity.occurrences && activity.occurrences.length) ? activity.occurrences : (activity.one_time_date ? [{ date: activity.one_time_date, start_time: activity.start_time || null }] : []);
  return mine.filter((o) => !occurrenceKnown(o, have)).map((o) => ({ date: o.date, start_time: o.start_time || null }));
}

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

module.exports = { missingOccurrences, patchIncomingLocation, handBackIncoming, enrichExistingFromCandidate, applyAddressToActivity, applyCityToActivity, applyImageToActivity, applyActivityPatch, verifiedUpdate, classifyZeroRowWrite, deniedError, OPEN_INCOMING, handBackFromPublish, setPublishImplForTests };
