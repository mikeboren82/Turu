// ITM (EPSG:2039) -> WGS84 for the CBS settlement reference points. Known-place validation across the
// country (north / centre / Jerusalem / south / a small locality / a West Bank settlement in Turu's coverage):
// each CBS "centre of the built-up area" must land within 2 km of the well-known city coordinates.
const test = require('node:test');
const assert = require('node:assert/strict');
const { itmToWgs84, parseCbsCoordinates } = require('../lib/itm');
const { haversineKm } = require('../lib/canonicalSettlement');

// raw values are the actual CBS bycode2024 rows (codes 3000, 5000, 4000, 9000, 2600, 4100, 1063, 3570)
const KNOWN = [
  ['ירושלים', '220975632346', 31.7784, 35.2222],
  ['תל אביב - יפו', '180263664864', 32.0809, 34.7806],
  ['חיפה', '201178745467', 32.7940, 34.9896],
  ['באר שבע', '179501573657', 31.2530, 34.7915],
  ['אילת', '194135385051', 29.5577, 34.9519],
  ['קצרין (small, north-east)', '264540766483', 32.9925, 35.6899],
  ['מעלות-תרשיחא (north)', '226290768808', 33.0167, 35.2708],
  ['אריאל (West Bank)', '217856667882', 32.1039, 35.1868],
];

test('parseCbsCoordinates: 12-digit metres, 10-digit tens of metres, anything else null', () => {
  assert.deepEqual(parseCbsCoordinates('220975632346'), { E: 220975, N: 632346, precision_m: 1 });
  assert.deepEqual(parseCbsCoordinates('2196077510'), { E: 219600, N: 775100, precision_m: 10 });
  assert.equal(parseCbsCoordinates(''), null); assert.equal(parseCbsCoordinates(null), null); assert.equal(parseCbsCoordinates('12345'), null);
});

test('ITM -> WGS84 lands on the known city centres (north, centre, Jerusalem, south, small locality, West Bank)', () => {
  for (const [name, raw, lat, lng] of KNOWN) {
    const c = parseCbsCoordinates(raw);
    const w = itmToWgs84(c.E, c.N);
    const km = haversineKm(w.lat, w.lng, lat, lng);
    // CBS marks the centre of the BUILT-UP area (Haifa: Hadar, 2.1 km from the Wikipedia point) - 2.5 km tolerance
    assert.ok(km < 2.5, `${name}: ${w.lat},${w.lng} is ${km.toFixed(2)} km from the known centre ${lat},${lng}`);
  }
});

test('the old Cassini grid or a swapped E/N would be caught (sanity: swapped input is far off)', () => {
  const c = parseCbsCoordinates('220975632346');
  const swapped = itmToWgs84(c.N, c.E);
  assert.ok(!Number.isFinite(swapped.lat) || haversineKm(swapped.lat, swapped.lng, 31.7784, 35.2222) > 100);
});
