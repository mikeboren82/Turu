// MISSING_CITY (0094) - the Cleaner case for "published + coordinates + no canonical city", and the
// shared canonical settlement resolver it depends on. Letters refer to the brief's test list (A-M).
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSettlementIndex, resolveSettlement, isMissingCity, isAdministrativeArea, centroidCheck } = require('../lib/canonicalSettlement');
const { proposeCity, settlementFromAddress } = require('../cleaner/cityResolver');
const { discoverCases, upsertCases } = require('../cleaner/discover');
const { applyCityToActivity } = require('../cleaner/apply');

const SETTLEMENTS = [
  { settlement_id: '7100', name_he: 'אשקלון', name_en: 'ASHQELON', region: 'אשקלון', population: 150000, lat: 31.6688, lng: 34.5743 },
  { settlement_id: '4000', name_he: 'חיפה', name_en: 'HAIFA', region: 'חיפה', population: 290000, lat: 32.794, lng: 34.9896 },
  { settlement_id: '7400', name_he: 'נתניה', name_en: 'NETANYA', region: 'נתניה', population: 230000, lat: 32.3215, lng: 34.8532 },
  { settlement_id: '5000', name_he: 'תל אביב - יפו', name_en: 'TEL AVIV - YAFO', region: 'ת"א - מרכז', population: 470000, lat: 32.0853, lng: 34.7818 },
  { settlement_id: '2630', name_he: 'קרית גת', name_en: 'QIRYAT GAT', region: 'אשקלון', population: 60000, lat: 31.61, lng: 34.7642 },
  { settlement_id: '1304', name_he: 'שוהם', name_en: 'SHOHAM', region: 'רמלה', population: 22000, lat: 31.9986, lng: 34.9456 },
  { settlement_id: '0055', name_he: 'נגה', name_en: 'NOGAH', council: 'לכיש', region: 'אשקלון', population: 500, lat: 31.62, lng: 34.69 },
  { settlement_id: '0315', name_he: 'רשפים', name_en: 'RESHAFIM', council: 'עמק המעיינות', region: 'עפולה', population: 900, lat: 32.4814, lng: 35.4755 },
  { settlement_id: '9999', name_he: 'בלי מרכז', name_en: 'NO CENTROID', region: 'חיפה', population: 300, lat: null, lng: null },
];
const index = buildSettlementIndex(SETTLEMENTS, [{ alias_name: 'שהם', settlement_id: '1304' }, { alias_name: 'Ashkelon', settlement_id: '7100' }]);
const rev = (localities, extra = {}) => async () => ({ localities: Object.entries(localities).map(([field, value]) => ({ field, value })), countryCode: 'il', raw: 'x', street: null, ...extra });
const never = async () => { throw new Error('reverse must not be called'); };

test('missing city = NULL / blank / whitespace / placeholder; an unusual real locality is not missing', () => {
  for (const v of [null, undefined, '', '   ', '-', 'null', 'ישראל', 'Israel', 'לא ידוע']) assert.equal(isMissingCity(v), true, JSON.stringify(v));
  for (const v of ['אעצם (שבט)', 'رام الله', 'מועצה אזורית גולן', 'X']) assert.equal(isMissingCity(v), false, v);
});

test('D/M: aliases, merged authorities, spelling and English variants normalize to ONE canonical settlement; unknown stays null', () => {
  assert.equal(resolveSettlement(index, 'תל־אביב–יפו').city, 'תל אביב יפו');
  assert.equal(resolveSettlement(index, 'תל אביב').settlement_id, '5000');
  assert.equal(resolveSettlement(index, 'יפו').how, 'merged_authority_alias');
  assert.equal(resolveSettlement(index, 'קריית גת').city, 'קריית גת'); // CBS writes "קרית", Turu's canonical form is "קריית"
  assert.equal(resolveSettlement(index, 'שהם').city, 'שוהם');
  assert.equal(resolveSettlement(index, 'Ashkelon').city, 'אשקלון'); // curated English alias
  assert.equal(resolveSettlement(index, 'HAIFA').city, 'חיפה'); // exact CBS English name
  assert.equal(resolveSettlement(index, 'ירושלים | القدس'), null); // not in this fixture -> null, never a guess
  assert.equal(resolveSettlement(index, 'עיר שלא קיימת'), null);
  assert.equal(isAdministrativeArea('מועצה אזורית עמק המעיינות'), true);
  assert.equal(resolveSettlement(index, 'מועצה אזורית עמק המעיינות'), null, 'an administrative area is never a city');
});

test('C: reverse geocode -> known settlement near its centroid -> HIGH proposal with the canonical value', async () => {
  const p = await proposeCity({ lat: 31.6777, lng: 34.562, city: null, address: 'השייטת' }, { index, reverse: rev({ city: 'אשקלון' }) });
  assert.equal(p.klass, 'AUTO_FIX_HIGH'); assert.equal(p.confidence, 'HIGH'); assert.equal(p.city, 'אשקלון'); assert.equal(p.settlement_id, '7100');
  assert.equal(p.region, 'הדרום והנגב');
});

test('D: raw geocoder variant is normalized before it becomes a proposal (never written raw)', async () => {
  const p = await proposeCity({ lat: 32.05, lng: 34.76, city: '' }, { index, reverse: rev({ city: 'תל־אביב–יפו' }) });
  assert.equal(p.klass, 'AUTO_FIX_HIGH'); assert.equal(p.city, 'תל אביב יפו'); assert.equal(p.raw, 'תל־אביב–יפו');
});

test('village inside a regional council: the village wins, the council is skipped as administrative', async () => {
  const p = await proposeCity({ lat: 32.4814, lng: 35.4755, city: null, address: 'רשפים, 1090500' }, { index, reverse: rev({ city: 'מועצה אזורית עמק המעיינות', village: 'רשפים' }) });
  assert.equal(p.klass, 'AUTO_FIX_HIGH'); assert.equal(p.city, 'רשפים'); assert.equal(p.method, 'address+reverse');
});

test('E: unknown locality / only an administrative area -> no write, explained', async () => {
  const a = await proposeCity({ lat: 32.48, lng: 35.08, city: null }, { index, reverse: rev({ village: 'כפר לא מוכר' }) });
  assert.equal(a.klass, 'UNRESOLVED'); assert.equal(a.city, null); assert.ok(a.evidence.nearest.length);
  const b = await proposeCity({ lat: 32.48, lng: 35.08, city: null }, { index, reverse: rev({ municipality: 'מועצה אזורית מנשה' }) });
  assert.equal(b.klass, 'UNRESOLVED'); assert.match(b.reason, /administrative area/);
});

test('F: coordinates say Haifa, the strong venue says Netanya -> CONFLICT, nothing written', async () => {
  const p = await proposeCity({ lat: 32.8, lng: 34.99, city: null, venue_city: 'נתניה' }, { index, reverse: rev({ city: 'חיפה' }) });
  assert.equal(p.klass, 'CONFLICT'); assert.equal(p.city, null); assert.match(p.reason, /venue=נתניה vs reverse=חיפה/);
});

test('geographic consistency: a settlement far from the coordinates is a CONFLICT, not a repair', async () => {
  const p = await proposeCity({ lat: 32.8, lng: 34.99, city: null }, { index, reverse: rev({ city: 'אשקלון' }) });
  assert.equal(p.klass, 'CONFLICT'); assert.equal(p.city, null); assert.equal(p.proposed, 'אשקלון');
});

test('a street that shares a settlement name is not city evidence ("נגה" street near Rishon)', async () => {
  const s = settlementFromAddress(index, 'נגה', 31.93195, 34.77805);
  assert.equal(s.settlement, null); assert.equal(s.rejected[0].token, 'נגה');
});

test('G: city already exists -> ALREADY_FIXED, reverse never called', async () => {
  const p = await proposeCity({ lat: 32.8, lng: 34.99, city: 'חיפה' }, { index, reverse: never });
  assert.equal(p.klass, 'ALREADY_FIXED');
});

test('venue + address agree -> HIGH without any external request', async () => {
  const p = await proposeCity({ lat: 32.32, lng: 34.85, city: null, venue_city: 'נתניה', address: 'הרצל 5, נתניה' }, { index, reverse: never });
  assert.equal(p.klass, 'AUTO_FIX_HIGH'); assert.equal(p.method, 'venue+address');
});

test('K: geocoder failure / rate limit -> RETRY (backoff), never a guess', async () => {
  const a = await proposeCity({ lat: 32.8, lng: 34.99, city: null }, { index, reverse: async () => null });
  assert.equal(a.klass, 'RETRY');
  const b = await proposeCity({ lat: 32.8, lng: 34.99, city: null }, { index, reverse: async () => { throw new Error('429'); } });
  assert.equal(b.klass, 'RETRY'); assert.equal(b.city, null);
});

test('L: weak (city-centroid) coordinates alone prove nothing; an independent address agreeing does', async () => {
  const weak = { lat: 32.794, lng: 34.9896, city: null, address_source: 'geocode:city_centroid', address_confidence: 'LOW' };
  const a = await proposeCity(weak, { index, reverse: rev({ city: 'חיפה' }) });
  assert.equal(a.klass, 'NEEDS_CORROBORATION'); assert.equal(a.city, 'חיפה'); assert.equal(a.confidence, 'MEDIUM');
  const b = await proposeCity({ ...weak, address: 'הנמל 3, חיפה' }, { index, reverse: rev({ city: 'חיפה' }) });
  assert.equal(b.klass, 'AUTO_FIX_HIGH');
  const onCentroid = await proposeCity({ lat: 32.794, lng: 34.9896, city: null }, { index, reverse: rev({ city: 'חיפה' }) });
  assert.equal(onCentroid.klass, 'NEEDS_CORROBORATION', 'a point exactly on the settlement centroid with no address is a possible centroid artifact');
});

test('invalid coordinates and places outside Israel are never repaired', async () => {
  assert.equal((await proposeCity({ lat: 0, lng: 0, city: null }, { index, reverse: never })).klass, 'INVALID_COORDINATES');
  assert.equal((await proposeCity({ lat: 48.85, lng: 2.35, city: null }, { index, reverse: never })).klass, 'INVALID_COORDINATES');
  const jo = await proposeCity({ lat: 30.84, lng: 35.64, city: null }, { index, reverse: rev({ city: 'الطفيلة' }, { countryCode: 'jo' }) });
  assert.equal(jo.klass, 'OTHER'); assert.equal(jo.reason, 'outside_israel');
});

test('a settlement without a centroid needs a second signal', async () => {
  assert.equal((await proposeCity({ lat: 32.7, lng: 35.1, city: null }, { index, reverse: rev({ village: 'בלי מרכז' }) })).klass, 'NEEDS_CORROBORATION');
  assert.equal((await proposeCity({ lat: 32.7, lng: 35.1, city: null, address: 'הגפן 1, בלי מרכז' }, { index, reverse: rev({ village: 'בלי מרכז' }) })).klass, 'AUTO_FIX_HIGH');
  assert.equal(centroidCheck(index.byId.get('9999'), 32.7, 35.1), null);
});

test('rural point: council boundary + dominant nearest CBS centroid of the same council -> HIGH; without dominance or council agreement -> unresolved', async () => {
  const idx = buildSettlementIndex([
    { settlement_id: '718', name_he: 'ירחיב', council: 'דרום השרון', region: 'פתח תקוה', lat: 32.15, lng: 34.97 },
    { settlement_id: '1236', name_he: 'נירית', council: 'דרום השרון', region: 'פתח תקוה', lat: 32.15, lng: 34.99 },
    { settlement_id: '3654', name_he: 'ברקן', council: 'שומרון', region: 'אריאל', lat: 32.2, lng: 34.97 },
  ]);
  const near = await proposeCity({ lat: 32.1545, lng: 34.9705, city: null, address: 'צבעוני' }, { index: idx, reverse: rev({ city: 'מועצה אזורית דרום השרון' }) });
  assert.equal(near.klass, 'AUTO_FIX_HIGH'); assert.equal(near.city, 'ירחיב'); assert.equal(near.method, 'nearest_settlement+council');
  const between = await proposeCity({ lat: 32.15, lng: 34.98, city: null }, { index: idx, reverse: rev({ city: 'מועצה אזורית דרום השרון' }) });
  assert.equal(between.klass, 'UNRESOLVED', 'two settlements equally near - no dominance');
  const otherCouncil = await proposeCity({ lat: 32.1545, lng: 34.9705, city: null }, { index: idx, reverse: rev({ region: 'מועצה אזורית לב השרון' }) });
  assert.equal(otherCouncil.klass, 'UNRESOLVED', 'the council boundary does not match the nearest settlement');
  const noCouncil = await proposeCity({ lat: 32.1545, lng: 34.9705, city: null }, { index: idx, reverse: rev({}) });
  assert.equal(noCouncil.klass, 'UNRESOLVED', 'proximity alone is never enough');
});

test('Gaza strip is outside the service area', async () => {
  const p = await proposeCity({ lat: 31.52, lng: 34.43, city: null }, { index, reverse: rev({}, { countryCode: null, state: 'רצועת עזה' }) });
  assert.equal(p.klass, 'OTHER'); assert.equal(p.reason, 'outside_israel');
});

// ---- discovery / idempotency / stale write (DB stubs) ----
function discoverClient({ activities, known = [] }) {
  const upserts = []; const updates = [];
  const from = (table) => {
    const st = { op: 'select', payload: null };
    const chain = new Proxy({}, { get(_o, k) {
      if (k === 'upsert') return (rows) => { st.op = 'upsert'; st.payload = rows; upserts.push(...rows); return chain; };
      if (k === 'update') return (p) => { st.op = 'update'; updates.push(p); return chain; };
      if (k === 'then') return (res) => res({ data: st.op === 'upsert' ? st.payload.map((_, i) => ({ id: 'c' + i })) : table === 'activities' ? activities : table === 'cleaner_cases' ? known : [], error: null });
      return () => chain;
    } });
    return chain;
  };
  return { from, upserts, updates };
}
const act = (id, loc, extra = {}) => ({ id, category: 'גן שעשועים', venue_id: null, source_id: null, placeholder_group: null, photo_skipped: false, locations: { id: 'l' + id, address: 'x 1', region: 'השרון', address_source: null, address_confidence: null, ...loc }, activity_schedules: [], activity_images: [], ...extra });

test('A/G: published + valid coordinates + no city -> one missing_city candidate; a row with a city -> none', async () => {
  const client = discoverClient({ activities: [act('1', { lat: 32.1, lng: 34.8, city: null }), act('2', { lat: 32.1, lng: 34.8, city: '  ' }), act('3', { lat: 32.1, lng: 34.8, city: 'חיפה' }), act('4', { lat: null, lng: null, city: null })] });
  const { candidates } = await discoverCases(client, { today: '2026-09-17' });
  const mc = candidates.filter((c) => c.issue === 'missing_city');
  assert.deepEqual(mc.map((c) => c.subject_id), ['1', '2']);
  assert.ok(!candidates.some((c) => c.issue === 'missing_city' && c.subject_id === '4'), 'no coordinates -> missing_coordinates owns it');
});

test('B/I: the same discovery twice keeps ONE case, and an image case on the same activity is untouched', async () => {
  const a = act('1', { lat: 32.1, lng: 34.8, city: null }, { category: 'חווה' }); // non-playground -> also missing_image
  const first = discoverClient({ activities: [a] });
  const c1 = (await discoverCases(first, { today: '2026-09-17' })).candidates;
  assert.ok(c1.some((c) => c.issue === 'missing_city') && c1.some((c) => c.issue === 'missing_image'));
  const r1 = await upsertCases(first, c1);
  assert.equal(r1.created, c1.length);
  const second = discoverClient({ activities: [a], known: c1.map((c) => ({ ...c, status: 'open' })) });
  const r2 = await upsertCases(second, (await discoverCases(second, { today: '2026-09-17' })).candidates);
  assert.equal(r2.created, 0); assert.equal(second.upserts.length, 0); assert.equal(r2.closedExternally, 0);
});

test('J: after the repair the activity is no longer a candidate (no reopen) and its other cases survive', async () => {
  const fixed = act('1', { lat: 32.1, lng: 34.8, city: 'חיפה' }, { category: 'חווה' });
  const known = [{ subject_kind: 'activity', subject_id: '1', issue: 'missing_city', status: 'resolved' }, { subject_kind: 'activity', subject_id: '1', issue: 'missing_image', status: 'open' }];
  const client = discoverClient({ activities: [fixed], known });
  const { candidates } = await discoverCases(client, { today: '2026-09-17' });
  assert.ok(!candidates.some((c) => c.issue === 'missing_city'));
  const r = await upsertCases(client, candidates);
  assert.equal(r.closedExternally, 0, 'the open image case is still wanted, the resolved city case is not reopened');
});

function applyClient({ current, hit = true }) {
  const updates = [];
  const from = (table) => {
    const st = { op: 'select', filters: [], payload: null };
    const chain = new Proxy({}, { get(_o, k) {
      if (k === 'update') return (p) => { st.op = 'update'; st.payload = p; return chain; };
      if (k === 'maybeSingle') return () => Promise.resolve({ data: current, error: null });
      if (k === 'then') return (res) => { if (st.op === 'update') { updates.push({ table, payload: st.payload, filters: st.filters }); return res({ data: hit ? [{ id: 'l1' }] : [], error: null }); } return res({ data: null, error: null }); };
      return (...a) => { st.filters.push([k, ...a]); return chain; };
    } });
    return chain;
  };
  return { from, updates };
}
const proposal = { city: 'אשקלון', region: 'הדרום והנגב', settlement_id: '7100' };

test('H: a city filled after discovery is never overwritten -> already_fixed, no update issued', async () => {
  const client = applyClient({ current: { id: 'l1', city: 'אשדוד', region: null } });
  const r = await applyCityToActivity(client, { id: 'a1', location_id: 'l1' }, proposal);
  assert.deepEqual(r.wrote, []); assert.equal(r.why, 'already_fixed'); assert.equal(client.updates.length, 0);
});

test('H: the write itself is conditional on the city still being empty (race between read and write)', async () => {
  const client = applyClient({ current: { id: 'l1', city: null, region: 'הדרום והנגב' }, hit: false });
  const r = await applyCityToActivity(client, { id: 'a1', location_id: 'l1' }, proposal);
  assert.deepEqual(r.wrote, []); assert.equal(r.why, 'already_fixed');
  assert.ok(client.updates[0].filters.some((f) => f[0] === 'is' && f[1] === 'city' && f[2] === null));
});

test('repair writes the canonical city and fills a null region only', async () => {
  const client = applyClient({ current: { id: 'l1', city: '', region: null } });
  const r = await applyCityToActivity(client, { id: 'a1', location_id: 'l1' }, proposal);
  assert.deepEqual(r.wrote, ['citiesAdded', 'regionsAdded']);
  assert.deepEqual(client.updates[0].payload, { city: 'אשקלון' });
  assert.ok(client.updates[0].filters.some((f) => f[0] === 'eq' && f[1] === 'city' && f[2] === ''), 'blank city guarded by its seen value');
  assert.ok(client.updates[1].filters.some((f) => f[0] === 'is' && f[1] === 'region'));
});

test('a coordinate-fallback region that contradicts the canonical settlement is corrected with a value guard', async () => {
  const client = applyClient({ current: { id: 'l1', city: null, region: 'ירושלים והסביבה' } });
  const r = await applyCityToActivity(client, { id: 'a1', location_id: 'l1' }, proposal);
  assert.deepEqual(r.wrote, ['citiesAdded', 'regionsCorrected']); assert.equal(r.regionWas, 'ירושלים והסביבה');
  assert.ok(client.updates[1].filters.some((f) => f[0] === 'eq' && f[1] === 'region' && f[2] === 'ירושלים והסביבה'));
});

// ---- prevention in the Monster create path (server.js requireVerifiedLocation) ----
test('create path: canonical city from the venue, else from a "street, city" address near the centroid; never from a bare token or a far city', async () => {
  const { canonicalCityFallback } = require('../lib/canonicalSettlement');
  const lib = require('../lib/canonicalSettlement');
  const client = { from: (table) => { const chain = new Proxy({}, { get(_o, k) { if (k === 'maybeSingle') return () => Promise.resolve({ data: { city: 'נתניה' }, error: null }); if (k === 'then') return (res) => res({ data: table === 'settlements' ? SETTLEMENTS : [], error: null }); return () => chain; } }); return chain; } };
  await lib.loadSettlementIndex(client, { fresh: true });
  assert.deepEqual(await canonicalCityFallback(client, { venueId: 'v1', address: null, lat: 32.32, lng: 34.85 }), { city: 'נתניה', region: 'השרון', how: 'venue' });
  assert.equal((await canonicalCityFallback(client, { address: 'הנמל 3, חיפה', lat: 32.8, lng: 34.99 })).city, 'חיפה');
  assert.equal(await canonicalCityFallback(client, { address: 'חיפה', lat: 32.8, lng: 34.99 }), null, 'a bare token may be a street name');
  assert.equal(await canonicalCityFallback(client, { address: 'הרצל 1, אשקלון', lat: 32.8, lng: 34.99 }), null, 'address city far from the coordinates');
});
