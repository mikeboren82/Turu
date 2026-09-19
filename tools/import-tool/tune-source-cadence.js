// TuRu - CONTINUOUS MONSTER: evidence-based scan cadence (lib/sourceCadence.js) applied to the registry.
// Dry run by default: prints the plan + expected scans/day. --apply writes scan_frequency_hours only (never health,
// next_scan_at or activation), value-guarded on the current frequency, at most --max changes per run.
//   node tune-source-cadence.js [--apply] [--max=40]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { all } = require('./cleaner/discover');
const { cadencePlan, expectedScansPerDay } = require('./lib/sourceCadence');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const APPLY = !!args.apply; const MAX = Number(args.max || 40); const BUDGET = Number(args.budget || 60); // expected scans/day ceiling (AI cost)

(async () => {
  const { client } = await getClient();
  const sources = await all(client, 'sources', 'id, name, source_kind, publisher_type, is_active, health_status, scan_frequency_hours');
  const logs = await all(client, 'source_scan_logs', 'source_id, status, pages_checked, pages_changed, new_count, updated_count, auto_approved_count', (q) => q.gte('started_at', new Date(Date.now() - 30 * 86400000).toISOString()));
  const y = {};
  for (const l of logs) { const e = (y[l.source_id] ||= { scans: 0, ok: 0, pages: 0, changed: 0, new_c: 0, upd: 0, auto: 0 }); e.scans++; if (l.status !== 'error') e.ok++; e.pages += l.pages_checked || 0; e.changed += l.pages_changed || 0; e.new_c += l.new_count || 0; e.upd += l.updated_count || 0; e.auto += l.auto_approved_count || 0; }
  const plan = cadencePlan(sources, y, { budgetScansPerDay: BUDGET });
  const changes = plan.filter((p) => p.change);
  const before = Math.round(plan.reduce((n, p) => n + (p.current ? 24 / p.current : 0), 0) * 10) / 10;
  console.log(`active non-social sources ${plan.length} | changes ${changes.length} | expected scans/day ${before} -> ${expectedScansPerDay(plan)} | ${APPLY ? 'APPLY max ' + MAX : 'DRY RUN'}`);
  const byK = {}; for (const p of plan) { const k = p.klass + ':' + p.proposed; byK[k] = (byK[k] || 0) + 1; } console.log('proposed cadence classes', JSON.stringify(byK));
  let applied = 0;
  for (const p of changes.slice(0, APPLY ? MAX : 0)) {
    const { data, error } = await client.from('sources').update({ scan_frequency_hours: p.proposed }).eq('id', p.source_id).eq('scan_frequency_hours', p.current).select('id');
    if (error) { p.error = error.message; continue; }
    if (data && data.length) { applied++; p.applied = true; }
  }
  for (const p of changes.slice(0, 40)) console.log(`  ${String(p.name).slice(0, 34).padEnd(34)} ${p.klass.padEnd(7)} ${String(p.current).padStart(4)}h -> ${String(p.proposed).padStart(4)}h ${p.applied ? 'APPLIED' : ''} | ${p.why}`);
  const file = path.join(__dirname, `source-cadence-${new Date().toISOString().slice(0, 10)}${APPLY ? '-applied' : '-dryrun'}.json`);
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), applied: APPLY, changes: changes.length, written: applied, expectedScansPerDayBefore: before, expectedScansPerDayAfter: expectedScansPerDay(plan), plan }, null, 2));
  console.log(`written ${applied} ->`, path.basename(file));
})().catch((e) => { console.error(e); process.exit(1); });
