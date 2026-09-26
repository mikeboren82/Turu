// TuRu Cleaner - DISCOVER + CLASSIFY + PRIORITIZE: find records that need attention and upsert one
// cleaner_cases row per (subject, issue). Idempotent; cheap enough to run every cycle (a few
// paginated selects). Playgrounds are exempt from missing_image (placeholder policy is their designed
// resolution) but not from incomplete_address (reverse geocoding is cheap and useful in the app).
const { normalizeCityName } = require('../cityNaming');
const { isMissingCity, loadSettlementIndex, classifyCityValue } = require('../lib/canonicalSettlement');
const { classifyPlayVenue } = require('../lib/playVenueClassifier');
const { sanitizeCategory } = require('../lib/categoryValidation');

const BASE_PRIORITY = { category_noncanonical: 20, missing_location: 10, verify_location: 11, rejected_missing_address: 12, unverified_location: 15, missing_city: 22, city_not_canonical: 23, misclassified: 24, missing_schedule: 25, incomplete_address: 30, missing_required_metadata: 35, missing_venue: 40, missing_region: 45, missing_image: 50, broken_image: 52, low_quality_description: 60 };
// 'ימי פעילות' (2026-09-19): a recurring event the extractor returned without weekdays - temporal evidence the
// approval gate requires; the metadata resolver looks for the weekdays on the event's card / detail page
const META_ISSUES = new Set(['קטגוריה', 'תאריך', 'סוג ישות', 'קהל יעד לא ברור', 'ימי פעילות']);

async function all(client, table, select, fn) {
  let from = 0, rows = [];
  while (true) {
    let data = null, lastErr = null;
    for (let attempt = 0; attempt < 3 && !data; attempt++) {
      // transient network terminations happen on long paged reads (seen 2026-09-14) - retry, never half-read
      let q = client.from(table).select(select).range(from, from + 999); if (fn) q = fn(q);
      try { const r = await q; if (r.error) throw new Error(r.error.message); data = r.data; } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); }
    }
    if (!data) throw new Error(table + ': ' + (lastErr?.message || 'read failed'));
    rows = rows.concat(data); if (data.length < 1000) return rows; from += 1000;
  }
}

// an extracted "2026-09-31" is not a date; it must not reach the date column (and is itself a metadata defect)
function validDate(d) {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = new Date(d + 'T00:00:00Z');
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d ? null : d;
}

function priorityFor(issue, { eventDate, live, recurring, today }) {
  let p = BASE_PRIORITY[issue] ?? 50;
  if (eventDate) { const days = (new Date(eventDate) - new Date(today)) / 86400000; if (days <= 7) p -= 5; else if (days <= 30) p -= 3; }
  if (live) p -= 2;
  if (recurring) p -= 1;
  return p;
}

// -> { candidates: [{subject_kind, subject_id, issue, priority, event_date, source_id, opened_reason}], stats }
async function discoverCases(client, { today, verifyLocation = { enabled: false, limit: null } }) {
  const out = []; const stats = {};
  const add = (c) => { out.push(c); stats[c.issue] = (stats[c.issue] || 0) + 1; };

  // A. open incoming candidates (match_type new): blocking location / metadata issues
  const inc = await all(client, 'incoming_activities', 'id, source_id, validation_issues, found_at, status, city:extracted_data->>city, location_name:extracted_data->>location_name, formatted_address:extracted_data->>formatted_address, schedule_type:extracted_data->>schedule_type, one_time_date:extracted_data->>one_time_date, lat:extracted_data->>lat', (q) => q.in('status', ['new', 'needs_review', 'failed']).eq('match_type', 'new'));
  for (const r of inc) {
    const eventDate = r.schedule_type === 'one_time' ? validDate(r.one_time_date) : null;
    const recurring = r.schedule_type === 'recurring';
    const issues = [...(r.validation_issues || [])];
    if (r.schedule_type === 'one_time' && r.one_time_date && !eventDate && !issues.includes('תאריך')) issues.push('תאריך');
    const hasPlace = !!(normalizeCityName(r.city || null) && (r.location_name || r.formatted_address));
    if (!hasPlace) add({ subject_kind: 'incoming', subject_id: r.id, issue: 'missing_location', priority: priorityFor('missing_location', { eventDate, recurring, today }), event_date: eventDate, source_id: r.source_id, opened_reason: !r.city ? 'no city' : 'no location_name' });
    const meta = issues.filter((i) => META_ISSUES.has(i));
    if (meta.length) add({ subject_kind: 'incoming', subject_id: r.id, issue: 'missing_required_metadata', priority: priorityFor('missing_required_metadata', { eventDate, recurring, today }), event_date: eventDate, source_id: r.source_id, opened_reason: meta.join(',') });
    if (r.status === 'failed') add({ subject_kind: 'incoming', subject_id: r.id, issue: 'missing_required_metadata', priority: 20, event_date: eventDate, source_id: r.source_id, opened_reason: 'status failed' });
  }

  // A2. VERIFY_LOCATION (Phase 2, 2026-09-24): clean candidates whose only blocker is a verified location, and resolved
  // rows that need re-evaluation / hand-back only - see cleaner/verifyLocation.js (canonical policy, shape exclusions)
  // GATED: automation_settings.verify_location_enabled (default false) or an explicit pilot run with a case limit
  let vl = { candidates: [], stats: { disabled: true }, reopenIds: [] };
  if (verifyLocation.enabled) {
    const { discoverVerifyLocation } = require('./verifyLocation');
    vl = await discoverVerifyLocation(client, { today });
    // hand-backs first (already resolved), then the soonest events
    const ordered = [...vl.candidates].sort((a, b) => a.priority - b.priority || String(a.event_date || '9999').localeCompare(String(b.event_date || '9999')));
    for (const cand of verifyLocation.limit ? ordered.slice(0, verifyLocation.limit) : ordered) add(cand);
  }
  stats.verify_location_plan = vl.stats;

  // B. live activities with missing important data
  // canonical settlement knowledge for CITY_NOT_CANONICAL; without it (empty table / stub) no claim is made
  let index = null;
  try { index = await loadSettlementIndex(client); } catch { index = null; }
  const acts = await all(client, 'activities', 'id, name, name_source, category, venue_id, source_id, placeholder_group, photo_skipped, locations(id, address, city, lat, lng, region, address_source, address_confidence), activity_schedules(schedule_type, one_time_date), activity_images(id)', (q) => q.eq('status', 'approved'));
  for (const a of acts) {
    const pg = a.category === 'גן שעשועים';
    const loc = a.locations; const sched = a.activity_schedules || [];
    // occurrence model: several dated rows per event - the event is live until its LAST date passes;
    // the case's event_date is the earliest upcoming performance
    const dates = sched.filter((s) => s.schedule_type === 'one_time').map((s) => validDate(s.one_time_date || null)).filter(Boolean).sort();
    const eventDate = dates.find((d) => d >= today) || dates[dates.length - 1] || null;
    const recurring = sched.some((s) => s.schedule_type === 'recurring');
    const ctx = { eventDate, live: true, recurring, today };
    if (dates.length && dates.every((d) => d < today)) continue; // expired: the cron archives it, nothing to repair
    // weak coordinates = provenance says city-centroid geocode (prospective stamp by the approve path,
    // or the multi-signal historical audit) - not a verified location, repairable with stronger evidence
    const weakCoords = loc && loc.lat != null && (loc.address_source === 'geocode:city_centroid' || loc.address_source === 'geocode:city_centroid_suspected');
    if (!loc || loc.lat == null || loc.lng == null) add({ subject_kind: 'activity', subject_id: a.id, issue: 'missing_coordinates', priority: 12, event_date: eventDate, source_id: a.source_id, opened_reason: 'live without coordinates' });
    else if (weakCoords && !pg) add({ subject_kind: 'activity', subject_id: a.id, issue: 'unverified_location', priority: priorityFor('unverified_location', ctx), event_date: eventDate, source_id: a.source_id, opened_reason: 'coordinates are a city centroid (' + loc.address_source + ')' });
    else if (!loc.address) add({ subject_kind: 'activity', subject_id: a.id, issue: 'incomplete_address', priority: priorityFor('incomplete_address', ctx) + (pg ? 20 : 0), event_date: eventDate, source_id: a.source_id, opened_reason: 'coordinates without street address' });
    // MISSING_CITY: published + coordinates + no canonical city (NULL / blank / placeholder). The card reads
    // locations.city, so the locality vanishes from Results while the detail screen still shows the address.
    // Playgrounds included - they are most of this debt. One case per activity (unique subject+issue).
    if (loc && loc.lat != null && loc.lng != null && isMissingCity(loc.city)) add({ subject_kind: 'activity', subject_id: a.id, issue: 'missing_city', priority: priorityFor('missing_city', ctx), event_date: eventDate, source_id: a.source_id, opened_reason: 'published with coordinates but no canonical city' });
    // CITY_NOT_CANONICAL (0099): a stored city that is a regional council, a non-canonical spelling variant or a
    // locality string the shared resolver does not know. `city` = the canonical user-facing settlement; the
    // repair runs the same evidence pipeline as missing_city with the stored value as the write guard.
    else if (loc && loc.lat != null && loc.lng != null && index && index.size && !isMissingCity(loc.city)) {
      const nc = classifyCityValue(index, loc.city);
      if (nc) add({ subject_kind: 'activity', subject_id: a.id, issue: 'city_not_canonical', priority: priorityFor('city_not_canonical', ctx), event_date: eventDate, source_id: a.source_id, opened_reason: `${nc.kind}${nc.script ? '/' + nc.script : ''}: "${loc.city}"${nc.canonical ? ' -> ' + nc.canonical : ''}` });
    }
    // MISCLASSIFIED (0096): filed as a public playground, but its own name proves another kind of venue
    // (indoor play centre / amusement park) or no venue at all (an equipment company). HIGH and MEDIUM both
    // open a case; only HIGH is ever written.
    if (pg) { const k = classifyPlayVenue(a.name, { nameSource: a.name_source }); if (k) add({ subject_kind: 'activity', subject_id: a.id, issue: 'misclassified', priority: priorityFor('misclassified', ctx), event_date: null, source_id: a.source_id, opened_reason: `playground by category, ${k.kind} by name ("${k.token}")` }); }
    // Phase E: a stored category that is not in constants/categoryValues.json at all. Deterministic
    // and evidence-complete - sanitizeCategory reports whether a canonical destination exists
    // (a declared alias, e.g. 'גן חיות' -> 'חיות וגני חיות') or whether a human must decide.
    const catVerdict = sanitizeCategory(a.category);
    if (a.category && catVerdict.rejected) {
      add({ subject_kind: 'activity', subject_id: a.id, issue: 'category_noncanonical', priority: priorityFor('category_noncanonical', ctx), event_date: null, source_id: a.source_id, opened_reason: `non-canonical category "${a.category}" - no deterministic canonical destination` });
    } else if (catVerdict.normalizedFrom) {
      add({ subject_kind: 'activity', subject_id: a.id, issue: 'category_noncanonical', priority: priorityFor('category_noncanonical', ctx), event_date: null, source_id: a.source_id, opened_reason: `alias "${catVerdict.normalizedFrom}" -> canonical "${catVerdict.category}"` });
    }
    if (!pg && !a.venue_id) add({ subject_kind: 'activity', subject_id: a.id, issue: 'missing_venue', priority: priorityFor('missing_venue', ctx), event_date: eventDate, source_id: a.source_id, opened_reason: 'no canonical venue' });
    if (!pg && !(a.activity_images || []).length && !a.photo_skipped) add({ subject_kind: 'activity', subject_id: a.id, issue: 'missing_image', priority: priorityFor('missing_image', ctx), event_date: eventDate, source_id: a.source_id, opened_reason: a.placeholder_group ? 'placeholder ' + a.placeholder_group : 'no image' });
    if (!pg && !sched.length) add({ subject_kind: 'activity', subject_id: a.id, issue: 'missing_schedule', priority: priorityFor('missing_schedule', ctx), event_date: null, source_id: a.source_id, opened_reason: 'no schedule rows' });
    if (loc && !loc.region) add({ subject_kind: 'activity', subject_id: a.id, issue: 'missing_region', priority: priorityFor('missing_region', ctx), event_date: eventDate, source_id: a.source_id, opened_reason: 'location without region' });
  }
  // C. retired settlement scanner's review backlog (0089): one case per unresolved review case,
  //    referencing the row (no copied queue). Priority after blocking location work.
  const reviews = await all(client, 'settlement_scan_review_cases', 'id, case_type, detection_count, resolution', (q) => q.eq('status', 'needs_review'));
  for (const r of reviews) {
    add({ subject_kind: 'settlement_review', subject_id: r.id, issue: 'settlement_review', priority: 28 - Math.min(3, r.detection_count || 1), event_date: null, source_id: null, opened_reason: 'legacy ' + r.case_type });
  }
  return { candidates: out, stats, verifyLocationReopen: vl.reopenIds };
}

// issues introduced by a migration that widens cleaner_cases_issue_check; until that migration is applied
// the constraint rejects them - they are skipped (reported), never allowed to fail the whole discovery
// Phase E taxonomy/data-integrity issues are gated on 0101, which is PREPARED BUT NOT APPLIED.
// Until it is, cleaner_cases_issue_check rejects them and they are skipped-and-reported rather than
// failing the whole discovery pass - the same treatment city_not_canonical got while 0100 was pending.
const MIGRATION_GATED_ISSUES = {
  city_not_canonical: '0100',
  verify_location: '0112',
  category_noncanonical: '0101',
  category_primary_experience_mismatch: '0101',
  scanner_place_kind_mismatch: '0101',
  possible_coordinate_duplicate: '0101',
};
const isIssueCheckViolation = (error) => error && (error.code === '23514' || /cleaner_cases_issue_check/.test(error.message || ''));

// upsert without touching attempts/status of existing open cases; re-open nothing here (reopen.js does)
async function upsertCases(client, candidates) {
  let created = 0, existing = 0; const skippedByConstraint = {};
  const known = await all(client, 'cleaner_cases', 'subject_kind, subject_id, issue, status');
  const key = (c) => `${c.subject_kind}|${c.subject_id}|${c.issue}`;
  const map = new Map(known.map((k) => [key(k), k]));
  let rows = [];
  for (const c of candidates) { if (map.has(key(c))) { existing++; continue; } rows.push({ ...c, status: 'open', next_attempt_at: new Date().toISOString() }); }
  // gated issues go in their own chunk first: a constraint violation there drops only them
  const gated = rows.filter((r) => MIGRATION_GATED_ISSUES[r.issue]); rows = rows.filter((r) => !MIGRATION_GATED_ISSUES[r.issue]);
  for (let i = 0; i < gated.length; i += 200) {
    const chunk = gated.slice(i, i + 200);
    const { data, error } = await client.from('cleaner_cases').upsert(chunk, { onConflict: 'subject_kind,subject_id,issue', ignoreDuplicates: true }).select('id');
    if (error && isIssueCheckViolation(error)) { for (const r of chunk) skippedByConstraint[r.issue] = (skippedByConstraint[r.issue] || 0) + 1; continue; }
    if (error) throw new Error('cleaner_cases upsert: ' + error.message);
    created += (data || []).length;
  }
  for (const [issue, n] of Object.entries(skippedByConstraint)) console.log(`discover: ${n} ${issue} candidates NOT recorded - cleaner_cases_issue_check does not allow the issue yet (migration ${MIGRATION_GATED_ISSUES[issue]} not applied)`);
  for (let i = 0; i < rows.length; i += 200) {
    // idempotent: two workers discovering at the same moment both see the same new subjects (found
    // by the 2026-09-14 two-worker test) - the unique key decides, duplicates are ignored, not errors
    const { data, error } = await client.from('cleaner_cases').upsert(rows.slice(i, i + 200), { onConflict: 'subject_kind,subject_id,issue', ignoreDuplicates: true }).select('id');
    if (error) throw new Error('cleaner_cases upsert: ' + error.message);
    created += (data || []).length;
  }
  // cases whose subject no longer has the issue => resolved, with the REAL reason (2026-09-24). This used to write
  // 'resolved_externally' for every one - including incoming rows whose issue vanished because THE CLEANER itself
  // patched the location and whose hand-back then never completed (3 open, eligible rows closed that way).
  const wanted = new Set(candidates.map(key));
  // verify_location is never stale-swept: its handler re-validates the row (policy, shape, coordinates) on every attempt,
  // and discovery may be disabled or limited (pilot) - absence from this pass is not evidence
  const stale = known.filter((k) => k.status === 'open' && !wanted.has(key(k)) && k.issue !== 'verify_location');
  const incIds = [...new Set(stale.filter((k) => k.subject_kind === 'incoming').map((k) => k.subject_id))];
  const incRows = new Map();
  for (let i = 0; i < incIds.length; i += 150) {
    const { data, error } = await client.from('incoming_activities').select('id, status, cleaner_location:extracted_data->cleaner_location').in('id', incIds.slice(i, i + 150));
    if (error) throw new Error('stale-case subject read: ' + error.message);
    for (const r of data || []) incRows.set(r.id, r);
  }
  const outcomes = {};
  for (const k of stale) {
    const resolution = staleCaseResolution(k.subject_kind, k.subject_kind === 'incoming' ? (incRows.get(k.subject_id) || null) : undefined);
    outcomes[resolution.outcome] = (outcomes[resolution.outcome] || 0) + 1;
    await client.from('cleaner_cases').update({ status: 'resolved', resolution, resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() }).match({ subject_kind: k.subject_kind, subject_id: k.subject_id, issue: k.issue });
  }
  return { created, existing, closedExternally: stale.length, staleOutcomes: outcomes, skippedByConstraint };
}

// why an open case's issue disappeared -> its resolution (explicit codes, pure):
//   resolved_externally  the incoming row was decided / removed by another process (or a non-incoming subject)
//   handback_pending     the row is still OPEN and carries the Cleaner's own location patch: resolved evidence
//                        whose publication decision is still owed (the canonical evaluator decides it later -
//                        never assumed done)
//   issue_cleared        the row is still open and something other than the Cleaner fixed the data (a rescan)
const OPEN_INCOMING_STATUSES = ['new', 'needs_review', 'failed'];
function staleCaseResolution(subjectKind, row) {
  if (subjectKind !== 'incoming') return { outcome: 'resolved_externally' };
  if (!row) return { outcome: 'resolved_externally', why: 'row_not_found' };
  if (!OPEN_INCOMING_STATUSES.includes(row.status)) return { outcome: 'resolved_externally', why: 'status:' + row.status };
  if (row.cleaner_location) return { outcome: 'handback_pending', why: 'open row carries the Cleaner location patch; publication not decided' };
  return { outcome: 'issue_cleared', why: 'open row no longer shows the issue' };
}

module.exports = { discoverCases, upsertCases, all, BASE_PRIORITY, MIGRATION_GATED_ISSUES, staleCaseResolution };
