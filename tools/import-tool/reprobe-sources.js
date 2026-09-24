// TuRu - CONTINUOUS MONSTER: monthly re-probe of paused / 403-blocked sources from the LOCAL IP (read-only by
// default). A source the edge runtime cannot reach but the admin machine can is a relay candidate; a source that is
// gone (404) stays paused. --apply flips only `strategy='local_relay'` + `is_active=true` for sources that answered
// 200 locally with Hebrew content, at most --max per run, never touches trust or health counters.
//   node reprobe-sources.js [--max=30] [--apply]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { all } = require('./cleaner/discover');
const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const MAX = Number(args.max || 30); const APPLY = !!args.apply;
const UA = 'Mozilla/5.0 (compatible; TuruBot/1.0)';
(async () => {
  const { client } = await getClient();
  const sources = await all(client, 'sources', 'id, name, seed_url, strategy, is_active, health_status, last_failure_kind, consecutive_failures, priority, source_kind', (q) => q.or('health_status.eq.auto_paused,and(health_status.eq.failing,last_failure_kind.eq.access_403_waf),and(health_status.eq.backed_off,last_failure_kind.eq.access_403_waf)'));
  const pick = sources.filter((s) => !['facebook', 'instagram'].includes(s.source_kind) && s.strategy !== 'local_relay').slice(0, MAX);
  console.log(`candidates ${sources.length} | probing ${pick.length} | ${APPLY ? 'APPLY' : 'report only'}`);
  const rows = []; const dist = {};
  for (const s of pick) {
    let verdict, status = null, hebrew = 0;
    try { const r = await fetch(s.seed_url, { headers: { 'User-Agent': UA, 'Accept-Language': 'he-IL,he;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(20000) }); status = r.status; const t = (await r.text()).replace(/<[^>]+>/g, ' '); hebrew = (t.match(/[֐-׿]/g) || []).length; verdict = r.status === 404 || r.status === 410 ? 'gone' : r.ok && hebrew >= 100 ? 'reachable_locally' : r.ok ? 'reachable_no_content' : 'blocked_locally'; }
    catch (e) { verdict = 'unreachable_locally'; }
    dist[verdict] = (dist[verdict] || 0) + 1;
    const row = { id: s.id, name: s.name, seed_url: s.seed_url, health: s.health_status, failure: s.last_failure_kind, status, hebrew, verdict, proposal: verdict === 'reachable_locally' ? 'strategy=local_relay + reactivate' : verdict === 'gone' ? 'keep paused (gone)' : 'keep' };
    if (APPLY && verdict === 'reachable_locally') { const { data } = await client.from('sources').update({ strategy: 'local_relay', is_active: true, disabled_reason: null, consecutive_failures: 0, health_status: 'healthy', next_scan_at: new Date().toISOString() }).eq('id', s.id).eq('strategy', s.strategy).select('id'); row.applied = !!(data && data.length); }
    rows.push(row); console.log(`  ${verdict.padEnd(22)} ${String(s.name).slice(0, 36).padEnd(36)} ${s.health_status}/${s.last_failure_kind || '-'} -> HTTP ${status} ${hebrew} he | ${row.proposal}${row.applied ? ' APPLIED' : ''}`);
    await new Promise((r) => setTimeout(r, 800));
  }
  const file = path.join(__dirname, `reprobe-sources-${new Date().toISOString().slice(0, 10)}${APPLY ? '-applied' : ''}.json`);
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), applied: APPLY, distribution: dist, rows }, null, 2));
  console.log(JSON.stringify(dist), '->', path.basename(file));
})().catch((e) => { console.error(e); process.exit(1); });
