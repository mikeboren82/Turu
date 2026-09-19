// SERVICE AREA (2026-09-19 product decision): a GEOGRAPHIC rule. Israeli Arab localities stay in scope,
// PA-administered localities are outside, border/outposts stay AMBIGUOUS (never excluded on a proxy).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { classifyServiceArea, loadPaLocalities } = require('../lib/serviceArea');
const { buildSettlementIndex } = require('../lib/canonicalSettlement');

// CBS settlements (real centroids): Israeli Arab localities, Jewish localities, West Bank settlements, Gaza-envelope kibbutzim
const SETTLEMENTS = [
  { settlement_id: '2710', name_he: 'אום אל-פחם', lat: 32.5190, lng: 35.1530 }, { settlement_id: '7300', name_he: 'נצרת', lat: 32.7020, lng: 35.2970 },
  { settlement_id: '1161', name_he: 'רהט', lat: 31.3930, lng: 34.7540 }, { settlement_id: '0494', name_he: 'דאלית אל-כרמל', lat: 32.6931, lng: 35.0503 },
  { settlement_id: '0472', name_he: 'אבו גוש', lat: 31.8067, lng: 35.1078 }, { settlement_id: '3570', name_he: 'אריאל', lat: 32.1039, lng: 35.1868 },
  { settlement_id: '3574', name_he: 'בית אל', lat: 31.9426, lng: 35.2229 }, { settlement_id: '3000', name_he: 'ירושלים', lat: 31.7834, lng: 35.2198 },
  { settlement_id: '0393', name_he: 'נתיב העשרה', lat: 31.5500, lng: 34.5300 }, { settlement_id: '0384', name_he: 'נחל עוז', lat: 31.4720, lng: 34.4980 },
  { settlement_id: '3572', name_he: 'כפר תפוח', lat: 32.1170, lng: 35.2560 }, { settlement_id: '1031', name_he: 'שדרות', lat: 31.5250, lng: 34.5960 },
  { settlement_id: '3760', name_he: 'קרית ארבע', lat: 31.5270, lng: 35.1120 }, { settlement_id: '2200', name_he: 'טירה', lat: 32.2330, lng: 34.9500 },
];
const index = buildSettlementIndex(SETTLEMENTS, []);
const pa = loadPaLocalities(path.join(__dirname, '..', 'reference', 'pa-localities.json'));

test('Israeli Arab localities are IN SCOPE (the rule is geographic, never a name/script/population proxy)', () => {
  for (const [name, lat, lng] of [['אום אל-פחם', 32.519, 35.153], ['נצרת', 32.702, 35.297], ['רהט', 31.393, 34.754], ['דאלית אל-כרמל', 32.691, 35.057], ['אבו גוש', 31.808, 35.106], ['טירה', 32.233, 34.95]]) {
    const v = classifyServiceArea({ lat, lng }, { index, pa }); assert.equal(v.klass, 'IN_SCOPE', name + ' ' + v.reason);
  }
});

test('Palestinian-administered cities and camps are OUTSIDE when no CBS settlement is within 2 km', () => {
  for (const [name, lat, lng] of [['Ramallah', 31.909, 35.197], ['Gaza', 31.52, 34.452], ['Bethlehem', 31.705, 35.202], ['Jenin camp', 32.462, 35.284], ['Jabalia', 31.537, 34.477]]) {
    const v = classifyServiceArea({ lat, lng }, { index, pa }); assert.equal(v.klass, 'OUTSIDE_SERVICE_AREA', name + ' ' + v.reason);
  }
});

test('Israeli settlements in the West Bank and the Gaza-envelope communities are IN SCOPE', () => {
  for (const [name, lat, lng] of [['אריאל', 32.1039, 35.1868], ['בית אל', 31.9426, 35.2229], ['נתיב העשרה', 31.55, 34.53], ['שדרות', 31.525, 34.596], ['קרית ארבע', 31.527, 35.112]]) {
    const v = classifyServiceArea({ lat, lng }, { index, pa }); assert.equal(v.klass, 'IN_SCOPE', name + ' ' + v.reason);
  }
});

test('border cases stay AMBIGUOUS: a PA locality with a CBS settlement 2-4 km away; an unrecognised outpost with reverse=ps is unresolved, never excluded', () => {
  // Hebron (PA city) and Kiryat Arba (CBS settlement) sit 1.5-2 km apart: two claims on one point -> AMBIGUOUS, never OUTSIDE, never IN_SCOPE by proximity
  for (const [lat, lng] of [[31.524, 35.098], [31.53, 35.095], [31.535, 35.101]]) { const h = classifyServiceArea({ lat, lng }, { index, pa }); assert.equal(h.klass, 'AMBIGUOUS', h.reason); }
  // the same Hebron point with a reverse geocode that names the Arabic city (not a CBS settlement) stays AMBIGUOUS
  const hr = classifyServiceArea({ lat: 31.53, lng: 35.095 }, { index, pa, reverse: { countryCode: 'ps', localities: [{ field: 'city', value: 'الخليل' }] } }); assert.equal(hr.klass, 'AMBIGUOUS');
  // an outpost 3 km from Kfar Tapuach, no PA locality nearby, reverse says ps + a Hebrew locality name -> AMBIGUOUS (or in scope by CBS), never OUTSIDE
  const o = classifyServiceArea({ lat: 32.14, lng: 35.23 }, { index, pa, reverse: { countryCode: 'ps', state: 'Judea and Samaria', localities: [{ field: 'village', value: 'תפוח מערב' }] } });
  assert.notEqual(o.klass, 'OUTSIDE_SERVICE_AREA', o.reason);
  // a point in the open West Bank with no evidence either way -> IN_SCOPE by default (no proxy), MEDIUM/HIGH
  const d = classifyServiceArea({ lat: 32.0, lng: 35.4 }, { index, pa }); assert.notEqual(d.klass, 'OUTSIDE_SERVICE_AREA');
});

test('reverse-geocode evidence refines: resolving to a CBS settlement -> IN_SCOPE; foreign country -> OUTSIDE_FOREIGN; Gaza state -> OUTSIDE', () => {
  const r = classifyServiceArea({ lat: 32.53, lng: 35.16 }, { index, pa, reverse: { countryCode: 'il', localities: [{ field: 'city', value: 'אום אל-פחם' }] } }); assert.equal(r.klass, 'IN_SCOPE');
  const f = classifyServiceArea({ lat: 29.53, lng: 35.0 }, { index, pa, reverse: { countryCode: 'jo', localities: [{ field: 'city', value: 'العقبة' }] } }); assert.equal(f.klass, 'OUTSIDE_FOREIGN');
  const g = classifyServiceArea({ lat: 31.30, lng: 34.28 }, { index, pa, reverse: { countryCode: 'ps', state: 'רצועת עזה', localities: [] } }); assert.equal(g.klass, 'OUTSIDE_SERVICE_AREA');
});

test('invalid coordinates are DATA_ERROR, never a verdict', () => {
  assert.equal(classifyServiceArea({ lat: null, lng: null }, { index, pa }).klass, 'DATA_ERROR');
  assert.equal(classifyServiceArea({ lat: 0, lng: 0 }, { index, pa }).klass, 'DATA_ERROR');
  assert.equal(classifyServiceArea({ lat: 48.8, lng: 2.3 }, { index, pa }).klass, 'DATA_ERROR');
});

test('SAFETY: a record that names a CBS settlement within 8 km is never auto-excluded (Jerusalem neighbourhood next to Anata -> AMBIGUOUS), a far-away name does not help', () => {
  // a point 1 km east of Anata's centre, ~6 km from Jerusalem's single CBS point (no CBS settlement within 4 km)
  const anata = pa.localities.find((l) => l.name === 'Anata'); assert.ok(anata, 'Anata in the PA reference');
  const point = { lat: anata.lat, lng: anata.lng + 0.011 };
  const bare = classifyServiceArea(point, { index, pa });
  assert.equal(bare.klass, 'OUTSIDE_SERVICE_AREA', 'without a hint the geographic rule decides');
  const hinted = classifyServiceArea(point, { index, pa, cityHint: 'ירושלים' });
  assert.equal(hinted.klass, 'AMBIGUOUS'); assert.equal(hinted.evidence.city_hint.city, 'ירושלים');
  // Gaza City with a bogus hint of a far settlement stays OUTSIDE (the hint must be within 8 km)
  assert.equal(classifyServiceArea({ lat: 31.5017, lng: 34.4668 }, { index, pa, cityHint: 'ירושלים' }).klass, 'OUTSIDE_SERVICE_AREA');
});
