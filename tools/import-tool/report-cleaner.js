// TuRu - THE CLEANER coverage report (THE-CLEANER.md §25-26): how many records still need
// attention and why, what was resolved/archived, which sources/families generate incomplete
// records, and whether anything is stuck beyond the retry window. Read-only; writes
// cleaner-report-<date>.json for tracking across runs.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { all } = require('./cleaner/discover');
const { settingsFrom } = require('./cleaner/lifecycle');

const tally = (arr, fn) => { const m = {}; arr.forEach((x) => { const k = fn(x) ?? '(null)'; m[k] = (m[k] || 0) + 1; }); return m; };
const FAMILY = { municipality_calendar: 'municipality', chain_events_page: 'mall', aggregator: 'aggregator', ticketing: 'ticketing', facebook: 'social', instagram: 'social' };
const FAMILY_PUB = { municipality: 'municipality', local_council: 'municipality', regional_council: 'municipality', mall_chain: 'mall', community_center_network: 'community_center', venue_operator: 'venue', organizer: 'organizer', aggregator: 'aggregator' };

(async () => {
  const { client } = await getClient();
  const { data: settingsRows } = await client.from('automation_settings').select('key, value');
  const settings = settingsFrom(settingsRows);
  const cases = await all(client, 'cleaner_cases', '*');
  const sources = await all(client, 'sources', 'id, name, source_kind, publisher_type');
  const srcById = Object.fromEntries(sources.map((s) => [s.id, s]));
  const familyOf = (id) => { const s = srcById[id]; return s ? (FAMILY[s.source_kind] || FAMILY_PUB[s.publisher_type] || 'venue') : '(no source)'; };
  const now = Date.now();
  const windowMs = (settings.backoffHours.reduce((a, b) => a + b, 0) + 24) * 3600 * 1000;
  const open = cases.filter((c) => c.status === 'open');
  const stuck = open.filter((c) => now - new Date(c.created_at).getTime() > windowMs);
  const { data: runs } = await client.from('cleaner_runs').select('*').order('started_at', { ascending: false }).limit(20);
  const resolvedCases = cases.filter((c) => c.status === 'resolved');
  const avgAttempts = resolvedCases.length ? resolvedCases.reduce((n, c) => n + (c.attempts || 0), 0) / resolvedCases.length : 0;
  const byFamily = {}; for (const c of cases) { const f = familyOf(c.source_id); const b = (byFamily[f] ||= { cases: 0, resolved: 0, archived: 0, open: 0, missing_address: 0 }); b.cases++; b[c.status]++; if (['missing_location', 'incomplete_address', 'missing_coordinates'].includes(c.issue)) b.missing_address++; }
  const bySource = tally(cases.filter((c) => c.source_id), (c) => srcById[c.source_id]?.name || c.source_id);
  const byIssue = {}; for (const c of cases) { (byIssue[c.issue] ||= { open: 0, resolved: 0, archived: 0 })[c.status]++; }
  const successByIssue = Object.fromEntries(Object.entries(byIssue).map(([k, v]) => [k, v.resolved + v.archived ? Math.round(100 * v.resolved / (v.resolved + v.archived)) : null]));
  const outcomes = tally(resolvedCases, (c) => c.resolution?.outcome);
  const { count: liveNoAddr } = await client.from('locations').select('id', { count: 'exact', head: true }).is('address', null);
  const report = {
    generatedAt: new Date().toISOString(),
    backlog: { open: open.length, due: open.filter((c) => new Date(c.next_attempt_at).getTime() <= now).length, stuckBeyondWindow: stuck.length, byIssue, byPriorityBucket: tally(open, (c) => (c.priority <= 15 ? 'blocking' : c.priority <= 35 ? 'important' : 'enrichment')) },
    resolved: { total: resolvedCases.length, outcomes, avgAttempts: Math.round(avgAttempts * 100) / 100, successRateByIssue: successByIssue },
    archived: { total: cases.filter((c) => c.status === 'archived').length, byReason: tally(cases.filter((c) => c.status === 'archived'), (c) => c.archive_reason) },
    byFamily, topSources: Object.entries(bySource).sort((a, b) => b[1] - a[1]).slice(0, 15),
    runs: (runs || []).map((r) => ({ started_at: r.started_at, finished_at: r.finished_at, counters: r.counters })),
    stuckSample: stuck.slice(0, 10).map((c) => ({ issue: c.issue, subject: c.subject_id, attempts: c.attempts, last_error: c.last_error })),
    unexplainedBacklog: open.filter((c) => !c.opened_reason).length,
    locationsWithoutAddress: liveNoAddr,
  };
  const file = path.join(__dirname, `cleaner-report-${report.generatedAt.slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log('=== THE CLEANER ===');
  console.log('backlog', report.backlog.open, '| due now', report.backlog.due, '| stuck beyond window', report.backlog.stuckBeyondWindow, '| unexplained', report.unexplainedBacklog);
  console.log('by issue', JSON.stringify(byIssue));
  console.log('resolved', report.resolved.total, 'outcomes', JSON.stringify(outcomes), 'avg attempts', report.resolved.avgAttempts, '| success% by issue', JSON.stringify(successByIssue));
  console.log('archived', report.archived.total, JSON.stringify(report.archived.byReason));
  console.log('by family', JSON.stringify(byFamily));
  console.log('top sources', report.topSources.map(([k, v]) => `${k}=${v}`).join(' | '));
  console.log('last run', report.runs[0] ? JSON.stringify(report.runs[0]) : '-');
  console.log('written', path.basename(file));
})().catch((e) => { console.error(e); process.exit(1); });
