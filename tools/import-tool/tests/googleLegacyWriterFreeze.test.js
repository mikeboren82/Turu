// LEGACY WRITER FREEZE (Google Places release policy, 2026-09-27). Before the legacy scrub, no manual script may
// re-create Google-derived catalogue facts or undo the scrub:
//   - reconcile-playground-twins.js: an independent row is NEVER archived in favour of a Google-origin row; a
//     Google-origin loser gives the independent keeper nothing (no fills, no images)
//   - migrate-playground-names.js / enrich-playground-addresses.js never derive values from a Google-origin row
//   - location reuse (server.js, scan-source, the Cleaner's locationResolver) never adopts a Google-origin location on
//     a name match - orphan or not - through lib/googlePlacesPolicy.js pickReusableLocation
// No database, no network: pure decisions, a recording fake client, and source pins on every guarded path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pickReusableLocation, LOCATION_ORIGIN_SELECT } = require('../lib/googlePlacesPolicy');
const { decideTwinOutcome, mergePair } = require('../reconcile-playground-twins');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MAPS = 'https://maps.google.com/?cid=4412345678901234567';
const HIGH = { outcome: 'SAME_PLACE_HIGH', decisive: 'same name + 12 m', signals: [] };

const row = (id, extra = {}) => ({
  id, name: 'גן שעשועים', status: 'approved', google_place_id: null, source_url: null, content_origin: null, location_id: `loc-${id}`,
  locations: { id: `loc-${id}`, region: null, address: null, city: null, lat: 32.1, lng: 34.8 }, activity_images: [], ...extra,
});
const osm = (id = 'osm', extra) => row(id, { source_url: 'https://www.openstreetmap.org/way/1', google_place_id: 'ChIJosm', ...extra });
const muni = (id = 'muni', extra) => row(id, { source_url: 'https://www.raanana.muni.il/parks/1', ...extra });
const google = (id = 'g', extra) => row(id, { source_url: MAPS, google_place_id: 'ChIJg', ...extra });

// ---- reconcile-playground-twins keeper rule ----

test('twins: OSM vs Google -> the OSM row keeps, the Google row is the loser (both query orientations)', () => {
  let d = decideTwinOutcome({ existingRow: osm(), placeRow: google(), verdict: HIGH });
  assert.deepEqual([d.action, d.keeper.id, d.loser.id, d.rule], ['merge', 'osm', 'g', 'independent_keeper']);
  d = decideTwinOutcome({ existingRow: google(), placeRow: osm(), verdict: HIGH });
  assert.deepEqual([d.action, d.keeper.id, d.loser.id], ['merge', 'osm', 'g']);
});

test('twins: independent municipal vs Google -> independent keeper; a scrubbed marked Google row is still the loser', () => {
  const d = decideTwinOutcome({ existingRow: muni(), placeRow: google('g2', { source_url: null, content_origin: 'google_places_legacy' }), verdict: HIGH });
  assert.deepEqual([d.action, d.keeper.id, d.loser.id], ['merge', 'muni', 'g2']);
});

test('twins: two independent rows -> review, never an automatic merge (a backfilled place id does not make one "Google")', () => {
  const d = decideTwinOutcome({ existingRow: osm(), placeRow: muni('m2', { google_place_id: 'ChIJosm' }), verdict: HIGH });
  assert.deepEqual(d, { action: 'review', reason: 'two_independent_rows' });
  assert.deepEqual(decideTwinOutcome({ existingRow: google('g1'), placeRow: google('g2'), verdict: HIGH }), { action: 'review', reason: 'two_google_origin_rows' });
});

test('twins: ambiguous identity -> no-op (nothing merged, nothing archived)', () => {
  for (const outcome of ['SAME_PLACE_MEDIUM_NEEDS_MORE_EVIDENCE', 'INSUFFICIENT_EVIDENCE', 'DISTINCT_PLACES']) {
    assert.deepEqual(decideTwinOutcome({ existingRow: osm(), placeRow: google(), verdict: { outcome } }), { action: 'noop', reason: outcome });
  }
  assert.equal(decideTwinOutcome({ existingRow: osm(), placeRow: google(), verdict: null }).action, 'noop');
});

test('twins: the independent row is never the loser in any outcome', () => {
  const verdicts = [HIGH, { outcome: 'SAME_PLACE_MEDIUM_NEEDS_MORE_EVIDENCE' }, { outcome: 'DISTINCT_PLACES' }];
  for (const [a, b] of [[osm(), google()], [google(), osm()], [muni(), google()], [google(), muni()]]) {
    for (const v of verdicts) {
      const d = decideTwinOutcome({ existingRow: a, placeRow: b, verdict: v });
      if (d.action === 'merge') assert.notEqual(d.loser.source_url, 'https://www.openstreetmap.org/way/1');
      if (d.action === 'merge') assert.equal(d.loser.id, 'g');
    }
  }
});

function recordingClient() {
  const calls = [];
  const builder = (table) => {
    const q = { table, op: 'select', patch: null };
    const b = {
      select() { return b; }, eq() { return b; }, is() { return b; }, in() { return b; }, limit() { return b; }, maybeSingle() { return b; },
      insert(p) { q.op = 'insert'; q.patch = p; return b; }, upsert(p) { q.op = 'upsert'; q.patch = p; return b; }, update(p) { q.op = 'update'; q.patch = p; return b; },
      then(res, rej) { calls.push({ ...q }); return Promise.resolve({ data: [], error: null }).then(res, rej); },
    };
    return b;
  };
  return {
    calls,
    from: builder,
    rpc: async (fn, args) => { calls.push({ table: 'rpc:' + fn, op: 'rpc', patch: args }); return { data: { outcome: 'archived' }, error: null }; },
  };
}

test('twins mergePair: a Google-origin loser gives the independent keeper nothing, and only the Google row is archived', async () => {
  const client = recordingClient();
  const keeper = osm();
  const loser = google('g', { locations: { id: 'loc-g', region: 'השרון', address: 'Google Street 9', city: 'רעננה', lat: 32.1, lng: 34.8 },
    activity_images: [{ url: 'https://example.org/own.jpg', status: 'approved', image_source_type: 'ORIGINAL_SOURCE' }] });
  const r = await mergePair(client, 'bot', { id: 'rc1', resolution: {} }, keeper, loser, HIGH);
  assert.equal(r.merged, true);
  assert.deepEqual(r.fills, []);
  assert.equal(r.imgs, 0);
  assert.ok(!client.calls.some((c) => c.table === 'locations' && c.op === 'update'), 'no Google address/region onto the keeper location');
  assert.ok(!client.calls.some((c) => c.table === 'activity_images' && c.op === 'insert'), 'no image copied from the Google row');
  const archive = client.calls.filter((c) => c.op === 'rpc');
  assert.deepEqual(archive.map((c) => [c.patch.p_activity_id, c.patch.p_keeper_activity_id]), [['g', 'osm']]);
  const rc = client.calls.find((c) => c.table === 'settlement_scan_review_cases');
  assert.equal(rc.patch.resolution.twin.keeper_rule, 'independent_keeper');
});

test('twins: the script selects provenance, decides through decideTwinOutcome, and reports to git-ignored reports/', () => {
  const s = read('tools/import-tool/reconcile-playground-twins.js');
  assert.match(s, /const sel = `id, name, status, category, google_place_id, source_url, content_origin,/);
  assert.match(s, /decideTwinOutcome\(\{ existingRow: osmRow, placeRow: googleRow, verdict: v \}\)/);
  assert.match(s, /if \(APPLY && d\.action === 'merge'\)/);
  assert.doesNotMatch(s, /mergePair\(client, userId, rc, osmRow, googleRow/, 'the 09-14 Google-keeper call is gone');
  assert.match(s, /path\.join\(__dirname, 'reports'\)/);
});

// ---- location reuse ----

test('pickReusableLocation: a Google-origin candidate (marker, orphan, or used by a Google row) is skipped; a name never decides', () => {
  const googleOrphan = { id: 'l-orphan', name: 'גן הדקל', content_origin: 'google_places_legacy', activities: [] };
  const usedByGoogle = { id: 'l-g', name: 'גן הדקל', content_origin: null, activities: [{ source_url: MAPS, content_origin: null }] };
  const independent = { id: 'l-osm', name: 'גן הדקל', content_origin: null, activities: [{ source_url: 'https://www.openstreetmap.org/way/1' }] };
  const unusedUnmarked = { id: 'l-free', name: 'גן הדקל', content_origin: null, activities: [] };
  assert.equal(pickReusableLocation([googleOrphan, usedByGoogle, independent]).id, 'l-osm');
  assert.equal(pickReusableLocation([googleOrphan, usedByGoogle]), null, 'nothing reusable -> the caller creates its own row');
  assert.equal(pickReusableLocation([unusedUnmarked]).id, 'l-free', 'an unmarked orphan is only recognisable after the location backfill');
  assert.equal(pickReusableLocation(null), null);
  assert.equal(pickReusableLocation(independent).id, 'l-osm');
});

test('every name/venue-based location reuse path goes through pickReusableLocation with the origin fields selected', () => {
  const server = read('tools/import-tool/server.js');
  assert.match(server, /select\(`id, city, region, lat, lng, address, \$\{LOCATION_ORIGIN_SELECT\}`\)\.ilike\('name', activity\.location_name\)/);
  assert.match(server, /const existing = pickReusableLocation\(nameMatches\);/);
  assert.doesNotMatch(server, /from\('locations'\)\.select\('id, city, region, lat, lng, address'\)\.ilike/);
  const scan = read('supabase/functions/scan-source/index.ts');
  assert.match(scan, /const LOC_SELECT = `id, city, region, lat, lng, address, \$\{LOCATION_ORIGIN_SELECT\}`;/);
  assert.match(scan, /const existingLoc = pickReusableLocation\(/);
  const resolver = read('tools/import-tool/cleaner/locationResolver.js');
  assert.match(resolver, /address_confidence, \$\{LOCATION_ORIGIN_SELECT\}`\)\.ilike\('name', s\.location_name\)/);
  assert.match(resolver, /const loc = pickReusableLocation\(/);
  assert.match(resolver, /!isGoogleOriginActivity\(a\) && !isGoogleOriginLocation\(a\.locations\)/);
  assert.equal(LOCATION_ORIGIN_SELECT, 'content_origin, activities(source_url, content_origin)');
});

test('Google-origin rows are never renamed or re-addressed from their Places facts', () => {
  const names = read('tools/import-tool/migrate-playground-names.js');
  assert.match(names, /source_url, content_origin, location:locations\(address, city, region\)/);
  assert.match(names, /all = all\.concat\(data\.filter\(\(a\) => !isGoogleOriginActivity\(a\)\)\);/);
  const addrs = read('tools/import-tool/enrich-playground-addresses.js');
  assert.match(addrs, /all = all\.concat\(data\.filter\(\(a\) => !isGoogleOriginActivity\(a\)\)\);/);
});
