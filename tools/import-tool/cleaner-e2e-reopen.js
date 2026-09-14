// TuRu - THE CLEANER safe end-to-end REOPEN proof (brief §15/§21, user rule 2026-09-14: never force a
// legitimate production candidate through archive/reject to prove this). Creates ONE isolated test
// record on a real trusted source (extracted_data.cleaner_e2e = true), runs the REAL cleaner.js code
// paths against it, and cleans up only what it created.
//   unresolved -> stages tried / recorded unavailable -> terminal archive with structured explanation
//   -> new canonical evidence (test venue + alias) -> reopenWhereEvidenceChanged -> case reopens
//   -> resolves from stage `existing` -> real matcher (no duplicate) -> published via /approve
//   -> exactly one activity for the fingerprint, activity_sources 'created' -> cleanup
//   node cleaner-e2e-reopen.js [--keep]     (--keep leaves the test data in place for inspection)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getClient } = require('./supabase');
const { createVenueWithAlias } = require('./venueLearning');
const { computeEventFingerprint } = require('./eventFingerprint');

const KEEP = process.argv.includes('--keep');
const SOURCE_ID = 'b47bfcae-be85-49f5-93a9-9a4c29abc9ce'; // עיריית גבעתיים - אירועים (trust 85 >= 80)
const LABEL = 'אולם הבדיקות של המנקה';                     // resolves nowhere until the test venue exists
const NAME = 'בדיקת THE CLEANER - הצגה לילדים (רשומת בדיקה זמנית)';
const DATE = '2026-10-20';
const log = []; const t = () => new Date().toISOString();
const step = (name, data) => { log.push({ at: t(), step: name, ...data }); console.log(`[${name}]`, JSON.stringify(data).slice(0, 300)); };
const cleaner = (...a) => { const r = spawnSync(process.execPath, ['cleaner.js', ...a], { cwd: __dirname, encoding: 'utf8', timeout: 600000 }); const out = (r.stdout || '') + (r.stderr || ''); console.log(out.split('\n').filter((l) => /->|refusing|cycle failed|Error/.test(l)).join('\n')); return out; };

(async () => {
  const { client, userId } = await getClient();
  const created = { incoming: null, case: null, venue: null, activity: null, location: null };
  try {
    // 1. isolated test record: label only, no city, no page - nothing can resolve it yet
    const fingerprint = computeEventFingerprint({ name: NAME, venueId: null, city: null, scheduleType: 'one_time', oneTimeDate: DATE, recurringDays: [], startTime: '17:00' });
    const ed = { cleaner_e2e: true, name: NAME, entity_type: 'אירוע', description: 'הצגה לילדים ולכל המשפחה - רשומת בדיקה של THE CLEANER, תימחק אוטומטית', schedule_type: 'one_time', one_time_date: DATE, start_time: '17:00', location_name: LABEL, city: null, category: 'הצגה', audience: 'children', min_age: 3, max_age: 8, price_type: 'free', event_fingerprint: fingerprint, image_urls: [] };
    // page_url is NOT NULL; an unreachable host means source_page/detail_page are TRIED and fail (recorded), never resolve
    const { data: inc, error: e1 } = await client.from('incoming_activities').insert({ source_id: SOURCE_ID, page_url: 'https://cleaner-e2e.invalid/events/1', match_type: 'new', status: 'needs_review', extracted_data: ed, validation_issues: ['עיר'], raw_source_snapshot: 'cleaner e2e' }).select('id').single();
    if (e1) throw e1; created.incoming = inc.id;
    const { data: cs, error: e2 } = await client.from('cleaner_cases').insert({ subject_kind: 'incoming', subject_id: inc.id, issue: 'missing_location', priority: 10, status: 'open', event_date: DATE, source_id: SOURCE_ID, opened_reason: 'cleaner_e2e: no city' }).select('id').single();
    if (e2) throw e2; created.case = cs.id;
    step('created', { incoming_id: inc.id, case_id: cs.id, fingerprint });

    // 2. attempts until terminal archive (each attempt = new strategies / recorded unavailable)
    for (let i = 1; i <= 4; i++) {
      cleaner('--case=' + cs.id, '--now', '--no-clusters');
      const { data: c } = await client.from('cleaner_cases').select('status, attempts, methods_tried, resolution, archive_reason, claimed_by, lease_until').eq('id', cs.id).single();
      step(`attempt_${i}`, { status: c.status, attempts: c.attempts, methods_tried: c.methods_tried, unavailable: (c.resolution?.unavailable || []).map((u) => u.stage + ':' + u.why), next: c.resolution?.next_strategy, lease_released: c.claimed_by === null && c.lease_until === null });
      if (c.status === 'archived') { step('archived', { archive_reason: c.archive_reason, explanation: c.resolution.explanation }); break; }
    }
    const { data: rowA } = await client.from('incoming_activities').select('status, archive_reason, reject_reason').eq('id', inc.id).single();
    step('row_after_archive', rowA);
    if (rowA.status !== 'rejected') throw new Error('expected the blocking archive to reject the test row');

    // 3. new canonical evidence: a venue + alias for the label (what the cluster step / an admin would add)
    const v = await createVenueWithAlias(client, { label: LABEL, city: 'גבעתיים', region: 'גוש דן והמרכז', type: 'theater', lat: 32.0719, lng: 34.8097, address: 'רחוב הבדיקה 1', notes: 'cleaner_e2e temporary test venue', userId });
    if (!v.venue) throw new Error('test venue: ' + v.error);
    created.venue = v.venue.id; step('evidence_changed', { venue_id: v.venue.id, created: v.created });

    // 4. reopen detection
    cleaner('--reopen-only', '--force');
    const { data: c2 } = await client.from('cleaner_cases').select('status, attempts, reopened_count, opened_reason, archive_reason').eq('id', cs.id).single();
    const { data: row2 } = await client.from('incoming_activities').select('status, archive_reason').eq('id', inc.id).single();
    step('reopened', { case: c2, row: row2 });
    if (c2.status !== 'open' || c2.reopened_count !== 1 || row2.status !== 'needs_review') throw new Error('reopen did not happen');

    // 5. resolve + dedup + publish through the real path
    cleaner('--case=' + cs.id, '--now', '--no-clusters');
    const { data: c3 } = await client.from('cleaner_cases').select('status, resolution').eq('id', cs.id).single();
    step('resolved', { status: c3.status, outcome: c3.resolution?.outcome, method: c3.resolution?.method, confidence: c3.resolution?.confidence, handback: c3.resolution?.handback });
    const { data: acts } = await client.from('activities').select('id, name, venue_id, location_id, event_fingerprint, source_id, locations(name, address, city, lat, lng, venue_id, address_source)').eq('event_fingerprint', computeEventFingerprint({ name: NAME, venueId: v.venue.id, city: 'גבעתיים', scheduleType: 'one_time', oneTimeDate: DATE, recurringDays: [], startTime: '17:00' }));
    const { data: byName } = await client.from('activities').select('id').eq('name', NAME);
    created.activity = acts?.[0]?.id || byName?.[0]?.id || null; created.location = acts?.[0]?.location_id || null;
    const { data: prov } = created.activity ? await client.from('activity_sources').select('relation, source_id, incoming_activity_id, page_url').eq('activity_id', created.activity) : { data: [] };
    step('canonical', { activities_for_fingerprint: (acts || []).length, activities_by_name: (byName || []).length, activity: acts?.[0] || null, provenance: prov });
    const ok = c3.status === 'resolved' && ['published', 'duplicate_merged', 'awaiting_policy'].includes(c3.resolution?.outcome) && (byName || []).length <= 1;
    step('verdict', { ok, duplicate_created: (byName || []).length > 1 });
  } finally {
    if (!KEEP) {
      // cleanup ONLY the isolated test data created above
      if (created.activity) { for (const tbl of ['activity_images', 'activity_schedules', 'activity_sources']) await client.from(tbl).delete().eq('activity_id', created.activity); await client.from('activities').delete().eq('id', created.activity); }
      if (created.location) { const { count } = await client.from('activities').select('id', { count: 'exact', head: true }).eq('location_id', created.location); if (!count) await client.from('locations').delete().eq('id', created.location); }
      if (created.venue) { await client.from('locations').update({ venue_id: null }).eq('venue_id', created.venue); await client.from('venue_aliases').delete().eq('venue_id', created.venue); await client.from('venues').delete().eq('id', created.venue); }
      if (created.case) await client.from('cleaner_cases').delete().eq('id', created.case);
      if (created.incoming) await client.from('incoming_activities').delete().eq('id', created.incoming).eq('extracted_data->>cleaner_e2e', 'true');
      step('cleanup', created);
    }
    const file = path.join(process.env.CLEANER_E2E_OUT || __dirname, `cleaner-e2e-reopen-${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(file, JSON.stringify(log, null, 2));
    console.log('written', file);
  }
})().catch((e) => { console.error(e); process.exit(1); });
