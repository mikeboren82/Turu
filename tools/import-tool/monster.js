// TuRu - CONTINUOUS MONSTER orchestrator (LOCAL jobs; the durable jobs - source scanning and expiry - run inside
// Supabase pg_cron and are only OBSERVED here). One bounded cycle = the due local jobs, run sequentially, each
// isolated (a failure is recorded and the cycle continues), overlap-locked (logs/monster.lock, stale after 3 h),
// with a heartbeat + per-job state in automation_settings (`monster_state`, `monster_enabled`).
//   node monster.js status                       heartbeat report (machine-readable monster-status.json + summary)
//   node monster.js cycle [--dry-run] [--job=x]  run the due local jobs (dry-run: select + report, mutate nothing)
//   node monster.js pause | resume               automation_settings.monster_enabled=false/true (local jobs only;
//                                                  pg_cron scanning is paused with scanning_enabled=false)
//   node monster.js install-task                 print the Task Scheduler command (never executes it)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getClient } = require('./supabase');
const { all } = require('./cleaner/discover');
const { JOBS, selectJobs, lockIsStale, schedulerCommand, pauseCommand } = require('./lib/monsterJobs');
const { reviewBudget } = require('./lib/reviewBudget');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const cmd = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'status';
const DRY = !!args['dry-run'];
const LOCK = path.join(__dirname, 'logs', 'monster.lock');
const ROOT = __dirname;

async function readSetting(client, key, dflt) { const { data } = await client.from('automation_settings').select('value').eq('key', key).maybeSingle(); return data ? data.value : dflt; }
async function writeSetting(client, key, value) { const { error } = await client.from('automation_settings').upsert({ key, value }, { onConflict: 'key' }); if (error) throw error; }

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  let lock = null; try { lock = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { lock = null; }
  if (lock && !lockIsStale(lock)) return { ok: false, lock };
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  return { ok: true };
}
function releaseLock() { try { fs.unlinkSync(LOCK); } catch { /* gone */ } }

// a job = one child process (the existing script) with its own timeout; stdout tail kept for the state
function runJob(job, extra = []) {
  const parts = job.command.split(' ').slice(1); // drop leading "node"
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [...parts, ...extra], { cwd: ROOT, encoding: 'utf8', timeout: 45 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  const tail = out.split('\n').filter(Boolean).slice(-6).join(' | ').slice(0, 900);
  return { status: r.status === 0 ? 'ok' : (r.error && r.error.code === 'ETIMEDOUT' ? 'timeout' : 'error'), code: r.status, ms: Date.now() - t0, tail };
}

async function status(client) {
  const since24 = new Date(Date.now() - 86400000).toISOString(), since7 = new Date(Date.now() - 7 * 86400000).toISOString();
  const [logs, incWindow, incOpen, runs, cases, sources, settings] = await Promise.all([
    all(client, 'source_scan_logs', 'source_id, started_at, finished_at, status, pages_checked, pages_changed, ai_calls, activities_found, new_count, updated_count, duplicate_count, auto_approved_count, failure_kind, listing_metrics', (q) => q.gte('started_at', since24)),
    all(client, 'incoming_activities', 'id, status, match_type, archive_reason, validation_issues, confidence_score, found_at, city:extracted_data->>city, formatted_address:extracted_data->>formatted_address, location_name:extracted_data->>location_name', (q) => q.gte('found_at', since7)),
    all(client, 'incoming_activities', 'id, status, match_type, archive_reason, validation_issues, confidence_score, city:extracted_data->>city, formatted_address:extracted_data->>formatted_address, location_name:extracted_data->>location_name', (q) => q.in('status', ['new', 'needs_review'])),
    all(client, 'cleaner_runs', 'started_at, finished_at, worker, counters, notes', (q) => q.gte('started_at', since24)),
    all(client, 'cleaner_cases', 'issue, status, created_at, resolved_at', (q) => q.or(`created_at.gte.${since7},resolved_at.gte.${since7},status.eq.open`)),
    all(client, 'sources', 'id, name, is_active, health_status, consecutive_failures, last_failure_kind, next_scan_at, strategy, source_kind'),
    client.from('automation_settings').select('key, value').in('key', ['monster_state', 'monster_enabled', 'scanning_enabled', 'cleaner_enabled']).then((r) => Object.fromEntries((r.data || []).map((x) => [x.key, x.value]))),
  ]);
  const { count: reviewed7 } = await client.from('incoming_activities').select('id', { count: 'exact', head: true }).gte('reviewed_at', since7);
  const sum = (arr, k) => arr.reduce((n, x) => n + (Number(x[k]) || 0), 0);
  const finishedRuns = runs.filter((r) => r.finished_at);
  const cSum = (k) => finishedRuns.reduce((n, r) => n + (Number(r.counters?.[k]) || 0), 0);
  const state = settings.monster_state || {};
  const lastCycle = state._cycle?.finishedAt || null;
  const failing = sources.filter((s) => s.is_active && ['failing', 'backed_off', 'attention_required'].includes(s.health_status)).sort((a, b) => (b.consecutive_failures || 0) - (a.consecutive_failures || 0));
  const openCases = cases.filter((c) => c.status === 'open').length;
  const created7 = cases.filter((c) => c.created_at >= since7).length, resolved7 = cases.filter((c) => c.resolved_at && c.resolved_at >= since7).length;
  const budget = reviewBudget({ window: incWindow, openQueue: incOpen, reviewedInWindow: reviewed7 || 0, cleanerResolvedInWindow: resolved7 });
  const report = {
    generatedAt: new Date().toISOString(),
    running: { monster_enabled: settings.monster_enabled !== false, scanning_enabled: settings.scanning_enabled !== false, cleaner_enabled: settings.cleaner_enabled !== false, lastLocalCycle: lastCycle, lastScan: logs.map((l) => l.started_at).sort().pop() || null, jobs: Object.fromEntries(Object.entries(state).filter(([k]) => !k.startsWith('_'))) },
    last24h: { scans: logs.length, scansOk: logs.filter((l) => l.status === 'success').length, scansPartial: logs.filter((l) => l.status === 'partial').length, scansFailed: logs.filter((l) => l.status === 'error').length, aiCalls: sum(logs, 'ai_calls'), pagesChecked: sum(logs, 'pages_checked'), pagesChanged: sum(logs, 'pages_changed'), candidatesFound: sum(logs, 'activities_found'), newCandidates: sum(logs, 'new_count'), updates: sum(logs, 'updated_count'), duplicatesAvoided: sum(logs, 'duplicate_count'), autoPublished: sum(logs, 'auto_approved_count'), outsideServiceAreaBlocked: logs.reduce((n, l) => n + (Number(l.listing_metrics?.outside_service_area) || 0) + (Number(l.listing_metrics?.skipped_outside_service_area) || 0), 0), cleanerRuns: finishedRuns.length, cleanerInspected: cSum('inspected'), cleanerResolved: cSum('resolved'), cleanerArchived: cSum('archived'), cleanerWriteDenied: cSum('writeDenied'), cleanerErrors: cSum('errors') },
    backlog: { openCleanerCases: openCases, casesCreated7d: created7, casesResolved7d: resolved7, trend: created7 > resolved7 ? 'increasing' : 'decreasing', reviewQueueOpen: incOpen.length, reviewInflow7d: budget.inflow, reviewOutflow7d: budget.outflow, humanOnlyOpen: budget.humanOnly, reviewBuckets: budget.open, weekBuckets: budget.perCycle, signals: budget.signals },
    sources: { active: sources.filter((s) => s.is_active).length, healthy: sources.filter((s) => s.is_active && s.health_status === 'healthy').length, failing: failing.length, paused: sources.filter((s) => s.health_status === 'auto_paused').length, relay: sources.filter((s) => s.is_active && s.strategy === 'local_relay').length, dueNow: sources.filter((s) => s.is_active && s.next_scan_at && s.next_scan_at <= new Date().toISOString()).length, repeatedlyFailing: failing.slice(0, 10).map((s) => ({ name: s.name, failures: s.consecutive_failures, kind: s.last_failure_kind, health: s.health_status })) },
    gaps: (() => { try { const files = fs.readdirSync(ROOT).filter((f) => /^coverage-report-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); const j = JSON.parse(fs.readFileSync(path.join(ROOT, files[files.length - 1]), 'utf8')); return { from: files[files.length - 1], count: (j.gaps || []).length, top: (j.gaps || []).filter((g) => g.severity === 'high').slice(0, 8).map((g) => g.message) }; } catch { return { from: null, count: null, top: [] }; } })(),
  };
  fs.writeFileSync(path.join(ROOT, 'monster-status.json'), JSON.stringify(report, null, 2));
  const r = report;
  console.log(`MONSTER ${r.running.monster_enabled ? 'ENABLED' : 'PAUSED'} | scanning ${r.running.scanning_enabled ? 'on' : 'OFF'} | cleaner ${r.running.cleaner_enabled ? 'on' : 'OFF'} | last local cycle ${r.running.lastLocalCycle || 'never'} | last scan ${r.running.lastScan || 'none in 24 h'}`);
  console.log(`24h: scans ${r.last24h.scans} (ok ${r.last24h.scansOk}, partial ${r.last24h.scansPartial}, failed ${r.last24h.scansFailed}) | AI calls ${r.last24h.aiCalls} | candidates ${r.last24h.candidatesFound} (new ${r.last24h.newCandidates}, updates ${r.last24h.updates}, dup avoided ${r.last24h.duplicatesAvoided}) | published ${r.last24h.autoPublished} | outside service area ${r.last24h.outsideServiceAreaBlocked} | Cleaner runs ${r.last24h.cleanerRuns}: resolved ${r.last24h.cleanerResolved}, archived ${r.last24h.cleanerArchived}, denied ${r.last24h.cleanerWriteDenied}, errors ${r.last24h.cleanerErrors}`);
  console.log(`backlog: Cleaner open ${r.backlog.openCleanerCases} (7d +${r.backlog.casesCreated7d}/-${r.backlog.casesResolved7d}, ${r.backlog.trend}) | review open ${r.backlog.reviewQueueOpen} (inflow ${r.backlog.reviewInflow7d} / outflow ${r.backlog.reviewOutflow7d}, human-only ${r.backlog.humanOnlyOpen}) | signals ${r.backlog.signals.map((s) => s.code).join(',') || 'none'}`);
  console.log(`sources: active ${r.sources.active}, healthy ${r.sources.healthy}, failing ${r.sources.failing}, paused ${r.sources.paused}, relay ${r.sources.relay}, due now ${r.sources.dueNow} | repeatedly failing: ${r.sources.repeatedlyFailing.slice(0, 5).map((s) => s.name + ' x' + s.failures).join('; ')}`);
  console.log(`gaps (${r.gaps.from || 'no coverage report'}): ${r.gaps.count ?? '-'} | ${r.gaps.top.slice(0, 3).join(' | ')}`);
  return report;
}

async function cycle(client) {
  const enabled = (await readSetting(client, 'monster_enabled', true)) !== false;
  const state = (await readSetting(client, 'monster_state', {})) || {};
  const jobs = selectJobs({ state, only: args.job ? String(args.job) : null, enabled: enabled || DRY });
  console.log(`${DRY ? 'DRY RUN - ' : ''}monster cycle: enabled=${enabled} due jobs: ${jobs.map((j) => j.id + '(max ' + (j.maxWork ?? '-') + ')').join(', ') || 'none'}`);
  if (DRY) { for (const j of jobs) console.log(`  would run: ${j.command}  | every ${j.everyHours} h | last ${state[j.id]?.lastRunAt || 'never'} | ${j.reason}`); return { dryRun: true, jobs: jobs.map((j) => j.id) }; }
  if (!enabled) return { paused: true };
  const lock = acquireLock(); if (!lock.ok) { console.log('another Monster cycle holds the lock (pid ' + lock.lock.pid + ' since ' + lock.lock.at + ') - refusing to overlap'); return { overlapped: true }; }
  const startedAt = new Date().toISOString();
  try {
    for (const j of jobs) {
      console.log(`--- ${j.id}: ${j.command}`);
      let res;
      try { res = runJob(j); } catch (e) { res = { status: 'error', tail: (e.message || String(e)).slice(0, 300), ms: 0 }; }
      state[j.id] = { lastRunAt: new Date().toISOString(), lastStatus: res.status, lastMs: res.ms, lastTail: res.tail };
      console.log(`    -> ${res.status} in ${Math.round(res.ms / 1000)} s | ${res.tail.slice(0, 200)}`);
      await writeSetting(client, 'monster_state', { ...state, _cycle: { startedAt, heartbeatAt: new Date().toISOString() } });
    }
    state._cycle = { startedAt, finishedAt: new Date().toISOString(), jobs: jobs.map((j) => j.id) };
    await writeSetting(client, 'monster_state', state);
  } finally { releaseLock(); }
  return { ran: jobs.map((j) => j.id) };
}

(async () => {
  const { client } = await getClient();
  if (cmd === 'status') await status(client);
  else if (cmd === 'cycle') { await cycle(client); if (!DRY) await status(client); }
  else if (cmd === 'pause') { await writeSetting(client, 'monster_enabled', false); console.log('monster_enabled=false (local jobs paused; pg_cron scanning unchanged - set scanning_enabled=false to pause scans)'); }
  else if (cmd === 'resume') { await writeSetting(client, 'monster_enabled', true); console.log('monster_enabled=true'); }
  else if (cmd === 'install-task') { console.log('NOT executed - copy to an elevated prompt after approval:'); console.log(schedulerCommand({ root: ROOT, everyMinutes: Number(args.every || 60) })); console.log('pause: ' + pauseCommand(ROOT)); console.log('remove: schtasks /Delete /TN "TuRu Monster" /F'); }
  else throw new Error('unknown command ' + cmd);
})().catch((e) => { console.error(e); process.exit(1); });
