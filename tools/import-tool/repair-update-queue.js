// TuRu - THE CLEANER: one-time repair of the pending UPDATE review queue (wave 2, 2026-09-17).
// scan-source used to manufacture update rows from non-changes ("17:00:00" vs "17:00", a reworded
// model summary, a place label contained in the other, an identity-only backfill) and stacked a new row
// per rescan. The scanner is fixed (_shared/matching.ts, scan-source supersede); this closes what it left:
//   NO_GAIN      every entry of the stored diff is a non-change under the corrected rules
//                -> status 'duplicate' (the row and its original diff stay in the table; nothing is deleted)
//   SUPERSEDED   an older pending row of the same (activity, source) - the newest one stays for review
//   MISASSOCIATED the row came from "same listing URL + genre-word overlap" identity and the candidate's
//                place AND dates contradict the activity (or no distinctive title word is shared):
//                it is NOT an update of that activity -> detached into a reviewable NEW candidate
//   KEEP         a real change, untouched (its diff is never rewritten)
// An identity-only diff also writes activities.event_key fill-null (the same backfill scan-source now does).
// Deterministic rules only, status guard on every write, dry run by default:
//   node repair-update-queue.js            report
//   node repair-update-queue.js --apply    apply
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { all } = require('./cleaner/discover');
const { wordOverlapScore, distinctiveSharedWords, computeConfidence, getConfidenceThresholds, mapExistingRow } = require('./cleaner/matching');
const { normalizeForMatch } = require('./eventFingerprint');

const APPLY = process.argv.includes('--apply');
const hhmm = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t ?? '').trim()); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null; };
const fold = (t) => normalizeForMatch(t).replace(/[׳״]/g, '').replace(/יי/g, 'י').replace(/וו/g, 'ו');
const sameLabel = (a, b) => { const x = fold(a), y = fold(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };

// -> the entries of a stored diff that are still a change under the corrected rules
function realChanges(diff) {
  const out = {};
  for (const [k, e] of Object.entries(diff || {})) {
    if (!e || e.after == null) continue;
    if ((k === 'start_time' || k === 'end_time') && e.before != null && hhmm(e.before) === hhmm(e.after)) continue;
    if (k === 'description' && String(e.before || '').trim() && wordOverlapScore(e.before, e.after) >= 0.5) continue;
    if (k === 'location_name' && sameLabel(e.before, e.after)) continue;
    out[k] = e;
  }
  return out;
}
const identityOnly = (d) => { const k = Object.keys(d); return k.length === 1 && k[0] === 'event_key' && d.event_key.before == null; };

(async () => {
  const { client } = await getClient();
  const rows = await all(client, 'incoming_activities', 'id, source_id, existing_activity_id, found_at, confidence_score, confidence_breakdown, diff, page_url, extracted_data', (q) => q.eq('match_type', 'update').eq('status', 'needs_review'));
  const { data: settingsRows } = await client.from('automation_settings').select('key, value');
  const thresholds = getConfidenceThresholds(Object.fromEntries((settingsRows || []).map((r) => [r.key, r.value])));
  const plan = []; const counts = { KEEP: 0, NO_GAIN: 0, SUPERSEDED: 0, MISASSOCIATED: 0, identityBackfill: 0 };
  // 1. classify each row on its own
  for (const r of rows) {
    const real = realChanges(r.diff);
    let klass = 'KEEP', why = null;
    if (!Object.keys(real).length) { klass = 'NO_GAIN'; why = 'every diff entry is a non-change (time format / reworded summary / same place label)'; }
    else if (identityOnly(real)) { klass = 'NO_GAIN'; why = 'identity-only backfill'; }
    plan.push({ row: r, klass, why, real });
  }
  // 2. association: only rows that were matched through URL identity (score 0.95, exact_url_match) are re-judged
  const needExisting = plan.filter((p) => p.klass === 'KEEP' && Number(p.row.confidence_score) === 0.95 && p.row.confidence_breakdown?.exact_url_match === 1 && !p.row.confidence_breakdown?.fingerprint_match);
  for (const p of needExisting) {
    const { data: a } = await client.from('activities').select('id, name, name_source, description, category, entity_type, min_age, max_age, price_type, price_amount, booking_requirement, source_url, venue_id, event_fingerprint, event_key, event_key_kind, official_url, source_id, location:locations!inner(name, city, lat, lng, address, address_source), activity_schedules(schedule_type, one_time_date, start_time, end_time, day_of_week), activity_images(url)').eq('id', p.row.existing_activity_id).maybeSingle();
    if (!a) continue;
    const ed = p.row.extracted_data || {};
    const cand = { name: ed.name, city: ed.city, location_name: ed.location_name || null, pageUrl: p.row.page_url, venue_id: ed.venue_id || null, lat: ed.lat ?? null, lng: ed.lng ?? null, one_time_date: ed.one_time_date || null, occurrences: ed.occurrences || null, recurring_days: ed.recurring_days || [], event_fingerprint: ed.event_fingerprint || null };
    const today = new Date().toISOString().slice(0, 10);
    const c = computeConfidence(cand, mapExistingRow(a, today), thresholds);
    if (c.score < thresholds.needsReview) { p.klass = 'MISASSOCIATED'; p.why = `URL identity no longer holds (score ${c.score}; distinctive title words ${c.breakdown.distinctive_name}, place+dates contradiction ${c.breakdown.association_conflict}): "${ed.name}" is not "${a.name}"`; p.existingName = a.name;
      // where does the detached candidate belong? already live as its own activity -> duplicate of THAT one;
      // a one-time date already past -> expired; otherwise a reviewable NEW candidate
      const today2 = new Date().toISOString().slice(0, 10);
      let live = null;
      if (ed.event_key) { const { data } = await client.from('activities').select('id').eq('event_key', ed.event_key).eq('status', 'approved').limit(1).maybeSingle(); live = data?.id || null; }
      if (!live && ed.event_fingerprint) { const { data } = await client.from('activities').select('id').eq('event_fingerprint', ed.event_fingerprint).eq('status', 'approved').limit(1).maybeSingle(); live = data?.id || null; }
      const dates = Array.isArray(ed.occurrences) && ed.occurrences.length ? ed.occurrences.map((o) => o.date) : (ed.one_time_date ? [ed.one_time_date] : []);
      p.detachTo = live ? { kind: 'duplicate_of', id: live } : (ed.schedule_type === 'one_time' && dates.length && dates.every((d) => d < today2)) ? { kind: 'expired' } : { kind: 'new' };
    }
  }
  // 3. stacks: newest KEEP row per (activity, source) stays
  const groups = new Map();
  for (const p of plan.filter((x) => x.klass === 'KEEP')) { const k = `${p.row.existing_activity_id}|${p.row.source_id}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
  for (const g of groups.values()) { g.sort((a, b) => new Date(b.row.found_at) - new Date(a.row.found_at)); g.slice(1).forEach((p) => { p.klass = 'SUPERSEDED'; p.why = 'superseded by newer pending update ' + g[0].row.id; }); }
  for (const p of plan) counts[p.klass]++;

  if (APPLY) {
    const now = new Date().toISOString();
    for (const p of plan) {
      const guard = (q) => q.eq('id', p.row.id).eq('status', 'needs_review').eq('match_type', 'update');
      if (p.klass === 'NO_GAIN' || p.klass === 'SUPERSEDED') {
        const ek = p.row.diff?.event_key; const ed = p.row.extracted_data || {};
        if (ek && ek.before == null && ed.event_key && p.row.existing_activity_id) { const { data: w } = await client.from('activities').update({ event_key: ed.event_key, event_key_kind: ed.event_key_kind ?? null }).eq('id', p.row.existing_activity_id).is('event_key', null).select('id'); if (w && w.length) counts.identityBackfill++; }
        await guard(client.from('incoming_activities').update({ status: 'duplicate', match_type: 'duplicate', reject_reason: `THE CLEANER (wave 2 queue repair): ${p.why}`, reviewed_at: now }));
      } else if (p.klass === 'MISASSOCIATED' && p.detachTo.kind === 'duplicate_of') {
        await guard(client.from('incoming_activities').update({ status: 'duplicate', match_type: 'duplicate', existing_activity_id: p.detachTo.id, diff: {}, reject_reason: 'THE CLEANER (wave 2 queue repair): was mis-associated as an update of another event; it is already live as its own activity', reviewed_at: now }));
      } else if (p.klass === 'MISASSOCIATED' && p.detachTo.kind === 'expired') {
        await guard(client.from('incoming_activities').update({ status: 'archived_expired', match_type: 'expired', existing_activity_id: null, diff: {}, archive_reason: 'activity_expired_before_resolution', reject_reason: 'THE CLEANER (wave 2 queue repair): mis-associated update of another event; its own date has passed', reviewed_at: now }));
      } else if (p.klass === 'MISASSOCIATED') {
        await guard(client.from('incoming_activities').update({ match_type: 'new', existing_activity_id: null, diff: {}, confidence_score: 0, confidence_breakdown: { ...(p.row.confidence_breakdown || {}), detached_from: p.row.existing_activity_id, detached_why: p.why }, reject_reason: null }));
      }
    }
  }
  const file = path.join(__dirname, `update-queue-repair-${new Date().toISOString().slice(0, 10)}${APPLY ? '-applied' : '-dryrun'}.json`);
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), applied: APPLY, pendingBefore: rows.length, counts, rows: plan.map((p) => ({ id: p.row.id, activity: p.row.existing_activity_id, klass: p.klass, why: p.why, name: p.row.extracted_data?.name, existingName: p.existingName || null, detachTo: p.detachTo || null, diffKeys: Object.keys(p.row.diff || {}), realKeys: Object.keys(p.real) })) }, null, 2));
  console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'} | pending update rows ${rows.length} ->`, JSON.stringify(counts), '->', path.basename(file));
  const dt = {}; plan.filter((p) => p.klass === 'MISASSOCIATED').forEach((p) => { dt[p.detachTo.kind] = (dt[p.detachTo.kind] || 0) + 1; }); console.log('  detached ->', JSON.stringify(dt));
  plan.filter((p) => p.klass === 'MISASSOCIATED').slice(0, 6).forEach((p) => console.log('  MISASSOCIATED:', p.why.slice(0, 210)));
})().catch((e) => { console.error(e); process.exit(1); });
