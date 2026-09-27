// Merge image safety (2026-09-27): lib/mergeImages.js is the one rule for copying activity_images rows between
// activities - a place-photo proxy / PROVIDER row is never copied (it names the LOSER's place: production row
// ee34196d, reconcile-playground-twins 2026-09-14), only approved non-provider rows are copied, with their status and
// provenance exactly. Then: every live copy path is pinned to the helper (static), and /api/merge's server-side
// enforcement is exercised end to end against an in-memory client.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  COPY_COLUMNS, IMAGE_COPY_SELECT, IMAGE_CLASS, isPlacePhotoProxyUrl, proxyPlaceId, isProviderImage, classifyImage,
  isCopyableSourceImage, planImageCopy, copyLoserImages, planRequestedMergeImages,
} = require('../lib/mergeImages');

const SUPA = 'https://proj.supabase.co';
const proxy = (pid) => `${SUPA}/functions/v1/place-photo/${pid}`;
const KEEPER = 'keeper-1';
const ACTOR = 'actor-1';
const LOSER_PID = 'ChIJj5Oj-loser';
const KEEPER_PID = 'ChIJFe1m-keeper';

// a fully selected source row (IMAGE_COPY_SELECT); overrides win
function img(over = {}) {
  return { id: over.id || 'img-x', url: 'https://cdn.example/a.jpg', status: 'approved', image_source_type: 'EXTERNAL_SOURCE', image_source_url: 'https://site.example/page', needs_rights_review: true, image_kind: 'venue_specific', image_page_url: 'https://site.example/page', retrieved_at: '2026-09-01T10:00:00.000Z', ...over };
}
const plan = (loserImages, keeperImages = [], extra = {}) => planImageCopy({ loserImages, keeperImages, keeperId: KEEPER, uploadedBy: ACTOR, ...extra });

// ---- recognisers ----

test('proxy recogniser: URL shape, host-agnostic, embedded place id extracted', () => {
  assert.equal(isPlacePhotoProxyUrl(proxy('P1')), true);
  assert.equal(isPlacePhotoProxyUrl('https://other.host/functions/v1/place-photo/P1?maxwidth=800'), true);
  assert.equal(isPlacePhotoProxyUrl(`${SUPA}/functions/v1/place-photo/`), false, 'empty path is not a proxy');
  assert.equal(isPlacePhotoProxyUrl('https://lh3.googleusercontent.com/p/x'), false);
  assert.equal(proxyPlaceId(proxy('ChIJabc') + '?maxwidth=1200'), 'ChIJabc');
  assert.equal(proxyPlaceId(proxy('ChIJ%2Babc')), 'ChIJ+abc');
  assert.equal(proxyPlaceId('https://cdn.example/a.jpg'), null);
  assert.equal(isProviderImage({ url: 'https://lh3.googleusercontent.com/p/x', image_source_type: 'PROVIDER' }), true, 'PROVIDER label alone');
  assert.equal(isProviderImage({ url: proxy('P'), image_source_type: null }), true, 'proxy URL alone');
  assert.equal(classifyImage({ url: proxy('P'), status: 'approved', image_source_type: 'ORIGINAL_SOURCE' }), IMAGE_CLASS.PROVIDER, 'URL beats a wrong label');
});

// ---- 1-14: the helper contract ----

test('1. loser proxy with a DIFFERENT place id than the keeper -> never copied', () => {
  const p = plan([img({ url: proxy(LOSER_PID), image_source_type: 'PROVIDER', image_source_url: null, needs_rights_review: false })]);
  assert.deepEqual(p.rows, []);
  assert.equal(p.skipped.provider, 1);
});

test('2. loser proxy with the SAME place id as the keeper -> still never copied', () => {
  const p = plan([img({ url: proxy(KEEPER_PID), image_source_type: 'PROVIDER' })]);
  assert.deepEqual(p.rows, []);
  assert.equal(p.skipped.provider, 1);
});

test('3. keeper without google_place_id -> loser proxy never copied (the rule never reads place ids)', () => {
  const p = planImageCopy({ loserImages: [img({ url: proxy(LOSER_PID), image_source_type: 'PROVIDER' })], keeperImages: [], keeperId: KEEPER, uploadedBy: ACTOR, keeperPlaceId: null });
  assert.deepEqual(p.rows, []);
});

test('4. proxy-shaped URL with null source_type -> never copied', () => {
  const p = plan([img({ url: proxy(LOSER_PID), image_source_type: null })]);
  assert.deepEqual(p.rows, []);
  assert.equal(p.decisions[0].class, IMAGE_CLASS.PROVIDER);
});

test('5/6. rejected or pending proxy -> never copied', () => {
  for (const status of ['rejected', 'pending']) {
    const p = plan([img({ url: proxy(LOSER_PID), image_source_type: 'PROVIDER', status })]);
    assert.deepEqual(p.rows, [], status);
    assert.equal(p.skipped.provider, 1, 'provider is decided before status');
  }
});

test('7/8. rejected or pending external image -> never copied (no resurrection)', () => {
  const p = plan([img({ id: 'r', status: 'rejected' }), img({ id: 'p', url: 'https://cdn.example/b.jpg', status: 'pending' })]);
  assert.deepEqual(p.rows, []);
  assert.equal(p.skipped.rejected, 1);
  assert.equal(p.skipped.pending, 1);
});

test('a row selected without status is never copied (the column default is approved)', () => {
  const p = plan([{ id: 'legacy', url: 'https://cdn.example/a.jpg' }]);
  assert.deepEqual(p.rows, []);
  assert.equal(p.skipped.unknown_status, 1);
  assert.equal(isCopyableSourceImage({ url: 'https://cdn.example/a.jpg' }), false);
});

test('9. approved EXTERNAL_SOURCE -> copied with every provenance column exactly', () => {
  const src = img();
  const p = plan([src]);
  assert.equal(p.rows.length, 1);
  const expected = { activity_id: KEEPER, uploaded_by: ACTOR };
  for (const c of COPY_COLUMNS) expected[c] = src[c];
  assert.deepEqual(p.rows[0], expected);
  assert.equal('id' in p.rows[0], false, 'new row id');
  assert.equal('created_at' in p.rows[0], false, 'copy creation time is the column default');
});

test('10. approved ORIGINAL_SOURCE -> copied with provenance preserved', () => {
  const src = img({ image_source_type: 'ORIGINAL_SOURCE', needs_rights_review: false, image_kind: 'event_specific' });
  const [row] = plan([src]).rows;
  assert.equal(row.image_source_type, 'ORIGINAL_SOURCE');
  assert.equal(row.image_kind, 'event_specific');
  assert.equal(row.image_page_url, src.image_page_url);
  assert.equal(row.retrieved_at, src.retrieved_at);
});

test('11. rights-review flag preserved (both values, never defaulted)', () => {
  assert.equal(plan([img({ needs_rights_review: true })]).rows[0].needs_rights_review, true);
  assert.equal(plan([img({ needs_rights_review: false })]).rows[0].needs_rights_review, false);
});

test('12. image_source_url preserved, including an honest null (never fabricated)', () => {
  assert.equal(plan([img({ image_source_url: 'https://orig.example/x' })]).rows[0].image_source_url, 'https://orig.example/x');
  const nullProv = plan([img({ image_source_url: null, image_source_type: null })]).rows[0];
  assert.equal(nullProv.image_source_url, null);
  assert.equal(nullProv.image_source_type, null);
});

test('13. source status written explicitly (approved), never left to the column default', () => {
  const [row] = plan([img()]).rows;
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'status'), true);
  assert.equal(row.status, 'approved');
});

test('14. keeper already has the same non-proxy URL -> no duplicate; loser-internal duplicates collapse too', () => {
  const src = img();
  const p = plan([src, img({ id: 'twin' })], [{ url: src.url, status: 'rejected' }]);
  assert.deepEqual(p.rows, []);
  assert.equal(p.skipped.duplicate_url, 2);
  const q = plan([img({ id: 'a' }), img({ id: 'b' })], []);
  assert.equal(q.rows.length, 1);
});

test('a narrowly selected approved row throws instead of silently defaulting provenance', () => {
  assert.throws(() => plan([{ id: 'n', url: 'https://cdn.example/a.jpg', status: 'approved' }]), /selected without/);
});

test('max caps copies; the proxy decision precedes URL/limit logic', () => {
  const p = plan([img({ id: 'px', url: proxy(LOSER_PID), image_source_type: 'PROVIDER' }), img({ id: 'a', url: 'https://c/1' }), img({ id: 'b', url: 'https://c/2' })], [], { max: 1 });
  assert.deepEqual(p.decisions.map((d) => d.outcome), ['provider', 'copy', 'over_limit']);
});

test('IMAGE_COPY_SELECT names every copied column', () => {
  for (const c of COPY_COLUMNS) assert.match(IMAGE_COPY_SELECT, new RegExp(`\\b${c}\\b`));
  assert.match(IMAGE_COPY_SELECT, /\bid\b/);
});

// ---- copyLoserImages against an in-memory client ----

function fakeClient(tables = {}) {
  const t = structuredClone(tables); const inserts = []; const deletes = []; const updates = [];
  const from = (table) => {
    const q = { op: 'select', f: [], patch: null, cols: null };
    const rows = () => (t[table] ||= []).filter((r) => q.f.every(([k, v]) => r[k] === v));
    const run = () => {
      if (q.op === 'insert') { const list = (Array.isArray(q.patch) ? q.patch : [q.patch]).map((p, i) => ({ id: `${table}-new-${(t[table] || []).length + i}`, ...p })); (t[table] ||= []).push(...list); inserts.push({ table, rows: list }); return { data: null, error: null }; }
      if (q.op === 'delete') { const hit = rows(); t[table] = (t[table] || []).filter((r) => !hit.includes(r)); deletes.push({ table, n: hit.length }); return { data: null, error: null }; }
      if (q.op === 'update') { const hit = rows(); hit.forEach((r) => Object.assign(r, q.patch)); updates.push({ table, patch: q.patch }); return { data: null, error: null }; }
      const cols = q.cols ? q.cols.split(',').map((s) => s.trim()) : null;
      return { data: rows().map((r) => (cols ? Object.fromEntries(cols.map((c) => [c, r[c]])) : { ...r })), error: null };
    };
    const b = {
      select(cols) { q.cols = cols; return b; }, insert(p) { q.op = 'insert'; q.patch = p; return b; }, update(p) { q.op = 'update'; q.patch = p; return b; }, delete() { q.op = 'delete'; return b; },
      eq(k, v) { q.f.push([k, v]); return b; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  };
  return { client: { from }, t, inserts, deletes, updates };
}

test('copyLoserImages: the Baltimore shape (keeper w/o image, loser holds only its own proxy) inserts nothing', async () => {
  const db = fakeClient();
  const r = await copyLoserImages(db.client, { loserImages: [img({ id: 'acd2cdca', url: proxy(LOSER_PID), image_source_type: 'PROVIDER', image_source_url: 'https://maps.google.com/?cid=1', needs_rights_review: false })], keeperImages: [], keeperId: KEEPER, uploadedBy: ACTOR, max: 3 });
  assert.equal(r.inserted, 0);
  assert.equal(r.skipped.provider, 1);
  assert.deepEqual(db.inserts, [], 'no activity_images write at all');
});

test('copyLoserImages: mixed loser -> only the approved non-proxy row lands, provenance intact', async () => {
  const db = fakeClient();
  const good = img({ id: 'good', url: 'https://cdn.example/good.jpg', image_source_type: 'ORIGINAL_SOURCE', needs_rights_review: false });
  const r = await copyLoserImages(db.client, { loserImages: [img({ id: 'px', url: proxy(LOSER_PID), image_source_type: null }), img({ id: 'rej', url: 'https://cdn.example/rej.jpg', status: 'rejected' }), good], keeperImages: [], keeperId: KEEPER, uploadedBy: ACTOR, max: 3 });
  assert.equal(r.inserted, 1);
  assert.equal(db.inserts.length, 1);
  const [row] = db.inserts[0].rows;
  assert.equal(row.url, good.url);
  assert.equal(row.status, 'approved');
  assert.equal(row.image_source_type, 'ORIGINAL_SOURCE');
  assert.equal(row.retrieved_at, good.retrieved_at);
});

// ---- path-level pins: every live copy path goes through the helper ----

const ROOT = path.join(__dirname, '..');
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const RAW_IMAGE_INSERT = /from\(\s*['"]activity_images['"]\s*\)\s*\.insert\(/;

for (const script of ['reconcile-playground-twins.js', 'audit-place-duplicates.js', 'dedupe-fingerprint-activities.js', 'merge-occurrence-duplicates.js']) {
  test(`path pin: ${script} copies images only through lib/mergeImages copyLoserImages, on fully selected rows`, () => {
    const s = src(script);
    assert.match(s, /require\('\.\/lib\/mergeImages'\)/);
    assert.match(s, /copyLoserImages\(client,/);
    assert.doesNotMatch(s, RAW_IMAGE_INSERT, 'no hand-rolled activity_images insert left');
    assert.match(s, /activity_images\(\$\{IMAGE_COPY_SELECT\}\)/, 'status + provenance selected before copying');
    assert.doesNotMatch(s, /status:\s*'approved',\s*image_source/, 'no forced approved on copied images');
  });
}

test('path pin: cleaner series-sibling image candidates are filtered by isCopyableSourceImage', () => {
  const s = src('cleaner.js');
  assert.match(s, /activity_images\(url, status, image_source_type\)/);
  assert.match(s, /\.filter\(isCopyableSourceImage\)\.map\(\(i\) => i\.url\)/);
});

test('path pin: server.js applyMergedFields plans images via planRequestedMergeImages', () => {
  const s = src('server.js');
  const body = s.slice(s.indexOf('async function applyMergedFields'), s.indexOf("app.post('/api/merge'"));
  assert.match(body, /planRequestedMergeImages\(/);
  assert.match(body, /select\(IMAGE_COPY_SELECT\)\.eq\('activity_id', deleteActivityId\)/);
  assert.doesNotMatch(body, /imageUrlsToAdd\s*\n?\s*\.filter/, 'the old unfiltered URL insert is gone');
});

// ---- /api/merge server-side enforcement (applyMergedFields, the /api/merge body) ----

test('/api/merge: proxy URLs refused even when the LLM/client asks; loser rows resolve status + provenance', async () => {
  const { applyMergedFields } = require('../server');
  const loserGood = img({ id: 'lg', activity_id: 'loser', url: 'https://cdn.example/good.jpg', image_source_type: 'ORIGINAL_SOURCE', needs_rights_review: false });
  const db = fakeClient({
    activities: [{ id: KEEPER }, { id: 'loser' }],
    activity_images: [
      img({ id: 'k1', activity_id: KEEPER, url: 'https://cdn.example/keeper.jpg' }),
      loserGood,
      img({ id: 'lp', activity_id: 'loser', url: proxy(LOSER_PID), image_source_type: 'PROVIDER' }),
      img({ id: 'lpn', activity_id: 'loser', url: 'https://x.test/functions/v1/place-photo/OTHER', image_source_type: null }),
      img({ id: 'lr', activity_id: 'loser', url: 'https://cdn.example/rejected.jpg', status: 'rejected' }),
      img({ id: 'lpe', activity_id: 'loser', url: 'https://cdn.example/pending.jpg', status: 'pending' }),
    ],
  });
  const out = await applyMergedFields(db.client, ACTOR, {
    existingActivityId: KEEPER, deleteActivityId: 'loser', mergedFields: {},
    imageUrlsToAdd: [proxy(LOSER_PID), 'https://x.test/functions/v1/place-photo/OTHER', proxy(KEEPER_PID), 'https://cdn.example/rejected.jpg', 'https://cdn.example/pending.jpg', 'https://cdn.example/hallucinated.jpg', loserGood.url],
  });
  const inserted = db.inserts.filter((i) => i.table === 'activity_images').flatMap((i) => i.rows);
  assert.equal(inserted.length, 1);
  const expected = { activity_id: KEEPER, uploaded_by: ACTOR };
  for (const c of COPY_COLUMNS) expected[c] = loserGood[c];
  assert.deepEqual(Object.fromEntries(Object.entries(inserted[0]).filter(([k]) => k !== 'id')), expected);
  const why = Object.fromEntries(out.imagesRefused.map((r) => [r.url, r.why]));
  assert.equal(why[proxy(LOSER_PID)], 'place_photo_proxy');
  assert.equal(why['https://x.test/functions/v1/place-photo/OTHER'], 'place_photo_proxy');
  assert.equal(why[proxy(KEEPER_PID)], 'place_photo_proxy', 'not even a proxy for the keeper\'s own place id');
  assert.equal(why['https://cdn.example/rejected.jpg'], 'rejected');
  assert.equal(why['https://cdn.example/pending.jpg'], 'pending');
  assert.equal(why['https://cdn.example/hallucinated.jpg'], 'not_a_loser_image');
  assert.equal(db.deletes.filter((d) => d.table === 'activities').length, 1, 'duplicate semantics unchanged: the loser is still deleted');
});

test('/api/merge scrape-time flow (no loser): proxy refused, other URLs inserted exactly as before, max 3, keeper dedupe', async () => {
  const { applyMergedFields } = require('../server');
  const db = fakeClient({ activities: [{ id: KEEPER }], activity_images: [{ id: 'k', activity_id: KEEPER, url: 'https://cdn.example/have.jpg', status: 'approved' }] });
  const out = await applyMergedFields(db.client, ACTOR, {
    existingActivityId: KEEPER, mergedFields: {},
    imageUrlsToAdd: [proxy('ANY'), 'https://cdn.example/have.jpg', 'https://c/1.jpg', 'https://c/2.jpg', 'https://c/3.jpg', 'https://c/4.jpg'],
  });
  const inserted = db.inserts.filter((i) => i.table === 'activity_images').flatMap((i) => i.rows).map(({ id, ...r }) => r);
  assert.deepEqual(inserted, ['https://c/1.jpg', 'https://c/2.jpg', 'https://c/3.jpg'].map((url) => ({ activity_id: KEEPER, url, uploaded_by: ACTOR })));
  assert.deepEqual(out.imagesRefused, [{ url: proxy('ANY'), why: 'place_photo_proxy' }]);
});

test('planRequestedMergeImages: a proxy is refused before loser resolution, whatever the loser holds', () => {
  const r = planRequestedMergeImages({ requestedUrls: [proxy(LOSER_PID)], loserImages: [img({ url: proxy(LOSER_PID), image_source_type: 'ORIGINAL_SOURCE' })], keeperImages: [], keeperId: KEEPER, uploadedBy: ACTOR });
  assert.deepEqual(r.rows, []);
  assert.deepEqual(r.refused, [{ url: proxy(LOSER_PID), why: 'place_photo_proxy' }]);
});
