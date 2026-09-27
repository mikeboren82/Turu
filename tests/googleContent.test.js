// TuRu - interim Google content suppression (2026-09-27). Covers the pure detectors in
// lib/googleContent.js, the shared public image rule in lib/activities.js#mapActivityRow, the
// non-Google map pin filter, and source-level pins for the surfaces that bypass the mapper
// (LockedPreviewCard, map preview cards, my-things/profile thumbnails). It uses the same require hook
// (babel commonjs + react-native/AsyncStorage/supabase stubs) as tests/fetchApprovedActivitiesPaging.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');
const { addHook } = require('pirates');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const STUBS = {
  'react-native': { Platform: { OS: 'node' }, StyleSheet: { create: (s) => s } },
  '@react-native-async-storage/async-storage': { default: { getItem: async () => null, setItem: async () => {} } },
  './supabase': { supabase: {} },
};
const origLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (STUBS[request]) return { __esModule: true, ...STUBS[request] };
  return origLoad.call(this, request, ...rest);
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  return STUBS[request] ? `stub:${request}` : origResolve.call(this, request, ...rest);
};
addHook(
  (code, filename) => babel.transformSync(code, { filename, babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'] }).code,
  { exts: ['.js'], matcher: (f) => f.startsWith(path.join(ROOT, 'lib')) || f.startsWith(path.join(ROOT, 'constants')) },
);

const {
  isPlacesPhotoProxyUrl, isRawGooglePlacesPhotoUrl, isGooglePlacesPhotoUrl, publicImageUrl, publicImageUrls,
  firstPublicImageUrl, isGoogleMapsUrl, isGoogleOriginActivity, activitiesForNonGoogleMap,
} = require('../lib/googleContent');
const { mapActivityRow } = require('../lib/activities');

// These fixture shapes match production (2026-09-27 read-only SELECT). The ids are synthetic.
const PROXY = 'https://kkvgzubwsjsbqxzjejcs.supabase.co/functions/v1/place-photo/0f5f5616-aaaa-bbbb-cccc-000000000001';
const RAW_LH3 = 'https://lh3.googleusercontent.com/place-photos/AG9NLjSYNTHETIC=s4800-w800';
const MUNICIPAL = 'https://www.ramat-gan.muni.il/uploads/park-hayarkon.jpg';
const OSM_IMG = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Playground_OSM.jpg';
const OWN_UPLOAD = 'https://kkvgzubwsjsbqxzjejcs.supabase.co/storage/v1/object/public/activity-photos/u1/a1.jpg';

// ---- isGooglePlacesPhotoUrl ----

test('isGooglePlacesPhotoUrl: the TURU place-photo proxy is a Places photo', () => {
  assert.equal(isPlacesPhotoProxyUrl(PROXY), true);
  assert.equal(isGooglePlacesPhotoUrl(PROXY), true);
  assert.equal(isGooglePlacesPhotoUrl(`${PROXY}?maxWidthPx=800`), true, 'query string does not hide it');
  assert.equal(isGooglePlacesPhotoUrl('/functions/v1/place-photo/abc'), true, 'host-less relative form');
});

test('isGooglePlacesPhotoUrl: raw lh3 /place-photos/ URLs are Places photos', () => {
  assert.equal(isRawGooglePlacesPhotoUrl(RAW_LH3), true);
  assert.equal(isGooglePlacesPhotoUrl(RAW_LH3), true);
  assert.equal(isGooglePlacesPhotoUrl('https://LH3.GoogleUserContent.com/place-photos/X'), true, 'host is case-insensitive');
  assert.equal(isGooglePlacesPhotoUrl('https://lh5.googleusercontent.com/place-photos/X'), true);
});

test('isGooglePlacesPhotoUrl: the Places API photo media endpoints are Places photos', () => {
  assert.equal(isGooglePlacesPhotoUrl('https://places.googleapis.com/v1/places/ChIJabc/photos/AUc7xyz/media?maxWidthPx=400'), true);
  assert.equal(isGooglePlacesPhotoUrl('https://maps.googleapis.com/maps/api/place/photo?photo_reference=abc'), true);
});

test('isGooglePlacesPhotoUrl: an ordinary municipal JPG / OSM-sourced image / own upload is not', () => {
  for (const url of [MUNICIPAL, OSM_IMG, OWN_UPLOAD, 'https://www.openstreetmap.org/way/864294936']) {
    assert.equal(isGooglePlacesPhotoUrl(url), false, url);
  }
});

test('isGooglePlacesPhotoUrl: a googleusercontent/googleapis host alone does not qualify, only the proven path', () => {
  assert.equal(isGooglePlacesPhotoUrl('https://lh3.googleusercontent.com/a/ACg8ocProfilePic=s96-c'), false, 'Google account avatar');
  assert.equal(isGooglePlacesPhotoUrl('https://lh3.googleusercontent.com/d/1AbCdriveFile'), false);
  assert.equal(isGooglePlacesPhotoUrl('https://storage.googleapis.com/tama-static/img/hero.jpg'), false, 'present in prod, ordinary GCS hosting');
  assert.equal(isGooglePlacesPhotoUrl('https://evil.example/lh3.googleusercontent.com/place-photos/x'), false);
  assert.equal(isGooglePlacesPhotoUrl('https://example.com/place-photo/abc'), false, 'not the /functions/v1/ proxy path');
});

test('isGooglePlacesPhotoUrl: junk input is safe', () => {
  for (const v of [null, undefined, '', '   ', 42, {}, 'not a url']) assert.equal(isGooglePlacesPhotoUrl(v), false);
});

// ---- isGoogleOriginActivity ----

test('isGoogleOriginActivity: maps.google.com source (the production marker, ?cid=) is TRUE', () => {
  assert.equal(isGoogleOriginActivity({ sourceUrl: 'https://maps.google.com/?cid=1766991893191266' }), true);
  assert.equal(isGoogleOriginActivity({ source_url: 'https://maps.google.com/?cid=1766991893191266' }), true, 'raw row shape');
});

test('isGoogleOriginActivity: www.google.com/maps and google.com/maps sources are TRUE', () => {
  assert.equal(isGoogleOriginActivity({ sourceUrl: 'https://www.google.com/maps/place/?q=place_id:ChIJabc' }), true);
  assert.equal(isGoogleOriginActivity({ sourceUrl: 'https://google.com/maps/search/?api=1&query=x' }), true);
  assert.equal(isGoogleOriginActivity({ sourceUrl: 'https://www.google.co.il/maps/place/x' }), true);
  assert.equal(isGoogleOriginActivity({ sourceUrl: 'https://maps.app.goo.gl/AbCd123' }), true);
});

test('isGoogleOriginActivity: an OSM activity with a google_place_id is FALSE', () => {
  const a = { sourceUrl: 'https://www.openstreetmap.org/way/864294936', google_place_id: 'ChIJxyz' };
  assert.equal(isGoogleOriginActivity(a), false);
});

test('isGoogleOriginActivity: an ordinary site with a google_place_id is FALSE', () => {
  assert.equal(isGoogleOriginActivity({ sourceUrl: 'https://www.tel-aviv.gov.il/events/123', google_place_id: 'ChIJxyz' }), false);
});

test('isGoogleOriginActivity: no source is FALSE, whether or not there is a place id', () => {
  assert.equal(isGoogleOriginActivity({}), false);
  assert.equal(isGoogleOriginActivity({ sourceUrl: null, google_place_id: 'ChIJxyz' }), false);
  assert.equal(isGoogleOriginActivity(null), false);
});

test('isGoogleMapsUrl: google.com pages that are not /maps, and look-alike hosts, are FALSE', () => {
  assert.equal(isGoogleMapsUrl('https://www.google.com/search?q=maps'), false);
  assert.equal(isGoogleMapsUrl('https://www.google.com/mapsearch'), false);
  assert.equal(isGoogleMapsUrl('https://maps.google.com.evil.io/?cid=1'), false);
  assert.equal(isGoogleMapsUrl('https://notgoogle.com/maps/x'), false);
  assert.equal(isGoogleMapsUrl('https://goo.gl/xyz'), false);
});

// ---- shared public image rule (mapActivityRow) ----

function row(images, extra = {}) {
  return { id: 'act-1', name: 'x', activity_schedules: [], activity_images: images.map((url) => ({ url })), ...extra };
}

test('mapActivityRow: [proxy only] -> no public image (placeholder path)', () => {
  const m = mapActivityRow(row([PROXY]));
  assert.equal(m.imageUrl, null);
  assert.deepEqual(m.imageUrls, []);
});

test('mapActivityRow: [proxy, municipal] -> the municipal image is selected', () => {
  const m = mapActivityRow(row([PROXY, MUNICIPAL]));
  assert.equal(m.imageUrl, MUNICIPAL);
  assert.deepEqual(m.imageUrls, [MUNICIPAL]);
});

test('mapActivityRow: [raw Google Places image] -> no public image', () => {
  const m = mapActivityRow(row([RAW_LH3, RAW_LH3]));
  assert.equal(m.imageUrl, null);
  assert.deepEqual(m.imageUrls, []);
});

test('mapActivityRow: [normal image] -> retained, and order preserved for the gallery', () => {
  assert.equal(mapActivityRow(row([MUNICIPAL])).imageUrl, MUNICIPAL);
  assert.deepEqual(mapActivityRow(row([OSM_IMG, PROXY, OWN_UPLOAD])).imageUrls, [OSM_IMG, OWN_UPLOAD]);
});

test('mapActivityRow: the DB row object is not mutated', () => {
  const r = row([PROXY, MUNICIPAL]);
  const before = JSON.stringify(r);
  mapActivityRow(r);
  assert.equal(JSON.stringify(r), before);
});

test('publicImageUrls/firstPublicImageUrl: accept activity_images rows or plain strings', () => {
  assert.deepEqual(publicImageUrls([{ url: PROXY }, { url: null }, { url: MUNICIPAL }]), [MUNICIPAL]);
  assert.deepEqual(publicImageUrls([PROXY, OSM_IMG]), [OSM_IMG]);
  assert.equal(firstPublicImageUrl([{ url: RAW_LH3 }]), null);
  assert.equal(firstPublicImageUrl(undefined), null);
  assert.equal(publicImageUrl(PROXY), null);
  assert.equal(publicImageUrl(MUNICIPAL), MUNICIPAL);
});

// ---- 35c73bd0 פארק שרונה כפר יונה (2 visible raw lh3 place-photos in prod) ----

test('35c73bd0 shape: Google-origin (maps cid, no place id) with 2 raw lh3 photos -> no image and no map pin', () => {
  const m = mapActivityRow(row(
    ['https://lh3.googleusercontent.com/place-photos/AG9NLjSYNTHETIC1=s4800-w800', 'https://lh3.googleusercontent.com/place-photos/AG9NLjSYNTHETIC2=s4800-w800'],
    { id: '35c73bd0-0000-0000-0000-000000000000', source_url: 'https://maps.google.com/?cid=1766991893191266', location: { lat: 32.3, lng: 34.9 } },
  ));
  assert.equal(m.imageUrl, null);
  assert.deepEqual(m.imageUrls, []);
  assert.equal(isGoogleOriginActivity(m), true);
  assert.deepEqual(activitiesForNonGoogleMap([m]), []);
});

// ---- non-Google map pin filter ----

test('activitiesForNonGoogleMap: drops Google-origin rows, keeps independent rows with a place id, drops missing coords', () => {
  const google = mapActivityRow(row([PROXY], { id: 'g', source_url: 'https://maps.google.com/?cid=1', location: { lat: 32, lng: 34.8 } }));
  const osmWithPid = mapActivityRow(row([PROXY], { id: 'o', source_url: 'https://www.openstreetmap.org/way/1', google_place_id: 'ChIJ', location: { lat: 32.1, lng: 34.8 } }));
  const site = mapActivityRow(row([MUNICIPAL], { id: 's', source_url: 'https://www.ramat-gan.muni.il/x', location: { lat: 32.2, lng: 34.8 } }));
  const noCoords = mapActivityRow(row([], { id: 'n', source_url: 'https://www.openstreetmap.org/way/2' }));
  const pins = activitiesForNonGoogleMap([google, osmWithPid, site, noCoords]);
  assert.deepEqual(pins.map((a) => a.id), ['o', 's']);
  assert.equal(pins[0].imageUrl, null, 'independent row keeps its pin, but its proxy thumbnail is gone');
  assert.equal(pins[1].imageUrl, MUNICIPAL);
});

test('activitiesForNonGoogleMap: an all-Google result set gives zero pins, and junk input is safe', () => {
  const g = mapActivityRow(row([], { id: 'g', source_url: 'https://maps.google.com/?cid=1', location: { lat: 32, lng: 34.8 } }));
  assert.deepEqual(activitiesForNonGoogleMap([g]), []);
  assert.deepEqual(activitiesForNonGoogleMap(null), []);
  assert.deepEqual(activitiesForNonGoogleMap([null, undefined]), []);
});

// ---- source-level pins: surfaces that bypass the mapper or render map previews ----

for (const file of ['components/ActivitiesMap.web.js', 'components/ActivitiesMap.js']) {
  test(`${file}: pins come from activitiesForNonGoogleMap, the preview image goes through publicImageUrl, and the empty state uses the pinned set`, () => {
    const src = read(file);
    assert.match(src, /import \{ activitiesForNonGoogleMap, publicImageUrl \} from '\.\.\/lib\/googleContent';/);
    assert.match(src, /const pinned = useMemo\(\(\) => activitiesForNonGoogleMap\(withCoords\), \[withCoords\]\);/);
    assert.match(src, /pinned\.length === 0 \?/);
    assert.match(src, /withCoords\.length === 0 \? 'activities\.map\.emptyOverlay' : 'activities\.map\.notShownOverlay'/);
    assert.match(src, /publicImageUrl\((activity|selected)\.imageUrl\)/);
    assert.doesNotMatch(src, /uri: (activity|selected)\.imageUrl/, 'no raw imageUrl straight into <Image>');
  });
}

test('ActivitiesMap.web.js: coordinate groups (markers + fit bounds) are built from the pinned set only', () => {
  assert.match(read('components/ActivitiesMap.web.js'), /const groups = useMemo\(\(\) => groupByCoord\(pinned\), \[pinned\]\);/);
});

test('ActivitiesMap.js: markers, region and the selected preview all come from the pinned set (no stale selection)', () => {
  const src = read('components/ActivitiesMap.js');
  assert.match(src, /\{pinned\.map\(\(a\) => \(/);
  assert.match(src, /regionFor\(pinned, deviceCoords\)/);
  assert.match(src, /const selected = pinned\.find\(\(a\) => a\.id === selectedId\) \|\| null;/);
  assert.doesNotMatch(src, /\{withCoords\.map\(/, 'markers are not rendered from the unfiltered set');
});

test('LockedPreviewCard: imageUrl goes through publicImageUrl before becoming an <Image> uri', () => {
  const src = read('components/LockedPreviewCard.js');
  assert.match(src, /const imageUrl = publicImageUrl\(activity\?\.imageUrl\);/);
  assert.doesNotMatch(src, /uri: activity\.imageUrl/);
});

test('my-things/profile: raw activity_images thumbnails go through firstPublicImageUrl', () => {
  for (const file of ['app/my-things.js', 'app/profile.js']) {
    const src = read(file);
    assert.doesNotMatch(src, /activity_images\?\.\[0\]\?\.url/, file);
    assert.match(src, /firstPublicImageUrl\(/, file);
  }
});

test('my-things: nested activity select includes source_url, so its map can drop Google-origin pins', () => {
  assert.match(read('app/my-things.js'), /const NESTED_ACTIVITY_FIELDS = `[^`]*\bsource_url\b/);
});

test('mapActivityRow is the only constructor of imageUrl, and it uses publicImageUrls', () => {
  assert.match(read('lib/activities.js'), /const images = publicImageUrls\(row\.activity_images\);/);
});

test('i18n: notShownOverlay exists in he and en and carries no compliance/legal wording', () => {
  for (const loc of ['he', 'en']) {
    const json = JSON.parse(read(`lib/i18n/locales/${loc}/activities.json`));
    const text = json.map.notShownOverlay;
    assert.ok(text && typeof text === 'string', loc);
    assert.doesNotMatch(text, /google|licen|legal|polic|terms|גוגל|רישיון|משפט|מדיניות/i, loc);
  }
});

// ---- permanent Google-origin marker (supabase/0115, 2026-09-27) ----

const casesTable = JSON.parse(read('supabase/functions/_shared/googlePlacesPolicy.cases.json'));
const { isGooglePlaceUrn, GOOGLE_CONTENT_ORIGIN } = require('../lib/googleContent');

test('client twin: isGoogleOriginActivity / isGooglePlaceUrn / isGoogleMapsUrl agree with the shared server case table', () => {
  assert.equal(GOOGLE_CONTENT_ORIGIN, 'google_places_legacy');
  for (const [row, want] of casesTable.googleOriginActivities) assert.equal(isGoogleOriginActivity(row), want, JSON.stringify(row));
  for (const [value, want] of casesTable.googlePlaceUrns) assert.equal(isGooglePlaceUrn(value), want, String(value));
  for (const [url, want] of casesTable.mapsUrls) assert.equal(isGoogleMapsUrl(url), want, String(url));
});

const markedScrubbedRow = {
  id: 'g1', name: 'x', category: 'גן שעשועים', entity_type: 'מקום_קבוע', source_url: null, content_origin: 'google_places_legacy',
  google_place_id: 'ChIJ1', location: { lat: 32.1, lng: 34.8 }, activity_images: [], activity_schedules: [],
};

test('A: marker + scrubbed source_url -> still Google-origin through mapActivityRow, and still unpinned', () => {
  const m = mapActivityRow(markedScrubbedRow);
  assert.equal(m.contentOrigin, 'google_places_legacy');
  assert.equal(m.sourceUrl, null);
  assert.equal(isGoogleOriginActivity(m), true);
  assert.deepEqual(activitiesForNonGoogleMap([m]), []);
});

test('B/C: independent rows with a google_place_id stay independent (municipal, OSM) and keep their pin', () => {
  const muni = mapActivityRow({ ...markedScrubbedRow, id: 'm1', content_origin: null, source_url: 'https://www.raanana.muni.il/parks/1' });
  const osm = mapActivityRow({ ...markedScrubbedRow, id: 'o1', content_origin: null, source_url: 'https://www.openstreetmap.org/way/1', google_place_id: 'ChIJosm' });
  assert.equal(muni.contentOrigin, null);
  assert.equal(isGoogleOriginActivity(muni), false);
  assert.equal(isGoogleOriginActivity(osm), false);
  assert.deepEqual(activitiesForNonGoogleMap([muni, osm]).map((a) => a.id), ['m1', 'o1']);
});

test('D/E: an unmarked Maps row (migration window) and a marked re-sourced row are both Google-origin', () => {
  assert.equal(isGoogleOriginActivity(mapActivityRow({ ...markedScrubbedRow, content_origin: null, source_url: 'https://maps.google.com/?cid=1' })), true);
  assert.equal(isGoogleOriginActivity(mapActivityRow({ ...markedScrubbedRow, source_url: 'https://www.openstreetmap.org/way/9' })), true);
});

test('every client query that feeds isGoogleOriginActivity selects content_origin next to source_url', () => {
  const lib = read('lib/activities.js');
  for (const name of ['DETAIL_SELECT_QUERY', 'LIST_SELECT_QUERY']) {
    const q = lib.match(new RegExp(`const ${name} = \`([^\`]*)\`;`));
    assert.ok(q, name);
    assert.match(q[1], /\bsource_url, content_origin\b/, name);
  }
  assert.match(read('app/my-things.js'), /const NESTED_ACTIVITY_FIELDS = `[^`]*\bsource_url, content_origin\b/);
});

// ---- detail screen: a stored Google Maps URL is never a public source / ticket link ----

const { publicSourceUrl } = require('../lib/googleContent');
const priced = { price_type: 'range', price_amount: null, category: 'x', entity_type: 'מקום_קבוע', activity_schedules: [], activity_images: [] };

test('publicSourceUrl: Maps / place-URN / Google-origin -> null; an independent source is kept', () => {
  assert.equal(publicSourceUrl({ sourceUrl: 'https://maps.google.com/?cid=1766991893191266' }), null);
  assert.equal(publicSourceUrl({ source_url: 'https://www.google.com/maps/place/x' }), null);
  assert.equal(publicSourceUrl({ source_url: 'urn:google-place:ChIJ1' }), null);
  assert.equal(publicSourceUrl({ contentOrigin: 'google_places_legacy', sourceUrl: 'https://www.openstreetmap.org/way/9' }), null, 're-sourced Google-origin row');
  assert.equal(publicSourceUrl({ sourceUrl: 'https://www.raanana.muni.il/events/1', google_place_id: 'ChIJ1' }), 'https://www.raanana.muni.il/events/1');
  assert.equal(publicSourceUrl({ sourceUrl: '  ' }), null);
  assert.equal(publicSourceUrl(null), null);
});

test('mapActivityRow: a Google-origin row gets no source link, no action URL and no ticket button from its Maps URL', () => {
  for (const extra of [{ source_url: 'https://maps.google.com/?cid=1' }, { source_url: null, content_origin: 'google_places_legacy' }]) {
    const m = mapActivityRow({ id: 'g', name: 'x', ...priced, ...extra });
    assert.equal(m.publicSourceUrl, null);
    assert.equal(m.actionUrl, null);
    assert.equal(m.requiresTicket, false);
  }
});

test('mapActivityRow: independent rows keep the action ladder (official > detail > public source) and the ticket button', () => {
  const muni = mapActivityRow({ id: 'm', name: 'x', ...priced, source_url: 'https://www.raanana.muni.il/e/1', google_place_id: 'ChIJ1' });
  assert.equal(muni.publicSourceUrl, 'https://www.raanana.muni.il/e/1');
  assert.equal(muni.actionUrl, 'https://www.raanana.muni.il/e/1');
  assert.equal(muni.requiresTicket, true);
  const official = mapActivityRow({ id: 'o', name: 'x', ...priced, source_url: 'https://www.raanana.muni.il/e/1', official_url: 'https://tickets.example/1', detail_url: 'https://www.raanana.muni.il/e/1/d' });
  assert.equal(official.actionUrl, 'https://tickets.example/1');
  // an official ticket URL on a Google-origin row is not a Maps URL and stays usable as the action link
  assert.equal(mapActivityRow({ id: 'g', name: 'x', ...priced, source_url: 'https://maps.google.com/?cid=1', official_url: 'https://tickets.example/2' }).actionUrl, 'https://tickets.example/2');
});

test('app/activity/[id].js: the source link and the ticket button never open the raw stored sourceUrl', () => {
  const src = read('app/activity/[id].js');
  assert.doesNotMatch(src, /openExternal\(activity\.sourceUrl\)/);
  assert.doesNotMatch(src, /activity\.actionUrl \|\| activity\.sourceUrl/);
  assert.match(src, /activity\.requiresTicket && activity\.actionUrl \? \(/);
  assert.match(src, /openExternal\(activity\.publicSourceUrl\)/);
  // place navigation stays coordinate-based; no Maps link is built from a stored value or a place id
  const nav = read('lib/openNavigation.js');
  assert.doesNotMatch(nav, /sourceUrl|source_url|place_id|googlePlaceId/);
});
