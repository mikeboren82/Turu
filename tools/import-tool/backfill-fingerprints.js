// TuRu - one-off/idempotent: compute activities.event_fingerprint (0079) for dated/recurring
// activities that don't have one yet. Uses the Node mirror of the Deno fingerprint (eventFingerprint.js).
//   node backfill-fingerprints.js [--apply]
require('dotenv').config();
const { getClient } = require('./supabase');
const { computeEventFingerprint } = require('./eventFingerprint');
const APPLY = process.argv.includes('--apply');

(async () => {
  const { client } = await getClient();
  let all = [], from = 0;
  while (true) {
    const { data, error } = await client.from('activities')
      .select('id, name, venue_id, event_fingerprint, location:locations(city), activity_schedules(schedule_type, one_time_date, start_time, day_of_week)')
      .range(from, from + 999);
    if (error) throw error;
    all = all.concat(data); if (data.length < 1000) break; from += 1000;
  }
  const targets = all.filter((a) => !a.event_fingerprint && (a.activity_schedules || []).some((s) => s.schedule_type === 'one_time' || s.schedule_type === 'recurring'));
  console.log(`activities: ${all.length}, candidates for fingerprint: ${targets.length} (${APPLY ? 'APPLY' : 'DRY RUN'})`);
  let done = 0;
  for (const a of targets) {
    // occurrence model (0091): rows are unordered and there may be several dated ones - the LEGACY
    // fingerprint is the earliest occurrence's (never rotated afterwards; event_key is the event identity)
    const s = [...a.activity_schedules].sort((x, y) => String(x.one_time_date || '').localeCompare(String(y.one_time_date || '')) || String(x.start_time || '').localeCompare(String(y.start_time || '')));
    const first = s.find((x) => x.schedule_type === 'one_time' && x.one_time_date) || s[0];
    const type = first.schedule_type;
    const fp = computeEventFingerprint({
      name: a.name, venueId: a.venue_id, city: a.location?.city, scheduleType: type,
      oneTimeDate: first.one_time_date, recurringDays: s.map((x) => x.day_of_week).filter(Boolean), startTime: first.start_time,
    });
    if (!fp) continue;
    if (APPLY) { const { error } = await client.from('activities').update({ event_fingerprint: fp }).eq('id', a.id); if (error) console.error(a.id, error.message); }
    else if (done < 5) console.log('  ', a.name, '->', fp);
    done++;
  }
  console.log(`fingerprints ${APPLY ? 'written' : 'computed'}: ${done}`);
})().catch((e) => { console.error(e); process.exit(1); });
