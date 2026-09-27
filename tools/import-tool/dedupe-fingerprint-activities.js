// TuRu - resolve activities that share an event_fingerprint (same normalized name + venue/city +
// date/days + start time). These are the same real-world event stored twice; seen 2026-09-13 after a
// bulk queue approval (57 extra rows: the scanner queued the same event from two scans minutes
// apart / a page listing it twice, and the approve path had no fingerprint guard - both fixed).
// Reversible, never deletes: keeper = earliest non-archived row; each loser is archived, its
// provenance (activity_sources) is copied onto the keeper, its approved non-provider images are copied (with
// their status/provenance, lib/mergeImages.js) if the keeper lacks them, and its incoming_activities row is re-pointed (status rejected-as-duplicate, existing_activity_id
// = keeper) so the queue history stays truthful.
//   node dedupe-fingerprint-activities.js [--apply]
require('dotenv').config();
const { getClient } = require('./supabase');
const { archiveActivity, isArchived, describe } = require('./lib/activityArchive');
const { mergeActivitySources } = require('./lib/activitySourceMerge');
const { copyLoserImages, IMAGE_COPY_SELECT } = require('./lib/mergeImages');

const APPLY = process.argv.includes('--apply');

async function all(client, table, select, fn) {
  let from = 0, rows = [];
  while (true) { let q = client.from(table).select(select).range(from, from + 999); if (fn) q = fn(q); const { data, error } = await q; if (error) throw error; rows = rows.concat(data); if (data.length < 1000) return rows; from += 1000; }
}

(async () => {
  const { client, userId } = await getClient();
  const acts = await all(client, 'activities', `id, name, status, event_fingerprint, source_id, created_at, activity_images(${IMAGE_COPY_SELECT})`,
    (q) => q.not('event_fingerprint', 'is', null).neq('status', 'archived').order('created_at', { ascending: true }));
  const groups = {};
  for (const a of acts) (groups[a.event_fingerprint] = groups[a.event_fingerprint] || []).push(a);
  const dupGroups = Object.values(groups).filter((g) => g.length > 1);
  const losers = dupGroups.flatMap((g) => g.slice(1).map((l) => ({ keeper: g[0], loser: l })));
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: ${dupGroups.length} fingerprint groups, ${losers.length} duplicate rows to archive`);
  for (const g of dupGroups.slice(0, 10)) console.log(`  keep ${g[0].id.slice(0, 8)} (${g[0].created_at.slice(11, 16)})  archive ${g.slice(1).map((l) => l.id.slice(0, 8)).join(',')}  | ${g[0].name}`);
  if (!APPLY) return;

  let archived = 0, provMoved = 0, imgMoved = 0, imgProviderSkipped = 0, incRepointed = 0;
  for (const { keeper, loser } of losers) {
    // non-destructive: never downgrades an existing keeper row sharing a page_url with the loser
    // (2026-09-22, "Harden activity_sources Merge" - see lib/activitySourceMerge.js for the rules)
    const { counts: provCounts } = await mergeActivitySources(client, { keeperActivityId: keeper.id, loserActivityId: loser.id });
    provMoved += provCounts.ADDED + provCounts.PRESERVED_EXISTING;
    // 2026-09-27: provider/proxy, rejected and pending images never copied; approved ones keep status + provenance
    const img = await copyLoserImages(client, { loserImages: loser.activity_images, keeperImages: keeper.activity_images, keeperId: keeper.id, uploadedBy: userId, max: 3 });
    imgMoved += img.inserted; imgProviderSkipped += img.skipped.provider;
    if (img.inserted) keeper.activity_images = [...(keeper.activity_images || []), ...img.rows]; // a later loser of the same group sees them
    const { error: incErr } = await client.from('incoming_activities').update({
      status: 'rejected', existing_activity_id: keeper.id, reviewed_by: userId, reviewed_at: new Date().toISOString(),
      reject_reason: 'כפילות - אותה טביעת אצבע של אירוע; מוזגה לפעילות ' + keeper.id,
    }).eq('created_activity_id', loser.id);
    if (!incErr) incRepointed++;
    // now also stamps archive_reason/archived_at, which this script used to leave null - the
    // controlled transition requires a reason, and this script's reason is exactly this one.
    const arch = await archiveActivity(client, { activityId: loser.id, expectedStatus: loser.status || 'approved', archiveReason: 'duplicate_of_existing_activity', keeperActivityId: keeper.id });
    if (!isArchived(arch)) { console.log('  archive failed -', describe(arch)); continue; }
    archived++;
  }
  console.log(`done: archived ${archived}, provenance rows moved ${provMoved}, images copied ${imgMoved} (provider/proxy skipped ${imgProviderSkipped}), incoming rows re-pointed ${incRepointed}`);
})().catch((e) => { console.error(e); process.exit(1); });
