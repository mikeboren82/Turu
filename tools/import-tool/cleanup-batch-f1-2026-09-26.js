// TuRu - Repair Batch F Part 1 (2026-09-26): library binding + identity-poison repairs from the Phase 1 golden-case
// ledger (PHASE1-GOLDEN-CASES-REPAIR-LEDGER-2026-09-25.md), after R3 (generic venue attestation, a0a19fc / scan-source
// v92) was deployed. Owner decisions: E-1 REVOKE the Ramat HaSharon generic attestation; E-8 category AND
// placeholder_group; E-21 only if fresh evidence still shows the wrong alias; E-22 no write.
//
//   E-7   965388d6 playground filed as חיות וגני חיות            -> category גן שעשועים (placeholder PLAY_AND_FUN kept)
//   E-8   42b4758b אקווריום ישראל filed as מוזיאון לילדים          -> חיות וגני חיות + NATURE_AND_ANIMALS (no venue/alias/coords)
//   E-3   5d4ebd74 צומת ספרים bookshop filed as a library place  -> archive_activity RPC, auto_publish_false_positive_retail
//   E-17  source 2f279cc1 generic name "ספרייה עירונית"          -> "הספרייה העירונית בית שמש" (stays inactive)
//   E-2   289d1e90 + location 0e2f5d2f named bare "ספרייה"       -> "הספרייה העירונית רמת השרון" (name_source admin_confirmed)
//   E-1   venue_aliases ספרייה / ספרייה העירונית on 6801a6f3      -> deleted (attestation revoked; specific aliases kept)
//   RH    open incoming 5d1049a3 / ead35d80 carry extracted_data.venue_id = 6801a6f3 from before the revocation - the
//         approve path (server.js publishIncoming) trusts a present venue_id and only resolves when it is empty, and
//         reprocess-review-queue.js is a whole-queue approve/publish tool, not a per-row venue re-resolution - so the
//         smallest guarded change: remove ONLY the extracted_data.venue_id key, everything else byte-for-byte preserved
//   E-21  venue_aliases "הספרייה העירונית כפר סבא" on 10f003b0 (the CHILDREN'S library) -> deleted, only if every
//         evidence check below still holds; genuine children's-library aliases untouched
//   E-22  Kiryat Ata: no write (generic label must stay unresolved)
//
// Guards: every write carries its exact expectedOld (verifiedConditionalUpdate / verifiedFieldUpdate, archive RPC,
// delete scoped to (venue_id, alias_normalized) with an exact affected-row count). The whole plan is re-read and
// checked BEFORE the first write (any drift -> no write at all); each mutation is read back; the first failure stops
// the batch (successful earlier rows are NOT auto-rolled-back - the rollback JSON holds every original row).
//
//   node cleanup-batch-f1-2026-09-26.js --deps-snapshot=<json>            (dry run, default)
//   node cleanup-batch-f1-2026-09-26.js --deps-snapshot=<json> --apply    (execute)
// <json> = { activity_id, readAt, counts: {favorites, planned_activities, ...} } from an elevated READ-ONLY SELECT
// (the bot cannot see user-owned rows); without it the E-3 dependency check is UNKNOWN and the batch stops.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { verifiedConditionalUpdate, verifiedFieldUpdate, isSuccess, describe } = require('./lib/verifiedWrite');
const { archiveActivity, isArchived, describe: describeArchive } = require('./lib/activityArchive');
const { resolveVenue, normalizeVenueAlias } = require('./venueNaming');

const APPLY = process.argv.includes('--apply');
const TAG = 'cleanup-batch-f1-2026-09-26';
const REPORTS = path.join(__dirname, 'reports');
const RH_VENUE = '6801a6f3-1fe7-4b57-b65e-cad2f159c933';
const RH_LOCATION = '0e2f5d2f-15d6-45c7-8cf5-356c71e7cbbc';
const KS_VENUE = '10f003b0-b21a-41b4-9e09-05ce8c17f9ba';
const RH_NAME = 'הספרייה העירונית רמת השרון';

const ACTIVITY_EDITS = [
  { key: 'E-7', id: '965388d6-4034-4616-90f6-a1635bb2ac3e',
    expectedOld: { category: 'חיות וגני חיות', status: 'approved', entity_type: 'מקום_קבוע', name_source: 'generated_from_address', venue_id: null, placeholder_group: 'PLAY_AND_FUN' },
    patch: { category: 'גן שעשועים' } },
  { key: 'E-8', id: '42b4758b-85ae-44db-b3d1-41b714cd717a',
    expectedOld: { category: 'מוזיאון לילדים', placeholder_group: 'CULTURE_CREATIVITY', status: 'approved', entity_type: 'מקום_קבוע', venue_id: null, google_place_id: 'ChIJI2bqvtPZAhURTsyWtPTWw30', location_id: 'bef89f2c-bd2c-43d5-9ead-efdb1fe51ef3' },
    patch: { category: 'חיות וגני חיות', placeholder_group: 'NATURE_AND_ANIMALS' } },
  { key: 'E-2 activity', id: '289d1e90-14a0-4073-863c-6ed1cd2abb10',
    expectedOld: { name: 'ספרייה', name_source: null, status: 'approved', category: 'ספרייה', entity_type: 'מקום_קבוע', venue_id: RH_VENUE, location_id: RH_LOCATION },
    patch: { name: RH_NAME, name_source: 'admin_confirmed' } },
];
const E3 = { id: '5d4ebd74-a5e8-4bbd-92de-f471b8a33ecb', expected: { status: 'approved', category: 'ספרייה', name: 'צומת ספרים' }, reason: 'auto_publish_false_positive_retail' };
const E17 = { id: '2f279cc1-d435-49f2-99e1-51c20f5536f8',
  expectedOld: { name: 'ספרייה עירונית', publisher_name: 'ספרייה עירונית', is_active: false, seed_url: 'https://betshemesh.agronplus.org/', updated_at: '2026-09-19T19:44:50.591451+00:00' },
  patch: { name: 'הספרייה העירונית בית שמש', publisher_name: 'הספרייה העירונית בית שמש' } };
const E2_LOCATION = { id: RH_LOCATION, expectedOld: { name: 'ספרייה', city: 'רמת השרון', venue_id: RH_VENUE }, patch: { name: RH_NAME }, expectedReferences: 34 };
const E1_ALIASES = ['ספרייה', 'ספרייה העירונית'];
const RH_SPECIFIC_ALIASES = ['ספרייה העירונית רמת השרון', 'ספריית רמת השרון'];
const STALE_ROWS = [
  { id: '5d1049a3-0de8-4092-8f7d-7a07bece9722', status: 'needs_review', updated_at: '2026-09-14T13:31:21.748398+00:00' },
  { id: 'ead35d80-93da-49ba-bb8d-156820a58258', status: 'new', updated_at: '2026-09-22T14:17:08.028857+00:00' },
];
const E21 = { venueId: KS_VENUE, aliasNormalized: 'ספרייה העירונית כפר סבא', keepAliases: ['ספריית הילדים והנוער כפר סבא', 'ספריית הילדים כפר סבא'] };

const pick = (row, keys) => Object.fromEntries(keys.map((k) => [k, row?.[k] ?? null]));
const diffFields = (row, expected) => Object.entries(expected).filter(([k, v]) => (row?.[k] ?? null) !== v).map(([k, v]) => `${k}: expected ${JSON.stringify(v)}, found ${JSON.stringify(row?.[k] ?? null)}`);
const stableJson = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((kk) => [kk, x[kk]])) : x));
const withoutVenueId = (ed) => { const { venue_id, ...rest } = ed; return rest; }; // eslint-disable-line no-unused-vars

async function readAll(client) {
  const one = async (table, id, cols = '*') => { const { data, error } = await client.from(table).select(cols).eq('id', id).maybeSingle(); if (error) throw error; return data; };
  const s = {};
  for (const e of ACTIVITY_EDITS) s[e.key] = await one('activities', e.id);
  s['E-3'] = await one('activities', E3.id);
  s['E-17'] = await one('sources', E17.id);
  s['E-2 location'] = await one('locations', E2_LOCATION.id);
  const { count: refs } = await client.from('activities').select('id', { count: 'exact', head: true }).eq('location_id', RH_LOCATION);
  s['E-2 location refs'] = refs;
  const { data: rhAliases, error: aErr } = await client.from('venue_aliases').select('alias, alias_normalized, venue_id, created_at').eq('venue_id', RH_VENUE);
  if (aErr) throw aErr;
  s['E-1 aliases'] = rhAliases;
  s.stale = [];
  for (const r of STALE_ROWS) s.stale.push(await one('incoming_activities', r.id, 'id, status, updated_at, extracted_data'));
  const { data: ksAliases, error: kErr } = await client.from('venue_aliases').select('alias, alias_normalized, venue_id, created_at').eq('venue_id', KS_VENUE);
  if (kErr) throw kErr;
  s['E-21 aliases'] = ksAliases;
  s['E-21 venue'] = await one('venues', KS_VENUE, 'id, name_he, venue_type, city, is_active, merged_into');
  const { count: ksActs } = await client.from('activities').select('id', { count: 'exact', head: true }).eq('venue_id', KS_VENUE);
  const { count: ksLocs } = await client.from('locations').select('id', { count: 'exact', head: true }).eq('venue_id', KS_VENUE);
  const { count: ksInc } = await client.from('incoming_activities').select('id', { count: 'exact', head: true }).eq('extracted_data->>venue_id', KS_VENUE);
  s['E-21 dependents'] = { activities: ksActs, locations: ksLocs, incoming: ksInc };
  // user-owned tables are invisible to the bot under RLS (count comes back null = UNKNOWN, never 0). The E-3 user
  // dependency proof therefore comes from an elevated read-only SELECT snapshot (--deps-snapshot=<json>, <= 30 min
  // old); a bot-visible non-zero count still blocks on its own.
  const deps = {};
  for (const t of ['favorites', 'planned_activities', 'visited_activities', 'hidden_activities', 'personal_notes', 'community_notes', 'activity_benefits']) {
    const { count } = await client.from(t).select('id', { count: 'exact', head: true }).eq('activity_id', E3.id); deps[t] = count;
  }
  const snapArg = (process.argv.find((a) => a.startsWith('--deps-snapshot=')) || '').split('=')[1];
  if (snapArg) {
    const snap = JSON.parse(fs.readFileSync(snapArg, 'utf8'));
    const ageMin = (Date.now() - Date.parse(snap.readAt)) / 60000;
    if (snap.activity_id !== E3.id || !(ageMin >= 0 && ageMin <= 30)) throw new Error(`deps snapshot is for ${snap.activity_id} / ${Math.round(ageMin)} min old - refresh it`);
    for (const [t, v] of Object.entries(deps)) if (v === null) deps[t] = snap.counts[t] ?? null;
    s['E-3 dependency snapshot'] = snap;
  }
  s['E-3 dependencies'] = deps;
  return s;
}

// -> list of drift strings (empty = every expectedOld holds) and the E-21 evidence verdict
function checkPlan(s) {
  const drift = [];
  for (const e of ACTIVITY_EDITS) { if (!s[e.key]) drift.push(`${e.key}: row not found`); else drift.push(...diffFields(s[e.key], e.expectedOld).map((d) => `${e.key}: ${d}`)); }
  if (!s['E-3']) drift.push('E-3: row not found'); else drift.push(...diffFields(s['E-3'], E3.expected).map((d) => `E-3: ${d}`));
  for (const [k, v] of Object.entries(s['E-3 dependencies'])) if (v !== 0) drift.push(`E-3: ${k}=${v} user-facing dependency`);
  if (!s['E-17']) drift.push('E-17: row not found'); else drift.push(...diffFields(s['E-17'], E17.expectedOld).map((d) => `E-17: ${d}`));
  if (!s['E-2 location']) drift.push('E-2 location: not found'); else drift.push(...diffFields(s['E-2 location'], E2_LOCATION.expectedOld).map((d) => `E-2 location: ${d}`));
  if (s['E-2 location refs'] !== E2_LOCATION.expectedReferences) drift.push(`E-2 location: ${s['E-2 location refs']} referencing activities, expected ${E2_LOCATION.expectedReferences}`);
  const rhNorm = s['E-1 aliases'].map((a) => a.alias_normalized).sort();
  const expectRh = [...E1_ALIASES, ...RH_SPECIFIC_ALIASES].sort();
  if (stableJson(rhNorm) !== stableJson(expectRh)) drift.push(`E-1: RH aliases ${JSON.stringify(rhNorm)}, expected ${JSON.stringify(expectRh)}`);
  s.stale.forEach((row, i) => {
    const exp = STALE_ROWS[i];
    if (!row) { drift.push(`RH stale ${exp.id.slice(0, 8)}: not found`); return; }
    if (row.status !== exp.status) drift.push(`RH stale ${exp.id.slice(0, 8)}: status ${row.status}, expected ${exp.status}`);
    if (row.updated_at !== exp.updated_at) drift.push(`RH stale ${exp.id.slice(0, 8)}: updated_at ${row.updated_at}, expected ${exp.updated_at}`);
    if (row.extracted_data?.venue_id !== RH_VENUE) drift.push(`RH stale ${exp.id.slice(0, 8)}: extracted_data.venue_id ${row.extracted_data?.venue_id}, expected ${RH_VENUE}`);
    if (normalizeVenueAlias(row.extracted_data?.location_name) !== 'ספרייה' || row.extracted_data?.city !== 'רמת השרון') drift.push(`RH stale ${exp.id.slice(0, 8)}: label/city no longer the generic RH library label`);
  });
  // E-21 evidence (skip, never drift-stop, when it no longer matches the recorded defect)
  const v = s['E-21 venue'];
  const ksNorm = s['E-21 aliases'].map((a) => a.alias_normalized);
  const e21 = [];
  if (!v || v.venue_type !== 'library' || v.name_he !== 'ספריית הילדים והנוער כפר סבא' || v.city !== 'כפר סבא' || !v.is_active || v.merged_into) e21.push('target venue is no longer the active Kfar Saba children\'s & youth library');
  if (ksNorm.filter((a) => a === E21.aliasNormalized).length !== 1) e21.push('the municipal-library alias row is not present exactly once');
  for (const k of E21.keepAliases) if (!ksNorm.includes(normalizeVenueAlias(k))) e21.push(`genuine children's alias "${k}" missing - picture changed`);
  const d = s['E-21 dependents'];
  if (d.activities || d.locations || d.incoming) e21.push(`rows rely on the venue (${JSON.stringify(d)}) - needs a human look`);
  return { drift, e21Evidence: e21, e21Apply: e21.length === 0 };
}

async function resolverSnapshot(client) {
  const q = async (locationName, city) => { const v = await resolveVenue(client, { locationName, city }); return v ? `${v.id.slice(0, 8)} ${v.name_he}` : null; };
  return {
    'ספרייה + רמת השרון': await q('ספרייה', 'רמת השרון'),
    'ספרייה עירונית + רמת השרון': await q('ספרייה עירונית', 'רמת השרון'),
    [`${RH_NAME} (specific)`]: await q(RH_NAME, 'רמת השרון'),
    'ספריית רמת השרון (specific)': await q('ספריית רמת השרון', 'רמת השרון'),
    'הספרייה העירונית כפר סבא + כפר סבא': await q('הספרייה העירונית כפר סבא', 'כפר סבא'),
    'ספרייה העירונית + כפר סבא (generic)': await q('ספרייה העירונית', 'כפר סבא'),
    'ספריית הילדים והנוער כפר סבא (specific)': await q('ספריית הילדים והנוער כפר סבא', 'כפר סבא'),
    'ספריית הילדים כפר סבא (specific)': await q('ספריית הילדים כפר סבא', 'כפר סבא'),
    'ספרייה עירונית + קריית אתא (E-22)': await q('ספרייה עירונית', 'קריית אתא'),
    'ספרייה + no city': await q('ספרייה', null),
  };
}

function plannedMutations(s, e21Apply) {
  const m = [];
  for (const e of ACTIVITY_EDITS) m.push({ key: e.key, table: 'activities', id: e.id, op: 'update', expectedOld: e.expectedOld, patch: e.patch, expectedRows: 1 });
  m.push({ key: 'E-3', table: 'activities', id: E3.id, op: 'archive_activity RPC', expectedStatus: 'approved', archiveReason: E3.reason, expectedRows: 1 });
  m.push({ key: 'E-17', table: 'sources', id: E17.id, op: 'update', expectedOld: E17.expectedOld, patch: E17.patch, expectedRows: 1 });
  m.push({ key: 'E-2 location', table: 'locations', id: E2_LOCATION.id, op: 'update', expectedOld: E2_LOCATION.expectedOld, patch: E2_LOCATION.patch, expectedRows: 1 });
  for (const a of E1_ALIASES) m.push({ key: 'E-1', table: 'venue_aliases', op: 'delete', match: { venue_id: RH_VENUE, alias_normalized: a }, expectedRows: 1 });
  s.stale.forEach((row, i) => m.push({ key: 'RH stale', table: 'incoming_activities', id: STALE_ROWS[i].id, op: 'update extracted_data: remove key venue_id only', expectedOld: { status: STALE_ROWS[i].status, updated_at: STALE_ROWS[i].updated_at, 'extracted_data->>venue_id': RH_VENUE }, path: 'extracted_data.venue_id', before: row.extracted_data.venue_id, after: '(key absent)', expectedRows: 1 }));
  if (e21Apply) m.push({ key: 'E-21', table: 'venue_aliases', op: 'delete', match: { venue_id: E21.venueId, alias_normalized: E21.aliasNormalized }, expectedRows: 1 });
  return m;
}

(async () => {
  const { client } = await getClient();
  const startedAt = new Date().toISOString();
  console.log(`=== ${TAG} (${APPLY ? 'APPLY' : 'DRY RUN'}) ${startedAt} ===`);
  const s = await readAll(client);
  const { drift, e21Evidence, e21Apply } = checkPlan(s);
  const mutations = plannedMutations(s, e21Apply);
  const rollback = {
    note: 'original rows before any write - restore field-by-field with the same guards (expect the patched values as expectedOld)',
    activities: Object.fromEntries([...ACTIVITY_EDITS.map((e) => [e.id, pick(s[e.key], Object.keys({ ...e.expectedOld, ...e.patch }))]), [E3.id, pick(s['E-3'], ['status', 'archive_reason', 'archived_at', 'name', 'category'])]]),
    sources: { [E17.id]: pick(s['E-17'], ['name', 'publisher_name', 'is_active', 'updated_at']) },
    locations: { [E2_LOCATION.id]: pick(s['E-2 location'], ['name', 'city', 'venue_id']) },
    venue_aliases_deleted: [...s['E-1 aliases'].filter((a) => E1_ALIASES.includes(a.alias_normalized)), ...(e21Apply ? s['E-21 aliases'].filter((a) => a.alias_normalized === E21.aliasNormalized) : [])],
    incoming_extracted_data: Object.fromEntries(s.stale.map((r) => [r.id, { status: r.status, updated_at: r.updated_at, extracted_data: r.extracted_data }])),
    e3_archive_undo: 'status approved->archived was done by archive_activity RPC; undo needs elevated exact-ID SQL: update activities set status=\'approved\', archive_reason=null, archived_at=null where id=\'' + E3.id + '\' and status=\'archived\' and archive_reason=\'' + E3.reason + '\'',
  };
  const report = { tag: TAG, generatedAt: startedAt, applied: APPLY, drift, e21: { apply: e21Apply, evidenceProblems: e21Evidence }, mutations, resolverBefore: await resolverSnapshot(client), results: [], stoppedAt: null };
  console.log('drift:', drift.length ? drift : 'none');
  console.log(`E-21: ${e21Apply ? 'evidence still matches the recorded defect -> delete' : 'SKIP (NEEDS_HUMAN_DECISION): ' + e21Evidence.join('; ')}`);
  mutations.forEach((m, i) => console.log(`  ${String(i + 1).padStart(2)}. ${m.key.padEnd(13)} ${m.table.padEnd(19)} ${m.op}${m.id ? ' ' + m.id.slice(0, 8) : ''}${m.match ? ' ' + JSON.stringify(m.match) : ''}${m.patch ? ' -> ' + JSON.stringify(m.patch) : ''}  [expect ${m.expectedRows} row]`));
  console.log('resolver before:', report.resolverBefore);
  fs.mkdirSync(REPORTS, { recursive: true });
  const out = (suffix, obj) => { const f = path.join(REPORTS, `${TAG}-${suffix}.json`); fs.writeFileSync(f, JSON.stringify(obj, null, 2)); return f; };

  if (drift.length) { report.stoppedAt = 'preflight drift - no write'; console.log('STOP: drift, no write'); out(APPLY ? 'applied' : 'dryrun', report); process.exitCode = 2; return; }
  if (!APPLY) { report.rollbackPreview = rollback; console.log('\nreport ->', path.basename(out('dryrun', report))); return; }

  console.log('rollback ->', path.basename(out('rollback', { tag: TAG, writtenAt: new Date().toISOString(), ...rollback })));
  const record = (m, ok, detail) => { report.results.push({ key: m.key, table: m.table, id: m.id || null, match: m.match || null, ok, detail, at: new Date().toISOString() }); console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${m.key.padEnd(13)} ${detail}`); if (!ok) report.stoppedAt = m.key; return ok; };
  const readBack = async (table, id, cols) => (await client.from(table).select(cols).eq('id', id).maybeSingle()).data;

  for (const m of mutations) {
    if (m.op === 'update' && m.table !== 'incoming_activities') {
      const r = await verifiedConditionalUpdate(client, { table: m.table, id: m.id, patch: m.patch, expectedOld: m.expectedOld });
      if (!isSuccess(r) || r.rows !== 1) { record(m, false, describe(r)); break; }
      const back = await readBack(m.table, m.id, '*');
      const bad = diffFields(back, m.patch);
      if (!record(m, bad.length === 0, bad.length ? 'read-back mismatch: ' + bad.join('; ') : `updated 1 row, read-back ${JSON.stringify(pick(back, Object.keys(m.patch)))}`)) break;
      if (m.key === 'E-2 location') {
        const { count } = await client.from('activities').select('id', { count: 'exact', head: true }).eq('location_id', m.id);
        if (!record({ key: 'E-2 refs', table: 'activities' }, count === E2_LOCATION.expectedReferences, `${count} activities still reference the location`)) break;
      }
    } else if (m.op === 'archive_activity RPC') {
      const fresh = await readBack('activities', m.id, 'status, category, name');
      const pre = diffFields(fresh, E3.expected);
      if (pre.length) { record(m, false, 'precondition changed: ' + pre.join('; ')); break; }
      const r = await archiveActivity(client, { activityId: m.id, expectedStatus: 'approved', archiveReason: m.archiveReason });
      if (!isArchived(r)) { record(m, false, describeArchive(r)); break; }
      const back = await readBack('activities', m.id, 'status, archive_reason, archived_at');
      if (!record(m, back.status === 'archived' && back.archive_reason === m.archiveReason, `archived, read-back ${JSON.stringify(back)}`)) break;
    } else if (m.op === 'delete') {
      let q = client.from(m.table).delete();
      for (const [k, v] of Object.entries(m.match)) q = q.eq(k, v);
      const { data, error } = await q.select('alias, alias_normalized, venue_id, created_at');
      if (error || !data || data.length !== m.expectedRows) { record(m, false, `delete affected ${data ? data.length : 'error'} row(s), expected ${m.expectedRows}${error ? ' - ' + error.message : ''}`); break; }
      let chk = client.from(m.table).select('alias_normalized');
      for (const [k, v] of Object.entries(m.match)) chk = chk.eq(k, v);
      const { data: left } = await chk;
      if (!record(m, (left || []).length === 0, `deleted ${JSON.stringify(data[0])}, read-back ${(left || []).length} remaining`)) break;
    } else if (m.table === 'incoming_activities') {
      const i = STALE_ROWS.findIndex((r) => r.id === m.id);
      const before = s.stale[i];
      const fresh = await readBack('incoming_activities', m.id, 'id, status, updated_at, extracted_data');
      if (!fresh || fresh.updated_at !== before.updated_at || stableJson(fresh.extracted_data) !== stableJson(before.extracted_data)) { record(m, false, 'row changed since preflight read'); break; }
      const wanted = withoutVenueId(before.extracted_data);
      const r = await verifiedFieldUpdate(client, {
        table: 'incoming_activities', id: m.id,
        patch: { extracted_data: wanted, updated_at: new Date().toISOString() },
        applyGuard: (q) => q.eq('status', before.status).eq('updated_at', before.updated_at).eq('extracted_data->>venue_id', RH_VENUE),
        guardStillHolds: (row) => row.status === before.status && row.updated_at === before.updated_at && row.extracted_data?.venue_id === RH_VENUE,
        alreadySatisfied: (row) => !('venue_id' in (row.extracted_data || {})),
      });
      if (!isSuccess(r) || r.rows !== 1) { record(m, false, describe(r)); break; }
      const back = await readBack('incoming_activities', m.id, 'status, extracted_data');
      const ok = back.status === before.status && !('venue_id' in back.extracted_data) && stableJson(back.extracted_data) === stableJson(wanted);
      if (!record(m, ok, ok ? `extracted_data.venue_id removed; ${Object.keys(back.extracted_data).length} other keys byte-identical; status ${back.status}` : 'read-back mismatch')) break;
    }
  }
  report.resolverAfter = await resolverSnapshot(client);
  report.finishedAt = new Date().toISOString();
  console.log('resolver after:', report.resolverAfter);
  console.log('\nreport ->', path.basename(out('applied', report)));
  if (report.stoppedAt) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
