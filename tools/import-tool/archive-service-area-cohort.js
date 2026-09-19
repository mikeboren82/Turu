// TuRu - SERVICE AREA: archive the APPROVED historical cohort (Phase D, 2026-09-19). Dry run by default.
// Input: the audit report (service-area-audit-<date>.json) - only rows classified A_CONFIRMED_OUTSIDE_SERVICE_AREA
// AND flagged in_cohort_37 (the approved set); every other class / cohort is never touched. Immediately before each
// write the row is re-classified from its CURRENT coordinates (city hint + cached reverse) and must still be OUTSIDE.
// Lifecycle: the same verified activity write the Cleaner uses (status approved -> archived, archive_reason =
// outside_service_area, archived_at; write_denied is recorded, never bypassed) + the Cleaner case closes with the same
// reason (its earlier resolution is kept inside the new resolution as `previous`). Nothing is deleted.
//   node archive-service-area-cohort.js [--apply] [--audit=service-area-audit-2026-09-19.json]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { loadSettlementIndex } = require('./lib/canonicalSettlement');
const { classifyServiceArea } = require('./lib/serviceArea');
const { applyActivityPatch, deniedError } = require('./cleaner/apply');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const APPLY = !!args.apply;
const AUDIT = path.join(__dirname, String(args.audit || 'service-area-audit-2026-09-19.json'));
const CACHE = path.join(__dirname, 'logs', 'reverse-cache.json');

function cachedReverse(lat, lng) {
  try { const c = JSON.parse(fs.readFileSync(CACHE, 'utf8')); const k = `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`; const r = c[k]?.r; if (!r) return null; const a = r.address || {};
    return { countryCode: a.country_code || null, state: a.state || null, localities: ['city', 'town', 'village', 'municipality', 'suburb', 'hamlet'].filter((f) => a[f]).map((f) => ({ field: f, value: a[f] })) }; } catch { return null; }
}

(async () => {
  const audit = JSON.parse(fs.readFileSync(AUDIT, 'utf8'));
  const approved = audit.rows.filter((r) => r.klass === 'A_CONFIRMED_OUTSIDE_SERVICE_AREA' && r.in_cohort_37 === true);
  const { client } = await getClient();
  const index = await loadSettlementIndex(client);
  const now = new Date().toISOString();
  const out = []; const dist = {};
  console.log(`approved cohort rows ${approved.length} | ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  for (const r of approved) {
    const rec = { activity_id: r.activity_id, name: r.name, stored_city: r.stored_city, audit_reason: r.reason };
    const { data: a, error } = await client.from('activities').select('id, name, status, archive_reason, locations(city, lat, lng)').eq('id', r.activity_id).maybeSingle();
    if (error || !a) { rec.outcome = 'not_found'; rec.error = error?.message; out.push(rec); dist[rec.outcome] = (dist[rec.outcome] || 0) + 1; console.log('  NOT FOUND', r.activity_id); continue; }
    if (a.status !== 'approved') { rec.outcome = 'skipped_not_published'; rec.status = a.status; out.push(rec); dist[rec.outcome] = (dist[rec.outcome] || 0) + 1; console.log('  skip (status ' + a.status + ')', a.name); continue; }
    const L = a.locations || {};
    const v = classifyServiceArea({ lat: L.lat, lng: L.lng }, { index, reverse: cachedReverse(L.lat, L.lng), cityHint: L.city || null });
    rec.now = { lat: L.lat, lng: L.lng, klass: v.klass, reason: v.reason, evidence: v.evidence };
    if (v.klass !== 'OUTSIDE_SERVICE_AREA') { rec.outcome = 'skipped_reclassified_' + v.klass; out.push(rec); dist[rec.outcome] = (dist[rec.outcome] || 0) + 1; console.log('  SKIP - now ' + v.klass + ':', a.name, '|', v.reason); continue; }
    if (!APPLY) { rec.outcome = 'dry:would_archive'; out.push(rec); dist[rec.outcome] = (dist[rec.outcome] || 0) + 1; console.log('  would archive', a.name, '|', v.reason.slice(0, 80)); continue; }
    const w = await applyActivityPatch(client, a.id, { status: 'archived', archive_reason: 'outside_service_area', archived_at: now }, (q) => q.eq('status', 'approved'), (row) => row.status === 'approved');
    if (!w.wrote && w.why === 'write_denied') { rec.outcome = 'write_denied'; rec.error = deniedError('activities', ['status']); out.push(rec); dist[rec.outcome] = (dist[rec.outcome] || 0) + 1; console.log('  WRITE_DENIED', a.name); continue; }
    if (!w.wrote) { rec.outcome = 'not_written'; rec.why = w.why; out.push(rec); dist[rec.outcome] = (dist[rec.outcome] || 0) + 1; console.log('  not written (' + w.why + ')', a.name); continue; }
    // the Cleaner case closes with the same reason; its earlier resolution stays inside the new one
    const { data: cases } = await client.from('cleaner_cases').select('id, status, archive_reason, resolution').eq('subject_id', a.id).eq('issue', 'city_not_canonical');
    for (const c of cases || []) {
      await client.from('cleaner_cases').update({ status: 'archived', archive_reason: 'outside_service_area', last_attempt_at: now, resolution: { outcome: 'archived', reason: 'outside_service_area', note: 'SERVICE AREA (approved historical cohort, Phase D 2026-09-19): ' + v.reason, service_area: v, previous: c.resolution || null, previous_archive_reason: c.archive_reason || null } }).eq('id', c.id);
    }
    rec.outcome = 'archived'; rec.cases_closed = (cases || []).length; out.push(rec); dist[rec.outcome] = (dist[rec.outcome] || 0) + 1; console.log('  archived', a.name, '| cases closed', (cases || []).length);
  }
  const file = path.join(__dirname, `service-area-cohort-${new Date().toISOString().slice(0, 10)}${APPLY ? '-applied' : '-dryrun'}.json`);
  fs.writeFileSync(file, JSON.stringify({ generatedAt: now, applied: APPLY, audit: path.basename(AUDIT), distribution: dist, rollback: "update activities set status='published', archive_reason=null, archived_at=null where id = any(<ids>) and archive_reason='outside_service_area' -- and reopen the cleaner_cases with resolution.previous", rows: out }, null, 2));
  console.log(JSON.stringify(dist), '->', path.basename(file));
})().catch((e) => { console.error(e); process.exit(1); });
