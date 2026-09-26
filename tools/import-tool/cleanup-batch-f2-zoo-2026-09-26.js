// TuRu - Repair Batch F Part 2 (2026-09-26): Jerusalem Zoo venue consolidation (ledger E-5, E-6, E-16), the exact
// mutation manifest of the READ-ONLY preflight (REPAIR-BATCH-F-PART2-ZOO-PREFLIGHT-2026-09-26), after 0114
// (venues.google_place_id UNIQUE) and the merge place-id invariant (8dedcb5). Owner decisions: keeper e254dab3;
// merge 287600a2 then 6b785f3c; keeper lat/lng := the HIGH operator-map pair (address untouched); fingerprint
// normalisation SKIPPED (no event carries v:<loser>; the stored c:ירושלים forms stay matchable through scan-source's
// dual venue/city probe); E-6 keeper place f3a2a32a, archive 3dc25beb (no rename, no price/min_age copy - follow-up
// only); E-16 reject 732ec7ae / 83a87847 / d0806120, HOLD_HUMAN 2538d1be / 83da1a99 (no write).
//
// The merge replicates server.js /api/venues/merge with PER-ID guarded updates (never the `.eq('venue_id', loser)` set
// predicate): place-id step first (planPlaceIdMerge must be NONE - all three ids are null), exact re-points, keeper
// alias for the loser's name, loser is_active=false + merged_into=keeper. Loser alias rows stay (inert).
//
//   node cleanup-batch-f2-zoo-2026-09-26.js --deps-snapshot=<json>            (dry run, default)
//   node cleanup-batch-f2-zoo-2026-09-26.js --deps-snapshot=<json> --apply    (execute)
// <json> = { activity_id: 3dc25beb..., readAt, counts } from an elevated READ-ONLY SELECT (the bot cannot see user-owned
// rows); without it the E-6 dependency check is UNKNOWN and the batch stops.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { verifiedConditionalUpdate, isSuccess, describe } = require('./lib/verifiedWrite');
const { archiveActivity, isArchived, describe: describeArchive } = require('./lib/activityArchive');
const { planPlaceIdMerge } = require('./lib/venuePlaceId');
const { resolveVenue, normalizeVenueAlias } = require('./venueNaming');
const { withoutGenericAliases } = require('./venueLearning');

const APPLY = process.argv.includes('--apply');
const TAG = 'cleanup-batch-f2-zoo-2026-09-26';
const REPORTS = path.join(__dirname, 'reports');
const BOT = 'a632e473-aff1-47bc-97c7-b39e5d39f2b7';

const KEEPER = 'e254dab3-2fff-48e9-b793-9824f08af119';
const HIGH = { lat: 31.7461139, lng: 35.1766343 };
const VENUES = {
  [KEEPER]: { updated_at: '2026-09-24T12:08:05.819+00:00', lat: 31.7448338, lng: 35.1781123, address: 'יצחק מודעי', is_active: true, merged_into: null, google_place_id: null },
  '287600a2-96ba-4a70-8caf-5963114d2c90': { updated_at: '2026-09-18T16:45:22.165+00:00', is_active: true, merged_into: null, google_place_id: null },
  '6b785f3c-af9e-4404-b0e2-ee508ae554c8': { updated_at: '2026-09-17T18:29:11.268+00:00', is_active: true, merged_into: null, google_place_id: null },
};
const MERGES = [
  { loser: '287600a2-96ba-4a70-8caf-5963114d2c90', label: 'A',
    activities: { 'c8266cb1-3d7e-455c-9da1-32f896dd808a': 'approved', 'e3cefe7e-0bdc-4dd6-b192-0ac2c76731e1': 'approved', 'e6ded2da-3e99-41a0-9976-51303a720c65': 'approved' },
    locations: ['b6481dfa-f4ad-4d0e-9ac2-9de582f08981'], alias: 'גן החיות התנ״כי בירושלים', aliasNormalized: 'גן החיות התנכי בירושלים' },
  { loser: '6b785f3c-af9e-4404-b0e2-ee508ae554c8', label: 'B',
    activities: { 'f3a2a32a-e133-47aa-bb25-b364b29c62cb': 'approved', '1d0b5b3e-9fc3-4f4c-9b58-25e1ba2a3ba9': 'approved', '14895359-5b80-4d39-98c3-fde0104dfe06': 'approved', 'd22e9612-8f3a-4b0a-bf31-2d4dbf00e301': 'archived' },
    locations: ['4b634be9-a9f7-4f8d-8591-0c8f252751c8'], alias: 'גן החיות ואקווריום ישראל', aliasNormalized: 'גן החיות ואקווריום ישראל' },
];
const KEEPER_BEFORE = { activities: ['3dc25beb-723b-41ad-8158-24e6441cfaa8', '8cceeb9b-8456-4846-890d-1aa3dba4fd66'], locations: ['a96f3129-59a5-41ba-9a00-00ae2d56a007'],
  sources: ['04e6583f', '0805c358', '4edbe5f0'], aliases: ['גן החיות התנכי', 'גן החיות התנכי ואקווריום ישראל', 'גן החיות התנכי ירושלים', 'הגן הזואולוגי התנכי'] };
// the six inspected event fingerprints - verified byte-identical, NEVER written (normalisation skipped by owner decision)
const FINGERPRINTS = {
  'c8266cb1-3d7e-455c-9da1-32f896dd808a': 'האכלות והעשרות בעלי חיים|c:ירושלים|ראשון,שני,שלישי,רביעי,חמישי,שישי,שבת|10:00',
  'e3cefe7e-0bdc-4dd6-b192-0ac2c76731e1': 'מפגשים מקרוב עם בעלי חיים בבית חי|c:ירושלים|שישי,שבת|11:00',
  'e6ded2da-3e99-41a0-9976-51303a720c65': 'שעת סיפור גבי הפיל ופילון או שירלי השימפנזה|c:ירושלים|ראשון,שבת|13:00',
  '1d0b5b3e-9fc3-4f4c-9b58-25e1ba2a3ba9': 'מפגש חשיפה חוגי טבע|c:ירושלים|2026-10-05|',
  'd22e9612-8f3a-4b0a-bf31-2d4dbf00e301': 'תנועת נח יום חשיפה|c:ירושלים|2026-09-16|',
  '14895359-5b80-4d39-98c3-fde0104dfe06': null,
};
const E6 = { archive: '3dc25beb-723b-41ad-8158-24e6441cfaa8', keeper: 'f3a2a32a-e133-47aa-bb25-b364b29c62cb', reason: 'duplicate_of_existing_activity' };
const E16_REJECT = [
  { id: '732ec7ae-e44d-438d-a744-b44e97df34ec', existing: 'b285346c-4fad-4005-8065-8382b3567004', updated_at: '2026-09-20T17:30:31.724112+00:00',
    patch: { status: 'rejected', reject_reason: 'הוכרע כאזור בתוך אתר (מדבריום) - לא נוצרת פעילות עצמאית' }, why: 'REJECT_SUB_ATTRACTION (Midbarium savanna zone)' },
  { id: '83a87847-9256-464b-8256-87edf7327db0', existing: E6.archive, updated_at: '2026-09-13T17:17:40.119663+00:00',
    patch: { status: 'rejected', archive_reason: 'duplicate_of_existing_activity', reject_reason: `כפילות מאומתת - המקום הוא ${E6.keeper}` }, why: 'REJECT_DUPLICATE_PLACE (zoo place, canonical f3a2a32a after E-6)' },
  { id: 'd0806120-7902-4bd5-ad77-82ffd31cee9f', existing: '8975d402-16cd-4793-b839-4ed9de5d2c72', updated_at: '2026-09-13T11:01:35.864222+00:00',
    patch: { status: 'rejected', archive_reason: 'duplicate_of_existing_activity', reject_reason: 'כפילות מאומתת - המקום הוא fb452020-d834-4f32-8c2e-988d0367b36d' }, why: 'REJECT_DUPLICATE_PLACE (Midbarium, canonical fb452020)' },
];
const HOLD = { '2538d1be-ac73-4245-a87b-0ae325596665': '2026-09-20T17:30:31.658366+00:00', '83da1a99-2bd7-4bbd-aba6-086874f01c76': '2026-09-20T17:30:24.855284+00:00' };
const ZOO_LABELS = ['גן החיות התנ״כי', 'גן החיות התנ״כי בירושלים', 'גן החיות ואקווריום ישראל', 'גן החיות התנ״כי ואקווריום ישראל'];

const sorted = (a) => [...a].sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const diffFields = (row, expected) => Object.entries(expected).filter(([k, v]) => (row?.[k] ?? null) !== v).map(([k, v]) => `${k}: expected ${JSON.stringify(v)}, found ${JSON.stringify(row?.[k] ?? null)}`);
const pick = (row, keys) => Object.fromEntries(keys.map((k) => [k, row?.[k] ?? null]));

async function readAll(client) {
  const s = { venues: {}, pointers: {}, aliases: {} };
  const { data: vs, error } = await client.from('venues').select('*').in('id', Object.keys(VENUES));
  if (error) throw error;
  for (const v of vs || []) s.venues[v.id] = v;
  for (const id of Object.keys(VENUES)) {
    const [a, l, src, al] = await Promise.all([
      client.from('activities').select('id, status, venue_id, created_by, event_fingerprint').eq('venue_id', id),
      client.from('locations').select('id, venue_id').eq('venue_id', id),
      client.from('sources').select('id, venue_id').eq('venue_id', id),
      client.from('venue_aliases').select('alias, alias_normalized, venue_id, created_at').eq('venue_id', id),
    ]);
    for (const r of [a, l, src, al]) if (r.error) throw r.error;
    s.pointers[id] = { activities: a.data, locations: l.data, sources: src.data };
    s.aliases[id] = al.data;
  }
  const { data: fps } = await client.from('activities').select('id, event_fingerprint').in('id', Object.keys(FINGERPRINTS));
  s.fingerprints = Object.fromEntries((fps || []).map((r) => [r.id, r.event_fingerprint]));
  const { data: e6 } = await client.from('activities').select('id, status, venue_id, name, price_amount, price_type, min_age, archive_reason, created_by').in('id', [E6.archive, E6.keeper]);
  s.e6 = Object.fromEntries((e6 || []).map((r) => [r.id, r]));
  const { data: inc } = await client.from('incoming_activities').select('id, status, existing_activity_id, reject_reason, archive_reason, reviewed_by, reviewed_at, updated_at').in('id', [...E16_REJECT.map((r) => r.id), ...Object.keys(HOLD)]);
  s.incoming = Object.fromEntries((inc || []).map((r) => [r.id, r]));
  const deps = {};
  for (const t of ['favorites', 'planned_activities', 'visited_activities', 'hidden_activities', 'personal_notes', 'community_notes', 'activity_benefits', 'dismissed_issues']) {
    const { count } = await client.from(t).select('id', { count: 'exact', head: true }).eq('activity_id', E6.archive); deps[t] = count; // null = invisible to the bot = UNKNOWN
  }
  const snapArg = (process.argv.find((a) => a.startsWith('--deps-snapshot=')) || '').split('=')[1];
  if (snapArg) {
    const snap = JSON.parse(fs.readFileSync(snapArg, 'utf8'));
    const ageMin = (Date.now() - Date.parse(snap.readAt)) / 60000;
    if (snap.activity_id !== E6.archive || !(ageMin >= 0 && ageMin <= 30)) throw new Error(`deps snapshot is for ${snap.activity_id} / ${Math.round(ageMin)} min old - refresh it`);
    for (const [t, v] of Object.entries(deps)) if (v === null) deps[t] = snap.counts[t] ?? null;
    s.depsSnapshot = snap;
  }
  s.e6Deps = deps;
  return s;
}

function checkPlan(s) {
  const d = [];
  for (const [id, exp] of Object.entries(VENUES)) {
    const v = s.venues[id];
    if (!v) { d.push(`venue ${id.slice(0, 8)} missing`); continue; }
    d.push(...diffFields(v, exp).map((x) => `venue ${id.slice(0, 8)}: ${x}`));
  }
  for (const m of MERGES) {
    const p = s.pointers[m.loser];
    if (!same(p.activities.map((a) => a.id), Object.keys(m.activities))) d.push(`loser ${m.label}: activity set ${JSON.stringify(p.activities.map((a) => a.id.slice(0, 8)))}`);
    for (const a of p.activities) {
      if (m.activities[a.id] && a.status !== m.activities[a.id]) d.push(`${a.id.slice(0, 8)}: status ${a.status}, expected ${m.activities[a.id]}`);
      if (a.created_by !== BOT) d.push(`${a.id.slice(0, 8)}: created_by ${a.created_by} - bot RLS cannot update it`);
    }
    if (!same(p.locations.map((l) => l.id), m.locations)) d.push(`loser ${m.label}: location set ${JSON.stringify(p.locations.map((l) => l.id.slice(0, 8)))}`);
    if (p.sources.length) d.push(`loser ${m.label}: ${p.sources.length} source pointer(s) - not in the reviewed plan`);
    if (!same(s.aliases[m.loser].map((a) => a.alias_normalized), [m.aliasNormalized])) d.push(`loser ${m.label}: aliases ${JSON.stringify(s.aliases[m.loser].map((a) => a.alias_normalized))}`);
    if (normalizeVenueAlias(m.alias) !== m.aliasNormalized) d.push(`alias normalization drift for ${m.alias}`);
    if (withoutGenericAliases([{ alias: m.alias, alias_normalized: m.aliasNormalized }]).dropped.length) d.push(`alias ${m.alias} is generic - merge would not carry it`);
    const plan = planPlaceIdMerge(s.venues[KEEPER] || {}, s.venues[m.loser] || {});
    if (plan.action !== 'NONE') d.push(`place-id merge plan for ${m.label} is ${plan.action}, expected NONE - do not improvise`);
  }
  const kp = s.pointers[KEEPER];
  if (!same(kp.activities.map((a) => a.id), KEEPER_BEFORE.activities)) d.push(`keeper activity set ${JSON.stringify(kp.activities.map((a) => a.id.slice(0, 8)))}`);
  if (!same(kp.locations.map((l) => l.id), KEEPER_BEFORE.locations)) d.push('keeper location set drifted');
  if (!same(kp.sources.map((x) => x.id.slice(0, 8)), KEEPER_BEFORE.sources)) d.push('keeper source set drifted');
  if (!same(s.aliases[KEEPER].map((a) => a.alias_normalized), KEEPER_BEFORE.aliases)) d.push(`keeper aliases ${JSON.stringify(s.aliases[KEEPER].map((a) => a.alias_normalized))}`);
  for (const [id, fp] of Object.entries(FINGERPRINTS)) if ((s.fingerprints[id] ?? null) !== fp) d.push(`fingerprint ${id.slice(0, 8)} drifted: ${s.fingerprints[id]}`);
  const a = s.e6[E6.archive], k = s.e6[E6.keeper];
  if (!a || a.status !== 'approved' || a.venue_id !== KEEPER) d.push(`E-6 archive target ${JSON.stringify(a && pick(a, ['status', 'venue_id']))}`);
  if (!k || k.status !== 'approved' || k.venue_id !== MERGES[1].loser) d.push(`E-6 keeper ${JSON.stringify(k && pick(k, ['status', 'venue_id']))}`);
  for (const [t, v] of Object.entries(s.e6Deps)) if (v !== 0) d.push(`E-6: ${t}=${v === null ? 'UNKNOWN (needs --deps-snapshot)' : v}`);
  for (const r of E16_REJECT) {
    const row = s.incoming[r.id];
    if (!row) { d.push(`E-16 ${r.id.slice(0, 8)} missing`); continue; }
    d.push(...diffFields(row, { status: 'needs_review', existing_activity_id: r.existing, updated_at: r.updated_at, reject_reason: null, reviewed_by: null }).map((x) => `E-16 ${r.id.slice(0, 8)}: ${x}`));
  }
  for (const [id, upd] of Object.entries(HOLD)) { const row = s.incoming[id]; if (!row || row.status !== 'needs_review' || row.updated_at !== upd) d.push(`HOLD ${id.slice(0, 8)} drifted`); }
  return d;
}

function plannedMutations() {
  const m = [];
  m.push({ key: 'keeper coords', table: 'venues', id: KEEPER, expectedOld: { lat: VENUES[KEEPER].lat, lng: VENUES[KEEPER].lng, is_active: true, merged_into: null, google_place_id: null, updated_at: VENUES[KEEPER].updated_at }, patch: { ...HIGH }, bumpUpdatedAt: true });
  for (const g of MERGES) {
    m.push({ key: `merge ${g.label} place-id`, op: 'assert_place_id_null', loser: g.loser });
    for (const [id, status] of Object.entries(g.activities)) m.push({ key: `merge ${g.label} activity`, table: 'activities', id, expectedOld: { venue_id: g.loser, status }, patch: { venue_id: KEEPER } });
    for (const id of g.locations) m.push({ key: `merge ${g.label} location`, table: 'locations', id, expectedOld: { venue_id: g.loser }, patch: { venue_id: KEEPER } });
    m.push({ key: `merge ${g.label} alias`, op: 'alias_insert', row: { alias: g.alias, alias_normalized: g.aliasNormalized, venue_id: KEEPER } });
    m.push({ key: `merge ${g.label} loser flag`, table: 'venues', id: g.loser, expectedOld: { is_active: true, merged_into: null, google_place_id: null, updated_at: VENUES[g.loser].updated_at }, patch: { is_active: false, merged_into: KEEPER }, bumpUpdatedAt: true });
  }
  m.push({ key: 'pointer assertions', op: 'assert_pointers' });
  m.push({ key: 'fingerprints', op: 'assert_fingerprints' });
  m.push({ key: 'E-6', op: 'archive', id: E6.archive, keeper: E6.keeper, reason: E6.reason });
  for (const r of E16_REJECT) m.push({ key: 'E-16', table: 'incoming_activities', id: r.id, why: r.why, expectedOld: { status: 'needs_review', existing_activity_id: r.existing, updated_at: r.updated_at, reject_reason: null, reviewed_by: null }, patch: { ...r.patch, reviewed_by: BOT } , stampReviewedAt: true });
  m.push({ key: 'HOLD_HUMAN', op: 'assert_hold' });
  return m;
}

const writes = (m) => m.filter((x) => x.table || x.op === 'alias_insert' || x.op === 'archive');

(async () => {
  const { client } = await getClient();
  const startedAt = new Date().toISOString();
  console.log(`=== ${TAG} (${APPLY ? 'APPLY' : 'DRY RUN'}) ${startedAt} ===`);
  const s = await readAll(client);
  const drift = checkPlan(s);
  const mutations = plannedMutations();
  const resolve = async () => Object.fromEntries(await Promise.all(ZOO_LABELS.map(async (l) => { const v = await resolveVenue(client, { locationName: l, city: 'ירושלים' }); return [l, v ? `${v.id.slice(0, 8)} ${v.name_he}` : null]; })));
  const rollback = {
    note: 'pre-state of every row this batch writes; restore with the same guards inverted (expectedOld = the batch\'s patch values)',
    venues: Object.fromEntries(Object.keys(VENUES).map((id) => [id, pick(s.venues[id], ['lat', 'lng', 'address', 'is_active', 'merged_into', 'google_place_id', 'updated_at'])])),
    activities_venue_id: Object.fromEntries(MERGES.flatMap((g) => Object.keys(g.activities).map((id) => [id, g.loser]))),
    locations_venue_id: Object.fromEntries(MERGES.flatMap((g) => g.locations.map((id) => [id, g.loser]))),
    venue_aliases_added: MERGES.map((g) => ({ alias_normalized: g.aliasNormalized, venue_id: KEEPER, rollback: 'delete by PK (alias_normalized, venue_id)' })),
    e6_archive: { id: E6.archive, pre: pick(s.e6[E6.archive], ['status', 'archive_reason']), undo: `admin-only elevated SQL: update activities set status='approved', archive_reason=null, archived_at=null where id='${E6.archive}' and status='archived' and archive_reason='${E6.reason}'` },
    incoming: Object.fromEntries(E16_REJECT.map((r) => [r.id, pick(s.incoming[r.id], ['status', 'existing_activity_id', 'reject_reason', 'archive_reason', 'reviewed_by', 'reviewed_at', 'updated_at'])])),
    fingerprints_unchanged: FINGERPRINTS,
  };
  const followUp = { e6_keeper_fill_candidates: { activity: E6.keeper, from_archived_duplicate: E6.archive, price_amount: s.e6[E6.archive]?.price_amount ?? null, price_type: s.e6[E6.archive]?.price_type ?? null, min_age: s.e6[E6.archive]?.min_age ?? null, note: 'NOT copied (owner decision) - fill-if-null candidate for a separate decision' },
    semantic_duplicate_pair_for_dedupe_queue: ['e6ded2da-3e99-41a0-9976-51303a720c65', '8cceeb9b-8456-4846-890d-1aa3dba4fd66'],
    keeper_address: 'unchanged (יצחק מודעי is a MEDIUM reverse geocode of the OLD point) - let the Cleaner incomplete_address path re-geocode the new point later' };
  const report = { tag: TAG, generatedAt: startedAt, applied: APPLY, drift, mutations, writeCount: writes(mutations).length, resolverBefore: await resolve(), followUp, results: [], stoppedAt: null };
  console.log('drift:', drift.length ? drift : 'none');
  mutations.forEach((m, i) => console.log(`  ${String(i + 1).padStart(2)}. ${m.key.padEnd(22)} ${m.table ? `${m.table} ${m.id.slice(0, 8)} ${JSON.stringify(m.patch)}` : m.op + (m.row ? ' ' + JSON.stringify(m.row) : '') + (m.id ? ' ' + m.id.slice(0, 8) : '')}`));
  console.log(`writes planned: ${report.writeCount}`);
  fs.mkdirSync(REPORTS, { recursive: true });
  const out = (suffix, obj) => { const f = path.join(REPORTS, `${TAG}-${suffix}.json`); fs.writeFileSync(f, JSON.stringify(obj, null, 2)); return f; };
  if (drift.length) { report.stoppedAt = 'preflight drift - no write'; console.log('STOP: drift, no write'); out(APPLY ? 'applied' : 'dryrun', report); process.exitCode = 2; return; }
  if (!APPLY) { report.rollbackPreview = rollback; console.log('resolver before:', report.resolverBefore); console.log('\nreport ->', path.basename(out('dryrun', report))); return; }

  console.log('rollback ->', path.basename(out('rollback', { tag: TAG, writtenAt: new Date().toISOString(), ...rollback })));
  const record = (m, ok, detail) => { report.results.push({ key: m.key, id: m.id || null, ok, detail, at: new Date().toISOString() }); console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${m.key.padEnd(22)} ${m.id ? m.id.slice(0, 8) + ' ' : ''}${detail}`); if (!ok) report.stoppedAt = `${m.key} ${m.id || ''}`.trim(); return ok; };
  const one = async (table, id, cols = '*') => (await client.from(table).select(cols).eq('id', id).maybeSingle()).data;
  const count = async (table, col, val) => (await client.from(table).select('id', { count: 'exact', head: true }).eq(col, val)).count;

  for (const m of mutations) {
    if (m.table) {
      const patch = { ...m.patch, ...(m.bumpUpdatedAt ? { updated_at: new Date().toISOString() } : {}), ...(m.stampReviewedAt ? { reviewed_at: new Date().toISOString() } : {}) };
      const r = await verifiedConditionalUpdate(client, { table: m.table, id: m.id, patch, expectedOld: m.expectedOld });
      if (!isSuccess(r) || r.rows !== 1) { record(m, false, describe(r)); break; }
      const back = await one(m.table, m.id);
      const bad = diffFields(back, m.patch);
      if (m.key === 'keeper coords' && back.address !== VENUES[KEEPER].address) bad.push('address changed');
      if (!record(m, bad.length === 0, bad.length ? 'read-back mismatch: ' + bad.join('; ') : `1 row, read-back ${JSON.stringify(pick(back, Object.keys(m.patch)))}`)) break;
    } else if (m.op === 'assert_place_id_null') {
      const [k, l] = [await one('venues', KEEPER), await one('venues', m.loser)];
      const plan = planPlaceIdMerge(k, l);
      if (!record(m, k.google_place_id === null && l.google_place_id === null && plan.action === 'NONE' && l.is_active && !l.merged_into, `keeper/loser google_place_id null, planPlaceIdMerge=${plan.action}`)) break;
    } else if (m.op === 'alias_insert') {
      const { data, error } = await client.from('venue_aliases').upsert([m.row], { onConflict: 'alias_normalized,venue_id', ignoreDuplicates: true }).select('alias, alias_normalized, venue_id');
      if (error || !data || data.length !== 1) { record(m, false, `alias upsert returned ${data ? data.length : 'error'} row(s)${error ? ' - ' + error.message : ''} (expected 1 new row)`); break; }
      const { data: back } = await client.from('venue_aliases').select('alias_normalized').eq('venue_id', KEEPER).eq('alias_normalized', m.row.alias_normalized);
      if (!record(m, (back || []).length === 1, `alias "${m.row.alias}" [${m.row.alias_normalized}] on keeper`)) break;
    } else if (m.op === 'assert_pointers') {
      const res = {};
      for (const g of MERGES) for (const t of ['activities', 'locations', 'sources']) res[`${t}@${g.label}`] = await count(t, 'venue_id', g.loser);
      for (const t of ['activities', 'locations', 'sources']) res[`${t}@keeper`] = await count(t, 'venue_id', KEEPER);
      const { data: al } = await client.from('venue_aliases').select('alias_normalized').eq('venue_id', KEEPER);
      res['aliases@keeper'] = (al || []).length;
      const losers = await Promise.all(MERGES.map((g) => one('venues', g.loser)));
      const keeper = await one('venues', KEEPER);
      const ok = MERGES.every((g) => res[`activities@${g.label}`] === 0 && res[`locations@${g.label}`] === 0 && res[`sources@${g.label}`] === 0)
        && res['activities@keeper'] === 9 && res['locations@keeper'] === 3 && res['sources@keeper'] === 3 && res['aliases@keeper'] === 6
        && losers.every((l) => l.is_active === false && l.merged_into === KEEPER && l.google_place_id === null) && keeper.google_place_id === null && keeper.is_active;
      if (!record(m, ok, JSON.stringify(res))) break;
    } else if (m.op === 'assert_fingerprints') {
      const { data } = await client.from('activities').select('id, event_fingerprint').in('id', Object.keys(FINGERPRINTS));
      const bad = (data || []).filter((r) => (r.event_fingerprint ?? null) !== FINGERPRINTS[r.id]).map((r) => r.id.slice(0, 8));
      if (!record(m, (data || []).length === 6 && bad.length === 0, bad.length ? 'CHANGED: ' + bad.join(',') : '6/6 byte-identical (no fingerprint write)')) break;
    } else if (m.op === 'archive') {
      const [a, k] = [await one('activities', m.id, 'status, venue_id'), await one('activities', m.keeper, 'status, venue_id')];
      if (a?.status !== 'approved' || a?.venue_id !== KEEPER || k?.status !== 'approved' || k?.venue_id !== KEEPER) { record(m, false, `precondition: archive=${JSON.stringify(a)} keeper=${JSON.stringify(k)}`); break; }
      const r = await archiveActivity(client, { activityId: m.id, expectedStatus: 'approved', archiveReason: m.reason, keeperActivityId: m.keeper });
      if (!isArchived(r)) { record(m, false, describeArchive(r)); break; }
      const back = await one('activities', m.id, 'status, archive_reason, archived_at');
      if (!record(m, back.status === 'archived' && back.archive_reason === m.reason && !!back.archived_at, `archived, read-back ${JSON.stringify(back)}; keeper ${m.keeper.slice(0, 8)} approved`)) break;
    } else if (m.op === 'assert_hold') {
      const { data } = await client.from('incoming_activities').select('id, status, updated_at').in('id', Object.keys(HOLD));
      const ok = (data || []).length === 2 && data.every((r) => r.status === 'needs_review' && r.updated_at === HOLD[r.id]);
      if (!record(m, ok, `2538d1be + 83da1a99 untouched: ${JSON.stringify((data || []).map((r) => r.status))}`)) break;
    }
  }
  report.resolverAfter = await resolve();
  report.finishedAt = new Date().toISOString();
  console.log('resolver before:', report.resolverBefore);
  console.log('resolver after: ', report.resolverAfter);
  console.log('\nreport ->', path.basename(out('applied', report)));
  if (report.stoppedAt) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
