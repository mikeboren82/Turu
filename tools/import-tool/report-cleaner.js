// TuRu - THE CLEANER coverage report (THE-CLEANER.md §25-26 + continuation pass 2026-09-14):
//   backlog by issue / priority bucket / archive reason, resolved outcomes, stuck-beyond-window,
//   INFORMATION GAIN (what actually improved: street addresses, coordinates, venues, images...),
//   SOURCE DEBT (which sources create Cleaner work, dominant issue, likely root cause -> feedback
//   for THE MONSTER), HISTORICAL vs NEW debt (cases whose subject entered after the Cleaner's first
//   run - the long-term health signal), venue-cluster / canonical-venue effects, centroid cases,
//   awaiting-retry cases with their next available stage.
// Read-only; writes cleaner-report-<date>.json for tracking across runs.
//   node report-cleaner.js [--since=2026-09-13T17:51:00Z] [--json-only]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { all } = require('./cleaner/discover');
const { settingsFrom, LOCATION_ISSUES } = require('./cleaner/lifecycle');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const tally = (arr, fn) => { const m = {}; arr.forEach((x) => { const k = fn(x) ?? '(null)'; m[k] = (m[k] || 0) + 1; }); return m; };
const FAMILY = { municipality_calendar: 'municipality', chain_events_page: 'mall', aggregator: 'aggregator', ticketing: 'ticketing', facebook: 'social', instagram: 'social' };
const FAMILY_PUB = { municipality: 'municipality', local_council: 'municipality', regional_council: 'municipality', mall_chain: 'mall', community_center_network: 'community_center', venue_operator: 'venue', organizer: 'organizer', aggregator: 'aggregator' };
const GAIN_KEYS = ['addressesAdded', 'streetAddressesAdded', 'coordsAdded', 'coordsImproved', 'venuesLinked', 'venueRowsEnriched', 'venuesCreated', 'imagesAdded', 'brokenImagesReplaced', 'schedulesAdded', 'regionsAdded', 'metadataFieldsAdded', 'incomingPromoted', 'existingEnriched', 'duplicatesMerged'];

// likely root cause of a source's Cleaner debt, from the evidence its cases produced
function rootCause(src, cases) {
  const resolved = cases.filter((c) => c.status === 'resolved');
  const methods = tally(resolved, (c) => c.resolution?.method || c.resolution?.outcome);
  const archived = cases.filter((c) => c.status === 'archived');
  const dom = Object.entries(tally(cases, (c) => c.issue)).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (methods.detail_page) return 'missing_detail_traversal';
  if (methods.existing_venue || methods.existing_source_venue || cases.some((c) => c.resolution?.via_cluster)) return 'venue_resolution_weakness';
  if (methods.source_page || methods.reverse_geocode) return 'extraction_weakness';
  if (src.strategy === 'api_json' && dom && LOCATION_ISSUES.has(dom)) return 'adapter_weakness';
  if (archived.length && archived.every((c) => /unresolved|not_found/.test(c.archive_reason || ''))) return 'source_limitation';
  if (dom === 'missing_required_metadata') return 'extraction_weakness';
  if (dom === 'missing_image') return 'source_limitation';
  return 'unknown';
}

(async () => {
  const { client } = await getClient();
  const { data: settingsRows } = await client.from('automation_settings').select('key, value');
  const settings = settingsFrom(settingsRows);
  const cases = await all(client, 'cleaner_cases', '*');
  const sources = await all(client, 'sources', 'id, name, source_kind, publisher_type, strategy');
  const srcById = Object.fromEntries(sources.map((s) => [s.id, s]));
  const familyOf = (id) => { const s = srcById[id]; return s ? (FAMILY[s.source_kind] || FAMILY_PUB[s.publisher_type] || 'venue') : '(no source)'; };
  const pathOf = (id) => { const s = srcById[id]; return s ? (s.strategy || 'generic_html') : '(no source)'; };
  const now = Date.now();
  const windowMs = (settings.backoffHours.reduce((a, b) => a + b, 0) + 24) * 3600 * 1000;
  const open = cases.filter((c) => c.status === 'open');
  const stuck = open.filter((c) => now - new Date(c.created_at).getTime() > windowMs);
  const { data: runs } = await client.from('cleaner_runs').select('*').order('started_at', { ascending: false }).limit(200);
  const finished = (runs || []).filter((r) => r.finished_at);
  const firstRunAt = finished.length ? new Date(finished[finished.length - 1].started_at) : new Date(0);
  const since = args.since ? new Date(String(args.since)) : firstRunAt;
  const resolvedCases = cases.filter((c) => c.status === 'resolved');
  const noGain = resolvedCases.filter((c) => ['resolved_externally', 'already_filled', 'unsupported_issue'].includes(c.resolution?.outcome));
  const avgAttempts = resolvedCases.length ? resolvedCases.reduce((n, c) => n + (c.attempts || 0), 0) / resolvedCases.length : 0;
  const byFamily = {}; for (const c of cases) { const f = familyOf(c.source_id); const b = (byFamily[f] ||= { cases: 0, resolved: 0, archived: 0, open: 0, missing_address: 0 }); b.cases++; b[c.status]++; if (['missing_location', 'incomplete_address', 'missing_coordinates', 'unverified_location'].includes(c.issue)) b.missing_address++; }
  const byIssue = {}; for (const c of cases) { (byIssue[c.issue] ||= { open: 0, resolved: 0, archived: 0 })[c.status]++; }
  const successByIssue = Object.fromEntries(Object.entries(byIssue).map(([k, v]) => [k, v.resolved + v.archived ? Math.round(100 * v.resolved / (v.resolved + v.archived)) : null]));
  const outcomes = tally(resolvedCases, (c) => c.resolution?.outcome);
  const resolvedByMethod = tally(resolvedCases.filter((c) => c.resolution?.method), (c) => c.resolution.method);

  // information gain = sum of run counters since `since` (each run counts what it actually wrote)
  const gainRuns = finished.filter((r) => new Date(r.started_at) >= since && r.counters && r.counters.gain);
  const informationGain = Object.fromEntries(GAIN_KEYS.map((k) => [k, gainRuns.reduce((n, r) => n + (r.counters.gain[k] || 0), 0)]));
  const sum = (k) => gainRuns.reduce((n, r) => n + (r.counters[k] || 0), 0);
  const venueEffects = { clustersResolved: sum('venueClustersResolved'), casesResolvedViaCluster: sum('resolvedViaCluster'), casesResolvedViaCanonicalVenue: sum('resolvedViaVenue'), externalLookupsAvoided: sum('externalLookupsAvoided'), venueRowsEnriched: informationGain.venueRowsEnriched, venuesCreated: informationGain.venuesCreated };
  const archivedByReason = tally(cases.filter((c) => c.status === 'archived'), (c) => c.archive_reason);
  const archivedUnexplained = cases.filter((c) => c.status === 'archived' && !(c.resolution?.explanation?.why_insufficient)).length;

  // awaiting retry: open cases in backoff, with the next strategy the lifecycle recorded
  const awaiting = open.filter((c) => new Date(c.next_attempt_at).getTime() > now);
  const awaitingByNext = tally(awaiting, (c) => `${c.issue}:${c.resolution?.next_strategy || (c.attempts ? 'existing' : 'first attempt')}`);

  // historical vs new debt: subject entered the system after the Cleaner's first run
  const incIds = cases.filter((c) => c.subject_kind === 'incoming').map((c) => c.subject_id);
  const actIds = cases.filter((c) => c.subject_kind === 'activity').map((c) => c.subject_id);
  const enteredAt = new Map();
  for (let i = 0; i < incIds.length; i += 200) { const { data } = await client.from('incoming_activities').select('id, found_at').in('id', incIds.slice(i, i + 200)); for (const r of data || []) enteredAt.set('incoming|' + r.id, new Date(r.found_at).getTime()); }
  for (let i = 0; i < actIds.length; i += 200) { const { data } = await client.from('activities').select('id, created_at').in('id', actIds.slice(i, i + 200)); for (const r of data || []) enteredAt.set('activity|' + r.id, new Date(r.created_at).getTime()); }
  const isNew = (c) => (enteredAt.get(c.subject_kind + '|' + c.subject_id) || 0) > firstRunAt.getTime();
  const newCases = cases.filter(isNew); const histCases = cases.filter((c) => !isNew(c));
  const debtSplit = (arr) => ({ total: arr.length, open: arr.filter((c) => c.status === 'open').length, byIssue: tally(arr, (c) => c.issue), bySource: Object.entries(tally(arr, (c) => srcById[c.source_id]?.name || '(no source)')).sort((a, b) => b[1] - a[1]).slice(0, 12), byFamily: tally(arr, (c) => familyOf(c.source_id)), byIngestionPath: tally(arr, (c) => pathOf(c.source_id)) });
  // rate: new cases per 100 subjects that entered since the first run
  const { count: incSince } = await client.from('incoming_activities').select('id', { count: 'exact', head: true }).gte('found_at', firstRunAt.toISOString());
  const { count: actSince } = await client.from('activities').select('id', { count: 'exact', head: true }).gte('created_at', firstRunAt.toISOString()).eq('status', 'approved');
  const newDebt = { since: firstRunAt.toISOString(), subjectsEntered: { incoming: incSince || 0, activities: actSince || 0 }, cases: debtSplit(newCases), casesPer100Subjects: (incSince || 0) + (actSince || 0) ? Math.round(100 * newCases.length / ((incSince || 0) + (actSince || 0)) * 10) / 10 : null };

  // source debt: activities/candidates vs cases, dominant issue, ratio, likely root cause
  const bySrc = {}; for (const c of cases) { if (!c.source_id) continue; (bySrc[c.source_id] ||= []).push(c); }
  const srcIds = Object.keys(bySrc);
  const ingested = new Map();
  for (let i = 0; i < srcIds.length; i += 100) {
    const ids = srcIds.slice(i, i + 100);
    const { data: acts } = await client.from('activities').select('source_id').in('source_id', ids).eq('status', 'approved');
    const { data: incs } = await client.from('incoming_activities').select('source_id').in('source_id', ids).eq('match_type', 'new');
    for (const r of acts || []) { const e = ingested.get(r.source_id) || { activities: 0, candidates: 0 }; e.activities++; ingested.set(r.source_id, e); }
    for (const r of incs || []) { const e = ingested.get(r.source_id) || { activities: 0, candidates: 0 }; e.candidates++; ingested.set(r.source_id, e); }
  }
  const sourceDebt = srcIds.map((id) => {
    const cs = bySrc[id]; const ing = ingested.get(id) || { activities: 0, candidates: 0 }; const subjects = new Set(cs.map((c) => c.subject_id)).size;
    const issues = tally(cs, (c) => c.issue); const dominant = Object.entries(issues).sort((a, b) => b[1] - a[1])[0];
    const denom = Math.max(ing.activities + ing.candidates, subjects);
    return { source: srcById[id]?.name || id, family: familyOf(id), path: pathOf(id), activities: ing.activities, candidates: ing.candidates, cases: cs.length, subjectsWithCases: subjects, open: cs.filter((c) => c.status === 'open').length, dominantIssue: dominant ? `${dominant[0]} (${dominant[1]})` : null, debtRatio: denom ? Math.round(100 * subjects / denom) : null, likelyRootCause: rootCause(srcById[id] || {}, cs), flags: [dominant && LOCATION_ISSUES.has(dominant[0]) && denom && subjects / denom >= 0.5 ? 'missing_address_rate>=50%' : null].filter(Boolean) };
  }).sort((a, b) => b.cases - a.cases);

  const { count: liveNoAddr } = await client.from('locations').select('id', { count: 'exact', head: true }).is('address', null);
  const { count: centroidSuspected } = await client.from('locations').select('id', { count: 'exact', head: true }).in('address_source', ['geocode:city_centroid', 'geocode:city_centroid_suspected']);
  const { count: centroidRepaired } = await client.from('cleaner_cases').select('id', { count: 'exact', head: true }).eq('issue', 'unverified_location').eq('status', 'resolved');
  // MISSING_CITY (0094): the one number that must always be answerable + the case breakdown
  const { data: mcRows } = await client.from('activities').select('id, locations!inner(city, lat)').eq('status', 'approved').not('locations.lat', 'is', null).or('city.is.null,city.eq.', { referencedTable: 'locations' });
  const mcCases = cases.filter((c) => c.issue === 'missing_city');
  const mcRuns = (runs || []).map((r) => r.counters?.missingCity).filter(Boolean);
  const mcSum = (k) => mcRuns.reduce((n, m) => n + (m[k] || 0), 0);
  const missingCity = {
    published_missing_city: (mcRows || []).length,
    missing_city_cases_opened: mcCases.length,
    missing_city_auto_fixed: mcCases.filter((c) => c.status === 'resolved' && c.resolution?.outcome === 'city_filled').length,
    missing_city_already_fixed: mcCases.filter((c) => c.status === 'resolved' && c.resolution?.outcome !== 'city_filled').length,
    missing_city_conflict: mcCases.filter((c) => c.archive_reason === 'requires_human_judgment').length,
    missing_city_unresolved: mcCases.filter((c) => c.archive_reason === 'city_unresolved').length,
    missing_city_human_review: mcCases.filter((c) => c.archive_reason === 'requires_human_judgment').length,
    missing_city_outside_service_area: mcCases.filter((c) => c.archive_reason === 'outside_service_area').length,
    missing_city_open: mcCases.filter((c) => c.status === 'open').length,
    reverse_geocode_attempts: mcSum('reverseAttempts'), reverse_geocode_success: mcSum('reverseSuccess'), reverse_geocode_requests: mcSum('reverseRequests'),
    canonical_settlement_match: mcSum('settlementMatch'), normalization_failure: mcSum('normalizationFailure'),
    byMethod: tally(mcCases.filter((c) => c.resolution?.outcome === 'city_filled'), (c) => c.resolution.method),
  };
  const report = {
    generatedAt: new Date().toISOString(), since: since.toISOString(),
    backlog: { open: open.length, due: open.filter((c) => new Date(c.next_attempt_at).getTime() <= now).length, awaitingRetry: awaiting.length, stuckBeyondWindow: stuck.length, byIssue, byPriorityBucket: tally(open, (c) => (c.priority <= 15 ? 'blocking' : c.priority <= 35 ? 'important' : 'enrichment')), leased: open.filter((c) => c.lease_until && new Date(c.lease_until).getTime() > now).length },
    awaitingRetryByNextStrategy: awaitingByNext,
    resolved: { total: resolvedCases.length, withGain: resolvedCases.length - noGain.length, noGain: noGain.length, outcomes, byMethod: resolvedByMethod, avgAttempts: Math.round(avgAttempts * 100) / 100, successRateByIssue: successByIssue },
    archived: { total: cases.filter((c) => c.status === 'archived').length, byReason: archivedByReason, unexplained: archivedUnexplained },
    informationGain, venueEffects,
    byFamily, sourceDebt: sourceDebt.slice(0, 40), topSources: sourceDebt.slice(0, 15).map((s) => [s.source, s.cases]),
    historicalDebt: debtSplit(histCases), newDebt,
    missingCity,
    centroid: { suspectedLocations: centroidSuspected || 0, repairedCases: centroidRepaired || 0 },
    runs: (runs || []).slice(0, 20).map((r) => ({ started_at: r.started_at, finished_at: r.finished_at, worker: r.worker, notes: r.notes, counters: r.counters })),
    stuckSample: stuck.slice(0, 10).map((c) => ({ issue: c.issue, subject: c.subject_id, attempts: c.attempts, last_error: c.last_error })),
    unexplainedBacklog: open.filter((c) => !c.opened_reason).length,
    locationsWithoutAddress: liveNoAddr,
  };
  const file = path.join(__dirname, `cleaner-report-${report.generatedAt.slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  if (args['json-only']) { console.log(path.basename(file)); return; }
  console.log('=== THE CLEANER ===');
  console.log('backlog', report.backlog.open, '| due now', report.backlog.due, '| awaiting retry', report.backlog.awaitingRetry, '| stuck beyond window', report.backlog.stuckBeyondWindow, '| unexplained', report.unexplainedBacklog, '| leased', report.backlog.leased);
  console.log('by issue', JSON.stringify(byIssue));
  console.log('resolved', report.resolved.total, '(with gain', report.resolved.withGain, '/ no gain', report.resolved.noGain + ')', 'outcomes', JSON.stringify(outcomes), '| by method', JSON.stringify(resolvedByMethod));
  console.log('archived', report.archived.total, JSON.stringify(archivedByReason), '| unexplained archives', archivedUnexplained);
  console.log('information gain since', report.since, JSON.stringify(informationGain));
  console.log('venue effects', JSON.stringify(venueEffects));
  console.log('awaiting retry by next strategy', JSON.stringify(awaitingByNext));
  console.log('historical debt', histCases.length, '| new debt', JSON.stringify({ total: newDebt.cases.total, open: newDebt.cases.open, per100: newDebt.casesPer100Subjects, entered: newDebt.subjectsEntered, byIssue: newDebt.cases.byIssue, byPath: newDebt.cases.byIngestionPath }));
  console.log('missing city', JSON.stringify(report.missingCity));
  console.log('centroid', JSON.stringify(report.centroid));
  console.log('source debt (top 12):'); sourceDebt.slice(0, 12).forEach((s) => console.log(`  ${s.source} | ${s.family}/${s.path} | acts ${s.activities} cand ${s.candidates} | cases ${s.cases} (open ${s.open}) | ${s.dominantIssue} | ratio ${s.debtRatio}% | ${s.likelyRootCause} ${s.flags.join(',')}`));
  console.log('last run', report.runs[0] ? JSON.stringify(report.runs[0]).slice(0, 400) : '-');
  console.log('written', path.basename(file));
})().catch((e) => { console.error(e); process.exit(1); });
