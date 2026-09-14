// TuRu - one-off repair (2026-09-14): 7 unverified_location cases got a verified street address but
// kept their city-centroid coordinates (the address write ran before the coordinate replacement and
// erased the LOW marker it keyed on - fixed in cleaner/apply.js). Re-resolves those activities through
// the normal resolver and replaces the coordinates only while they are still the exact centroid values.
//   node repair-centroid-coords.js [--apply]
require('dotenv').config();
const { getClient } = require('./supabase');
const { resolveLocation } = require('./cleaner/locationResolver');
const { applyAddressToActivity } = require('./cleaner/apply');

const APPLY = process.argv.includes('--apply');
const CASE_IDS = ['4cdb5426-7d61-41c6-a407-72f4d2eca8b4', '50b540b1-4522-40cf-af11-40924de78a4b', '95800a1c-3e9a-4dec-8f18-cca1dfd026c5', '913701f6-206d-4490-bc61-671e3f428e7a', '70754396-079c-4df4-90c0-934b9ebb6f69', 'f37d6853-bda8-4ad8-8d6d-e3f85e3bbc3b', '6bece1e2-e13e-4af3-9c25-f977f3e74c00'];

(async () => {
  const { client } = await getClient();
  const { data: cases } = await client.from('cleaner_cases').select('id, subject_id, resolution').in('id', CASE_IDS);
  let fixed = 0;
  for (const c of cases || []) {
    const { data: a } = await client.from('activities').select('id, name, source_id, source_url, organizer_name, location_id, venue_id, locations(id, name, address, city, lat, lng, address_source, address_confidence), activity_sources(page_url, relation)').eq('id', c.subject_id).maybeSingle();
    if (!a) continue;
    const pageUrl = (a.activity_sources || []).find((s) => s.relation === 'created')?.page_url || a.source_url || null;
    const subject = { name: a.name, location_name: a.locations?.name || null, city: a.locations?.city || null, organizer_name: a.organizer_name || null, page_url: pageUrl, source_id: a.source_id, source_venue_id: null };
    // page evidence only, and never coordinates that merely repeat the centroid (another centroid victim of the same source)
    const { result, errors } = await resolveLocation(client, subject, { stages: ['source_page', 'detail_page', 'place_lookup'], maxEvidenceStages: 3, avoidCoords: { lat: a.locations?.lat, lng: a.locations?.lng } });
    if (errors.length) console.log('   ', errors.join(' | ').slice(0, 160));
    const ok = result && result.lat != null && ['HIGH', 'MEDIUM'].includes(result.confidence);
    console.log(`${a.name.slice(0, 40)} | ${a.locations?.city} | now ${a.locations?.lat},${a.locations?.lng} -> ${ok ? result.lat + ',' + result.lng + ' ' + result.method + '/' + result.confidence : 'no verified evidence'}`);
    if (!ok || !APPLY) continue;
    const w = await applyAddressToActivity(client, a, { ...result, address: null }, { replaceWeak: true });
    if (w.wrote.includes('coordsImproved')) { fixed++; await client.from('cleaner_cases').update({ resolution: { ...(c.resolution || {}), outcome: 'coordinates_verified', repaired_at: new Date().toISOString(), method: result.method, confidence: result.confidence, gain: ['coordsImproved'] }, updated_at: new Date().toISOString() }).eq('id', c.id); }
    else console.log('   not written:', w.skipped.join(','));
  }
  console.log(`${APPLY ? 'APPLY' : 'REPORT'}: ${fixed} coordinates replaced of ${(cases || []).length}`);
})().catch((e) => { console.error(e); process.exit(1); });
