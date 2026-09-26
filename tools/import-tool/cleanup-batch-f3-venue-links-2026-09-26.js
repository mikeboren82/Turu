// TuRu - Repair Batch F Part 3 (2026-09-26): venue-link repairs E-9 / E-10 / E-11 from the Phase 1 golden-case ledger,
// after Parts 1 (ae88017) + 2 (7b3855a) and 0114. Owner decisions:
//   E-10  cc171937 חוות הנדיב: activity.venue_id := 0f0b5b05 (its location 2649176a already carries it). Nothing else.
//   E-9   venue 321d0c38 חוות ארץ האיילים: city גוש עציון -> כפר עציון (lat/lng/address/region untouched - the location's
//         point is only MEDIUM import-time geocode evidence); location fab68c27 + activity 14b18786 linked to it.
//   E-11  children's library 5cf4e228 moves off the host venue בית ספיר (8a0bfac8): venue 10f003b0 gets lat/lng only (same
//         building as location a7d0bc56; its address "השרון" is not a street and is NOT copied); a NEW dedicated location
//         (address null) is created; the activity moves venue_id + location_id in one guarded patch. NO city-less alias
//         "ספריית הילדים והנוער" (it would become a cross-city binding trap) - the city-qualified aliases stay as they are.
//   Out of scope: the zoo story-hour duplicate pair (e6ded2da / 8cceeb9b) - recorded, no write.
//
// Write doors: the bot's verifiedConditionalUpdate (exact expectedOld, one row, read-back) for venues, locations and
// the bot-owned activity. Two activities (14b18786, cc171937) have created_by = NULL, which the activities UPDATE policy
// (created_by = auth.uid() OR is_admin()) never lets the bot write: those two use ONE elevated exact-ID statement each
// (`supabase db query --linked`, owner-approved 2026-09-26, same precedent as taxonomy Phase F) - WHERE carries the full
// expectedOld, RETURNING must yield exactly one row, and the bot reads it back. An already-satisfied link (the Cleaner's
// missing_venue case got there first) is NO_CHANGE_ALREADY_SATISFIED. Rollback JSON is written before the first write.
//
//   node cleanup-batch-f3-venue-links-2026-09-26.js            (dry run, default)
//   node cleanup-batch-f3-venue-links-2026-09-26.js --apply    (execute)
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { getClient } = require('./supabase');
const { verifiedConditionalUpdate, isSuccess, describe, OUTCOME } = require('./lib/verifiedWrite');
const { resolveVenue } = require('./venueNaming');

const APPLY = process.argv.includes('--apply');
const TAG = 'cleanup-batch-f3-2026-09-26';
const REPORTS = path.join(__dirname, 'reports');
const REPO = path.join(__dirname, '..', '..');

const E10 = { activity: 'cc171937-72d6-4aae-b1d4-652c68772b78', location: '2649176a-49e8-4e53-aac8-82ecdbd949a2', venue: '0f0b5b05-32c1-49c7-900f-cca29d4a21dc' };
const E9 = { activity: '14b18786-cc9c-49fe-85cd-c993335b22ab', location: 'fab68c27-cb20-43b7-bfed-7102bb123ebb', venue: '321d0c38-b9d4-4e87-be39-296025927ffd',
  venueOld: { city: 'גוש עציון', is_active: true, merged_into: null, google_place_id: null, lat: null, lng: null, address: null, region: 'ירושלים והסביבה', updated_at: '2026-09-13T11:02:07.35671+00:00' },
  newCity: 'כפר עציון' };
const E11 = { activity: '5cf4e228-6549-40b3-b49d-3c31377025b2', host: '8a0bfac8-070c-40cf-84bc-13595519e0f6', hostLocation: 'a7d0bc56-7ca3-48cf-b91d-04ac5bd5cea5', venue: '10f003b0-b21a-41b4-9e09-05ce8c17f9ba',
  venueOld: { lat: null, lng: null, address: null, is_active: true, merged_into: null, google_place_id: null, updated_at: '2026-09-13T11:02:37.830988+00:00' },
  coords: { lat: 32.173774, lng: 34.892692 },
  newLocation: { name: 'ספריית הילדים והנוער כפר סבא', city: 'כפר סבא', region: 'השרון', lat: 32.173774, lng: 34.892692, address: null, venue_id: '10f003b0-b21a-41b4-9e09-05ce8c17f9ba' },
  hostStoryHours: ['596b3f3f', '741632c7', '84ea2718'], citylessAlias: 'ספריית הילדים והנוער' };
const DUPLICATE_PAIR = ['e6ded2da-3e99-41a0-9976-51303a720c65', '8cceeb9b-8456-4846-890d-1aa3dba4fd66'];

const diffFields = (row, expected) => Object.entries(expected).filter(([k, v]) => (row?.[k] ?? null) !== v).map(([k, v]) => `${k}: expected ${JSON.stringify(v)}, found ${JSON.stringify(row?.[k] ?? null)}`);
const pick = (row, keys) => Object.fromEntries(keys.map((k) => [k, row?.[k] ?? null]));
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// one elevated exact-ID statement (NULL-owner activities only) -> rows RETURNING
function elevatedUpdate(sql) {
  const f = path.join(os.tmpdir(), `${TAG}-${Date.now()}.sql`);
  fs.writeFileSync(f, sql);
  try {
    const out = execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'supabase', 'db', 'query', '--linked', '-f', f, '-o', 'json'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    const j = JSON.parse(out.slice(out.indexOf('{')));
    return j.rows || [];
  } finally { fs.unlinkSync(f); }
}

// existing dedicated library location(s): by venue, or by canonical name in the city (two plain queries, errors fatal)
async function libraryLocations(client) {
  const a = await client.from('locations').select('*').eq('venue_id', E11.venue);
  const b = await client.from('locations').select('*').eq('city', E11.newLocation.city).eq('name', E11.newLocation.name);
  for (const r of [a, b]) if (r.error) throw r.error;
  return [...new Map([...a.data, ...b.data].map((l) => [l.id, l])).values()];
}

async function readAll(client) {
  const one = async (t, id, cols = '*') => { const { data, error } = await client.from(t).select(cols).eq('id', id).maybeSingle(); if (error) throw error; return data; };
  const s = {};
  for (const id of [E10.activity, E9.activity, E11.activity]) s[id] = await one('activities', id, 'id, name, status, venue_id, location_id, created_by, event_fingerprint');
  for (const id of [E10.location, E9.location, E11.hostLocation]) s[id] = await one('locations', id);
  for (const id of [E10.venue, E9.venue, E11.venue, E11.host]) s[id] = await one('venues', id);
  const { data: shared } = await client.from('activities').select('id, venue_id, status').eq('location_id', E11.hostLocation);
  s.shared = shared || [];
  s.libLocations = await libraryLocations(client);
  const { data: cityless } = await client.from('venue_aliases').select('venue_id').eq('alias_normalized', E11.citylessAlias);
  s.citylessAlias = cityless || [];
  const { data: ksAliases } = await client.from('venue_aliases').select('alias_normalized').eq('venue_id', E11.venue);
  s.ksAliases = (ksAliases || []).map((a) => a.alias_normalized).sort();
  return s;
}

// expected pre-state; an already-correct Cleaner link counts as satisfied, anything else is drift
function checkPlan(s) {
  const d = [];
  const a10 = s[E10.activity];
  if (!a10 || a10.status !== 'approved' || a10.location_id !== E10.location || ![null, E10.venue].includes(a10.venue_id)) d.push(`E-10 activity ${JSON.stringify(a10 && pick(a10, ['status', 'venue_id', 'location_id']))}`);
  if (s[E10.location]?.venue_id !== E10.venue) d.push('E-10 location 2649176a lost its venue');
  const v9 = s[E9.venue];
  if (!v9) d.push('E-9 venue missing');
  else if (v9.city !== E9.newCity) {
    d.push(...diffFields(v9, E9.venueOld).map((x) => `E-9 venue: ${x}`));
  } else if (v9.lat !== null || v9.lng !== null) d.push('E-9 venue already on כפר עציון AND has coordinates - inspect provenance');
  const l9 = s[E9.location];
  if (!l9 || l9.city !== 'כפר עציון' || ![null, E9.venue].includes(l9.venue_id)) d.push(`E-9 location ${JSON.stringify(l9 && pick(l9, ['city', 'venue_id']))}`);
  const a9 = s[E9.activity];
  if (!a9 || a9.status !== 'approved' || a9.location_id !== E9.location || ![null, E9.venue].includes(a9.venue_id)) d.push(`E-9 activity ${JSON.stringify(a9 && pick(a9, ['status', 'venue_id', 'location_id']))}`);
  for (const id of [E9.activity, E10.activity]) if (s[id] && s[id].created_by !== null) d.push(`${id.slice(0, 8)} created_by is no longer NULL - the elevated path is not needed/approved for it`);
  const v11 = s[E11.venue];
  if (!v11) d.push('E-11 venue missing'); else d.push(...diffFields(v11, E11.venueOld).map((x) => `E-11 venue: ${x}`));
  const a11 = s[E11.activity];
  if (!a11 || a11.status !== 'approved' || a11.venue_id !== E11.host || a11.location_id !== E11.hostLocation || a11.created_by === null) d.push(`E-11 activity ${JSON.stringify(a11 && pick(a11, ['status', 'venue_id', 'location_id', 'created_by']))}`);
  const hl = s[E11.hostLocation];
  if (!hl || hl.venue_id !== E11.host || hl.lat !== E11.coords.lat || hl.lng !== E11.coords.lng) d.push(`E-11 host location ${JSON.stringify(hl && pick(hl, ['venue_id', 'lat', 'lng']))}`);
  const sharedIds = s.shared.map((a) => a.id.slice(0, 8)).sort();
  if (JSON.stringify(sharedIds) !== JSON.stringify([...E11.hostStoryHours, E11.activity.slice(0, 8)].sort())) d.push(`E-11 shared location activities ${JSON.stringify(sharedIds)}`);
  if (s.libLocations.length) d.push(`E-11 a dedicated library location already exists: ${JSON.stringify(s.libLocations.map((l) => l.id))} - validate/reuse by hand`);
  if (s.citylessAlias.length) d.push('city-less alias ספריית הילדים והנוער now exists somewhere');
  if (JSON.stringify(s.ksAliases) !== JSON.stringify(['ספריית הילדים והנוער כפר סבא', 'ספריית הילדים כפר סבא'])) d.push(`E-11 venue aliases ${JSON.stringify(s.ksAliases)}`);
  if (s[E11.host]?.lat !== E11.coords.lat) d.push('host venue בית ספיר coordinates changed');
  return d;
}

function plannedMutations() {
  return [
    { key: 'E-10 activity', door: 'elevated', table: 'activities', id: E10.activity, expectedOld: { venue_id: null, status: 'approved', location_id: E10.location, created_by: null }, patch: { venue_id: E10.venue } },
    { key: 'E-9 venue city', door: 'bot', table: 'venues', id: E9.venue, expectedOld: E9.venueOld, patch: { city: E9.newCity }, bumpUpdatedAt: true },
    { key: 'E-9 location', door: 'bot', table: 'locations', id: E9.location, expectedOld: { venue_id: null, city: 'כפר עציון' }, patch: { venue_id: E9.venue } },
    { key: 'E-9 activity', door: 'elevated', table: 'activities', id: E9.activity, expectedOld: { venue_id: null, status: 'approved', location_id: E9.location, created_by: null }, patch: { venue_id: E9.venue } },
    { key: 'E-11 venue coords', door: 'bot', table: 'venues', id: E11.venue, expectedOld: E11.venueOld, patch: { ...E11.coords }, bumpUpdatedAt: true },
    { key: 'E-11 new location', door: 'bot', table: 'locations', op: 'insert', row: E11.newLocation },
    { key: 'E-11 activity move', door: 'bot', table: 'activities', id: E11.activity, expectedOld: { venue_id: E11.host, location_id: E11.hostLocation, status: 'approved' }, patch: { venue_id: E11.venue, location_id: '<new E-11 location id>' } },
  ];
}

async function resolverChecks(client) {
  const r = async (l, c) => { const v = await resolveVenue(client, { locationName: l, city: c }); return v ? `${v.id.slice(0, 8)} ${v.name_he}` : null; };
  return {
    'חוות ארץ האיילים + כפר עציון': await r('חוות ארץ האיילים', 'כפר עציון'),
    'חוות ארץ האיילים + גוש עציון (council form)': await r('חוות ארץ האיילים', 'גוש עציון'),
    'חוות הנדיב + זכרון יעקב': await r('חוות הנדיב', 'זכרון יעקב'),
    'ספריית הילדים והנוער כפר סבא + כפר סבא': await r('ספריית הילדים והנוער כפר סבא', 'כפר סבא'),
    'ספריית הילדים כפר סבא + כפר סבא': await r('ספריית הילדים כפר סבא', 'כפר סבא'),
    'ספריית הילדים והנוער + no city': await r('ספריית הילדים והנוער', null),
    'ספריית הילדים והנוער + כפר סבא': await r('ספריית הילדים והנוער', 'כפר סבא'),
    'בית ספיר + כפר סבא': await r('בית ספיר', 'כפר סבא'),
  };
}

(async () => {
  const { client } = await getClient();
  const startedAt = new Date().toISOString();
  console.log(`=== ${TAG} (${APPLY ? 'APPLY' : 'DRY RUN'}) ${startedAt} ===`);
  const s = await readAll(client);
  const drift = checkPlan(s);
  const mutations = plannedMutations();
  const rollback = {
    note: 'reverse order: move the E-11 activity back FIRST, then unlink/restore the rest with the same guards inverted. The two NULL-owner activity links (E-10, E-9 activity) can only be reversed by elevated exact-ID SQL. The inserted E-11 location becomes orphaned after the activity moves back; deleting it needs admin (locations_delete = is_admin()) - leave it for admin cleanup.',
    activities: Object.fromEntries([E10.activity, E9.activity, E11.activity].map((id) => [id, pick(s[id], ['venue_id', 'location_id', 'status', 'created_by'])])),
    locations: { [E9.location]: pick(s[E9.location], ['venue_id', 'city']) },
    venues: { [E9.venue]: pick(s[E9.venue], ['city', 'lat', 'lng', 'address', 'region', 'updated_at']), [E11.venue]: pick(s[E11.venue], ['lat', 'lng', 'address', 'updated_at']) },
    inserted_location: { payload: E11.newLocation, id: '(filled in applied report)' },
  };
  const report = { tag: TAG, generatedAt: startedAt, applied: APPLY, drift, mutations, writeCount: mutations.length,
    notes: { e11_coords_from: `${E11.hostLocation} (בית ספיר location, same building; its address "השרון" deliberately not copied)`,
      duplicate_pair_no_write: { ids: DUPLICATE_PAIR, status: 'confirmed duplicate candidate - keeper choice is a later human-reviewed dedupe action' },
      open_cleaner_cases: 'missing_venue cases 948863e0 (14b18786) and 28baa847 (cc171937) stay as they are; the Cleaner closes them on its next pass when it sees the link' },
    resolverBefore: await resolverChecks(client), results: [], stoppedAt: null };
  console.log('drift:', drift.length ? drift : 'none');
  mutations.forEach((m, i) => console.log(`  ${i + 1}. ${m.key.padEnd(20)} [${m.door}] ${m.table} ${m.op === 'insert' ? 'INSERT ' + JSON.stringify(m.row) : m.id.slice(0, 8) + ' ' + JSON.stringify(m.patch)}`));
  console.log(`writes planned: ${mutations.length}`);
  fs.mkdirSync(REPORTS, { recursive: true });
  const out = (suffix, obj) => { const f = path.join(REPORTS, `${TAG}-${suffix}.json`); fs.writeFileSync(f, JSON.stringify(obj, null, 2)); return f; };
  if (drift.length) { report.stoppedAt = 'preflight drift - no write'; console.log('STOP: drift, no write'); out(APPLY ? 'applied' : 'dryrun', report); process.exitCode = 2; return; }
  if (!APPLY) { report.rollbackPreview = rollback; console.log('resolver before:', report.resolverBefore); console.log('\nreport ->', path.basename(out('dryrun', report))); return; }

  out('rollback', { tag: TAG, writtenAt: new Date().toISOString(), ...rollback });
  const record = (m, ok, detail, outcome) => { report.results.push({ key: m.key, door: m.door, id: m.id || null, ok, outcome: outcome || (ok ? 'SUCCESS' : 'FAILED'), detail, at: new Date().toISOString() }); console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${m.key.padEnd(20)} ${outcome && outcome !== 'SUCCESS' ? '[' + outcome + '] ' : ''}${detail}`); if (!ok) report.stoppedAt = m.key; return ok; };
  const one = async (t, id) => (await client.from(t).select('*').eq('id', id).maybeSingle()).data;
  let newLocationId = null;

  for (const m of mutations) {
    if (m.key === 'E-11 activity move') m.patch.location_id = newLocationId;
    if (m.door === 'elevated') {
      const where = Object.entries(m.expectedOld).map(([k, v]) => (v === null ? `${k} is null` : `${k} = ${q(v)}`)).join(' and ');
      const set = Object.entries(m.patch).map(([k, v]) => `${k} = ${q(v)}`).join(', ');
      const sql = `update public.${m.table} set ${set} where id = ${q(m.id)} and ${where} returning id, venue_id;`;
      m.sql = sql;
      const rows = elevatedUpdate(sql);
      const back = await one(m.table, m.id);
      if (rows.length === 1 && diffFields(back, m.patch).length === 0) { record(m, true, `1 row (elevated exact-ID SQL), read-back ${JSON.stringify(pick(back, Object.keys(m.patch)))}`); continue; }
      if (rows.length === 0 && diffFields(back, m.patch).length === 0) { record(m, true, 'already linked (e.g. by the Cleaner) - read-back matches', OUTCOME.NO_CHANGE_ALREADY_SATISFIED); continue; }
      record(m, false, `elevated update returned ${rows.length} row(s); read-back ${JSON.stringify(pick(back, Object.keys(m.patch)))}`); break;
    } else if (m.op === 'insert') {
      const again = await libraryLocations(client);
      if (again.length) { record(m, false, `a library location appeared since preflight: ${JSON.stringify(again)}`); break; }
      const { data, error } = await client.from('locations').insert(m.row).select('*');
      if (error || !data || data.length !== 1) { record(m, false, `insert returned ${data ? data.length : 'error'} row(s)${error ? ' - ' + error.message : ''}`); break; }
      newLocationId = data[0].id;
      report.insertedLocation = data[0];
      const back = await one('locations', newLocationId);
      const bad = diffFields(back, m.row);
      if (!record(m, bad.length === 0, bad.length ? 'read-back mismatch: ' + bad.join('; ') : `inserted ${newLocationId} ${JSON.stringify(pick(back, Object.keys(m.row)))}`)) break;
      out('rollback', { tag: TAG, writtenAt: new Date().toISOString(), ...rollback, inserted_location: { payload: m.row, id: newLocationId } });
    } else {
      const patch = { ...m.patch, ...(m.bumpUpdatedAt ? { updated_at: new Date().toISOString() } : {}) };
      const r = await verifiedConditionalUpdate(client, { table: m.table, id: m.id, patch, expectedOld: m.expectedOld });
      if (r.outcome === OUTCOME.NO_CHANGE_ALREADY_SATISFIED) { record(m, true, 'already satisfied - read-back matches', r.outcome); continue; }
      if (!isSuccess(r) || r.rows !== 1) { record(m, false, describe(r)); break; }
      const back = await one(m.table, m.id);
      const bad = diffFields(back, m.patch);
      if (m.table === 'venues') for (const k of ['address', 'region', ...(m.key === 'E-9 venue city' ? ['lat', 'lng'] : [])]) if ((back[k] ?? null) !== (m.expectedOld[k] ?? s[m.id][k] ?? null)) bad.push(`${k} changed`);
      if (!record(m, bad.length === 0, bad.length ? 'read-back mismatch: ' + bad.join('; ') : `1 row, read-back ${JSON.stringify(pick(back, Object.keys(m.patch)))}`)) break;
    }
  }

  if (!report.stoppedAt) {
    // post-apply assertions (bot reads)
    const a = {};
    const act = async (id) => pick(await one('activities', id), ['venue_id', 'location_id', 'status']);
    a.e10 = await act(E10.activity);
    a.e9_activity = await act(E9.activity);
    a.e9_location = pick(await one('locations', E9.location), ['venue_id', 'city']);
    a.e9_venue = pick(await one('venues', E9.venue), ['city', 'lat', 'lng', 'address', 'region', 'google_place_id']);
    a.e11_venue = pick(await one('venues', E11.venue), ['lat', 'lng', 'address', 'google_place_id']);
    a.e11_activity = await act(E11.activity);
    a.e11_new_location = pick(await one('locations', newLocationId), ['name', 'city', 'region', 'lat', 'lng', 'address', 'venue_id']);
    a.host_location = pick(await one('locations', E11.hostLocation), ['venue_id', 'lat', 'lng', 'address']);
    const { data: shared } = await client.from('activities').select('id').eq('location_id', E11.hostLocation);
    a.host_location_activities = (shared || []).map((x) => x.id.slice(0, 8)).sort();
    const { data: cityless } = await client.from('venue_aliases').select('venue_id').eq('alias_normalized', E11.citylessAlias);
    a.cityless_alias_rows = (cityless || []).length;
    const ok = a.e10.venue_id === E10.venue && a.e9_activity.venue_id === E9.venue && a.e9_location.venue_id === E9.venue
      && a.e9_venue.city === E9.newCity && a.e9_venue.lat === null && a.e9_venue.lng === null && a.e9_venue.address === null && a.e9_venue.region === E9.venueOld.region
      && a.e11_venue.lat === E11.coords.lat && a.e11_venue.lng === E11.coords.lng && a.e11_venue.address === null
      && a.e11_activity.venue_id === E11.venue && a.e11_activity.location_id === newLocationId && a.e11_activity.status === 'approved'
      && diffFields(a.e11_new_location, E11.newLocation).length === 0
      && a.host_location.venue_id === E11.host && JSON.stringify(a.host_location_activities) === JSON.stringify([...E11.hostStoryHours].sort())
      && a.cityless_alias_rows === 0 && [a.e9_venue, a.e11_venue].every((v) => v.google_place_id === null);
    report.assertions = { ok, ...a };
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} post-apply assertions ${JSON.stringify(a)}`);
    if (!ok) report.stoppedAt = 'post-apply assertions';
  }
  report.resolverAfter = await resolverChecks(client);
  report.finishedAt = new Date().toISOString();
  console.log('resolver before:', report.resolverBefore);
  console.log('resolver after: ', report.resolverAfter);
  console.log('\nreport ->', path.basename(out('applied', report)));
  if (report.stoppedAt) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
