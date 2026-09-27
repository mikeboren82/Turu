// GOOGLE PLACES PERSISTENCE POLICY (2026-09-27, lib/googlePlacesPolicy.js): TURU stores a google_place_id, never new
// Places-returned content. Places-origin incoming rows cannot publish (and are not rejected / archived for it), ordinary
// incoming still publishes, an independent row may still receive a place id without losing its own facts, a Google Maps
// page is never a scrape source, a Maps URI never enters a new activity / provenance / image row, the Cleaner holds
// Places-derived work, and the SerpAPI rule from MAIN is unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const policy = require('../lib/googlePlacesPolicy');
const { publishIncoming, saveNewActivity, scrapeAndExtract, fetchPageTextForExtraction, PUBLISH_OUTCOME } = require('../server');
const { handBackIncoming, setPublishImplForTests } = require('../cleaner/apply');
const { applyOutcome } = require('../cleaner/settlementResolver');
const { upsertProvenanceSafe, OUTCOME } = require('../lib/activitySourceMerge');
const { fetchHtml } = require('../lib/fetchPage');
const { mayAutoSearchImage, autoImageFallback } = require('../lib/serpImage');
const { selectJobs } = require('../lib/monsterJobs');

const SHARED = path.join(__dirname, '../../../supabase/functions/_shared');
const table = JSON.parse(fs.readFileSync(path.join(SHARED, 'googlePlacesPolicy.cases.json'), 'utf8'));
const REASON = 'google_places_persistence_disabled';

// ---- the in-memory PostgREST-shaped fake of publishExecution.test.js (enough of supabase-js for these paths) ----
function fakeDb(init) {
  const t = structuredClone(init); let seq = 0; const writes = [];
  const from = (table) => {
    const q = { op: 'select', patch: null, f: [] };
    const test1 = (r, [k, v, kind]) => kind === 'eq' ? r[k] === v : kind === 'neq' ? r[k] !== v : kind === 'in' ? v.includes(r[k]) : kind === 'is' ? (r[k] ?? null) === v : true;
    const rows = () => (t[table] ||= []).filter((r) => q.f.every((f) => test1(r, f)));
    const run = () => {
      if (q.op !== 'select') writes.push({ table, op: q.op, patch: q.patch });
      if (q.op === 'insert' || q.op === 'upsert') {
        const list = (Array.isArray(q.patch) ? q.patch : [q.patch]).map((p) => ({ id: `${table}-${++seq}`, ...p }));
        (t[table] ||= []).push(...list); return { data: list.map((r) => ({ ...r })), error: null };
      }
      if (q.op === 'update') { const hit = rows(); for (const r of hit) Object.assign(r, q.patch); return { data: hit.map((r) => ({ ...r })), error: null }; }
      return { data: rows().map((r) => ({ ...r })), error: null };
    };
    const b = {
      select() { return b; }, insert(p) { q.op = 'insert'; q.patch = p; return b; }, upsert(p) { q.op = 'upsert'; q.patch = p; return b; }, update(p) { q.op = 'update'; q.patch = p; return b; },
      eq(k, v) { q.f.push([k, v, 'eq']); return b; }, neq(k, v) { q.f.push([k, v, 'neq']); return b; }, in(k, v) { q.f.push([k, v, 'in']); return b; }, is(k, v) { q.f.push([k, v, 'is']); return b; },
      lt() { return b; }, ilike() { return b; }, or() { return b; }, not() { return b; }, gte() { return b; }, lte() { return b; }, gt() { return b; }, order() { return b; }, range() { return b; }, limit() { return b; }, match() { return b; }, contains() { return b; }, filter() { return b; },
      single() { const r = run(); return Promise.resolve({ data: r.data ? r.data[0] ?? null : null, error: r.error }); },
      maybeSingle() { const r = run(); return Promise.resolve({ data: r.data ? r.data[0] ?? null : null, error: r.error }); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  };
  return { client: { from, rpc: async () => ({ data: null, error: null }) }, t, writes };
}
const TODAY_ISO = new Date().toISOString();
const ahead = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const pageCandidate = (over = {}) => ({ name: 'סדנת יצירה לילדים', description: 'סדנת יצירה לילדים בגילאי 4-8', category: 'יצירה', entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: ahead(10), city: 'חולון', location_name: 'מתנ"ס נווה ארזים', audience: 'children', lat: 32.01, lng: 34.77, image_urls: ['https://x/img.jpg'], registration_url: 'https://x/register', ...over });
const MAPS = 'https://maps.google.com/?cid=4412345678901234567';
// the three Places writer shapes, exactly as they store extracted_data / page_url
const PLACES_SHAPES = {
  scan_settlement_gaps: { page_url: MAPS, extracted_data: { name: 'גן שעשועים הדקל', formatted_address: 'הדקל 5, רעננה, ישראל', lat: 32.18, lon: 34.87, google_place_id: 'ChIJnew1', place_kind: 'PLAYGROUND', city: 'רעננה' } },
  python_discovery: { page_url: MAPS, extracted_data: { name: 'גן שעשועים הדקל', formatted_address: 'הדקל 5, רעננה', lat: 32.18, lon: 34.87, google_place_id: 'ChIJnew1', google_maps_uri: MAPS, place_kind: 'PLAYGROUND', types: ['playground'], discovery_methods: ['grid'] } },
  cleaner_new_valid: { page_url: 'https://www.google.com/maps', extracted_data: { name: 'גן שעשועים הדקל', formatted_address: 'הדקל 5, רעננה', lat: 32.18, lon: 34.87, google_place_id: 'ChIJnew1', place_kind: 'PLAYGROUND', city: 'רעננה', category: 'גן שעשועים', entity_type: 'מקום_קבוע', schedule_type: 'fixed_hours', price_type: 'free', price_amount: 0, indoor_outdoor: 'outdoor', booking_requirement: 'none', audience: 'family' } },
};
const world = ({ page_url = 'https://x/events', extracted_data = pageCandidate(), match_type = 'new', status = 'new', source_id = 'src-1' } = {}, extra = {}) => ({
  incoming_activities: [{ id: 'inc-1', source_id, page_url, match_type, status, validation_issues: [], deferred_until: null, existing_activity_id: null, created_activity_id: null, updated_at: TODAY_ISO, extracted_data }],
  sources: [{ id: 'src-1', name: 'עיריית חולון - לוח אירועים', seed_url: 'https://www.holon.muni.il/events', is_trusted: true, source_trust_score: 100, activities_approved_total: 0 }],
  activities: [], locations: [], activity_schedules: [], activity_images: [], activity_sources: [], venues: [], venue_aliases: [], automation_settings: [], settlements: [], settlement_aliases: [],
  ...extra,
});
const CATALOGUE = ['activities', 'locations', 'activity_images', 'activity_sources', 'activity_schedules'];
const catalogueWrites = (db) => db.writes.filter((w) => CATALOGUE.includes(w.table));

// ---- the central rule and its twins ----
test('policy: persistence is OFF; place_id is not the switch; the three twins share one case table', () => {
  assert.equal(policy.GOOGLE_PLACES_CONTENT_PERSISTENCE, false);
  assert.equal(policy.GOOGLE_PLACES_CONTENT_PERSISTENCE, table.persistence);
  assert.equal(policy.POLICY_REASON, table.policyReason);
  for (const [url, want] of table.mapsUrls) assert.equal(policy.isGoogleMapsUrl(url), want, String(url));
  for (const [ed, pageUrl, want] of table.placesOrigin) assert.equal(policy.isPlacesOriginCandidate(ed, pageUrl), want, JSON.stringify([ed, pageUrl]));
  // Deno + Python twins exist and carry the same constant, reason and origin keys
  const ts = fs.readFileSync(path.join(SHARED, 'googlePlacesPolicy.ts'), 'utf8');
  const py = fs.readFileSync(path.join(__dirname, '../../playground-discovery/google_policy.py'), 'utf8');
  assert.match(ts, /export const GOOGLE_PLACES_CONTENT_PERSISTENCE = false;/);
  assert.match(py, /^GOOGLE_PLACES_CONTENT_PERSISTENCE = False$/m);
  for (const src of [ts, py]) { assert.ok(src.includes(REASON)); for (const k of policy.PLACES_ORIGIN_KEYS) assert.ok(src.includes(`'${k}'`) || src.includes(`"${k}"`), k); }
  // a google_place_id alone never makes a row Places-origin / Google-origin
  assert.equal(policy.isPlacesOriginCandidate({ name: 'x', google_place_id: 'ChIJ1' }, 'https://www.raanana.muni.il/x'), false);
  assert.equal(policy.isGoogleOriginActivity({ source_url: 'https://www.openstreetmap.org/node/1', google_place_id: 'ChIJ1' }), false);
  assert.equal(policy.isGoogleOriginActivity({ source_url: MAPS }), true);
});

// ---- A: Places-shaped incoming cannot publish ----
for (const [shape, row] of Object.entries(PLACES_SHAPES)) {
  test(`A (${shape}): a Places-origin incoming row cannot publish - auto, human, dry run - and is not rejected / archived`, async () => {
    for (const mode of ['auto', 'human']) {
      const db = fakeDb(world({ ...row, source_id: null }));
      const r = await publishIncoming(db.client, 'bot', 'inc-1', { mode });
      assert.equal(r.outcome, PUBLISH_OUTCOME.POLICY_INELIGIBLE, JSON.stringify(r.body).slice(0, 300));
      assert.ok(r.body.blockers.includes(REASON), JSON.stringify(r.body.blockers));
      assert.deepEqual(catalogueWrites(db), [], 'no activity / location / image / provenance row');
      const inc = db.t.incoming_activities[0];
      assert.deepEqual([inc.status, inc.reject_reason, inc.archive_reason, inc.created_activity_id], ['new', undefined, undefined, null], 'evidence row kept as is');
      assert.deepEqual(inc.extracted_data, row.extracted_data, 'extracted_data untouched');
    }
    const dry = fakeDb(world({ ...row, source_id: null }));
    const d = await publishIncoming(dry.client, 'bot', 'inc-1', { mode: 'human', dryRun: true });
    assert.equal(d.outcome, PUBLISH_OUTCOME.POLICY_INELIGIBLE);
    assert.deepEqual(dry.writes, []);
  });
}

test('A: a Places row whose place id is already live is NOT linked as a duplicate (would store its Maps page_url as provenance)', async () => {
  const db = fakeDb(world({ ...PLACES_SHAPES.scan_settlement_gaps, source_id: null }, { activities: [{ id: 'act-osm', name: 'גן שעשועים – הדקל, רעננה', google_place_id: 'ChIJnew1', status: 'approved', source_url: 'https://www.openstreetmap.org/node/7' }] }));
  const r = await publishIncoming(db.client, 'reviewer', 'inc-1', { mode: 'human' });
  assert.equal(r.outcome, PUBLISH_OUTCOME.POLICY_INELIGIBLE);
  assert.deepEqual(db.t.activity_sources, []);
  assert.equal(db.t.incoming_activities[0].status, 'new');
});

test('A: a Places-origin UPDATE row is refused too (it would write Places content onto the existing activity)', async () => {
  const db = fakeDb(world({ ...PLACES_SHAPES.python_discovery, match_type: 'update', source_id: null }, { activities: [{ id: 'act-1', name: 'גן', status: 'approved' }] }));
  db.t.incoming_activities[0].existing_activity_id = 'act-1';
  const r = await publishIncoming(db.client, 'reviewer', 'inc-1', { mode: 'human' });
  assert.equal(r.outcome, PUBLISH_OUTCOME.POLICY_INELIGIBLE);
  assert.deepEqual(catalogueWrites(db), []);
});

// ---- B: ordinary incoming still publishes ----
test('B: an ordinary page-extracted incoming row still publishes normally (with and without an independent google_place_id)', async () => {
  for (const extra of [{}, { google_place_id: 'ChIJindependent' }]) {
    const db = fakeDb(world({ extracted_data: pageCandidate(extra) }));
    const r = await publishIncoming(db.client, 'bot', 'inc-1', { mode: 'auto' });
    assert.equal(r.outcome, PUBLISH_OUTCOME.PUBLISHED, JSON.stringify(r.body));
    assert.equal(db.t.activities.length, 1);
    assert.equal(db.t.activities[0].source_url, 'https://x/events');
    assert.equal(db.t.activities[0].google_place_id, extra.google_place_id || null);
    assert.equal(db.t.activity_sources[0].page_url, 'https://x/events');
  }
});

// ---- classifier: explicit provenance only - a generic coordinate / address / place-id key is never a Google fingerprint ----
test('classifier: Places-origin only by Maps page_url, google_maps_uri or formatted_address + place_kind; independent coordinate rows are never held', async () => {
  const origin = policy.isPlacesOriginCandidate;
  // A real Places-shaped incoming (all three writers) / B Google Maps page_url
  for (const row of Object.values(PLACES_SHAPES)) assert.equal(origin(row.extracted_data, row.page_url), true);
  assert.equal(origin({ ...PLACES_SHAPES.scan_settlement_gaps.extracted_data }, null), true, 'the Places key pair holds even without a page_url');
  assert.equal(origin({ name: 'x', city: 'רעננה', lat: 32.1, lng: 34.8 }, 'https://www.google.com/maps/place/x'), true);
  const independent = {
    C_osm_with_place_id: [{ name: 'גן שעשועים', lat: 32.18, lon: 34.87, osm_type: 'node', osm_id: 7, google_place_id: 'ChIJosm' }, 'https://www.openstreetmap.org/node/7'],
    D_municipal_gis_lat_lon: [{ name: 'גינה ציבורית', city: 'תל אביב-יפו', lat: 32.08, lon: 34.78, latitude: 32.08, longitude: 34.78 }, 'https://gisn.tel-aviv.gov.il/arcgis/rest/services/x/MapServer/0/query'],
    E_arcgis_geometry: [{ name: 'מתקן משחקים', geometry: { x: 34.78, y: 32.08, spatialReference: { wkid: 4326 } }, lat: 32.08, lon: 34.78 }, 'https://services.arcgis.com/abc/arcgis/rest/services/P/FeatureServer/0'],
    F_official_page_coords: [pageCandidate({ lon: 34.77, latitude: 32.01, longitude: 34.77 }), 'https://www.holon.muni.il/events/1'],
    G_place_id_alone: [{ google_place_id: 'ChIJ1' }, null],
    lone_formatted_address: [{ name: 'x', formatted_address: 'הדקל 5, רעננה' }, 'https://www.raanana.muni.il/x'],
    lone_place_kind: [{ name: 'x', place_kind: 'playground', lat: 32.1, lon: 34.8 }, 'https://www.playground-maker.co.il/projects-map'],
  };
  for (const [label, [ed, pageUrl]] of Object.entries(independent)) {
    assert.equal(origin(ed, pageUrl), false, label);
    assert.equal(policy.placesPersistenceReason(ed, pageUrl), null, label);
    assert.equal(policy.cleanerPolicyHold({ subjectKind: 'incoming', incoming: { extracted_data: ed, page_url: pageUrl } }), null, label);
  }
  // end to end: an ordinary page row that happens to carry `lon` is not held by the release policy
  const db = fakeDb(world({ extracted_data: pageCandidate({ lon: 34.77 }) }));
  const r = await publishIncoming(db.client, 'bot', 'inc-1', { mode: 'auto' });
  assert.ok(!(r.body.blockers || []).includes(REASON), JSON.stringify(r.body).slice(0, 300));
  assert.equal(r.outcome, PUBLISH_OUTCOME.PUBLISHED, JSON.stringify(r.body).slice(0, 300));
  // the Cleaner venue-cluster loader reads exactly the keys the rule reads (no drift back to `lon`)
  const vc = fs.readFileSync(path.join(__dirname, '../cleaner/venueClusters.js'), 'utf8');
  assert.ok(!/extracted_data->>lon\b|'lon'/.test(vc));
  assert.deepEqual([...policy.PLACES_ORIGIN_KEYS].sort(), ['formatted_address', 'google_maps_uri', 'place_kind']);
});

// ---- incomingShape ADDRESS-WIPE regression, through the real publish path ----
// incomingShape.isPlacesShape (pre-fix) sent any row with `lon` or `google_place_id` through the Places normalization:
// address re-derived from a missing formatted_address (-> null), playground defaults invented. Now only Places
// provenance (googlePlacesPolicy) does; `lon` / a place id / geometry / latitude-longitude change nothing.
test('address-wipe regression: independent rows with coordinates / lon / google_place_id publish with their own facts', async () => {
  const MUNI = 'https://www.holon.muni.il/events/1';
  const base = pageCandidate({ address: 'הנרקיס 3, חולון' }); // lat 32.01 / lng 34.77, no price, no indoor_outdoor
  const variants = {
    A_municipal_lat_lon: [{ ...base, lon: 34.77 }, MUNI],
    B_osm_lat_lon_only: [{ ...base, lng: undefined, lon: 34.77, osm_type: 'node', osm_id: 7 }, 'https://www.openstreetmap.org/node/7'],
    C_place_id: [{ ...base, google_place_id: 'ChIJindependent' }, MUNI],
    D_place_id_lat_lon: [{ ...base, lng: undefined, lon: 34.77, google_place_id: 'ChIJindependent' }, MUNI],
    E_arcgis_geometry: [{ ...base, geometry: { x: 34.77, y: 32.01, spatialReference: { wkid: 4326 } }, lon: 34.77 }, 'https://services.arcgis.com/abc/arcgis/rest/services/P/FeatureServer/0'],
    F_official_all_coord_keys: [{ ...base, lon: 34.77, latitude: 32.01, longitude: 34.77 }, MUNI],
  };
  const publish = async (ed, pageUrl) => {
    const db = fakeDb(world({ extracted_data: JSON.parse(JSON.stringify(ed)), page_url: pageUrl }));
    const r = await publishIncoming(db.client, 'reviewer', 'inc-1', { mode: 'human' });
    return { r, db };
  };
  const strip = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !/^id$|_id$|_at$/.test(k)));
  const baseline = await publish(base, MUNI);
  assert.equal(baseline.r.outcome, PUBLISH_OUTCOME.PUBLISHED, JSON.stringify(baseline.r.body));
  const [bAct, bLoc] = [baseline.db.t.activities[0], baseline.db.t.locations[0]];
  assert.deepEqual([bLoc.address, bLoc.city, bLoc.lat, bLoc.lng], ['הנרקיס 3, חולון', 'חולון', 32.01, 34.77]);
  for (const [label, [ed, pageUrl]] of Object.entries(variants)) {
    assert.equal(policy.isPlacesOriginCandidate(ed, pageUrl), false, label);
    const { r, db } = await publish(ed, pageUrl);
    assert.equal(r.outcome, PUBLISH_OUTCOME.PUBLISHED, `${label}: ${JSON.stringify(r.body).slice(0, 300)}`);
    const [a, l] = [db.t.activities[0], db.t.locations[0]];
    assert.equal(l.address, 'הנרקיס 3, חולון', `${label}: address survives`);
    assert.deepEqual([l.city, l.lat, l.lng, l.name], ['חולון', 32.01, 34.77, base.location_name], `${label}: city / coords / label survive`);
    assert.deepEqual([a.name, a.category, a.source_url], [base.name, base.category, pageUrl], `${label}: name / category / source`);
    assert.equal(a.google_place_id, ed.google_place_id || null, `${label}: a place id rides along, nothing else`);
    assert.equal(db.t.activity_sources[0].page_url, pageUrl, `${label}: provenance is the independent source`);
    // nothing changed merely because coordinates / lon / a place id exist: same rows as the plain page candidate
    assert.deepEqual({ ...strip(a), source_url: null }, { ...strip(bAct), source_url: null }, `${label}: activity identical to the plain row`);
    assert.deepEqual(strip(l), strip(bLoc), `${label}: location identical to the plain row`);
  }
  // automation too: a row that already has lng publishes automatically with a place id and lon attached
  const auto = fakeDb(world({ extracted_data: { ...base, lon: 34.77, google_place_id: 'ChIJindependent' }, page_url: MUNI }));
  const ar = await publishIncoming(auto.client, 'bot', 'inc-1', { mode: 'auto' });
  assert.equal(ar.outcome, PUBLISH_OUTCOME.PUBLISHED, JSON.stringify(ar.body).slice(0, 300));
  assert.equal(auto.t.locations[0].address, 'הנרקיס 3, חולון');
  // the real Places shapes and a Maps page_url are still held on the same path (section A above covers all three writers)
  for (const [ed, pageUrl] of [[PLACES_SHAPES.scan_settlement_gaps.extracted_data, MAPS], [{ ...base, google_place_id: 'ChIJx' }, 'https://www.google.com/maps/place/x']]) {
    const db = fakeDb(world({ extracted_data: ed, page_url: pageUrl, source_id: null }));
    const r = await publishIncoming(db.client, 'reviewer', 'inc-1', { mode: 'human' });
    assert.ok(r.body.blockers.includes(REASON), JSON.stringify(r.body).slice(0, 300));
    assert.deepEqual(catalogueWrites(db), []);
  }
});

// ---- C + D: independent activity + Google reconciliation -> place id only ----
test('C/D: reconciliation stores the place id on the independent row and nothing else (name / address / coords / source kept)', async () => {
  const osm = { id: 'act-osm', name: 'גן שעשועים – הדקל, רעננה', status: 'approved', category: 'גן שעשועים', google_place_id: null, location_id: 'loc-osm', source_url: 'https://www.openstreetmap.org/node/7' };
  const loc = { id: 'loc-osm', name: 'גן שעשועים – הדקל', address: null, city: 'רעננה', lat: 32.1801, lng: 34.8702 };
  const db = fakeDb({ activities: [osm], locations: [loc], settlement_scan_review_cases: [{ id: 'rc-1', google_place_id: 'ChIJgoogle', status: 'needs_review' }], settlement_scan_review_decisions: [] });
  const p = { outcome: 'DUPLICATE', confidence: 'HIGH', decisive: 'same street', signals: ['same street'], match: { id: 'act-osm', name: osm.name, category: osm.category },
    evidence: { candidate: { name: 'Google Park Name', address: 'הדקל 5, רעננה', city: 'רעננה', lat: 32.18012, lon: 34.87031 } } };
  const r = await applyOutcome(db.client, { id: 'rc-1', google_place_id: 'ChIJgoogle' }, p, { userId: 'bot' });
  assert.equal(r.applied, true);
  assert.deepEqual(r.gain, ['placeIdsAdded']);
  const a = db.t.activities[0]; const l = db.t.locations[0];
  assert.equal(a.google_place_id, 'ChIJgoogle', 'C: the place id is stored');
  assert.deepEqual([a.name, a.category, a.source_url], [osm.name, osm.category, osm.source_url], 'D: independent facts kept');
  assert.deepEqual([l.address, l.city, l.lat, l.lng, l.name], [null, 'רעננה', 32.1801, 34.8702, loc.name], 'D: no Places address / coords / name');
  const activityPatches = db.writes.filter((w) => w.table === 'activities' || w.table === 'locations').map((w) => Object.keys(w.patch));
  assert.deepEqual(activityPatches, [['google_place_id']], 'the only catalogue write is the place id');
  // fill-null: an existing place id is never replaced
  const again = fakeDb({ activities: [{ ...osm, google_place_id: 'ChIJother' }], locations: [loc], settlement_scan_review_cases: [{ id: 'rc-1', google_place_id: 'ChIJgoogle', status: 'needs_review' }], settlement_scan_review_decisions: [] });
  await applyOutcome(again.client, { id: 'rc-1', google_place_id: 'ChIJgoogle' }, p, { userId: 'bot' });
  assert.equal(again.t.activities[0].google_place_id, 'ChIJother');
});

test('Cleaner settlement NEW_VALID never becomes an incoming row / activity (nothing written)', async () => {
  const db = fakeDb({ settlement_scan_review_cases: [{ id: 'rc-2', google_place_id: 'ChIJnew', status: 'needs_review' }], settlement_scan_candidates: [{ google_place_id: 'ChIJnew', source_url: MAPS }] });
  const p = { outcome: 'NEW_VALID', confidence: 'HIGH', signals: ['playground'], category: 'גן שעשועים', evidence: { candidate: { name: 'גן חדש', address: 'הדקל 5, רעננה', city: 'רעננה', kind: 'PLAYGROUND', lat: 32.1, lon: 34.8 } } };
  const r = await applyOutcome(db.client, { id: 'rc-2', google_place_id: 'ChIJnew' }, p, { userId: 'bot' });
  assert.deepEqual(r, { applied: false, why: REASON });
  assert.deepEqual(db.writes, []);
  assert.equal(db.t.settlement_scan_review_cases[0].status, 'needs_review');
});

// ---- E: a Google Maps webpage is never a scrape source ----
test('E: a Google Maps page is rejected as a scrape / extraction / Cleaner source - without a request', async () => {
  const realFetch = global.fetch; const calls = [];
  global.fetch = async (u) => { calls.push(String(u)); return new Response('<html><body>ok page</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }); };
  try {
    for (const url of [MAPS, 'https://www.google.com/maps/place/Park/@32,34,17z', 'https://maps.app.goo.gl/abc']) {
      const r = await fetchHtml(url);
      assert.deepEqual([r.ok, r.error, r.blocked], [false, 'google_maps_page_not_a_source', 'google_maps']);
      assert.equal(await fetchPageTextForExtraction(url), null);
      await assert.rejects(scrapeAndExtract(url), (e) => e.status === 422 && e.code === 'GOOGLE_MAPS_PAGE_NOT_A_SOURCE');
    }
    assert.deepEqual(calls, [], 'no request to a Maps page');
    // ordinary pages and Maps URL GENERATION are unaffected
    const ok = await fetchHtml('https://www.raanana.muni.il/events');
    assert.equal(ok.ok, true);
    assert.equal(await fetchPageTextForExtraction('https://www.raanana.muni.il/events'), 'ok page');
    assert.deepEqual(calls, ['https://www.raanana.muni.il/events', 'https://www.raanana.muni.il/events']);
    const nav = fs.readFileSync(path.join(__dirname, '../../../lib/openNavigation.js'), 'utf8');
    assert.match(nav, /google\.com\/maps/, 'user navigation still builds Google Maps links');
  } finally { global.fetch = realFetch; }
});

// ---- F: googleMapsUri never enters a newly created activity / source / image row ----
test('F: saveNewActivity refuses a Maps source / detail / image URL before ANY write', async () => {
  const cases = [[MAPS, {}], ['https://x/events', { detail_url: MAPS }], ['https://x/events', { images: [{ url: MAPS, source_type: 'PROVIDER' }] }]];
  for (const [sourceUrl, extra] of cases) {
    const db = fakeDb(world());
    await assert.rejects(saveNewActivity(db.client, 'bot', sourceUrl, { ...pageCandidate(), ...extra }, {}), (e) => e.code === 'GOOGLE_PLACES_PERSISTENCE_DISABLED');
    assert.deepEqual(db.writes, []);
  }
});

test('F: provenance never stores a Maps page_url (upsert and twin-merge copy)', async () => {
  const db = fakeDb({ activity_sources: [] });
  const r = await upsertProvenanceSafe(db.client, 'act-1', { pageUrl: MAPS, relation: 'seen' });
  assert.equal(r.outcome, OUTCOME.FAILED);
  assert.match(r.error, new RegExp(REASON));
  assert.deepEqual(db.writes, []);
  const ok = await upsertProvenanceSafe(db.client, 'act-1', { pageUrl: 'https://x/events', relation: 'seen' });
  assert.equal(ok.outcome, OUTCOME.ADDED);
});

test('F: a merge never copies a Google-provenance image row (Maps image_source_url / raw Places photo url)', () => {
  const { classifyImage, isCopyableSourceImage, IMAGE_CLASS } = require('../lib/mergeImages');
  const base = { status: 'approved', image_source_type: 'ORIGINAL_SOURCE', needs_rights_review: false, image_kind: null, image_page_url: null, retrieved_at: null };
  assert.equal(isCopyableSourceImage({ ...base, url: 'https://cdn.example.org/a.jpg', image_source_url: MAPS }), false);
  assert.equal(isCopyableSourceImage({ ...base, url: 'https://lh3.googleusercontent.com/place-photos/abc=s800', image_source_url: null }), false);
  assert.equal(classifyImage({ ...base, url: 'https://cdn.example.org/a.jpg', image_source_url: MAPS }), IMAGE_CLASS.PROVIDER);
  // ordinary approved source images are still copied
  assert.equal(isCopyableSourceImage({ ...base, url: 'https://cdn.example.org/a.jpg', image_source_url: 'https://example.org/page' }), true);
  assert.equal(policy.isRawGooglePlacesPhotoUrl('https://places.googleapis.com/v1/places/ChIJ1/photos/ref/media'), true);
  assert.equal(policy.isRawGooglePlacesPhotoUrl('https://storage.googleapis.com/bucket/a.jpg'), false);
  assert.equal(policy.isRawGooglePlacesPhotoUrl('https://proj.supabase.co/functions/v1/place-photo/ChIJ1'), false);
});

test('F: the Cleaner hand-back never matches / merges / enriches / publishes a Places-origin row (no write at all)', async () => {
  const calls = [];
  setPublishImplForTests(async () => { calls.push('publish'); return { outcome: 'PUBLISHED', status: 200, body: { activityId: 'x' } }; });
  try {
    for (const row of Object.values(PLACES_SHAPES)) {
      const db = fakeDb(world({ ...row, source_id: null }, { activities: [{ id: 'act-osm', name: 'גן שעשועים הדקל', status: 'approved', google_place_id: null }] }));
      const settings = { thresholds: { duplicate: 0.9, needsReview: 0.6, proximityKm: 0.15 }, minTrust: 80, maxDaysAhead: 180 };
      const hb = await handBackIncoming(db.client, db.t.incoming_activities[0], { settings, userId: 'bot', cache: new Map(), today: TODAY_ISO.slice(0, 10), counters: { gain: {} } });
      assert.deepEqual([hb.outcome, hb.why, hb.via], ['awaiting_policy', REASON, 'google_places_policy']);
      assert.deepEqual(db.writes, []);
    }
    assert.deepEqual(calls, []);
  } finally { setPublishImplForTests(null); }
});

test('Cleaner hold rule: settlement reviews, Places-origin incoming and Google-origin activities are held; everything else is normal work', () => {
  const hold = policy.cleanerPolicyHold;
  assert.equal(hold({ subjectKind: 'settlement_review' }).subject, 'settlement_scan_candidate');
  for (const row of Object.values(PLACES_SHAPES)) assert.equal(hold({ subjectKind: 'incoming', incoming: row }).reason, REASON);
  assert.equal(hold({ subjectKind: 'incoming', incoming: { page_url: 'https://x/events', extracted_data: pageCandidate() } }), null);
  assert.equal(hold({ subjectKind: 'activity', activity: { source_url: MAPS, google_place_id: 'ChIJ1' } }).subject, 'google_origin_activity');
  // the 215 independent rows that later received a place id are ordinary Cleaner work
  assert.equal(hold({ subjectKind: 'activity', activity: { source_url: 'https://www.openstreetmap.org/node/7', google_place_id: 'ChIJ1' } }), null);
  assert.equal(hold({ subjectKind: 'activity', activity: { source_url: 'https://www.raanana.muni.il/x', google_place_id: null } }), null);
  // cleaner.js applies the rule to all three subject kinds before any processing, releasing (not archiving) the case
  const src = fs.readFileSync(path.join(__dirname, '../cleaner.js'), 'utf8');
  assert.equal((src.match(/cleanerPolicyHold\(/g) || []).length, 3);
  assert.match(src, /async function holdForGooglePolicy[\s\S]*?\.\.\.RELEASE, last_error:/);
});

// ---- G: SerpAPI behaviour from MAIN unchanged ----
test('G: SerpAPI image rule unchanged - never for a place-id row, still for an ordinary row with no image', async () => {
  assert.equal(mayAutoSearchImage({ imageAdded: false, archived: false, googlePlaceId: 'ChIJ1' }), false);
  assert.equal(mayAutoSearchImage({ imageAdded: false, archived: false, googlePlaceId: null }), true);
  assert.equal(mayAutoSearchImage({ imageAdded: true, archived: false, googlePlaceId: null }), false);
  const inserts = [];
  const client = { from: (table) => ({ insert: (row) => { inserts.push({ table, row }); return Promise.resolve({ error: null }); }, update: () => ({ eq: () => Promise.resolve({ error: null }) }) }) };
  const search = async () => ({ url: 'https://cdn.example.org/p.jpg', sourcePageUrl: 'https://example.org/p' });
  const r = await autoImageFallback(client, { activityId: 'a', userId: 'u', archived: false, imageAdded: false, placeholderGroup: 'park', activity: { name: 'x', city: 'y', google_place_id: null }, search });
  assert.deepEqual([r.searched, r.inserted, inserts[0].row.image_source_type, inserts[0].row.needs_rights_review], [true, true, 'EXTERNAL_SOURCE', true]);
});

test('places_photos stays gated OFF by default (Monster)', () => {
  const now = new Date('2026-09-27T10:00:00Z');
  assert.ok(!selectJobs({ state: {}, now, gates: {} }).some((j) => j.id === 'places_photos'));
  assert.ok(!selectJobs({ state: {}, now, gates: { places_photos_enabled: 'true' } }).some((j) => j.id === 'places_photos'));
});

test('static: no Node writer stores a Places response field; scan-settlement-gaps is hard-gated before any Places call', () => {
  const edge = fs.readFileSync(path.join(SHARED, '../scan-settlement-gaps/index.ts'), 'utf8');
  const serveAt = edge.indexOf('Deno.serve(');
  const gateAt = edge.indexOf('const gate = settlementScanGate(settings);');
  assert.ok(serveAt > 0 && gateAt > serveAt);
  const sinceServe = (re) => [...edge.slice(serveAt).matchAll(re)].map((m) => serveAt + m.index);
  const effects = [...sinceServe(/await (countNearbyIds|searchTextPlaygrounds|hasPhotos)\(/g), ...sinceServe(/\.(insert|update|upsert)\(/g)];
  assert.ok(effects.length >= 10);
  for (const at of effects) assert.ok(at > gateAt, 'every Places call and every write comes after the hard gate: ' + edge.slice(at, at + 60));
  assert.ok(!/DISCOVERY_FIELD_MASK = '[^']*googleMapsUri/.test(edge), 'googleMapsUri is no longer requested');
  // Node import-tool: no live writer maps googleMapsUri / websiteUri / primaryType / displayName into a row
  const files = ['server.js', 'cleaner.js', 'cleaner/apply.js', 'cleaner/settlementResolver.js', 'cleaner/locationResolver.js', 'cleaner/imageResolver.js', 'lib/serpImage.js', 'incomingShape.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    // (Nominatim's own `displayName` is OSM data - only the Places shape displayName.text / {text} counts)
    assert.ok(!/googleMapsUri|websiteUri|primaryType|displayName\s*\?*\.\s*text|displayName \|\| \{\}/.test(src), f);
  }
});
