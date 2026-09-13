const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeIncomingCandidate, splitFormattedAddress, isPlacesShape } = require('../incomingShape');

test('splitFormattedAddress drops postal codes and country, normalizes city', () => {
  assert.deepEqual(splitFormattedAddress('הרב קירשטיין 5-9, עפולה'), { street: 'הרב קירשטיין 5-9', city: 'עפולה' });
  assert.deepEqual(splitFormattedAddress('צובה, 9087000'), { street: null, city: 'צובה' });
  assert.deepEqual(splitFormattedAddress('דרך אבשלום 1, 3090000 זכרון יעקב, ישראל'), { street: 'דרך אבשלום 1', city: 'זכרון יעקב' });
  assert.deepEqual(splitFormattedAddress('חיפה'), { street: null, city: 'חיפה' });
  assert.deepEqual(splitFormattedAddress('קרית אונו'), { street: null, city: 'קריית אונו' });
  assert.deepEqual(splitFormattedAddress(null), { street: null, city: null });
});

test('Google-Places shape maps to the saveNewActivity contract with coordinates', () => {
  const ed = { name: 'גן קירשטיין', formatted_address: 'הרב קירשטיין 5-9, עפולה', lat: 32.61, lon: 35.28, google_place_id: 'ChIJx', place_kind: 'PARK', city: 'אסיף' };
  assert.equal(isPlacesShape(ed), true);
  const n = normalizeIncomingCandidate(ed);
  assert.equal(n.city, 'עפולה'); // formatted_address wins over the unreliable city field
  assert.equal(n.lng, 35.28);
  assert.equal(n.lat, 32.61);
  assert.equal(n.entity_type, 'מקום_קבוע');
  assert.equal(n.category, 'גן שעשועים');
  assert.equal(n.schedule_type, 'fixed_hours');
  assert.equal(n.address, 'הרב קירשטיין 5-9, עפולה');
  assert.equal(n.location_name, 'גן קירשטיין - הרב קירשטיין 5-9');
  assert.equal(n.google_place_id, 'ChIJx');
});

test('page-extraction shape is left intact except city normalization; missing price stays null', () => {
  const ed = { name: 'סדנה', location_name: 'קניון רננים', city: 'רעננה ', price_type: null, price_amount: null, schedule_type: 'one_time' };
  assert.equal(isPlacesShape(ed), false);
  const n = normalizeIncomingCandidate(ed);
  assert.equal(n.city, 'רעננה');
  assert.equal(n.price_type, null);
  assert.equal(n.price_amount, null);
  assert.equal(n.location_name, 'קניון רננים');
});
