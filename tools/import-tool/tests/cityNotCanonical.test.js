// CITY_NOT_CANONICAL (0099): `city` = the canonical user-facing settlement. A regional council, a spelling
// variant or an unknown locality string stored as the city is repaired through the SAME evidence pipeline
// as missing_city, with the stored value as evidence (council agreement) and as the write guard.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSettlementIndex, classifyCityValue, adminAreaName } = require('../lib/canonicalSettlement');
const { proposeCity } = require('../cleaner/cityResolver');
const { discoverCases } = require('../cleaner/discover');

const SETTLEMENTS = [
  { settlement_id: '5000', name_he: 'תל אביב - יפו', name_en: 'TEL AVIV - YAFO', region: 'ת"א - מרכז', lat: 32.0853, lng: 34.7818 },
  { settlement_id: '4000', name_he: 'חיפה', name_en: 'HAIFA', region: 'חיפה', lat: 32.794, lng: 34.9896 },
  { settlement_id: '4100', name_he: 'קצרין', name_en: 'QAZRIN', council: null, region: 'צפת', lat: 32.9925, lng: 35.6899 },
  { settlement_id: '4551', name_he: 'אלוני הבשן', name_en: 'ALONE HABASHAN', council: 'גולן', region: 'צפת', lat: 33.0439, lng: 35.8367 },
  { settlement_id: '4013', name_he: 'רמת מגשימים', name_en: 'RAMAT MAGSHIMIM', council: 'גולן', region: 'צפת', lat: 32.8467, lng: 35.8144 },
  { settlement_id: '0494', name_he: 'דאלית אל-כרמל', name_en: 'DALIYAT AL-KARMEL', region: 'חיפה', lat: 32.6931, lng: 35.0503 },
  { settlement_id: '0472', name_he: 'אבו גוש', name_en: 'ABU GHOSH', region: 'ירושלים', lat: 31.8067, lng: 35.1078 },
  { settlement_id: '3574', name_he: 'בית אל', name_en: 'BET EL', council: 'מטה בנימין', region: 'ירושלים', lat: 31.9426, lng: 35.2229 },
];
const index = buildSettlementIndex(SETTLEMENTS, []);
const rev = (localities, extra = {}) => async () => ({ localities: Object.entries(localities).map(([field, value]) => ({ field, value })), countryCode: 'il', raw: 'x', street: null, ...extra });
const never = async () => { throw new Error('reverse must not be called'); };

test('classifyCityValue: canonical -> null; council -> administrative_area; alias/variant -> variant; unknown -> unresolved with script', () => {
  assert.equal(classifyCityValue(index, 'חיפה'), null);
  assert.equal(classifyCityValue(index, 'תל אביב יפו'), null, 'the canonical stored form of a hyphenated CBS name');
  assert.deepEqual(classifyCityValue(index, 'מועצה אזורית גולן'), { kind: 'administrative_area', council: 'גולן' });
  assert.equal(adminAreaName('מועצה איזורית עמק הירדן'), 'עמק הירדן');
  const v = classifyCityValue(index, 'תל אביב'); assert.equal(v.kind, 'variant'); assert.equal(v.canonical, 'תל אביב יפו'); assert.equal(v.settlement_id, '5000');
  assert.deepEqual(classifyCityValue(index, 'دالية الكرمل'), { kind: 'unresolved', script: 'arabic' });
  assert.deepEqual(classifyCityValue(index, 'Tel Aviv Jaffa'), { kind: 'unresolved', script: 'latin' });
  assert.equal(classifyCityValue(index, null), null); assert.equal(classifyCityValue(index, ''), null, 'missing is missing_city, not this issue');
  assert.equal(classifyCityValue(buildSettlementIndex([], []), 'מועצה אזורית גולן'), null, 'no knowledge -> no claim');
});

test('an existing city is never touched without replace_city (ALREADY_FIXED, reverse never called)', async () => {
  const p = await proposeCity({ lat: 32.09, lng: 34.78, city: 'תל אביב' }, { index, reverse: never });
  assert.equal(p.klass, 'ALREADY_FIXED'); assert.equal(p.previous_city, null);
});

test('spelling / alias variant -> spelling_normalization HIGH through the shared resolver, no external request, guard value returned', async () => {
  const p = await proposeCity({ lat: 32.09, lng: 34.78, city: 'תל אביב', replace_city: true }, { index, reverse: never });
  assert.equal(p.klass, 'AUTO_FIX_HIGH'); assert.equal(p.city, 'תל אביב יפו'); assert.equal(p.method, 'spelling_normalization'); assert.equal(p.previous_city, 'תל אביב');
  // a variant whose settlement is far from the point is NOT normalized blindly - it falls through to evidence
  const far = await proposeCity({ lat: 32.794, lng: 34.99, city: 'תל אביב', replace_city: true }, { index, reverse: rev({ city: 'חיפה' }) });
  assert.equal(far.klass, 'AUTO_FIX_HIGH'); assert.equal(far.city, 'חיפה'); assert.equal(far.method, 'reverse'); assert.ok(far.signals.some((s) => s.startsWith('variant_far_from_centroid')));
});

test('regional council as city: resolves to the dominant nearest settlement of THAT council even when the geocoder only knows the council', async () => {
  const p = await proposeCity({ lat: 32.847, lng: 35.815, city: 'מועצה אזורית גולן', replace_city: true }, { index, reverse: rev({ region: 'מועצה אזורית גולן' }) });
  assert.equal(p.klass, 'AUTO_FIX_HIGH'); assert.equal(p.city, 'רמת מגשימים'); assert.equal(p.method, 'nearest_settlement+council'); assert.equal(p.previous_city, 'מועצה אזורית גולן');
  // the geocoder names nothing at all: the STORED council is the boundary evidence
  const stored = await proposeCity({ lat: 32.847, lng: 35.815, city: 'מועצה אזורית גולן', replace_city: true }, { index, reverse: rev({}) });
  assert.equal(stored.klass, 'AUTO_FIX_HIGH'); assert.ok(stored.signals.some((s) => s.includes('council_agrees=גולן(stored)')));
  // a stored council that contradicts the resolved settlement's council -> CONFLICT, nothing written
  const conflict = await proposeCity({ lat: 31.9426, lng: 35.2229, city: 'מועצה אזורית גולן', replace_city: true }, { index, reverse: rev({ village: 'בית אל' }) });
  assert.equal(conflict.klass, 'CONFLICT'); assert.match(conflict.reason, /stored council גולן disagrees/);
  // council-only evidence with no dominant nearby settlement stays UNRESOLVED (genuinely rural)
  const rural = await proposeCity({ lat: 32.95, lng: 35.83, city: 'מועצה אזורית גולן', replace_city: true }, { index, reverse: rev({ region: 'מועצה אזורית גולן' }) });
  assert.equal(rural.klass, 'UNRESOLVED');
});

test('Arabic-script OSM value: never rejected for its script - the reverse geocode names the Israeli locality -> HIGH canonical Hebrew value', async () => {
  const p = await proposeCity({ lat: 32.691, lng: 35.057, city: 'دالية الكرمل', replace_city: true }, { index, reverse: rev({ town: 'דאלית אל-כרמל' }) });
  // the canonical stored form is normalizeCityName(name_he): hyphen-like characters become spaces ("תל אביב יפו" convention)
  assert.equal(p.klass, 'AUTO_FIX_HIGH'); assert.equal(p.city, 'דאלית אל כרמל'); assert.equal(p.settlement_id, '0494'); assert.equal(p.previous_city, 'دالية الكرمل');
  const ag = await proposeCity({ lat: 31.808, lng: 35.106, city: 'أبو غوش‎', replace_city: true }, { index, reverse: rev({ village: 'אבו גוש' }) });
  assert.equal(ag.klass, 'AUTO_FIX_HIGH'); assert.equal(ag.city, 'אבו גוש');
});

test('Palestinian locality (country ps, no CBS settlement within 2 km) -> OTHER/palestinian_locality: a decision, never a rename or archive', async () => {
  const p = await proposeCity({ lat: 31.909, lng: 35.197, city: 'رام الله', replace_city: true }, { index, reverse: rev({ city: 'رام الله' }, { countryCode: 'ps' }) });
  assert.equal(p.klass, 'OTHER'); assert.equal(p.reason, 'palestinian_locality'); assert.equal(p.city, null);
  // an Israeli settlement the geocoder also tags "ps" resolves normally through the CBS index
  const be = await proposeCity({ lat: 31.945, lng: 35.226, city: 'Beit El', replace_city: true }, { index, reverse: rev({ village: 'בית אל' }, { countryCode: 'ps' }) });
  assert.equal(be.klass, 'AUTO_FIX_HIGH'); assert.equal(be.city, 'בית אל');
});

test('alias learning: generic geographic words, substrings of another settlement and unrelated Hebrew names are refused; foreign-script and spelling variants are learned', async () => {
  const { learnSettlementAlias } = require('../lib/canonicalSettlement');
  const idx = buildSettlementIndex([...SETTLEMENTS, { settlement_id: '4008', name_he: 'קשת', name_en: 'QESHET', council: 'גולן', region: 'צפת', lat: 32.97, lng: 35.8 }, { settlement_id: '0228', name_he: 'בית יצחק-שער חפר', name_en: 'BET YIZHAQ-SHA\'AR HEFER', region: 'נתניה', lat: 32.33, lng: 34.89 }, { settlement_id: '0166', name_he: 'טירת כרמל', name_en: 'TIRAT KARMEL', region: 'חיפה', lat: 32.76, lng: 34.97 }], []);
  const client = { from: () => { const chain = new Proxy({}, { get(_o, k) { if (k === 'then') return (res) => res({ data: [], error: null }); if (k === 'upsert') return () => chain; return () => chain; } }); return chain; } };
  assert.equal((await learnSettlementAlias(client, idx, 'גולן', '4008')).why, 'generic_geographic_word');
  assert.equal((await learnSettlementAlias(client, idx, 'צפון', '4000')).why, 'generic_geographic_word');
  assert.match((await learnSettlementAlias(client, idx, 'שער חפר', '0166')).why, /substring of another settlement/);
  assert.match((await learnSettlementAlias(client, idx, 'חוטר', '4000')).why, /shares no token/);
  assert.equal((await learnSettlementAlias(client, idx, 'טירת הכרמל', '0166')).learned, true);
  assert.equal((await learnSettlementAlias(client, idx, 'دالية الكرمل', '0494')).learned, true);
  assert.equal((await learnSettlementAlias(client, idx, 'Kfar Saba', '4000')).learned, true, 'Latin spellings carry no Hebrew token by nature');
  assert.equal((await learnSettlementAlias(client, idx, 'מועצה אזורית גולן', '4008')).why, 'not_a_locality_string');
});

test('discovery opens one city_not_canonical case per non-canonical published city and none for canonical / missing ones', async () => {
  const activities = [
    { id: '1', category: 'חווה', venue_id: 'v', source_id: null, placeholder_group: null, photo_skipped: true, locations: { id: 'l1', address: 'x 1', city: 'מועצה אזורית גולן', lat: 32.9, lng: 35.8, region: 'הצפון והגליל' }, activity_schedules: [{ schedule_type: 'fixed_hours' }], activity_images: [{ id: 'i' }] },
    { id: '2', category: 'חווה', venue_id: 'v', source_id: null, placeholder_group: null, photo_skipped: true, locations: { id: 'l2', address: 'x 1', city: 'חיפה', lat: 32.79, lng: 34.99, region: 'חיפה והקריות' }, activity_schedules: [{ schedule_type: 'fixed_hours' }], activity_images: [{ id: 'i' }] },
    { id: '3', category: 'חווה', venue_id: 'v', source_id: null, placeholder_group: null, photo_skipped: true, locations: { id: 'l3', address: 'x 1', city: null, lat: 32.79, lng: 34.99, region: 'חיפה והקריות' }, activity_schedules: [{ schedule_type: 'fixed_hours' }], activity_images: [{ id: 'i' }] },
    { id: '4', category: 'חווה', venue_id: 'v', source_id: null, placeholder_group: null, photo_skipped: true, locations: { id: 'l4', address: 'x 1', city: 'تل אביב', lat: 32.09, lng: 34.78, region: 'גוש דן והמרכז' }, activity_schedules: [{ schedule_type: 'fixed_hours' }], activity_images: [{ id: 'i' }] },
  ];
  const from = (table) => { const chain = new Proxy({}, { get(_o, k) { if (k === 'then') return (res) => res({ data: table === 'activities' ? activities : table === 'settlements' ? SETTLEMENTS : [], error: null }); return () => chain; } }); return chain; };
  const lib = require('../lib/canonicalSettlement'); await lib.loadSettlementIndex({ from }, { fresh: true });
  const { candidates } = await discoverCases({ from }, { today: '2026-09-19' });
  const nc = candidates.filter((c) => c.issue === 'city_not_canonical');
  assert.deepEqual(nc.map((c) => c.subject_id).sort(), ['1', '4']);
  assert.match(nc.find((c) => c.subject_id === '1').opened_reason, /administrative_area/);
  assert.match(nc.find((c) => c.subject_id === '4').opened_reason, /unresolved/);
  assert.ok(candidates.some((c) => c.issue === 'missing_city' && c.subject_id === '3'), 'a missing city stays missing_city');
  assert.ok(!candidates.some((c) => c.issue === 'city_not_canonical' && c.subject_id === '3'));
});
