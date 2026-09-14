// Stale-write protection: every Cleaner write on a live record is CONDITIONAL in SQL (fill-null /
// replace-LOW), an incoming row is only patched while still open, and a second image is never added.
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyAddressToActivity, patchIncomingLocation, applyImageToActivity } = require('../cleaner/apply');

// stub recording update chains; `rowsFor(table, filters)` decides whether the conditional update hits
function stub({ rowsFor = () => [{ id: 'x' }], count = 0, inserts = [] } = {}) {
  const updates = [];
  const table = (name) => {
    const t = { _op: null, _payload: null, _filters: [] };
    const self = new Proxy(t, { get(o, k) {
      if (k === 'update') return (p) => { o._op = 'update'; o._payload = p; return self; };
      if (k === 'insert') return (p) => { o._op = 'insert'; inserts.push({ table: name, payload: p }); return self; };
      if (k === 'select') return (_s, opts) => { if (opts && opts.head) o._op = 'count'; else o._op = o._op || 'select'; return self; };
      if (k === 'then') return (res) => { if (o._op === 'update') { updates.push({ table: name, payload: o._payload, filters: o._filters }); return res({ data: rowsFor(name, o._filters, o._payload), error: null }); } if (o._op === 'count') return res({ count, error: null }); return res({ data: null, error: null }); };
      if (k === 'maybeSingle') return () => Promise.resolve({ data: null, error: null });
      return (...a) => { o._filters.push([k, ...a]); return self; };
    } });
    return self;
  };
  return { from: table, updates, inserts };
}
const has = (u, name, ...args) => u.filters.some((f) => f[0] === name && args.every((x, i) => f[i + 1] === x));

test('address / coords / venue writes are guarded (is null | LOW) and report gain vs skipped', async () => {
  const client = stub({ rowsFor: (table, filters) => (has({ filters }, 'is', 'address') ? [] : [{ id: 'x' }]) }); // address already filled meanwhile
  const activity = { id: 'a1', location_id: 'l1', venue_id: null, locations: { id: 'l1', address: null, city: 'חולון', lat: null, lng: null, venue_id: null } };
  const r = await applyAddressToActivity(client, activity, { address: 'גולדה מאיר 6', city: 'חולון', lat: 32.01, lng: 34.77, venue_id: 'v1', method: 'source_page', confidence: 'HIGH' });
  assert.deepEqual(r.skipped, ['address']);
  assert.deepEqual(r.wrote, ['coordsAdded', 'venuesLinked']);
  const addr = client.updates.find((u) => u.table === 'locations' && u.payload.address);
  assert.ok(has(addr, 'is', 'address', null), 'address only fills a null');
  const coords = client.updates.find((u) => u.table === 'locations' && u.payload.lat != null);
  assert.ok(has(coords, 'is', 'lat', null), 'missing coordinates are filled only while still null');
  assert.equal(coords.payload.address_source, 'cleaner:source_page');
  assert.ok(client.updates.findIndex((u) => u.payload.lat != null) < client.updates.findIndex((u) => u.payload.address), 'coordinates are written before the address (the address write changes the provenance the coordinate guard reads)');
  // weak (centroid) coordinates: replaced only while they are still the exact values seen at claim time
  const weak = stub();
  const w = await applyAddressToActivity(weak, { id: 'a', location_id: 'l', locations: { lat: 32.1, lng: 34.8, address: null, address_source: 'geocode:city_centroid_suspected' } }, { lat: 32.11, lng: 34.81, method: 'source_page', confidence: 'HIGH' }, { replaceWeak: true });
  assert.deepEqual(w.wrote, ['coordsImproved']);
  const wu = weak.updates.find((u) => u.payload.lat != null);
  assert.ok(has(wu, 'eq', 'lat', 32.1) && has(wu, 'eq', 'lng', 34.8), 'optimistic guard on the weak values');
  // verified coordinates: never replaced
  const ver = stub();
  const v = await applyAddressToActivity(ver, { id: 'a', location_id: 'l', locations: { lat: 32.1, lng: 34.8, address: 'x', address_source: 'cleaner:source_page', address_confidence: 'HIGH' } }, { lat: 1, lng: 1, method: 'place_lookup', confidence: 'MEDIUM' });
  assert.ok(!v.wrote.includes('coordsImproved'));
  const venue = client.updates.find((u) => u.table === 'activities');
  assert.ok(has(venue, 'is', 'venue_id', null), 'a verified venue link is never overwritten');
});

test('LOW evidence never writes coordinates; a street address counts as street-level gain', async () => {
  const client = stub();
  const activity = { id: 'a1', location_id: 'l1', locations: { address: null, city: 'x', lat: 1, lng: 1 } };
  const r = await applyAddressToActivity(client, activity, { address: 'הרצל 5', lat: 2, lng: 2, method: 'place_lookup', confidence: 'LOW' });
  assert.deepEqual(r.wrote, ['streetAddressesAdded']);
  assert.ok(!client.updates.some((u) => u.payload.lat != null));
});

test('an incoming row is patched only while still open; a closed row returns null', async () => {
  const closed = stub({ rowsFor: () => [] });
  const row = { id: 'i1', status: 'new', extracted_data: { name: 'x' }, validation_issues: ['עיר'] };
  assert.equal(await patchIncomingLocation(closed, row, { city: 'חולון', lat: 1, lng: 1, method: 'm', confidence: 'HIGH' }), null);
  const open = stub();
  const patched = await patchIncomingLocation(open, row, { city: 'חולון', lat: 1, lng: 1, address: 'הרצל 5', method: 'm', confidence: 'HIGH' });
  assert.equal(patched.extracted_data.city, 'חולון'); assert.equal(patched.extracted_data.address, 'הרצל 5'); assert.deepEqual(patched.validation_issues, []);
  assert.ok(has(open.updates[0], 'in', 'status'), 'guarded by open status');
});

test('a second image is never inserted when one appeared meanwhile', async () => {
  const client = stub({ count: 1 });
  const r = await applyImageToActivity(client, { id: 'a1' }, { url: 'https://x/y.jpg', kind: 'event_specific' }, 'u');
  assert.deepEqual(r, { wrote: false, why: 'already_has_image' });
  assert.equal(client.inserts.length, 0);
  const client2 = stub({ count: 0 });
  const r2 = await applyImageToActivity(client2, { id: 'a1', placeholder_group: 'g' }, { url: 'https://x/y.jpg', kind: 'event_specific', image_source_type: 'ORIGINAL_SOURCE', needs_rights_review: false }, 'u');
  assert.equal(r2.wrote, true); assert.equal(client2.inserts[0].payload.image_kind, 'event_specific');
});
