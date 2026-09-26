// SerpAPI image search safety (2026-09-26): a Places activity never gets an automatic SerpAPI image, and every
// search-result row carries EXTERNAL_SOURCE + needs_rights_review (+ the result page when SerpAPI names one).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { searchGoogleImage, serpImageRow, mayAutoSearchImage, autoImageFallback } = require('../lib/serpImage');

function fakeClient() {
  const inserts = [];
  const updates = [];
  return {
    inserts, updates,
    from(table) {
      return {
        insert(row) { inserts.push({ table, row }); return Promise.resolve({ error: null }); },
        update(patch) { return { eq(k, v) { updates.push({ table, patch, [k]: v }); return Promise.resolve({ error: null }); } }; },
      };
    },
  };
}
function spySearch(result) {
  const calls = [];
  const fn = async (q) => { calls.push(q); return result; };
  fn.calls = calls;
  return fn;
}
const FOUND = { url: 'https://cdn.example.org/park.jpg', sourcePageUrl: 'https://example.org/park' };
const base = { activityId: 'act-1', userId: 'user-1', archived: false, imageAdded: false, placeholderGroup: 'park' };

test('A: google_place_id + no image -> searchGoogleImage is NOT called and nothing is written', async () => {
  const db = fakeClient();
  const search = spySearch(FOUND);
  const r = await autoImageFallback(db, { ...base, activity: { name: 'פארק נאות שקד', city: 'ירוחם', google_place_id: 'ChIJ123' }, search });
  assert.deepEqual(r, { searched: false, inserted: false });
  assert.equal(search.calls.length, 0);
  assert.deepEqual([db.inserts, db.updates], [[], []], 'placeholder kept, no image row');
});

test('B: a Places activity has no SerpAPI fallback in any state - the only automatic caller is guarded', async () => {
  // every combination a Places row can reach saveNewActivity with (no photo later = still no image row)
  for (const imageAdded of [false, true]) {
    for (const archived of [false, true]) {
      assert.equal(mayAutoSearchImage({ imageAdded, archived, googlePlaceId: 'ChIJ123' }), false);
    }
  }
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const calls = [...server.matchAll(/searchGoogleImage\(/g)].map((m) => m.index);
  const route = server.indexOf("app.post('/api/manage/search-photo'");
  const routeEnd = server.indexOf('app.post(', route + 1);
  assert.equal(calls.length, 1, 'server.js calls searchGoogleImage exactly once');
  assert.ok(calls[0] > route && calls[0] < routeEnd, 'and only from the manual admin button');
  const save = server.slice(server.indexOf('async function saveNewActivity'), server.indexOf('async function saveNewActivity') + 20000);
  assert.match(save, /await autoImageFallback\(client, \{ activity, activityId: savedActivity\.id, userId, archived, imageAdded, placeholderGroup \}\)/);
  // the places_photos job (no_photo / invalid / error outcomes) never reaches a web image search
  const pd = path.join(__dirname, '../../playground-discovery');
  for (const f of ['enrich_images.py', 'supabase_client.py', 'google_places.py']) {
    assert.doesNotMatch(fs.readFileSync(path.join(pd, f), 'utf8'), /serpapi|google_images|SERPAPI/i, f);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../lib/monsterJobs.js'), 'utf8'), /serpapi|search-photo/i);
});

test('C + D: a non-Places activity may still use SerpAPI; the row is EXTERNAL_SOURCE + needs_rights_review', async () => {
  const db = fakeClient();
  const search = spySearch(FOUND);
  const r = await autoImageFallback(db, { ...base, activity: { name: 'הצגת ילדים', city: 'חולון', google_place_id: null }, search });
  assert.deepEqual(r, { searched: true, inserted: true });
  assert.deepEqual(search.calls, ['הצגת ילדים חולון']);
  assert.equal(db.inserts.length, 1);
  assert.deepEqual(db.inserts[0], { table: 'activity_images', row: {
    activity_id: 'act-1', url: FOUND.url, uploaded_by: 'user-1',
    image_source_type: 'EXTERNAL_SOURCE', image_source_url: FOUND.sourcePageUrl, needs_rights_review: true,
  } });
  assert.ok(!('status' in db.inserts[0].row), 'automatic path keeps the column default (approved), as before');
  assert.deepEqual(db.updates, [{ table: 'activities', patch: { placeholder_group: null }, id: 'act-1' }]);
});

test('C: unchanged gates - an image from the source or an archived insert never searches', async () => {
  for (const over of [{ imageAdded: true }, { archived: true }]) {
    const db = fakeClient();
    const search = spySearch(FOUND);
    await autoImageFallback(db, { ...base, ...over, activity: { name: 'x', city: 'y' }, search });
    assert.equal(search.calls.length, 0);
    assert.equal(db.inserts.length, 0);
  }
  const db = fakeClient();
  await autoImageFallback(db, { ...base, activity: { name: 'x', city: 'y' }, search: spySearch(null) });
  assert.deepEqual([db.inserts, db.updates], [[], []], 'no result: nothing written, placeholder kept');
});

test('E: manual search-photo row is pending + EXTERNAL_SOURCE + needs_rights_review', () => {
  assert.deepEqual(serpImageRow({ activityId: 'act-2', userId: 'admin', found: FOUND, status: 'pending' }), {
    activity_id: 'act-2', url: FOUND.url, uploaded_by: 'admin', image_source_type: 'EXTERNAL_SOURCE',
    image_source_url: FOUND.sourcePageUrl, needs_rights_review: true, status: 'pending',
  });
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const route = server.slice(server.indexOf("app.post('/api/manage/search-photo'"), server.indexOf("app.post('/api/manage/manual-photo'"));
  assert.match(route, /\.insert\(serpImageRow\(\{ activityId: id, userId, found, status: 'pending' \}\)\)/);
});

function fakeFetch(body, { ok = true } = {}) {
  const urls = [];
  const fn = async (u) => { urls.push(u); return { ok, json: async () => body }; };
  fn.urls = urls;
  return fn;
}

test('F: image_source_url = the result page when SerpAPI exposes it; otherwise null, never the image URL', async () => {
  let f = fakeFetch({ images_results: [{ thumbnail: 't' }, { original: ' https://img.example/a.jpg ', link: 'https://site.example/page', source: 'site' }] });
  let r = await searchGoogleImage('פארק', { apiKey: 'k', fetchImpl: f });
  assert.deepEqual(r, { url: 'https://img.example/a.jpg', sourcePageUrl: 'https://site.example/page' });
  assert.match(f.urls[0], /engine=google_images/);
  assert.deepEqual(serpImageRow({ activityId: 'a', userId: 'u', found: r }).image_source_url, 'https://site.example/page');

  for (const link of [undefined, '', 'javascript:alert(1)', 42]) {
    r = await searchGoogleImage('פארק', { apiKey: 'k', fetchImpl: fakeFetch({ images_results: [{ original: 'https://img.example/b.jpg', link }] }) });
    assert.deepEqual(r, { url: 'https://img.example/b.jpg', sourcePageUrl: null }, String(link));
    const row = serpImageRow({ activityId: 'a', userId: 'u', found: r });
    assert.deepEqual([row.image_source_url, row.image_source_type, row.needs_rights_review], [null, 'EXTERNAL_SOURCE', true]);
  }
});

test('searchGoogleImage: no key / no query / HTTP error / no usable result / thrown fetch -> null', async () => {
  const f = fakeFetch({ images_results: [{ original: 'https://img/x.jpg' }] });
  assert.equal(await searchGoogleImage('q', { apiKey: '', fetchImpl: f }), null);
  assert.equal(await searchGoogleImage('', { apiKey: 'k', fetchImpl: f }), null);
  assert.equal(f.urls.length, 0, 'no key / no query: no paid call');
  assert.equal(await searchGoogleImage('q', { apiKey: 'k', fetchImpl: fakeFetch({}, { ok: false }) }), null);
  assert.equal(await searchGoogleImage('q', { apiKey: 'k', fetchImpl: fakeFetch({ images_results: [{ original: '  ' }] }) }), null);
  const orig = console.error; console.error = () => {};
  try {
    assert.equal(await searchGoogleImage('q', { apiKey: 'k', fetchImpl: async () => { throw new Error('net'); } }), null);
  } finally { console.error = orig; }
});
