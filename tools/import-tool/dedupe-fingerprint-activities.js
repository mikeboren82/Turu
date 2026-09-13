// TuRu - resolve activities that share an event_fingerprint (same normalized name + venue/city +
// date/days + start time). These are the same real-world event stored twice; seen 2026-09-13 after a
// bulk queue approval (57 extra rows: the scanner queued the same event from two scans minutes
// apart / a page listing it twice, and the approve path had no fingerprint guard - both fixed).
// Reversible, never deletes: keeper = earliest non-archived row; each loser is archived, its
// provenance (activity_sources) is copied onto the keeper, its images are copied if the keeper lacks
// them, and its incoming_activities row is re-pointed (status rejected-as-duplicate, existing_activity_id
// = keeper) so the queue history stays truthful.
//   node dedupe-fingerprint-activities.js [--apply]
require('dotenv').config();
const { getClient } = require('./supabase');

const APPLY = process.argv.includes('--apply');

async function all(client, table, select, fn) {
  let from = 0, rows = [];
  while (true) { let q = client.from(table).select(select).range(from, from + 999); if (fn) q = fn(q); const { data, error } = await q; if (error) throw error; rows = rows.concat(data); if (data.length < 1000) return rows; from += 1000; }
}

(async () => {
  const { client, userId } = await getClient();
  const acts = await all(client, 'activities', 'id, name, status, event_fingerprint, source_id, created_at, activity_images(id, url)',
    (q) => q.not('event_fingerprint', 'is', null).neq('status', 'archived').order('created_at', { ascending: true }));
  const groups = {};
  for (const a of acts) (groups[a.event_fingerprint] = groups[a.event_fingerprint] || []).push(a);
  const dupGroups = Object.values(groups).filter((g) => g.length > 1);
  const losers = dupGroups.flatMap((g) => g.slice(1).map((l) => ({ keeper: g[0], loser: l })));
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: ${dupGroups.length} fingerprint groups, ${losers.length} duplicate rows to archive`);
  for (const g of dupGroups.slice(0, 10)) console.log(`  keep ${g[0].id.slice(0, 8)} (${g[0].created_at.slice(11, 16)})  archive ${g.slice(1).map((l) => l.id.slice(0, 8)).join(',')}  | ${g[0].name}`);
  if (!APPLY) return;

  let archived = 0, provMoved = 0, imgMoved = 0, incRepointed = 0;
  for (const { keeper, loser } of losers) {
    const { data: prov } = await client.from('activity_sources').select('source_id, page_url, incoming_activity_id, relation, first_seen_at, last_seen_at').eq('activity_id', loser.id);
    for (const p of prov || []) {
      const { error } = await client.from('activity_sources').upsert({ ...p, activity_id: keeper.id, relation: 'seen', last_seen_at: p.last_seen_at || new Date().toISOString() }, { onConflict: 'activity_id,page_url' });
      if (!error) provMoved++;
    }
    const keeperUrls = new Set((keeper.activity_images || []).map((i) => i.url));
    const newImgs = (loser.activity_images || []).filter((i) => !keeperUrls.has(i.url)).slice(0, 3).map((i) => ({ activity_id: keeper.id, url: i.url, uploaded_by: userId }));
    if (newImgs.length) { const { error } = await client.from('activity_images').insert(newImgs); if (!error) imgMoved += newImgs.length; }
    const { error: incErr } = await client.from('incoming_activities').update({
      status: 'rejected', existing_activity_id: keeper.id, reviewed_by: userId, reviewed_at: new Date().toISOString(),
      reject_reason: 'כפילות - אותה טביעת אצבע של אירוע; מוזגה לפעילות ' + keeper.id,
    }).eq('created_activity_id', loser.id);
    if (!incErr) incRepointed++;
    const { error: archErr } = await client.from('activities').update({ status: 'archived' }).eq('id', loser.id);
    if (archErr) { console.log('  archive failed', loser.id, archErr.message); continue; }
    archived++;
  }
  console.log(`done: archived ${archived}, provenance rows moved ${provMoved}, images copied ${imgMoved}, incoming rows re-pointed ${incRepointed}`);
})().catch((e) => { console.error(e); process.exit(1); });
