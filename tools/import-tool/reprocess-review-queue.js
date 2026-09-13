// TuRu - re-evaluate the pending review queue under the CURRENT auto-publish policy and act on the
// clear cases, so the humans only see the ambiguous ones (platform brief: "routine ingestion is
// automatic"). Items were queued by older scanner versions (e.g. before 'מחיר' became a soft flag,
// before the audience field) - this applies today's rules to them:
//   approve  : match_type=new, trusted source (is_trusted or trust >= auto_approve_min_trust_score),
//              gating issues empty (only 'מחיר' allowed), one-time date within [today, +N days],
//              child relevance 'ok'  -> POST /api/incoming/:id/approve (same path as the admin button:
//              venue resolution, provenance, fingerprint, Places-shape mapping)
//   reject   : child relevance 'reject' (adult content) or one-time date already past
//   leave    : everything else stays for a human
//   node reprocess-review-queue.js [--apply] [--limit=N]
require('dotenv').config();
const { getClient } = require('./supabase');
const { assessChildRelevance } = require('./childRelevance');

const APPLY = process.argv.includes('--apply');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || Infinity;
const BASE = 'http://localhost:4321';
const SOFT = new Set(['מחיר']);

(async () => {
  const { client, userId } = await getClient();
  const { data: settingsRows } = await client.from('automation_settings').select('key, value');
  const settings = Object.fromEntries((settingsRows || []).map((r) => [r.key, r.value]));
  const minTrust = Number(settings.auto_approve_min_trust_score ?? 80);
  const maxDays = Number(settings.event_max_days_ahead ?? 180);
  const today = new Date().toISOString().slice(0, 10);
  const maxDate = new Date(Date.now() + maxDays * 86400000).toISOString().slice(0, 10);

  let rows = [], from = 0;
  while (true) {
    const { data, error } = await client.from('incoming_activities')
      .select('id, match_type, status, validation_issues, extracted_data, source:sources(id, name, is_trusted, source_trust_score)')
      .in('status', ['new', 'needs_review']).eq('match_type', 'new').order('found_at', { ascending: true }).range(from, from + 999);
    if (error) throw error;
    rows = rows.concat(data); if (data.length < 1000) break; from += 1000;
  }
  console.log(`pending 'new' items: ${rows.length} (${APPLY ? 'APPLY' : 'DRY RUN'}, trust>=${minTrust}, dates<=${maxDate})`);

  // Dedup pre-check: the scanner computed event_fingerprint at scan time; if an activity with that
  // fingerprint exists NOW (e.g. approved from another source since), approving would create a
  // duplicate - such items stay for a human to link/reject.
  const fps = [...new Set(rows.map((r) => r.extracted_data?.event_fingerprint).filter(Boolean))];
  const existingFp = new Set();
  for (let i = 0; i < fps.length; i += 150) {
    const { data } = await client.from('activities').select('event_fingerprint').in('event_fingerprint', fps.slice(i, i + 150));
    (data || []).forEach((a) => existingFp.add(a.event_fingerprint));
  }

  const plan = { approve: [], reject: [], leave: 0 };
  const leaveReasons = {};
  for (const r of rows) {
    const c = r.extracted_data || {};
    const rel = assessChildRelevance(c);
    if (c.event_fingerprint && existingFp.has(c.event_fingerprint)) { plan.leave++; leaveReasons['fingerprint already in activities'] = (leaveReasons['fingerprint already in activities'] || 0) + 1; continue; }
    const past = c.schedule_type === 'one_time' && c.one_time_date && c.one_time_date < today;
    if (rel === 'reject') { plan.reject.push({ id: r.id, reason: 'קהל יעד למבוגרים (בדיקת רלוונטיות לילדים)' }); continue; }
    if (past) { plan.reject.push({ id: r.id, reason: 'אירוע חד-פעמי שתאריכו עבר' }); continue; }
    const trusted = !!r.source?.is_trusted || (r.source?.source_trust_score != null && Number(r.source.source_trust_score) >= minTrust);
    // a possible-duplicate flag is a gating issue - never auto-approve over it
    const gating = (r.validation_issues || []).filter((i) => !SOFT.has(i));
    const dateOk = c.schedule_type !== 'one_time' || (c.one_time_date && c.one_time_date >= today && c.one_time_date <= maxDate);
    const hasPlace = !!(c.city && (c.location_name || c.formatted_address));
    if (trusted && gating.length === 0 && dateOk && hasPlace && rel === 'ok') { plan.approve.push({ id: r.id, name: c.name, src: r.source?.name, fp: c.event_fingerprint || null }); continue; }
    plan.leave++;
    const why = !trusted ? 'untrusted source' : gating.length ? 'issues: ' + gating.join(',') : !dateOk ? 'date not plausible' : !hasPlace ? 'no place' : 'relevance ' + rel;
    leaveReasons[why] = (leaveReasons[why] || 0) + 1;
  }
  console.log(`plan: approve ${plan.approve.length}, reject ${plan.reject.length}, leave ${plan.leave}`);
  console.log('leave reasons:', leaveReasons);
  console.log('approve sample:', plan.approve.slice(0, 8).map((a) => `${a.name} [${a.src}]`).join(' | '));
  if (!APPLY) return;

  let ok = 0, dup = 0, fail = 0;
  // within-batch twins (two queue rows, same fingerprint) are NOT skipped: the approve endpoint's
  // fingerprint guard turns the second one into a linked duplicate (409 + provenance) instead of
  // leaving it in the queue
  for (const a of plan.approve.slice(0, LIMIT)) {
    try {
      const res = await fetch(`${BASE}/api/incoming/${a.id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      if (res.status === 409) dup++; else if (!res.ok) { fail++; console.log('  approve failed:', a.name, (await res.json()).error); } else ok++;
    } catch (e) { fail++; console.log('  approve error:', a.name, e.message); }
  }
  let rej = 0;
  for (const rj of plan.reject) {
    const { error } = await client.from('incoming_activities').update({ status: 'rejected', reject_reason: rj.reason + ' (סבב חוזר של תור הבדיקה)', reviewed_by: userId, reviewed_at: new Date().toISOString() }).eq('id', rj.id);
    if (!error) rej++;
  }
  console.log(`applied: approved ${ok}, duplicates linked ${dup}, failed ${fail}, rejected ${rej}`);
})().catch((e) => { console.error(e); process.exit(1); });
