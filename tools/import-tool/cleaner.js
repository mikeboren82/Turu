// TuRu - THE CLEANER job (see THE-CLEANER.md). Repeatable: every cycle
//   DISCOVER incomplete records -> CLASSIFY -> PRIORITIZE -> VENUE CLUSTERS -> ENRICH -> VALIDATE ->
//   MERGE/PUBLISH -> ARCHIVE (with a structured explanation)
// runs on the admin machine (needs local page fetching like relay-scan.js and the admin server on
// :4321 for publishing). Never deletes; every terminal state carries a machine-readable reason.
// Concurrency (0088): cases are CLAIMED atomically through cleaner_claim_cases (lease); every
// terminal/retry write releases the lease; a crashed worker's lease expires and the case is claimable
// again. A second --loop refuses to start while another run has a fresh heartbeat (unless --force).
//   node cleaner.js                    one cycle (discover + clusters + process cleaner_batch_size due cases)
//   node cleaner.js --loop=30          repeat every 30 minutes
//   node cleaner.js --max=200          process up to 200 due cases this cycle
//   node cleaner.js --issue=missing_image   only that issue
//   node cleaner.js --case=<id> --now  one specific case, ignoring its backoff (controlled runs)
//   node cleaner.js --no-fair          strict priority order (default: 60% priority / 40% round-robin
//                                      across issues that would otherwise starve)
//   node cleaner.js --no-clusters      skip the venue-cluster step
//   node cleaner.js --centroid-audit[=apply]   multi-signal city-centroid audit (report / stamp LOW)
//   node cleaner.js --discover-only | --reopen-only | --dry-run | --force
require('dotenv').config();
const os = require('os');
const { getClient } = require('./supabase');
const { discoverCases, upsertCases, all } = require('./cleaner/discover');
const { settingsFrom, markAttemptFailed, resolveCase, releaseCase, archiveCase, archiveExpired, reopenWhereEvidenceChanged, stagesForAttempt, LOCATION_ISSUES } = require('./cleaner/lifecycle');
const { resolveLocation } = require('./cleaner/locationResolver');
const { resolveImage } = require('./cleaner/imageResolver');
const { enrichFields } = require('./cleaner/fieldEnricher');
const { patchIncomingLocation, handBackIncoming, applyAddressToActivity, applyImageToActivity } = require('./cleaner/apply');
const { resolveVenueClusters } = require('./cleaner/venueClusters');
const { auditCityCentroids } = require('./cleaner/centroidAudit');
const { wordOverlapScore } = require('./cleaner/matching');
const { isLearnableLabel } = require('./venueLearning');
const { proposeOutcome, applyOutcome } = require('./cleaner/settlementResolver');
const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const DRY = !!args['dry-run'];
const WORKER = String(args.worker || `${os.hostname()}:${process.pid}`);
const GAIN_KEYS = ['addressesAdded', 'streetAddressesAdded', 'coordsAdded', 'coordsImproved', 'venuesLinked', 'venueRowsEnriched', 'venuesCreated', 'imagesAdded', 'brokenImagesReplaced', 'schedulesAdded', 'regionsAdded', 'metadataFieldsAdded', 'incomingPromoted', 'existingEnriched', 'duplicatesMerged'];

async function loadIncoming(client, id) {
  const { data } = await client.from('incoming_activities').select('id, source_id, page_url, status, match_type, validation_issues, extracted_data, found_at, source:sources(id, name, venue_id, publisher_name, publisher_type, is_trusted, source_trust_score)').eq('id', id).maybeSingle();
  return data;
}
async function loadActivity(client, id) {
  const { data } = await client.from('activities').select('id, name, category, venue_id, source_id, source_url, location_id, placeholder_group, organizer_name, created_at, locations(id, name, address, city, lat, lng, region, venue_id, address_source, address_confidence), activity_images(url), activity_schedules(schedule_type, one_time_date, day_of_week, start_time, end_time), activity_sources(page_url, incoming_activity_id, relation)').eq('id', id).maybeSingle();
  return data;
}

const gain = (counters, keys) => { for (const k of keys || []) { counters.gain[k] = (counters.gain[k] || 0) + 1; } };
const countArchive = (counters, r) => { if (r.outcome === 'archived') { counters.archived++; counters.archiveReasons[r.reason] = (counters.archiveReasons[r.reason] || 0) + 1; } };
const viaCluster = (ctx, c, res) => { const k = ctx.clusterByCase && ctx.clusterByCase.get(c.id); if (k) { res.via_cluster = k; ctx.counters.resolvedViaCluster++; } return res; };
// resolved from canonical venue knowledge; an external lookup was avoided when the venue already
// carried coordinates or derived them from Turu's own linked locations (no geocoder call)
const viaVenue = (ctx, result) => { if (result && /^existing_(venue|source_venue)$/.test(result.method || '')) { ctx.counters.resolvedViaVenue++; const how = result.evidence?.coords || ''; if (how === 'venue' || how.startsWith('linked_locations')) ctx.counters.externalLookupsAvoided++; } };

async function processCase(client, c, ctx) {
  const { settings, counters, today } = ctx;
  counters.inspected++;
  const isNewDebt = (ts) => ts && new Date(ts).getTime() > ctx.newDebtSince;
  try {
    if (c.subject_kind === 'settlement_review') {
      // legacy settlement-review backlog (0089): one identity decision per review case
      const { data: rc } = await client.from('settlement_scan_review_cases').select('*').eq('id', c.subject_id).maybeSingle();
      if (!rc || rc.status !== 'needs_review') { counters.resolvedNoGain++; return resolveCase(client, c, { outcome: 'resolved_externally', status: rc?.status }); }
      const p = await proposeOutcome(client, rc, { ...ctx, dry: DRY, allowNetwork: true });
      counters.settlement = counters.settlement || {}; counters.settlement[p.outcome] = (counters.settlement[p.outcome] || 0) + 1;
      if (DRY) { ctx.proposals.push({ review_case_id: rc.id, case_type: rc.case_type, candidate: rc.candidate_name, address: rc.candidate_address, legacy_distance_m: rc.latest_distance_m, detection_count: rc.detection_count, existing_activity_id: rc.existing_activity_id, ...p }); return { outcome: 'dry:' + p.outcome, confidence: p.confidence, method: p.decisive || p.signals.slice(-1)[0] }; }
      // controlled apply (Phase L): only one outcome class per batch; everything else is given back untouched
      if (args['settlement-only'] && p.outcome !== String(args['settlement-only'])) { counters.inspected--; return { ...(await releaseCase(client, c)), outcome: 'released:' + p.outcome }; }
      if (['DUPLICATE', 'INVALID', 'NEW_VALID'].includes(p.outcome) && p.confidence === 'HIGH') {
        const a = await applyOutcome(client, rc, p, ctx);
        if (a.applied) { counters.resolved++; gain(counters, a.gain || []); if (a.activity_id) counters.published++; return resolveCase(client, c, { outcome: 'settlement_' + (a.converted || p.outcome).toLowerCase(), confidence: p.confidence, method: p.decisive || null, match: p.match || null, activity_id: a.activity_id || null, gain: a.gain || [], signals: p.signals }); }
        const r = await markAttemptFailed(client, c, { method: ['canonical_db', 'osm_reverse'], error: a.why || 'apply failed', settings, evidence: { proposal: p.outcome, why: a.why } });
        countArchive(counters, r); return r;
      }
      // not auto-resolvable: record the analysis on the review case (visible on /settlement-review), keep needs_review
      await client.from('settlement_scan_review_cases').update({ resolution: { outcome: p.outcome, confidence: p.confidence, signals: p.signals, match: p.match || null, missing: p.missing || null, next_action: p.next_action, evidence: p.evidence, cleaner_rule: 'settlementResolver v1 (2026-09-14)', analyzed_at: new Date().toISOString() }, resolution_note: `המנקה: ${p.outcome} (${p.confidence}) - ${p.signals.slice(-1)[0]}`, updated_at: new Date().toISOString() }).eq('id', rc.id).eq('status', 'needs_review');
      const reason = p.outcome === 'GENUINELY_HUMAN' ? 'requires_human_judgment' : 'insufficient_required_data';
      const r = await archiveCase(client, c, { reason, note: `${p.outcome} (${p.confidence}): ${p.signals.slice(-1)[0]}`, methods: ['canonical_db', 'candidate_data', p.evidence?.osm ? 'osm_reverse' : null].filter(Boolean), evidence: { proposal: p.outcome, match: p.match || null, missing: p.missing || null }, unavailable: [{ stage: 'google_place_details', why: 'no Places key on the Cleaner machine' }] });
      countArchive(counters, r); return r;
    }
    if (c.subject_kind === 'incoming') {
      const row = await loadIncoming(client, c.subject_id);
      if (!row || !['new', 'needs_review', 'failed'].includes(row.status)) { counters.resolvedNoGain++; return resolveCase(client, c, { outcome: 'resolved_externally', status: row?.status }); }
      if (isNewDebt(row.found_at)) counters.newDebtProcessed++;
      const ed = row.extracted_data || {};
      if (ed.schedule_type === 'one_time' && ed.one_time_date && ed.one_time_date < today) { const r = await archiveExpired(client, c, ed.one_time_date); countArchive(counters, r); return r; }

      if (LOCATION_ISSUES.has(c.issue)) {
        const subject = { name: ed.name, location_name: ed.location_name || null, city: ed.city || null, organizer_name: ed.organizer_name || null, page_url: row.page_url, source_id: row.source_id, source_venue_id: row.source?.venue_id || null, description: ed.description };
        if (!subject.location_name && !subject.city && !subject.organizer_name && !row.page_url) { const r = await archiveCase(client, c, { reason: 'insufficient_required_data', note: 'אין שם מקום, עיר, מארגן או עמוד מקור' }); countArchive(counters, r); return r; }
        const { result, tried, skipped, errors } = await resolveLocation(client, subject, { stages: stagesForAttempt(c), maxEvidenceStages: args.now ? 6 : 2, cache: ctx.cache, counters: counters.gain });
        if (result && result.lat != null && ['HIGH', 'MEDIUM'].includes(result.confidence)) {
          if (DRY) return { outcome: 'dry', result };
          viaVenue(ctx, result);
          const patched = await patchIncomingLocation(client, row, result);
          if (!patched) { counters.resolvedNoGain++; return resolveCase(client, c, { outcome: 'resolved_externally', note: 'row no longer open when writing' }); }
          gain(counters, [result.address ? (/\d/.test(result.address) ? 'streetAddressesAdded' : 'addressesAdded') : null, 'coordsAdded', result.venue_id ? 'venuesLinked' : null].filter(Boolean));
          const hb = await handBackIncoming(client, patched, ctx);
          if (hb.outcome === 'error') return markAttemptFailed(client, c, { method: tried, skipped, error: hb.error, settings, evidence: { location: result } });
          if (hb.outcome === 'published') { counters.published++; gain(counters, ['incomingPromoted']); } else if (hb.outcome === 'duplicate_merged') { counters.duplicatesMerged++; gain(counters, ['duplicatesMerged']); } else if (hb.outcome === 'awaiting_policy') counters.policyHold++;
          counters.resolved++;
          return resolveCase(client, c, viaCluster(ctx, c, { outcome: hb.outcome, method: result.method, confidence: result.confidence, evidence: result.evidence, handback: hb, tried, skipped }));
        }
        const r = await markAttemptFailed(client, c, { method: tried, skipped, error: errors.join('; ') || (result ? 'only LOW confidence: ' + result.method : 'no evidence'), settings, evidence: result ? { low: result, ambiguous: !!result.ambiguous } : null });
        countArchive(counters, r);
        return r;
      }
      if (c.issue === 'missing_required_metadata') {
        const r = await enrichFields(client, { kind: 'incoming', row }, ctx);
        if (r.filled.length) { counters.fieldsFilled += r.filled.length; gain(counters, r.filled.map(() => 'metadataFieldsAdded')); if (!r.remaining.length) { counters.resolved++; const patched = await loadIncoming(client, row.id); const hb = await handBackIncoming(client, patched, ctx); if (hb.outcome === 'published') { counters.published++; gain(counters, ['incomingPromoted']); } else if (hb.outcome === 'duplicate_merged') { counters.duplicatesMerged++; gain(counters, ['duplicatesMerged']); } else if (hb.outcome === 'awaiting_policy') counters.policyHold++; return resolveCase(client, c, { outcome: hb.outcome, filled: r.filled, handback: hb }); } }
        const rr = await markAttemptFailed(client, c, { method: r.tried, error: 'still missing: ' + r.remaining.join(','), settings, evidence: { remaining: r.remaining } });
        countArchive(counters, rr);
        return rr;
      }
      return resolveCase(client, c, { outcome: 'unsupported_issue' });
    }

    // ---- live activity ----
    const a = await loadActivity(client, c.subject_id);
    if (!a) { counters.resolvedNoGain++; return resolveCase(client, c, { outcome: 'resolved_externally' }); }
    if (isNewDebt(a.created_at)) counters.newDebtProcessed++;
    const pageUrl = (a.activity_sources || []).find((s) => s.relation === 'created')?.page_url || a.source_url || null;
    const incomingId = (a.activity_sources || []).find((s) => s.incoming_activity_id)?.incoming_activity_id || null;
    let incomingRow = null;
    if (incomingId) { const { data } = await client.from('incoming_activities').select('extracted_data').eq('id', incomingId).maybeSingle(); incomingRow = data; }
    const ed = incomingRow?.extracted_data || {};

    if (LOCATION_ISSUES.has(c.issue)) {
      const subject = { name: a.name, location_name: a.locations?.name || null, city: a.locations?.city || null, organizer_name: a.organizer_name || null, page_url: pageUrl, source_id: a.source_id, source_venue_id: null };
      let stages = stagesForAttempt(c);
      if (c.issue === 'incomplete_address' && a.locations?.lat != null && !(c.methods_tried || []).includes('reverse_geocode')) {
        // coordinates exist: a reverse geocode is the cheapest honest street address
        const { reverseAddress } = require('./cleaner/reverse');
        const rev = await reverseAddress(a.locations.lat, a.locations.lng);
        if (rev && rev.street) {
          const loc = { address: `${rev.street}${rev.houseNumber ? ' ' + rev.houseNumber : ''}`, city: rev.city, lat: null, lng: null, venue_id: null, method: 'reverse_geocode', confidence: 'MEDIUM', evidence: rev };
          if (DRY) return { outcome: 'dry', result: loc };
          const w = await applyAddressToActivity(client, a, loc);
          if (w.wrote.length) { gain(counters, w.wrote); counters.addressesFound++; counters.resolved++; return resolveCase(client, c, { outcome: 'address_filled', method: 'reverse_geocode', confidence: 'MEDIUM', evidence: rev, gain: w.wrote }); }
          counters.resolvedNoGain++; return resolveCase(client, c, { outcome: 'already_filled', method: 'reverse_geocode', skipped: w.skipped });
        }
        stages = stages.filter((s) => !s.startsWith('place_lookup'));
        c.methods_tried = [...(c.methods_tried || []), 'reverse_geocode'];
      }
      if (c.issue === 'missing_venue' && !isLearnableLabel(subject.location_name) && !isLearnableLabel(subject.organizer_name)) {
        // "שכונות ברחבי העיר" / "מקוון" / an organizer name is not a place - no venue can ever exist for it
        const r = await archiveCase(client, c, { reason: 'venue_not_found', note: `התווית "${subject.location_name || subject.organizer_name || ''}" אינה מקום (גנרית / מארגן / מספר מוקדים)`, evidence: { label: subject.location_name, organizer: subject.organizer_name } });
        countArchive(counters, r); return r;
      }
      const weakCoords = c.issue === 'unverified_location' && a.locations?.lat != null ? { lat: a.locations.lat, lng: a.locations.lng } : null;
      const { result, tried, skipped, errors } = await resolveLocation(client, subject, { stages, maxEvidenceStages: args.now ? 6 : 2, cache: ctx.cache, counters: counters.gain, needVenue: c.issue === 'missing_venue', avoidCoords: weakCoords });
      const ok = result && ['HIGH', 'MEDIUM'].includes(result.confidence) && (c.issue === 'missing_venue' ? !!result.venue_id : (result.address || result.lat != null));
      if (ok) {
        if (DRY) return { outcome: 'dry', result };
        viaVenue(ctx, result);
        const w = await applyAddressToActivity(client, a, result, { replaceWeak: c.issue === 'unverified_location' });
        const allTried = [...new Set([...(c.methods_tried || []), ...tried])];
        if (!w.wrote.length) { counters.resolvedNoGain++; return resolveCase(client, c, { outcome: 'already_filled', method: result.method, skipped: w.skipped, tried: allTried }); }
        gain(counters, w.wrote);
        if (w.wrote.includes('venuesLinked')) counters.venuesLinked++; if (w.wrote.some((k) => /address/i.test(k))) counters.addressesFound++;
        counters.resolved++;
        return resolveCase(client, c, viaCluster(ctx, c, { outcome: c.issue === 'missing_venue' ? 'venue_linked' : (c.issue === 'unverified_location' ? 'coordinates_verified' : 'address_filled'), method: result.method, confidence: result.confidence, evidence: result.evidence, gain: w.wrote, tried: allTried, skipped }));
      }
      const r = await markAttemptFailed(client, { ...c }, { method: tried, skipped, error: errors.join('; ') || (result ? 'only LOW confidence: ' + result.method : 'no evidence'), settings, evidence: result ? { low: result } : null });
      countArchive(counters, r);
      return r;
    }
    if (c.issue === 'missing_image' || c.issue === 'broken_image') {
      const { data: series } = await client.from('activities').select('id, name, activity_images(url)').eq('status', 'approved').neq('id', a.id).ilike('name', a.name.slice(0, 40) + '%').limit(5);
      const seriesUrls = (series || []).filter((s) => wordOverlapScore(s.name, a.name) >= 0.7).flatMap((s) => (s.activity_images || []).map((i) => i.url));
      const subject = { name: a.name, page_url: pageUrl, venue_id: a.venue_id, existing_urls: (a.activity_images || []).map((i) => i.url), incoming_images: ed.images || ed.image_urls || [], series_urls: seriesUrls };
      const r = await resolveImage(client, subject, { allowGeneric: false, cache: ctx.cache });
      if (r.found) {
        if (DRY) return { outcome: 'dry', result: r.found };
        const w = await applyImageToActivity(client, a, r.found, ctx.userId);
        if (!w.wrote) { counters.resolvedNoGain++; return resolveCase(client, c, { outcome: 'already_filled', why: w.why }); }
        counters.imagesFound++; counters.resolved++; gain(counters, [c.issue === 'broken_image' ? 'brokenImagesReplaced' : 'imagesAdded']);
        return resolveCase(client, c, { outcome: 'image_attached', kind: r.found.kind, why: r.found.why, url: r.found.url, page_url: r.found.page_url, tried: r.tried, downgrades: r.downgrades });
      }
      const rr = await markAttemptFailed(client, c, { method: r.tried, error: `no valid image (${r.candidates} candidates: ${r.rejected.slice(0, 4).map((x) => x.reason).join(',')})`, settings, evidence: { rejected: r.rejected.slice(0, 6), downgrades: r.downgrades } });
      countArchive(counters, rr);
      return rr;
    }
    if (c.issue === 'missing_schedule' || c.issue === 'missing_region') {
      const r = await enrichFields(client, { kind: 'activity', activity: a, extracted: ed }, ctx);
      const want = c.issue === 'missing_schedule' ? 'schedule' : 'region';
      if (r.filled.includes(want)) { counters.fieldsFilled += r.filled.length; counters.resolved++; gain(counters, [want === 'schedule' ? 'schedulesAdded' : 'regionsAdded']); return resolveCase(client, c, { outcome: 'field_filled', filled: r.filled }); }
      const rr = await markAttemptFailed(client, c, { method: r.tried, error: 'not derivable', settings, evidence: { remaining: [want] } });
      countArchive(counters, rr);
      return rr;
    }
    return resolveCase(client, c, { outcome: 'unsupported_issue' });
  } catch (e) {
    counters.errors++;
    return markAttemptFailed(client, c, { method: 'error', error: (e.message || String(e)).slice(0, 300), settings });
  }
}

// weighted fairness: ~60% strictly by priority, ~40% round-robin over issues that have due cases
async function claimBatch(client, settings, max) {
  const lease = settings.leaseSeconds;
  const claim = (limit, issue, ids) => client.rpc('cleaner_claim_cases', { p_worker: WORKER, p_limit: limit, p_issue: issue || null, p_lease_seconds: lease, p_case_ids: ids || null, p_ignore_backoff: !!args.now });
  if (args.case) { const { data, error } = await claim(1, null, [String(args.case)]); if (error) throw error; return data || []; }
  if (args.issue || args['no-fair']) { const { data, error } = await claim(max, args.issue ? String(args.issue) : null); if (error) throw error; return data || []; }
  const first = Math.ceil(max * 0.6);
  const { data: a, error: e1 } = await claim(first); if (e1) throw e1;
  const out = a || [];
  const { data: dueIssues } = await client.from('cleaner_cases').select('issue').eq('status', 'open').lte('next_attempt_at', new Date().toISOString()).is('lease_until', null).limit(2000);
  const issues = [...new Set((dueIssues || []).map((r) => r.issue))];
  const left = max - out.length;
  if (left > 0 && issues.length) {
    const per = Math.max(1, Math.floor(left / issues.length));
    for (const issue of issues) { const { data: b } = await claim(per, issue); for (const c of b || []) if (!out.some((x) => x.id === c.id)) out.push(c); if (out.length >= max) break; }
  }
  return out.slice(0, max);
}

async function cycle(client, userId) {
  const { data: settingsRows } = await client.from('automation_settings').select('key, value');
  const settings = settingsFrom(settingsRows);
  if (!settings.enabled && !args.force) { console.log('cleaner_enabled=false - nothing done (use --force)'); return null; }
  const today = new Date().toISOString().slice(0, 10);
  const counters = { inspected: 0, resolved: 0, resolvedNoGain: 0, published: 0, duplicatesMerged: 0, policyHold: 0, addressesFound: 0, imagesFound: 0, venuesLinked: 0, fieldsFilled: 0, archived: 0, archiveReasons: {}, errors: 0, discovered: 0, reopened: 0, venueClustersResolved: 0, resolvedViaCluster: 0, resolvedViaVenue: 0, externalLookupsAvoided: 0, newDebtProcessed: 0, gain: Object.fromEntries(GAIN_KEYS.map((k) => [k, 0])) };
  // run guard: an overlapping live run (fresh heartbeat) means a second worker - refuse unless --force
  const { data: live } = await client.from('cleaner_runs').select('id, worker, heartbeat_at').is('finished_at', null).gte('heartbeat_at', new Date(Date.now() - 5 * 60000).toISOString()).limit(1);
  // a controlled single-case run (--case) claims one specific id through the lease RPC, and a
  // reopen-only pass touches archived cases only - both are safe to overlap a live worker
  if (live && live.length && !args.force && !DRY && !args.case && !args['reopen-only']) { console.log(`another Cleaner run is live (${live[0].worker}, heartbeat ${live[0].heartbeat_at}) - refusing to overlap (use --force)`); return null; }
  // honest bookkeeping: runs that never finished (killed process) are marked abandoned
  if (!DRY) await client.from('cleaner_runs').update({ notes: 'abandoned (no finish, stale heartbeat)' }).is('finished_at', null).lt('started_at', new Date(Date.now() - 30 * 60000).toISOString()).is('notes', null);
  const { data: run } = DRY ? { data: null } : await client.from('cleaner_runs').insert({ mode: args.loop ? 'loop' : 'batch', worker: WORKER, heartbeat_at: new Date().toISOString() }).select('id').single();
  const t0 = Date.now();
  // "new debt" = subjects that entered the system after the previous finished run started
  const { data: prev } = await client.from('cleaner_runs').select('started_at').not('finished_at', 'is', null).order('started_at', { ascending: false }).limit(1);
  const newDebtSince = prev && prev[0] ? new Date(prev[0].started_at).getTime() : Date.now() - 86400000;
  try { return await cycleBody(client, userId, { settings, today, counters, run, t0, newDebtSince, cache: new Map() }); }
  catch (e) { if (run) await client.from('cleaner_runs').update({ finished_at: new Date().toISOString(), counters, notes: 'failed: ' + (e.message || String(e)).slice(0, 300) }).eq('id', run.id); throw e; }
}

async function cycleBody(client, userId, ctx) {
  const { settings, today, counters, run, t0 } = ctx;
  ctx.userId = userId;
  const heartbeat = async () => { if (run) await client.from('cleaner_runs').update({ heartbeat_at: new Date().toISOString(), counters }).eq('id', run.id); };
  if (args['centroid-audit']) {
    const r = await auditCityCentroids(client, { apply: args['centroid-audit'] === 'apply' && !DRY });
    counters.centroidAudit = { candidates: r.candidates, flagged: r.flagged.length, byProvenance: r.provenanceFlagged };
    r.flagged.slice(0, 30).forEach((f) => console.log(`  centroid? ${f.city} | ${f.name} | ${f.signal}`));
  }
  if (!args['reopen-only'] && !args.case) {
    const { candidates, stats } = await discoverCases(client, { today });
    const up = DRY ? { created: candidates.length, existing: 0, closedExternally: 0 } : await upsertCases(client, candidates);
    counters.discovered = up.created; counters.closedExternally = up.closedExternally;
    console.log(`discover: ${candidates.length} candidate issues ${JSON.stringify(stats)} -> new cases ${up.created}, existing ${up.existing}, closed externally ${up.closedExternally}`);
  }
  if (!args['discover-only'] && !args.case) {
    const ro = DRY ? { reopened: 0, scanned: 0 } : await reopenWhereEvidenceChanged(client);
    counters.reopened = ro.reopened;
    if (ro.scanned) console.log(`reopen: ${ro.reopened}/${ro.scanned} archived cases had new evidence`);
  }
  if (!args['discover-only'] && !args['reopen-only']) {
    if (!args['no-clusters'] && !args.case && !DRY) {
      const { clusters, stats } = await resolveVenueClusters(client, ctx, { minSize: settings.clusterMinSize, dry: DRY });
      counters.clusters = stats;
      for (const cl of clusters) console.log(`  cluster ${cl.label} [${cl.city || '?'}] x${cl.size} -> ${cl.outcome}${cl.venue ? ' ' + JSON.stringify(cl.venue).slice(0, 140) : ''}${cl.why ? ' | ' + cl.why.slice(0, 160) : ''}`);
      await heartbeat();
    }
    const max = Number(args.max || settings.batchSize);
    ctx.proposals = [];
    let due;
    if (DRY) { let q = client.from('cleaner_cases').select('*').eq('status', 'open').order('priority').limit(max); if (args.issue) q = q.eq('issue', String(args.issue)); if (!args.now) q = q.lte('next_attempt_at', new Date().toISOString()); due = (await q).data || []; }
    else if (args['members-first'] && ctx.clusterByCase && ctx.clusterByCase.size) {
      // Phase C (2026-09-14): the members of clusters whose venue was resolved go first - the compounding test
      const ids = [...ctx.clusterByCase.keys()].slice(0, max);
      const { data, error } = await client.rpc('cleaner_claim_cases', { p_worker: WORKER, p_limit: ids.length, p_issue: null, p_lease_seconds: settings.leaseSeconds, p_case_ids: ids, p_ignore_backoff: true });
      if (error) throw error; due = data || [];
      console.log(`members-first: ${ids.length} cluster members, claimed ${due.length}`);
    } else due = await claimBatch(client, settings, max);
    console.log(`processing ${due.length} claimed cases (max ${max}, worker ${WORKER})`);
    let n = 0;
    for (const c of due) {
      const r = await processCase(client, c, ctx);
      const tag = `${c.subject_kind}/${c.issue}`.padEnd(32);
      console.log(`  ${tag} ${c.subject_id.slice(0, 8)} -> ${r.outcome}${r.reason ? ' ' + r.reason : ''}${r.method ? ' via ' + r.method + '/' + (r.confidence || '') : ''}${r.gain ? ' +' + r.gain.join(',') : ''}${r.remaining ? ' next:' + (r.remaining[0] || 'existing') : ''}${r.error ? ' | ' + String(r.error).slice(0, 80) : ''}`);
      if (++n % 10 === 0) { await heartbeat(); if (!DRY) await client.rpc('cleaner_extend_lease', { p_worker: WORKER, p_case_ids: due.slice(n).map((x) => x.id), p_lease_seconds: settings.leaseSeconds }); }
    }
  }
  if (ctx.proposals && ctx.proposals.length) {
    const file = path.join(__dirname, `settlement-dryrun-${new Date().toISOString().slice(0, 10)}.json`);
    const dist = {}; for (const p of ctx.proposals) { const k = `${p.outcome}/${p.confidence}`; dist[k] = (dist[k] || 0) + 1; }
    fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), total: ctx.proposals.length, distribution: dist, proposals: ctx.proposals }, null, 2));
    console.log('dry-run proposals:', JSON.stringify(dist), '->', path.basename(file));
  }
  const { count: backlog } = await client.from('cleaner_cases').select('id', { count: 'exact', head: true }).eq('status', 'open');
  counters.backlog = backlog; counters.durationMs = Date.now() - t0;
  if (run) await client.from('cleaner_runs').update({ finished_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), counters }).eq('id', run.id);
  console.log('cycle done:', JSON.stringify(counters));
  return counters;
}

(async () => {
  const { client, userId } = await getClient();
  if (args.loop) {
    const minutes = Number(args.loop) || 30;
    console.log(`THE CLEANER loop every ${minutes} min (Ctrl+C to stop) - worker ${WORKER}`);
    while (true) { try { await cycle(client, userId); } catch (e) { console.error('cycle failed:', e.message); } await new Promise((r) => setTimeout(r, minutes * 60000)); }
  } else await cycle(client, userId);
})().catch((e) => { console.error(e); process.exit(1); });
