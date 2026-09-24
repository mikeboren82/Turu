// TuRu - CONTINUOUS MONSTER: per-cycle metrics from durable data (source_scan_logs, cleaner_runs, incoming_activities,
// sources, automation_settings.monster_state, logs/monster.log). Read-only. Used to review pilot cycles in any session.
//   node monster-cycle-report.js [--since=ISO] [--until=ISO] [--log=logs/monster.log]
// Without --since: the last cycle recorded in logs/monster.log ("===== <date> <time> =====" header, local time).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const LOG = path.join(__dirname, String(args.log || 'logs/monster.log'));

// "===== 19/09/2026 21:49:54.31 =====" (Windows %date% %time%, dd/MM/yyyy local) -> Date
function headerDate(line) { const m = line.match(/=====\s+(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/); return m ? new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}`) : null; }
function cyclesFromLog() {
  let lines = []; try { lines = fs.readFileSync(LOG, 'utf8').split(/\r?\n/); } catch { return []; }
  const cycles = []; let cur = null;
  for (const l of lines) {
    const d = headerDate(l); if (d) { cur = { startedAt: d, jobs: [], lines: [], overlapped: false, finished: false }; cycles.push(cur); continue; }
    if (!cur) continue; cur.lines.push(l);
    const j = l.match(/^--- (\w+): /); if (j) cur.jobs.push(j[1]);
    if (/refusing to overlap/.test(l)) cur.overlapped = true;
    if (/^MONSTER (ENABLED|PAUSED)/.test(l)) cur.finished = true;
  }
  return cycles;
}
const sum = (rows, f) => rows.reduce((n, r) => n + (Number(f(r)) || 0), 0);

(async () => {
  const cycles = cyclesFromLog(); const last = cycles[cycles.length - 1];
  const since = args.since ? new Date(String(args.since)) : last?.startedAt; if (!since) { console.log('no cycle found'); return; }
  const until = args.until ? new Date(String(args.until)) : new Date();
  const { client } = await getClient();
  const iso = (d) => d.toISOString();
  const { data: state } = await client.from('automation_settings').select('value').eq('key', 'monster_state').maybeSingle();
  const st = state?.value || {};
  const { data: scans } = await client.from('source_scan_logs').select('source_id, started_at, finished_at, status, pages_checked, ai_calls, new_count, updated_count, auto_approved_count, listing_metrics, sources(name, strategy)').gte('started_at', iso(since)).lte('started_at', iso(until));
  const relay = (scans || []).filter((s) => s.sources?.strategy === 'local_relay'); const cron = (scans || []).filter((s) => s.sources?.strategy !== 'local_relay');
  const lm = (rows, k) => sum(rows, (r) => (r.listing_metrics || {})[k]);
  const scanBlock = (rows) => ({ scans: rows.length, sources: new Set(rows.map((r) => r.source_id)).size, ok: rows.filter((r) => r.status === 'success').length, partial: rows.filter((r) => r.status === 'partial').length, failed: rows.filter((r) => r.status === 'error').length, pages: sum(rows, (r) => r.pages_checked), aiCalls: sum(rows, (r) => r.ai_calls), newCandidates: sum(rows, (r) => r.new_count), updates: sum(rows, (r) => r.updated_count), autoApproved: sum(rows, (r) => r.auto_approved_count), duplicatesAvoided: lm(rows, 'skipped_in_scan_duplicate') + lm(rows, 'skipped_pending_in_queue'), outsideServiceArea: lm(rows, 'outside_service_area') + lm(rows, 'skipped_outside_service_area'), zeroYield: rows.filter((r) => r.status !== 'error' && !(r.new_count || r.updated_count)).length });
  const { data: runs } = await client.from('cleaner_runs').select('started_at, finished_at, mode, counters, notes').gte('started_at', iso(since)).lte('started_at', iso(until));
  const c = (k) => sum(runs || [], (r) => (r.counters || {})[k]);
  const cleaner = { runs: (runs || []).length, inspected: c('inspected') || c('claimed'), resolved: c('resolved'), archived: c('archived'), requiresHumanJudgment: c('requiresHumanJudgment') || c('requires_human_judgment'), writeDenied: c('writeDenied'), errors: c('errors'), reopened: c('reopened'), counters: (runs || []).map((r) => r.counters) };
  const { data: inc } = await client.from('incoming_activities').select('status, match_type, archive_reason').gte('created_at', iso(since)).lte('created_at', iso(until));
  const byStatus = {}; for (const r of inc || []) { const k = r.status + (r.archive_reason ? '/' + r.archive_reason : ''); byStatus[k] = (byStatus[k] || 0) + 1; }
  const { data: disc } = await client.from('sources').select('name, is_active, discovery_batch, region').gte('created_at', iso(since)).lte('created_at', iso(until)).not('discovery_batch', 'is', null);
  const { data: cases } = await client.from('cleaner_cases').select('status, archive_reason').gte('created_at', iso(since)).lte('created_at', iso(until));
  const report = {
    window: { since: iso(since), until: iso(until), minutes: Math.round((until - since) / 60000) },
    cycle: last ? { startedAt: iso(last.startedAt), jobsRun: last.jobs, finished: last.finished, overlapped: last.overlapped } : null,
    jobs: Object.fromEntries(Object.entries(st).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, { lastRunAt: v.lastRunAt, status: v.lastStatus, minutes: v.lastMs ? Math.round(v.lastMs / 6000) / 10 : null, tail: (v.lastTail || '').split('\n').slice(-2).join(' | ').slice(0, 220) }])),
    relayScans: scanBlock(relay), durableScansInWindow: scanBlock(cron),
    cleaner, reviewRowsCreated: { total: (inc || []).length, byStatus }, cleanerCasesCreated: (cases || []).length,
    discoveryRegistered: (disc || []).map((d) => ({ name: d.name, region: d.region, active: d.is_active })),
  };
  console.log(JSON.stringify(report, null, 2));
  const file = path.join(__dirname, 'logs', `monster-cycle-${iso(since).slice(0, 16).replace(/[:T]/g, '-')}.json`);
  try { fs.writeFileSync(file, JSON.stringify(report, null, 2)); console.log('->', path.relative(__dirname, file)); } catch { /* logs dir optional */ }
})().catch((e) => { console.error(e); process.exit(1); });
