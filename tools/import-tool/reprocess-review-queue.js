// TuRu - re-evaluate the pending review queue under the CURRENT auto-publish policy and act on the
// clear cases, so the humans only see the ambiguous ones (platform brief: "routine ingestion is
// automatic"). Since 2026-09-24 the decision is the CANONICAL evaluator (lib/incomingEligibility.js) - the
// same one the admin approve route re-runs at its write boundary and the Cleaner hand-back uses. This tool
// keeps no policy of its own:
//   approve  : decision ELIGIBLE -> POST /api/incoming/:id/approve (mode 'auto': re-evaluated there, then
//              venue resolution, provenance, fingerprint guard, Places-shape mapping)
//   reject   : a terminal relevance_reject (adult content by the relevance rule)
//   leave    : everything else, counted by the evaluator's reason codes. An expired event is left for
//              pending-lifecycle.js (the one owner of expiry); an exact duplicate for the approve guard / a human.
//   node reprocess-review-queue.js [--apply] [--limit=N]
require('dotenv').config();
const { getClient } = require('./supabase');
const { evaluateIncomingRow, loadPolicySettings } = require('./lib/incomingEligibility');

const APPLY = process.argv.includes('--apply');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || Infinity;
const BASE = process.env.ADMIN_BASE || 'http://localhost:4321';

// evaluation -> { action: 'approve' | 'reject' | 'leave', why }
function reprocessAction(ev) {
  if (ev.decision === 'ELIGIBLE') return { action: 'approve', why: 'eligible' };
  if (ev.reasons.some((r) => r.code === 'relevance_reject')) return { action: 'reject', why: 'relevance_reject' };
  return { action: 'leave', why: ev.reasons.map((r) => r.code).sort().join(',') };
}

async function main() {
  const { client, userId } = await getClient();
  const settings = await loadPolicySettings(client);
  const { loadSettlementIndex } = require('./lib/canonicalSettlement');
  let serviceAreaIndex = null; try { serviceAreaIndex = await loadSettlementIndex(client); } catch { serviceAreaIndex = null; }

  let ids = [], from = 0;
  while (true) {
    const { data, error } = await client.from('incoming_activities').select('id')
      .in('status', ['new', 'needs_review']).eq('match_type', 'new').order('found_at', { ascending: true }).range(from, from + 999);
    if (error) throw error;
    ids = ids.concat(data.map((r) => r.id)); if (data.length < 1000) break; from += 1000;
  }
  console.log(`pending 'new' items: ${ids.length} (${APPLY ? 'APPLY' : 'DRY RUN'}, trust>=${settings.minTrust}, horizon ${settings.maxDaysAhead} d)`);

  const plan = { approve: [], reject: [], leave: 0 };
  const leaveReasons = {};
  for (const id of ids) {
    const ev = await evaluateIncomingRow(client, id, { settings, serviceAreaIndex });
    const a = reprocessAction(ev);
    const name = ev.row?.extracted_data?.name;
    if (a.action === 'approve') plan.approve.push({ id, name });
    else if (a.action === 'reject') plan.reject.push({ id, reason: 'קהל יעד למבוגרים (בדיקת רלוונטיות לילדים)' });
    else { plan.leave++; leaveReasons[a.why] = (leaveReasons[a.why] || 0) + 1; }
  }
  console.log(`plan: approve ${plan.approve.length}, reject ${plan.reject.length}, leave ${plan.leave}`);
  console.log('leave reasons:', leaveReasons);
  console.log('approve sample:', plan.approve.slice(0, 8).map((a) => a.name).join(' | '));
  if (!APPLY) return;

  let ok = 0, dup = 0, held = 0, fail = 0;
  for (const a of plan.approve.slice(0, LIMIT)) {
    try {
      const res = await fetch(`${BASE}/api/incoming/${a.id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'auto' }) });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 && body.held) held++; else if (res.status === 409) dup++; else if (!res.ok) { fail++; console.log('  approve failed:', a.name, body.error); } else ok++;
    } catch (e) { fail++; console.log('  approve error:', a.name, e.message); }
  }
  let rej = 0;
  for (const rj of plan.reject) {
    const { data, error } = await client.from('incoming_activities').update({ status: 'rejected', reject_reason: rj.reason + ' (סבב חוזר של תור הבדיקה)', reviewed_by: userId, reviewed_at: new Date().toISOString() })
      .eq('id', rj.id).in('status', ['new', 'needs_review']).select('id');
    if (!error && data && data.length) rej++;
  }
  console.log(`applied: approved ${ok}, duplicates linked ${dup}, held at the approve boundary ${held}, failed ${fail}, rejected ${rej}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { reprocessAction };
