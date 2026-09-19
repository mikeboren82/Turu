// TuRu - THE MONSTER validation cohort (unified stabilization program, 2026-09-19).
// Runs the REAL production path (scan_source_now RPC -> pg_net -> scan-source edge function) on a bounded
// set of ACTIVE sources, waits for their scan logs, and measures the funnel; then (phase measure) counts
// the Cleaner debt the NEW canonical subjects created and classifies every new case AVOIDABLE (the Cleaner
// can resolve it now from evidence the Monster already had: the same listing / detail page, canonical venue,
// canonical settlement knowledge) vs HONEST_UNRESOLVABLE / SOURCE_LIMITED.
//
// DENOMINATOR (documented): NEW CANONICAL SUBJECT = an activities row created in the window by a cohort
// source (auto-approved or archived-by-policy) + an incoming_activities row with match_type='new' found in
// the window by a cohort source (a candidate that becomes a subject of review / the Cleaner). Updates,
// duplicates, rediscovered historical debt and Cleaner rediscovery are NOT subjects.
//   node run-monster-cohort.js --phase=scan --sources=a0eb9ad9,627f3c65,... [--wait=900]
//   node run-monster-cohort.js --phase=measure --since=<ISO from the scan phase> --sources=...
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { resolveImage } = require('./cleaner/imageResolver');
const { resolveLocation } = require('./cleaner/locationResolver');
const { resolveIncomingMetadata } = require('./cleaner/fieldEnricher');
const { loadSettlementIndex, resolveSettlement, canonicalCityFallback } = require('./lib/canonicalSettlement');
const { wordOverlapScore } = require('./cleaner/matching');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const PHASE = String(args.phase || 'scan'); const WAIT = Number(args.wait || 900);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolveSources(client, prefixes) {
  const { data } = await client.from('sources').select('id, name, publisher_type, strategy, region, health_status, is_trusted, source_trust_score, adapter_config, last_scan_at').eq('is_active', true);
  const out = [];
  for (const p of prefixes) { const hit = (data || []).filter((s) => s.id.startsWith(p)); if (hit.length !== 1) throw new Error(`source prefix ${p} matches ${hit.length}`); out.push(hit[0]); }
  return out;
}

async function scanPhase(client, sources) {
  const t0 = new Date().toISOString();
  console.log('T0', t0, '| cohort', sources.map((s) => s.name).join(' | '));
  const dispatched = [];
  for (const s of sources) {
    const { data, error } = await client.rpc('scan_source_now', { p_source_id: s.id });
    dispatched.push({ id: s.id, name: s.name, ok: !error, error: error?.message || null, result: data });
    console.log(`  dispatch ${s.name}: ${error ? 'ERROR ' + error.message : 'ok'}`);
    await sleep(1500);
  }
  const logs = new Map(); const deadline = Date.now() + WAIT * 1000;
  while (Date.now() < deadline) {
    const { data } = await client.from('source_scan_logs').select('*').in('source_id', sources.map((s) => s.id)).gte('started_at', t0).order('started_at', { ascending: false });
    for (const l of data || []) if (!logs.has(l.source_id) || (l.finished_at && !logs.get(l.source_id).finished_at)) logs.set(l.source_id, l);
    const done = sources.filter((s) => logs.get(s.id)?.finished_at).length;
    console.log(`  ${new Date().toISOString().slice(11, 19)} scans finished ${done}/${sources.length}`);
    if (done === sources.length) break;
    await sleep(20000);
  }
  const perSource = sources.map((s) => { const l = logs.get(s.id); return { id: s.id, name: s.name, publisher_type: s.publisher_type, region: s.region, detail_traversal: !!(s.adapter_config && s.adapter_config.detail_traversal), scan: l ? { status: l.status, pages_checked: l.pages_checked, pages_changed: l.pages_changed, pages_unchanged: l.pages_unchanged, ai_calls: l.ai_calls, activities_found: l.activities_found, new: l.new_count, updated: l.updated_count, duplicate: l.duplicate_count, rejected: l.rejected_count, auto_approved: l.auto_approved_count, error: l.error_message, listing_metrics: l.listing_metrics, detail_metrics: l.detail_metrics } : null }; });
  const ids = sources.map((s) => s.id);
  const { data: acts } = await client.from('activities').select('id, name, status, source_id, entity_type, category, archive_reason, created_at').in('source_id', ids).gte('created_at', t0);
  const { data: incs } = await client.from('incoming_activities').select('id, source_id, match_type, status, validation_issues, found_at').in('source_id', ids).gte('found_at', t0);
  const tally = (arr, fn) => { const m = {}; for (const x of arr || []) { const k = fn(x) ?? '(null)'; m[k] = (m[k] || 0) + 1; } return m; };
  const report = { generatedAt: new Date().toISOString(), t0, dispatched, perSource, totals: { pages_checked: perSource.reduce((n, s) => n + (s.scan?.pages_checked || 0), 0), pages_changed: perSource.reduce((n, s) => n + (s.scan?.pages_changed || 0), 0), ai_calls: perSource.reduce((n, s) => n + (s.scan?.ai_calls || 0), 0), activities_found: perSource.reduce((n, s) => n + (s.scan?.activities_found || 0), 0), auto_approved: perSource.reduce((n, s) => n + (s.scan?.auto_approved || 0), 0) }, newActivities: { n: (acts || []).length, byStatus: tally(acts, (a) => a.status + (a.archive_reason ? ':' + a.archive_reason : '')), byEntity: tally(acts, (a) => a.entity_type) }, newIncoming: { n: (incs || []).length, byMatchType: tally(incs, (i) => i.match_type), byStatus: tally(incs, (i) => i.match_type + '/' + i.status), byIssue: tally((incs || []).flatMap((i) => i.validation_issues || []), (x) => x) }, newCanonicalSubjects: (acts || []).length + (incs || []).filter((i) => i.match_type === 'new').length };
  const file = path.join(__dirname, `monster-cohort-${t0.slice(0, 10)}-scan.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ totals: report.totals, newActivities: report.newActivities, newIncoming: report.newIncoming, newCanonicalSubjects: report.newCanonicalSubjects }, null, 1));
  console.log('->', path.basename(file), '| measure with --phase=measure --since=' + t0);
}

async function measurePhase(client, sources, since) {
  const ids = sources.map((s) => s.id); const srcName = Object.fromEntries(sources.map((s) => [s.id, s.name]));
  const { data: acts } = await client.from('activities').select('id, name, source_id, source_url, venue_id, category, entity_type, created_at, locations(id, name, address, city, lat, lng, region, address_source, address_confidence), activity_images(url), activity_sources(page_url, incoming_activity_id, relation)').in('source_id', ids).gte('created_at', since);
  const { data: incs } = await client.from('incoming_activities').select('id, source_id, page_url, status, match_type, validation_issues, extracted_data, found_at, source:sources(id, name, venue_id, publisher_type, is_trusted, source_trust_score)').in('source_id', ids).gte('found_at', since);
  const newIncoming = (incs || []).filter((i) => i.match_type === 'new');
  const subjects = (acts || []).length + newIncoming.length;
  const actIds = new Set((acts || []).map((a) => a.id)); const incIds = new Set(newIncoming.map((i) => i.id));
  const { data: cases } = await client.from('cleaner_cases').select('*').gte('created_at', since);
  const cohortCases = (cases || []).filter((c) => (c.subject_kind === 'activity' && actIds.has(c.subject_id)) || (c.subject_kind === 'incoming' && incIds.has(c.subject_id)));
  console.log(`since ${since} | new activities ${(acts || []).length} | new incoming (match new) ${newIncoming.length} | subjects ${subjects} | cohort Cleaner cases ${cohortCases.length}`);
  const index = await loadSettlementIndex(client);
  const cache = new Map(); const today = new Date().toISOString().slice(0, 10);
  const rows = [];
  for (const c of cohortCases) {
    const a = c.subject_kind === 'activity' ? (acts || []).find((x) => x.id === c.subject_id) : null;
    const inc = c.subject_kind === 'incoming' ? newIncoming.find((x) => x.id === c.subject_id) : null;
    let klass = 'HONEST_UNRESOLVABLE', why = null, method = null;
    try {
      if (c.issue === 'missing_image' && a) {
        const pageUrl = (a.activity_sources || []).find((s) => s.relation === 'created')?.page_url || a.source_url;
        const r = await resolveImage(client, { name: a.name, page_url: pageUrl, venue_id: a.venue_id, existing_urls: [], incoming_images: [], series_urls: [] }, { allowGeneric: false, cache });
        if (r.found) { klass = 'AVOIDABLE'; why = 'image_extraction_missed: ' + r.found.why + ' (' + r.found.kind + ')'; method = r.found.why; } else why = 'no valid image on listing/detail/venue (' + r.candidates + ' candidates, ' + [...new Set(r.rejected.map((x) => x.reason))].join(',') + ')';
      } else if (['incomplete_address', 'missing_venue', 'unverified_location', 'missing_location', 'missing_coordinates'].includes(c.issue)) {
        const subj = a ? { name: a.name, location_name: a.locations?.name || null, city: a.locations?.city || null, organizer_name: null, page_url: (a.activity_sources || []).find((s) => s.relation === 'created')?.page_url || a.source_url, source_id: a.source_id, source_venue_id: null }
          : { name: inc?.extracted_data?.name, location_name: inc?.extracted_data?.location_name || null, city: inc?.extracted_data?.city || null, organizer_name: inc?.extracted_data?.organizer_name || null, page_url: inc?.page_url, source_id: inc?.source_id, source_venue_id: inc?.source?.venue_id || null };
        const r = await resolveLocation(client, subj, { stages: ['existing', 'source_page', 'detail_page'], maxEvidenceStages: 2, cache, counters: {}, needVenue: c.issue === 'missing_venue' });
        const ok = r.result && ['HIGH', 'MEDIUM'].includes(r.result.confidence) && (c.issue === 'missing_venue' ? !!r.result.venue_id : (r.result.address || r.result.lat != null));
        if (ok) { klass = 'AVOIDABLE'; why = 'location_evidence_missed: ' + r.result.method; method = r.result.method; } else why = 'no HIGH/MEDIUM evidence in existing/source_page/detail_page (' + (r.tried || []).join(',') + ')';
      } else if (c.issue === 'missing_required_metadata' && inc) {
        const r = await resolveIncomingMetadata(client, inc, { today, cache, dry: true });
        if (r.filled && r.filled.length) { klass = 'AVOIDABLE'; why = 'metadata_extraction_missed: ' + r.filled.join(','); method = 'page_evidence'; } else why = 'no page evidence for ' + (r.remaining || []).join(',');
      } else if (c.issue === 'missing_region' && a) {
        const s = resolveSettlement(index, a.locations?.city); if (s && s.region) { klass = 'AVOIDABLE'; why = 'region_derivable_from_canonical_settlement'; method = 'settlement_region'; } else why = 'city not canonical / no region mapping';
      } else if (c.issue === 'missing_city' && a) {
        const r = await canonicalCityFallback(client, { venueId: a.venue_id, address: a.locations?.address, lat: a.locations?.lat, lng: a.locations?.lng }); if (r) { klass = 'AVOIDABLE'; why = 'city_from_' + r.how; method = r.how; } else why = 'no venue / address locality evidence';
      } else if (c.issue === 'missing_schedule') { why = 'no schedule in extraction (source page evidence would need the Cleaner page pass)'; }
      else if (c.issue === 'misclassified') { klass = 'AVOIDABLE'; why = 'name rule known at ingestion'; }
      else why = 'not classified';
    } catch (e) { why = 'error: ' + (e.message || e); }
    rows.push({ case_id: c.id, issue: c.issue, subject_kind: c.subject_kind, subject_id: c.subject_id, source: srcName[a?.source_id || inc?.source_id] || null, name: a?.name || inc?.extracted_data?.name || null, opened_reason: c.opened_reason, klass, why, method });
    console.log(`  ${c.issue.padEnd(26)} ${(a?.name || inc?.extracted_data?.name || '').slice(0, 40).padEnd(40)} -> ${klass} ${why || ''}`.slice(0, 200));
  }
  const tally = (arr, fn) => { const m = {}; for (const x of arr) { const k = fn(x) ?? '(null)'; m[k] = (m[k] || 0) + 1; } return m; };
  const avoidable = rows.filter((r) => r.klass === 'AVOIDABLE');
  const per100 = (n) => subjects ? Math.round(1000 * n / subjects) / 10 : null;
  const report = { generatedAt: new Date().toISOString(), since, cohort: sources.map((s) => ({ id: s.id, name: s.name, publisher_type: s.publisher_type, region: s.region })), denominator: { definition: 'activities created by a cohort source in the window + incoming match_type=new found by a cohort source in the window', activities: (acts || []).length, incomingNew: newIncoming.length, subjects }, cases: { total: rows.length, per100: per100(rows.length), avoidable: avoidable.length, avoidablePer100: per100(avoidable.length), byIssue: tally(rows, (r) => r.issue), byIssueAvoidable: tally(avoidable, (r) => r.issue), bySource: tally(rows, (r) => r.source), rootCauses: tally(avoidable, (r) => (r.why || '').split(':')[0] + (r.method ? '/' + r.method : '')) }, rows };
  const file = path.join(__dirname, `monster-cohort-${since.slice(0, 10)}-measure.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ denominator: report.denominator, cases: { ...report.cases, rows: undefined } }, null, 1)); console.log('->', path.basename(file));
}

(async () => {
  const { client } = await getClient();
  const sources = await resolveSources(client, String(args.sources || '').split(',').filter(Boolean));
  if (!sources.length) throw new Error('--sources=<id prefixes> required');
  if (PHASE === 'scan') await scanPhase(client, sources);
  else if (PHASE === 'measure') { if (!args.since) throw new Error('--since=<ISO> required'); await measurePhase(client, sources, String(args.since)); }
  else throw new Error('unknown phase');
})().catch((e) => { console.error(e); process.exit(1); });
