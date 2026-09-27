// Identity-based dedupeNearIdentical (lib/filterActivities.js, 2026-09-27 "client identity dedupe").
// Same title within 750 m used to be enough to hide a card. That is the display-side twin of the
// 09-11 delete that removed 1,235 distinct OSM playgrounds sharing a generated name. Now a pair
// collapses only with a shared strong identity signal (sharedIdentitySignal). Same babel
// commonjs hook + stubs as tests/dedupeNearIdentical.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');
const { addHook } = require('pirates');

const ROOT = path.resolve(__dirname, '..');
const STUBS = {
  'react-native': { Platform: { OS: 'node' }, StyleSheet: { create: (s) => s } },
  '@react-native-async-storage/async-storage': { default: { getItem: async () => null, setItem: async () => {} } },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  return STUBS[request] ? `stub:${request}` : origResolve.call(this, request, ...rest);
};
for (const [name, exp] of Object.entries(STUBS)) {
  const m = new Module(`stub:${name}`);
  m.exports = { __esModule: true, ...exp };
  m.loaded = true;
  Module._cache[`stub:${name}`] = m;
}
addHook(
  (code, filename) => babel.transformSync(code, { filename, babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'] }).code,
  { exts: ['.js'], matcher: (f) => f.startsWith(path.join(ROOT, 'lib')) || f.startsWith(path.join(ROOT, 'constants')) },
);

const {
  rankActivitiesWithSmartRadius, rankActivities, normalizeFilters, dedupeNearIdentical, sharedIdentitySignal,
} = require('../lib/filterActivities');

const FILTERS = normalizeFilters({});
const GENERATED = 'גן שעשועים – יצחק רבין, צורן';
const BASE = { lat: 32.3000, lng: 34.9000 };
// ~1 m of latitude = 0.000009 deg
const north = (m) => BASE.lat + m * 0.000009;

let seq = 0;
function act(over = {}) {
  seq += 1;
  return {
    id: `a${seq}`, title: GENERATED, category: 'גן שעשועים', city: 'צורן', lat: BASE.lat, lng: BASE.lng,
    locationId: `loc${seq}`, sourceUrl: null, eventKey: null, googlePlaceId: null,
    imageUrl: null, description: null, openHours: {}, occurrences: [], created_at: '2026-09-01T00:00:00Z',
    ...over,
  };
}
const osm = (kind, id) => `https://www.openstreetmap.org/${kind}/${id}`;
const ids = (list) => list.map((a) => a.id).sort();
const rank = (list) => rankActivitiesWithSmartRadius(list, FILTERS, null, [], [], [], null, null, []).activities;

test('A: same generated playground title, same city, 100 m apart, different OSM ids -> BOTH visible', () => {
  const a = act({ sourceUrl: osm('way', 1001) });
  const b = act({ sourceUrl: osm('way', 1002), lat: north(100) });
  assert.deepEqual(ids(rank([a, b])), ids([a, b]));
  assert.deepEqual(ids(rankActivities([a, b], FILTERS, null, [], [], [], null, null, [])), ids([a, b]));
});

test('B: same generated title, 700 m apart, different OSM ids -> BOTH visible', () => {
  const a = act({ sourceUrl: osm('node', 2001) });
  const b = act({ sourceUrl: osm('way', 2001), lat: north(700) }); // same number, different OSM type = different object
  assert.deepEqual(ids(rank([a, b])), ids([a, b]));
});

test('B2: 7 distinct OSM playgrounds with one generated name (the 09-11 cluster shape) -> all 7 visible', () => {
  const cluster = Array.from({ length: 7 }, (_, i) => act({ sourceUrl: osm('way', 3000 + i), lat: north(i * 90) }));
  assert.equal(rank(cluster).length, 7);
});

test('B3: distinct OSM objects veto a shared backfilled google_place_id -> BOTH visible', () => {
  const a = act({ sourceUrl: osm('way', 4001), googlePlaceId: 'ChIJ-park' });
  const b = act({ sourceUrl: osm('way', 4002), googlePlaceId: 'ChIJ-park', lat: north(60) });
  assert.equal(sharedIdentitySignal(a, b), null);
  assert.equal(rank([a, b]).length, 2);
});

test('C: same exact title + same source identity (one OSM object) -> collapses to one', () => {
  const a = act({ sourceUrl: osm('way', 5001) });
  const b = act({ sourceUrl: 'http://openstreetmap.org/way/5001', lat: north(40), created_at: '2026-09-02T00:00:00Z' });
  assert.equal(sharedIdentitySignal(a, b), 'osm_object');
  const out = rank([a, b]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, b.id, 'tie-break unchanged: equal completeness -> newer created_at survives');
});

test('D: same google_place_id (non-OSM rows) -> collapses', () => {
  const a = act({ title: 'פארק הילדים', category: 'פארק', googlePlaceId: 'ChIJ-same', sourceUrl: 'https://example.org/a' });
  const b = act({ title: 'פארק הילדים', category: 'פארק', googlePlaceId: 'ChIJ-same', sourceUrl: 'https://example.org/b', lat: north(120) });
  assert.equal(sharedIdentitySignal(a, b), 'google_place_id');
  assert.equal(rank([a, b]).length, 1);
});

test('D2: two different google_place_ids with the same title -> BOTH visible', () => {
  const a = act({ title: 'פארק שעשועים', googlePlaceId: 'ChIJ-1' });
  const b = act({ title: 'פארק שעשועים', googlePlaceId: 'ChIJ-2', lat: north(240) });
  assert.equal(rank([a, b]).length, 2);
});

test('E: same title only (no identity, no coordinates or far apart) -> NOT enough', () => {
  const noCoords = [act({ lat: null, lng: null }), act({ lat: null, lng: null })];
  assert.equal(dedupeNearIdentical(noCoords).length, 2);
  const far = [act(), act({ lat: north(3000) })];
  assert.equal(rank(far).length, 2);
});

test('F: same title + close coordinates only (30 m, no shared identity) -> NOT enough', () => {
  const a = act();
  const b = act({ lat: north(30) });
  assert.equal(sharedIdentitySignal(a, b), null);
  assert.equal(rank([a, b]).length, 2);
});

test('F2: a shared listing-page source_url is not identity -> BOTH visible', () => {
  const page = 'https://mallsevents.example.co.il/';
  const a = act({ title: 'MOVIELAND SUMMER SKY', category: 'קולנוע לילדים', sourceUrl: page });
  const b = act({ title: 'MOVIELAND SUMMER SKY', category: 'קולנוע לילדים', sourceUrl: page, lat: north(419) });
  assert.equal(rank([a, b]).length, 2);
});

test('G: non-playground exact duplicate at one location row -> existing dedupe preserved (richer row wins)', () => {
  const show = { title: 'הצגת ילדים: הקוסם', category: 'הצגה', locationId: 'loc-theatre', sourceUrl: 'https://muni.example/events/' };
  const poor = act({ ...show, created_at: '2026-09-20T00:00:00Z' });
  const rich = act({ ...show, imageUrl: 'https://img.example/1.jpg', description: 'desc', created_at: '2026-09-01T00:00:00Z' });
  assert.equal(sharedIdentitySignal(poor, rich), 'location');
  const out = rank([poor, rich]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, rich.id);
});

test('G2: same event_key on two location rows of one venue (split-venue spelling) -> collapses', () => {
  const key = 'tvs:פסטיבל הקוסם מארץ עוץ|v:venue-1|s:source-1';
  const a = act({ title: 'פסטיבל הקוסם מארץ עוץ', category: 'הצגה', eventKey: key, sourceUrl: 'https://mall.example/events/7599' });
  const b = act({ title: 'פסטיבל הקוסם מארץ עוץ', category: 'הצגה', eventKey: key, sourceUrl: 'https://mall.example/events/7564' });
  assert.equal(sharedIdentitySignal(a, b), 'event_key');
  assert.equal(rank([a, b]).length, 1);
});

test('H: occurrence semantics preserved', () => {
  // One row with several dated occurrences is one card, and its occurrences are untouched.
  const occ = [{ date: '2026-10-01', start: '17:00' }, { date: '2026-10-02', start: '17:00' }];
  const single = act({ title: 'מופע קסמים', category: 'הצגה', occurrences: occ });
  const [out] = dedupeNearIdentical([single]);
  assert.equal(out, single);
  assert.deepEqual(out.occurrences, occ);
  // Two rows = two dates of the same event at the same location row: one card, as before. Dedupe
  // runs after the date filter, so a date search still finds the row for that date.
  const d1 = act({ title: 'המטבח של מסייה ללוש', category: 'בישול', locationId: 'loc-hall', occurrences: [{ date: '2026-09-28' }] });
  const d2 = act({ title: 'המטבח של מסייה ללוש', category: 'בישול', locationId: 'loc-hall', occurrences: [{ date: '2026-09-29' }] });
  assert.equal(dedupeNearIdentical([d1, d2]).length, 1);
  assert.equal(dedupeNearIdentical([d2]).length, 1);
  // Same show title at two different halls 300 m apart, no shared identity: two events, two cards.
  const h1 = act({ title: 'שעת סיפור', category: 'ספרייה', locationId: 'loc-lib-1' });
  const h2 = act({ title: 'שעת סיפור', category: 'ספרייה', locationId: 'loc-lib-2', lat: north(300) });
  assert.equal(dedupeNearIdentical([h1, h2]).length, 2);
});

test('mixed cluster: only the identity-sharing pair collapses, order-independent', () => {
  const a = act({ sourceUrl: osm('way', 6001) });
  const aTwin = act({ sourceUrl: osm('way', 6001), lat: north(20), created_at: '2026-09-05T00:00:00Z' });
  const b = act({ sourceUrl: osm('way', 6002), lat: north(80) });
  const c = act({ lat: north(150) }); // no source identity at all
  const forward = ids(rank([a, aTwin, b, c]));
  const reverse = ids(rank([c, b, aTwin, a]));
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward, ids([aTwin, b, c]));
});
