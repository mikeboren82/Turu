const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { normalizeIncomingCandidate, splitFormattedAddress } = require('../incomingShape');
const policy = require('../lib/googlePlacesPolicy');

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
  assert.equal(policy.isPlacesOriginCandidate(ed), true);
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
  assert.equal(policy.isPlacesOriginCandidate(ed), false);
  const n = normalizeIncomingCandidate(ed);
  assert.equal(n.city, 'רעננה');
  assert.equal(n.price_type, null);
  assert.equal(n.price_amount, null);
  assert.equal(n.location_name, 'קניון רננים');
});

// ---- 2026-09-27: the Places branch is chosen by provenance (googlePlacesPolicy), never by lon / google_place_id ----
const MAPS = 'https://maps.google.com/?cid=4412345678901234567';
const PLACES_DEFAULTS = ['entity_type', 'category', 'price_type', 'price_amount', 'indoor_outdoor', 'booking_requirement'];
const independentRows = {
  A_municipal: [{ name: 'גינת הדקל', location_name: 'גינת הדקל', address: 'הדקל 5, רעננה', city: 'רעננה', lat: 32.18, lng: 34.87, lon: 34.87, schedule_type: 'fixed_hours' }, 'https://www.raanana.muni.il/parks/7'],
  B_osm: [{ name: 'גן שעשועים', location_name: 'גן שעשועים', city: 'רעננה', lat: 32.18, lon: 34.87, osm_type: 'node', osm_id: 7, schedule_type: 'fixed_hours' }, 'https://www.openstreetmap.org/node/7'],
  C_place_id: [{ name: 'גינת הדקל', location_name: 'גינת הדקל', address: 'הדקל 5, רעננה', city: 'רעננה', lat: 32.18, lng: 34.87, google_place_id: 'ChIJindependent', schedule_type: 'fixed_hours' }, 'https://www.raanana.muni.il/parks/7'],
  D_place_id_lat_lon: [{ name: 'גינת הדקל', location_name: 'גינת הדקל', address: 'הדקל 5, רעננה', city: 'רעננה', lat: 32.18, lon: 34.87, google_place_id: 'ChIJindependent', schedule_type: 'fixed_hours' }, 'https://www.raanana.muni.il/parks/7'],
  E_arcgis: [{ name: 'מתקן משחקים', location_name: 'מתקן משחקים', address: 'שד׳ ירושלים 12, תל אביב יפו', city: 'תל אביב יפו', geometry: { x: 34.78, y: 32.08, spatialReference: { wkid: 4326 } }, lat: 32.08, lon: 34.78, schedule_type: 'fixed_hours' }, 'https://services.arcgis.com/abc/arcgis/rest/services/P/FeatureServer/0'],
  F_official_coords: [{ name: 'סדנת יצירה', location_name: 'מתנ"ס נווה ארזים', address: 'הנרקיס 3, חולון', city: 'חולון', lat: '32.01', lng: '34.77', latitude: 32.01, longitude: 34.77, schedule_type: 'one_time', one_time_date: '2026-10-10', price_type: 'paid', price_amount: 40, category: 'יצירה' }, 'https://www.holon.muni.il/events/1'],
};

test('A-F: independent rows (coordinates, lon, google_place_id, geometry) keep every own field; nothing nulled or invented', () => {
  for (const [label, [ed, pageUrl]] of Object.entries(independentRows)) {
    assert.equal(policy.isPlacesOriginCandidate(ed, pageUrl), false, label);
    const n = normalizeIncomingCandidate(ed, { pageUrl });
    for (const k of Object.keys(ed)) {
      if (k === 'city') continue; // canonical spelling only
      assert.deepEqual(n[k], ed[k], `${label}: ${k} preserved`);
    }
    assert.equal(n.city, ed.city, `${label}: city (fixtures use the canonical spelling)`);
    assert.equal(n.address, ed.address, `${label}: address survives (not re-derived from a missing formatted_address)`);
    for (const k of PLACES_DEFAULTS) if (!(k in ed)) assert.equal(n[k], undefined, `${label}: no Places default for ${k}`);
    // lon is only a coordinate-key alias: fills a MISSING lng, never overrides one
    const wantLng = ed.lng != null ? ed.lng : (typeof ed.lon === 'number' ? ed.lon : undefined);
    assert.deepEqual(n.lng, wantLng, `${label}: lng`);
  }
  // an explicit lng is never replaced by lon
  assert.equal(normalizeIncomingCandidate({ name: 'x', lat: 32, lng: 34.5, lon: 34.9 }).lng, 34.5);
  // a non-numeric lon is not an alias
  assert.equal(normalizeIncomingCandidate({ name: 'x', lat: 32, lon: 'bad' }).lng, undefined);
});

test('G/H: real Places-shaped incoming and a Google Maps page_url still take the Places branch', () => {
  const writers = [
    [{ name: 'גן שעשועים הדקל', formatted_address: 'הדקל 5, רעננה, ישראל', lat: 32.18, lon: 34.87, google_place_id: 'ChIJnew1', place_kind: 'PLAYGROUND', city: 'רעננה' }, MAPS],
    [{ name: 'גן שעשועים הדקל', formatted_address: 'הדקל 5, רעננה', lat: 32.18, lon: 34.87, google_place_id: 'ChIJnew1', google_maps_uri: MAPS, place_kind: 'PLAYGROUND' }, MAPS],
    [{ name: 'גן שעשועים הדקל', formatted_address: 'הדקל 5, רעננה', lat: 32.18, lon: 34.87, google_place_id: 'ChIJnew1', place_kind: 'PLAYGROUND' }, null], // key pair alone
  ];
  for (const [ed, pageUrl] of writers) {
    const n = normalizeIncomingCandidate(ed, { pageUrl });
    assert.deepEqual([n.address, n.city, n.lng, n.entity_type, n.schedule_type], ['הדקל 5, רעננה', 'רעננה', 34.87, 'מקום_קבוע', 'fixed_hours'], JSON.stringify(ed));
  }
  // H: page-shaped facts under a Maps page_url are Places provenance (the same rule the evaluator holds on)
  const onMaps = { name: 'x', city: 'רעננה', lat: 32.1, lng: 34.8 };
  assert.equal(normalizeIncomingCandidate(onMaps, { pageUrl: 'https://www.google.com/maps/place/x' }).entity_type, 'מקום_קבוע');
  assert.equal(normalizeIncomingCandidate(onMaps, { pageUrl: 'https://www.raanana.muni.il/x' }).entity_type, undefined);
});

test('one definition of Places origin: incomingShape reuses googlePlacesPolicy, and every caller passes the row page_url', () => {
  const src = fs.readFileSync(path.join(__dirname, '../incomingShape.js'), 'utf8');
  assert.match(src, /require\('\.\/lib\/googlePlacesPolicy'\)/);
  assert.ok(!/isPlacesShape|ed\.lon !== undefined|google_place_id !== undefined/.test(src), 'no local lon / place-id origin rule');
  assert.equal(require('../incomingShape').isPlacesShape, undefined);
  const callers = { 'server.js': /normalizeIncomingCandidate\(item\.extracted_data, \{ pageUrl: item\.page_url \}\)/g, 'lib/incomingEligibility.js': /normalizeIncomingCandidate\(c, \{ pageUrl: row\.page_url \}\)/g };
  for (const [f, re] of Object.entries(callers)) {
    const s = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const all = (s.match(/normalizeIncomingCandidate\(/g) || []).length;
    const withUrl = (s.match(re) || []).length;
    assert.ok(all >= 1 && withUrl === all, `${f}: ${withUrl}/${all} calls pass page_url`);
  }
});
