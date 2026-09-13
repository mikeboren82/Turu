// TuRu - THE CLEANER job (see THE-CLEANER.md). Repeatable: every cycle
//   DISCOVER incomplete records -> CLASSIFY -> PRIORITIZE -> ENRICH -> VALIDATE -> MERGE/PUBLISH -> ARCHIVE
// runs on the admin machine (needs local page fetching like relay-scan.js and the admin server on
// :4321 for publishing). Never deletes; every terminal state carries a machine-readable reason.
//   node cleaner.js                    one cycle (discover + process due cases up to cleaner_batch_size)
//   node cleaner.js --loop=30          repeat every 30 minutes
//   node cleaner.js --max=200          process up to 200 due cases this cycle
//   node cleaner.js --issue=missing_image   only that issue
//   node cleaner.js --discover-only | --reopen-only | --dry-run
require('dotenv').config();
const { getClient } = require('./supabase');
const { discoverCases, upsertCases, all } = require('./cleaner/discover');
const { settingsFrom, markAttemptFailed, resolveCase, archiveCase, archiveExpired, reopenWhereEvidenceChanged, STAGES_BY_ATTEMPT, ARCHIVE_REASON_BY_ISSUE } = require('./cleaner/lifecycle');
const { resolveLocation } = require('./cleaner/locationResolver');
const { resolveImage } = require('./cleaner/imageResolver');
const { enrichFields } = require('./cleaner/fieldEnricher');
const { patchIncomingLocation, handBackIncoming, applyAddressToActivity, applyImageToActivity } = require('./cleaner/apply');
const { resolveVenue } = require('./venueNaming');
const { wordOverlapScore } = require('./cleaner/matching');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const DRY = !!args['dry-run'];

async function loadIncoming(client, id) {
  const { data } = await client.from('incoming_activities').select('id, source_id, page_url, status, match_type, validation_issues, extracted_data, source:sources(id, name, venue_id, publisher_name, publisher_type, is_trusted, source_trust_score)').eq('id', id).maybeSingle();
  return data;
}
async function loadActivity(client, id) {
  const { data } = await client.from('activities').select('id, name, category, venue_id, source_id, source_url, location_id, placeholder_group, organizer_name, locations(id, name, address, city, lat, lng, region, venue_id), activity_images(url), activity_schedules(schedule_type, one_time_date, day_of_week, start_time, end_time), activity_sources(page_url, incoming_activity_id, relation)').eq('id', id).maybeSingle();
  return data;
}

async function processCase(client, c, ctx) {
  const { settings, counters, today } = ctx;
  counters.inspected++;
  const attemptIdx = Math.min(c.attempts, STAGES_BY_ATTEMPT.length - 1);
  try {
    if (c.subject_kind === 'incoming') {
      const row = await loadIncoming(client, c.subject_id);
      if (!row || !['new', 'needs_review', 'failed'].includes(row.status)) return resolveCase(client, c, { outcome: 'resolved_externally', status: row?.status });
      const ed = row.extracted_data || {};
      if (ed.schedule_type === 'one_time' && ed.one_time_date && ed.one_time_date < today) { counters.archived++; counters.archiveReasons.activity_expired_before_resolution = (counters.archiveReasons.activity_expired_before_resolution || 0) + 1; return archiveExpired(client, c, ed.one_time_date); }

      if (c.issue === 'missing_location' || c.issue === 'rejected_missing_address' || c.issue === 'unverified_location') {
        const subject = { name: ed.name, location_name: ed.location_name || null, city: ed.city || null, organizer_name: ed.organizer_name || null, page_url: row.page_url, source_id: row.source_id, source_venue_id: row.source?.venue_id || null, description: ed.description };
        if (!subject.location_name && !subject.city && !subject.organizer_name) {
          // nothing to resolve against but the page itself
          if (!row.page_url) return archiveCase(client, c, { reason: 'insufficient_required_data', note: 'אין שם מקום, עיר או עמוד מקור' });
        }
        const { result, tried, errors } = await resolveLocation(client, subject, { stages: STAGES_BY_ATTEMPT[attemptIdx] });
        if (result && result.lat != null && ['HIGH', 'MEDIUM'].includes(result.confidence)) {
          if (DRY) return { outcome: 'dry', result };
          counters.addressesFound++;
          const patched = await patchIncomingLocation(client, row, result);
          const hb = await handBackIncoming(client, patched, ctx);
          if (hb.outcome === 'error') return markAttemptFailed(client, c, { method: tried, error: hb.error, settings, evidence: { location: result } });
          if (hb.outcome === 'published') counters.published++; else if (hb.outcome === 'duplicate_merged') counters.duplicatesMerged++; else if (hb.outcome === 'awaiting_policy') counters.policyHold++;
          counters.resolved++;
          return resolveCase(client, c, { outcome: hb.outcome, method: result.method, confidence: result.confidence, evidence: result.evidence, handback: hb });
        }
        const r = await markAttemptFailed(client, c, { method: tried, error: errors.join('; ') || (result ? 'only LOW confidence: ' + result.method : 'no evidence'), settings, evidence: result ? { low: result, ambiguous: !!result.ambiguous } : null });
        if (r.outcome === 'archived') { counters.archived++; counters.archiveReasons[r.reason] = (counters.archiveReasons[r.reason] || 0) + 1; }
        return r;
      }
      if (c.issue === 'missing_required_metadata') {
        const r = await enrichFields(client, { kind: 'incoming', row }, ctx);
        if (r.filled.length) { counters.fieldsFilled += r.filled.length; if (!r.remaining.length) { counters.resolved++; const patched = await loadIncoming(client, row.id); const hb = await handBackIncoming(client, patched, ctx); if (hb.outcome === 'published') counters.published++; return resolveCase(client, c, { outcome: hb.outcome, filled: r.filled, handback: hb }); } }
        const rr = await markAttemptFailed(client, c, { method: r.tried, error: 'still missing: ' + r.remaining.join(','), settings, evidence: { remaining: r.remaining } });
        if (rr.outcome === 'archived') { counters.archived++; counters.archiveReasons[rr.reason] = (counters.archiveReasons[rr.reason] || 0) + 1; }
        return rr;
      }
      return resolveCase(client, c, { outcome: 'unsupported_issue' });
    }

    // ---- live activity ----
    const a = await loadActivity(client, c.subject_id);
    if (!a) return resolveCase(client, c, { outcome: 'resolved_externally' });
    const pageUrl = (a.activity_sources || []).find((s) => s.relation === 'created')?.page_url || a.source_url || null;
    const incomingId = (a.activity_sources || []).find((s) => s.incoming_activity_id)?.incoming_activity_id || null;
    let incomingRow = null;
    if (incomingId) { const { data } = await client.from('incoming_activities').select('extracted_data').eq('id', incomingId).maybeSingle(); incomingRow = data; }
    const ed = incomingRow?.extracted_data || {};

    if (c.issue === 'incomplete_address' || c.issue === 'missing_coordinates' || c.issue === 'missing_venue') {
      const subject = { name: a.name, location_name: a.locations?.name || null, city: a.locations?.city || null, organizer_name: a.organizer_name || null, page_url: pageUrl, source_id: a.source_id, source_venue_id: null };
      let stages = STAGES_BY_ATTEMPT[attemptIdx];
      if (c.issue === 'incomplete_address' && a.locations?.lat != null) {
        // coordinates exist: a reverse geocode is the cheapest honest street address
        const { reverseAddress } = require('./cleaner/reverse');
        const rev = await reverseAddress(a.locations.lat, a.locations.lng);
        if (rev && rev.street) { if (!DRY) await applyAddressToActivity(client, a, { address: `${rev.street}${rev.houseNumber ? ' ' + rev.houseNumber : ''}`, city: rev.city, lat: null, lng: null, venue_id: null, method: 'reverse_geocode', confidence: 'MEDIUM', evidence: rev }); counters.addressesFound++; counters.resolved++; return resolveCase(client, c, { outcome: 'address_filled', method: 'reverse_geocode', confidence: 'MEDIUM', evidence: rev }); }
        stages = stages.filter((s) => s !== 'place_lookup');
      }
      const { result, tried, errors } = await resolveLocation(client, subject, { stages });
      const ok = result && ['HIGH', 'MEDIUM'].includes(result.confidence) && (c.issue === 'missing_venue' ? !!result.venue_id : (result.address || result.lat != null));
      if (ok) {
        if (!DRY) await applyAddressToActivity(client, a, result);
        if (c.issue === 'missing_venue') counters.venuesLinked++; else counters.addressesFound++;
        counters.resolved++;
        return resolveCase(client, c, { outcome: c.issue === 'missing_venue' ? 'venue_linked' : 'address_filled', method: result.method, confidence: result.confidence, evidence: result.evidence });
      }
      const r = await markAttemptFailed(client, c, { method: tried, error: errors.join('; ') || 'no evidence', settings, evidence: result ? { low: result } : null });
      if (r.outcome === 'archived') { counters.archived++; counters.archiveReasons[r.reason] = (counters.archiveReasons[r.reason] || 0) + 1; }
      return r;
    }
    if (c.issue === 'missing_image' || c.issue === 'broken_image') {
      // same-series images already in Turu (same title, has image)
      const { data: series } = await client.from('activities').select('id, name, activity_images(url)').eq('status', 'approved').neq('id', a.id).ilike('name', a.name.slice(0, 40) + '%').limit(5);
      const seriesUrls = (series || []).filter((s) => wordOverlapScore(s.name, a.name) >= 0.7).flatMap((s) => (s.activity_images || []).map((i) => i.url));
      const subject = { name: a.name, page_url: pageUrl, venue_id: a.venue_id, existing_urls: (a.activity_images || []).map((i) => i.url), incoming_images: ed.images || ed.image_urls || [], series_urls: seriesUrls };
      const r = await resolveImage(client, subject, { allowGeneric: false });
      if (r.found) {
        if (!DRY) await applyImageToActivity(client, a, r.found, ctx.userId);
        counters.imagesFound++; counters.resolved++;
        return resolveCase(client, c, { outcome: 'image_attached', kind: r.found.kind, url: r.found.url, page_url: r.found.page_url, tried: r.tried });
      }
      const rr = await markAttemptFailed(client, c, { method: r.tried, error: `no valid image (${r.candidates} candidates: ${r.rejected.slice(0, 4).map((x) => x.reason).join(',')})`, settings, evidence: { rejected: r.rejected.slice(0, 6) } });
      if (rr.outcome === 'archived') { counters.archived++; counters.archiveReasons[rr.reason] = (counters.archiveReasons[rr.reason] || 0) + 1; }
      return rr;
    }
    if (c.issue === 'missing_schedule' || c.issue === 'missing_region') {
      const r = await enrichFields(client, { kind: 'activity', activity: a, extracted: ed }, ctx);
      if (r.filled.includes(c.issue === 'missing_schedule' ? 'schedule' : 'region')) { counters.fieldsFilled += r.filled.length; counters.resolved++; return resolveCase(client, c, { outcome: 'field_filled', filled: r.filled }); }
      const rr = await markAttemptFailed(client, c, { method: r.tried, error: 'not derivable', settings });
      if (rr.outcome === 'archived') { counters.archived++; counters.archiveReasons[rr.reason] = (counters.archiveReasons[rr.reason] || 0) + 1; }
      return rr;
    }
    return resolveCase(client, c, { outcome: 'unsupported_issue' });
  } catch (e) {
    counters.errors++;
    return markAttemptFailed(client, c, { method: 'error', error: (e.message || String(e)).slice(0, 300), settings });
  }
}

async function cycle(client, userId) {
  const { data: settingsRows } = await client.from('automation_settings').select('key, value');
  const settings = settingsFrom(settingsRows);
  if (!settings.enabled && !args.force) { console.log('cleaner_enabled=false - nothing done (use --force)'); return null; }
  const today = new Date().toISOString().slice(0, 10);
  const counters = { inspected: 0, resolved: 0, published: 0, duplicatesMerged: 0, policyHold: 0, addressesFound: 0, imagesFound: 0, venuesLinked: 0, fieldsFilled: 0, archived: 0, archiveReasons: {}, errors: 0, discovered: 0, reopened: 0 };
  const { data: run } = DRY ? { data: null } : await client.from('cleaner_runs').insert({ mode: args.loop ? 'loop' : 'batch' }).select('id').single();
  const t0 = Date.now();
  try { return await cycleBody(client, userId, { settings, today, counters, run, t0 }); }
  catch (e) { if (run) await client.from('cleaner_runs').update({ finished_at: new Date().toISOString(), counters, notes: 'failed: ' + (e.message || String(e)).slice(0, 300) }).eq('id', run.id); throw e; }
}

async function cycleBody(client, userId, { settings, today, counters, run, t0 }) {
  if (!args['reopen-only']) {
    const { candidates, stats } = await discoverCases(client, { today });
    const up = DRY ? { created: candidates.length, existing: 0, closedExternally: 0 } : await upsertCases(client, candidates);
    counters.discovered = up.created;
    console.log(`discover: ${candidates.length} candidate issues ${JSON.stringify(stats)} -> new cases ${up.created}, existing ${up.existing}, closed externally ${up.closedExternally}`);
  }
  if (!args['discover-only']) {
    const ro = DRY ? { reopened: 0, scanned: 0 } : await reopenWhereEvidenceChanged(client);
    counters.reopened = ro.reopened;
    if (ro.scanned) console.log(`reopen: ${ro.reopened}/${ro.scanned} archived cases had new evidence`);
  }
  if (!args['discover-only'] && !args['reopen-only']) {
    const max = Number(args.max || settings.batchSize);
    let q = client.from('cleaner_cases').select('*').eq('status', 'open').lte('next_attempt_at', new Date().toISOString()).order('priority', { ascending: true }).order('event_date', { ascending: true, nullsFirst: false }).order('created_at', { ascending: true }).limit(max);
    if (args.issue) q = q.eq('issue', String(args.issue));
    const { data: due, error } = await q;
    if (error) throw error;
    console.log(`processing ${due.length} due cases (max ${max})`);
    const ctx = { settings, counters, today, userId, cache: new Map() };
    for (const c of due) {
      const r = await processCase(client, c, ctx);
      const tag = `${c.subject_kind}/${c.issue}`.padEnd(32);
      console.log(`  ${tag} ${c.subject_id.slice(0, 8)} -> ${r.outcome}${r.reason ? ' ' + r.reason : ''}${r.method ? ' via ' + r.method + '/' + (r.confidence || '') : ''}${r.error ? ' | ' + String(r.error).slice(0, 80) : ''}`);
    }
  }
  const { count: backlog } = await client.from('cleaner_cases').select('id', { count: 'exact', head: true }).eq('status', 'open');
  counters.backlog = backlog; counters.durationMs = Date.now() - t0;
  if (run) await client.from('cleaner_runs').update({ finished_at: new Date().toISOString(), counters }).eq('id', run.id);
  console.log('cycle done:', JSON.stringify(counters));
  return counters;
}

(async () => {
  const { client, userId } = await getClient();
  if (args.loop) {
    const minutes = Number(args.loop) || 30;
    console.log(`THE CLEANER loop every ${minutes} min (Ctrl+C to stop)`);
    while (true) { try { await cycle(client, userId); } catch (e) { console.error('cycle failed:', e.message); } await new Promise((r) => setTimeout(r, minutes * 60000)); }
  } else await cycle(client, userId);
})().catch((e) => { console.error(e); process.exit(1); });
