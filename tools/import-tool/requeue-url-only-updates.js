// TuRu - one-off repair for the listing-URL over-match (found 2026-09-13, fixed in
// _shared/matching.ts): candidates from a listing page were matched as "updates" of the FIRST
// activity created from that page purely because the activity's source_url equals the page URL
// (breakdown: exact_url_match=1, name_overlap<0.5, schedule_match<1). Those rows are really NEW
// candidates. This re-routes them: match_type='new', no existing link, no diff, status by gating
// issues - so reprocess-review-queue.js / the admin can approve them through the normal path
// (whose event_fingerprint + google_place_id guards still prevent exact duplicates).
// Not re-run here: the similarity search against OTHER activities (the scanner will see the same
// events again on its next scan and, with the fixed matcher, link true duplicates then).
//   node requeue-url-only-updates.js [--apply]
require('dotenv').config();
const { getClient } = require('./supabase');

const APPLY = process.argv.includes('--apply');
const SOFT = new Set(['מחיר']);

(async () => {
  const { client } = await getClient();
  let rows = [], from = 0;
  while (true) {
    const { data, error } = await client.from('incoming_activities').select('id, confidence_breakdown, validation_issues, existing_activity_id, source:sources(name)')
      .in('status', ['new', 'needs_review']).eq('match_type', 'update').range(from, from + 999);
    if (error) throw error; rows = rows.concat(data); if (data.length < 1000) break; from += 1000;
  }
  const urlOnly = rows.filter((r) => {
    const b = r.confidence_breakdown || {};
    return b.exact_url_match === 1 && (b.name_overlap || 0) < 0.5 && (b.schedule_match || 0) < 1 && (b.fingerprint_match || 0) < 1;
  });
  const bySrc = {}; urlOnly.forEach((r) => { bySrc[r.source?.name] = (bySrc[r.source?.name] || 0) + 1; });
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: open update items ${rows.length}, url-only false matches ${urlOnly.length}`);
  console.log(Object.entries(bySrc).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' | '));
  if (!APPLY) return;
  let ok = 0;
  for (const r of urlOnly) {
    const gating = (r.validation_issues || []).filter((i) => !SOFT.has(i));
    const { error } = await client.from('incoming_activities').update({
      match_type: 'new', existing_activity_id: null, diff: {}, confidence_score: 0, confidence_breakdown: {},
      status: gating.length ? 'needs_review' : 'new',
    }).eq('id', r.id);
    if (!error) ok++; else console.log('  failed', r.id, error.message);
  }
  console.log(`re-routed ${ok} items to match_type=new`);
})().catch((e) => { console.error(e); process.exit(1); });
