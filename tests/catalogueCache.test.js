// Tests for the client catalogue cache (2026-09-25, "Activities Loading + Client Cache
// Performance"): lib/catalogueCache.js (store + freshness policy + results view state),
// lib/activities.js#fetchAllApprovedRows paging de-duplication and fetchApprovedActivities'
// public-only, locale-live row shape, and the /activities route-reuse seam (lib/homeSession.js
// #paramsChanged) running over ONE shared cached catalogue. Same require-hook (babel commonjs +
// stubs) as the other lib tests; the store is driven with a fake fetcher and a fake clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');
const { addHook } = require('pirates');

const ROOT = path.resolve(__dirname, '..');

// A swappable fake Supabase client: tests that exercise lib/activities.js install their own.
let fakeSupabase = {};
const STUBS = {
  'react-native': { Platform: { OS: 'node' }, StyleSheet: { create: (s) => s } },
  '@react-native-async-storage/async-storage': { default: { getItem: async () => null, setItem: async () => {} } },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === './supabase') return 'stub:./supabase';
  return STUBS[request] ? `stub:${request}` : origResolve.call(this, request, ...rest);
};
for (const [name, exp] of Object.entries(STUBS)) {
  const m = new Module(`stub:${name}`);
  m.exports = { __esModule: true, ...exp };
  m.loaded = true;
  Module._cache[`stub:${name}`] = m;
}
{
  const m = new Module('stub:./supabase');
  m.exports = { __esModule: true, get supabase() { return fakeSupabase; } };
  m.loaded = true;
  Module._cache['stub:./supabase'] = m;
}
addHook(
  (code, filename) => babel.transformSync(code, { filename, babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'] }).code,
  { exts: ['.js'], matcher: (f) => f.startsWith(path.join(ROOT, 'lib')) || f.startsWith(path.join(ROOT, 'constants')) },
);

const {
  createCatalogueStore, resolveResultsView, RESULTS_VIEW, FRESH_MS, MAX_AGE_MS, RETRY_BACKOFF_MS,
} = require('../lib/catalogueCache');
const { fetchAllApprovedRows, fetchApprovedActivities } = require('../lib/activities');
const { applyFilters, normalizeFilters } = require('../lib/filterActivities');
const { paramsChanged } = require('../lib/homeSession');
const { DEFAULT_FILTERS } = require('../constants/filterSchema');
const { setLocale } = require('../lib/i18n');

// --- helpers ---

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// A fetcher whose calls are counted and whose results the test resolves/rejects explicitly.
function makeFetcher() {
  const calls = [];
  const fetcher = () => new Promise((resolve, reject) => { calls.push({ resolve, reject }); });
  return { fetcher, calls };
}

async function settle(p) { try { await p; } catch { /* surfaced through the snapshot */ } }

// --- A / B: loading is never the empty state ---

test('A. initial load: catalogue still loading with 0 matches -> LOADING, never LOADED_EMPTY', () => {
  assert.equal(resolveResultsView({ catalogueStatus: 'loading', userStateReady: false, loadError: null, resultCount: 0 }), RESULTS_VIEW.LOADING);
  assert.equal(resolveResultsView({ catalogueStatus: 'loading', userStateReady: true, loadError: null, resultCount: 0 }), RESULTS_VIEW.LOADING);
});

test('A. cached catalogue ready but per-user filtering inputs not yet loaded -> still LOADING (no unfiltered flash)', () => {
  assert.equal(resolveResultsView({ catalogueStatus: 'ready', userStateReady: false, loadError: null, resultCount: 0 }), RESULTS_VIEW.LOADING);
  assert.equal(resolveResultsView({ catalogueStatus: 'ready', userStateReady: false, loadError: null, resultCount: 42 }), RESULTS_VIEW.LOADING);
});

test('A. a fresh store starts in status loading with an empty list (the screen must not read that as "0 found")', () => {
  const { fetcher } = makeFetcher();
  const store = createCatalogueStore({ fetcher });
  assert.equal(store.getSnapshot().status, 'loading');
  assert.equal(store.getSnapshot().activities.length, 0);
});

test('A. app/activities.js only renders the header count and the empty state outside LOADING/LOAD_FAILED', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app/activities.js'), 'utf8');
  assert.match(src, /\{!loading && !loadError \? \(\s*<Text style=\{styles\.titleCount\}/, 'header count must be gated on the loaded states');
  assert.match(src, /const nonListBody = loading \? \([\s\S]*?\) : loadError \? \([\s\S]*?\) : filteredActivities\.length === 0 \?/, 'empty state must come after the loading and error branches');
  assert.match(src, /const loading = resultsView === RESULTS_VIEW\.LOADING;/);
  assert.match(src, /const loadError = resultsView === RESULTS_VIEW\.LOAD_FAILED;/);
});

test('B. loaded with 0 matches -> LOADED_EMPTY; with matches -> LOADED_WITH_RESULTS', () => {
  assert.equal(resolveResultsView({ catalogueStatus: 'ready', userStateReady: true, loadError: null, resultCount: 0 }), RESULTS_VIEW.LOADED_EMPTY);
  assert.equal(resolveResultsView({ catalogueStatus: 'ready', userStateReady: true, loadError: null, resultCount: 3 }), RESULTS_VIEW.LOADED_WITH_RESULTS);
});

test('B. an empty catalogue that loaded successfully is ready (LOADED_EMPTY), not stuck loading', async () => {
  const { fetcher, calls } = makeFetcher();
  const store = createCatalogueStore({ fetcher });
  const p = store.ensureFresh();
  calls[0].resolve([]);
  await p;
  assert.equal(store.getSnapshot().status, 'ready');
  assert.equal(resolveResultsView({ catalogueStatus: store.getSnapshot().status, userStateReady: true, loadError: null, resultCount: 0 }), RESULTS_VIEW.LOADED_EMPTY);
});

// --- C / D / E: reuse ---

test('C. second visit inside the freshness window renders from cache with no request', async () => {
  const clock = makeClock();
  const { fetcher, calls } = makeFetcher();
  const store = createCatalogueStore({ fetcher, now: clock.now });
  const p = store.ensureFresh();
  calls[0].resolve([{ id: 'a' }, { id: 'b' }]);
  await p;
  clock.advance(FRESH_MS - 1);
  assert.equal(store.ensureFresh(), null, 'fresh cache -> no new request');
  assert.equal(calls.length, 1);
  assert.equal(store.getSnapshot().status, 'ready');
  assert.deepEqual(store.getSnapshot().activities.map((a) => a.id), ['a', 'b']);
});

test('C. concurrent consumers (Home + Activities mounting together) share one in-flight request', async () => {
  const { fetcher, calls } = makeFetcher();
  const store = createCatalogueStore({ fetcher });
  const p1 = store.ensureFresh();
  const p2 = store.ensureFresh();
  const p3 = store.ensureFresh({ force: true });
  assert.equal(calls.length, 1);
  assert.equal(p1, p2);
  assert.equal(p1, p3);
  calls[0].resolve([{ id: 'x' }]);
  await p1;
  assert.equal(store.getSnapshot().activities.length, 1);
});

// The Activities screen never passes filters/location to the catalogue: filter and location
// changes are pure in-memory re-ranking. Simulate a session of edits over one cached catalogue.
const CATALOG = [
  { id: 'net-park', title: 'גן שעשועים בנתניה', category: 'גן שעשועים', city: 'נתניה', region: 'השרון', lat: 32.32, lng: 34.85 },
  { id: 'net-zoo', title: 'פינת חי בנתניה', category: 'פינת חי', city: 'נתניה', region: 'השרון', lat: 32.33, lng: 34.86 },
  { id: 'jlm-zoo', title: 'גן חיות בירושלים', category: 'חיות וגני חיות', city: 'ירושלים', region: 'ירושלים', lat: 31.75, lng: 35.18 },
  { id: 'jlm-museum', title: 'מוזיאון בירושלים', category: 'מוזיאון', city: 'ירושלים', region: 'ירושלים', lat: 31.77, lng: 35.2 },
];
const ids = (list) => list.map((a) => a.id).sort();
const cityFilters = (city, extra = {}) => ({ ...DEFAULT_FILTERS, ...extra, location: { ...DEFAULT_FILTERS.location, mode: 'city', city } });
const ANIMALS = ['חיות וגני חיות', 'חווה', 'פינת חי', 'בעלי חיים'];

test('D. filter (category) changes reuse the cached catalogue - no refetch, results follow the new filter', async () => {
  const { fetcher, calls } = makeFetcher();
  const store = createCatalogueStore({ fetcher });
  const p = store.ensureFresh();
  calls[0].resolve(CATALOG);
  await p;
  const rows = store.getSnapshot().activities;
  assert.deepEqual(ids(applyFilters(rows, normalizeFilters(cityFilters('נתניה')), null, [], [], [], [])), ['net-park', 'net-zoo']);
  assert.deepEqual(ids(applyFilters(rows, normalizeFilters(cityFilters('נתניה', { category: ANIMALS })), null, [], [], [], [])), ['net-zoo']);
  store.ensureFresh();
  assert.equal(calls.length, 1, 'a filter edit is not a catalogue request');
});

test('E. location changes reuse the cached catalogue - no refetch, results follow the new place', async () => {
  const { fetcher, calls } = makeFetcher();
  const store = createCatalogueStore({ fetcher });
  const p = store.ensureFresh();
  calls[0].resolve(CATALOG);
  await p;
  const rows = store.getSnapshot().activities;
  assert.deepEqual(ids(applyFilters(rows, normalizeFilters(cityFilters('ירושלים')), null, [], [], [], [])), ['jlm-museum', 'jlm-zoo']);
  const nearNetanya = { ...DEFAULT_FILTERS, location: { ...DEFAULT_FILTERS.location, mode: 'current', radiusKm: 10, travelMode: 'driving' } };
  assert.deepEqual(ids(applyFilters(rows, normalizeFilters(nearNetanya), { latitude: 32.3215, longitude: 34.8532 }, [], [], [], [])), ['net-park', 'net-zoo']);
  store.ensureFresh();
  assert.equal(calls.length, 1, 'a location edit is not a catalogue request');
});

// --- F / G / H: freshness ---

test('F. stale cache (past FRESH_MS) is served immediately AND triggers one background refresh', async () => {
  const clock = makeClock();
  const { fetcher, calls } = makeFetcher();
  const store = createCatalogueStore({ fetcher, now: clock.now });
  const p = store.ensureFresh();
  calls[0].resolve([{ id: 'old' }]);
  await p;
  clock.advance(FRESH_MS);
  const refresh = store.ensureFresh();
  assert.ok(refresh, 'stale -> refresh starts');
  assert.equal(calls.length, 2);
  const snap = store.getSnapshot();
  assert.equal(snap.status, 'ready', 'stale rows stay usable while revalidating');
  assert.equal(snap.refreshing, true);
  assert.deepEqual(snap.activities.map((a) => a.id), ['old']);
  calls[1].resolve([{ id: 'new' }]);
  await refresh;
});

test('F. cache older than MAX_AGE_MS is no longer valid: dropped to LOADING and reloaded (never kept forever)', async () => {
  const clock = makeClock();
  const { fetcher, calls } = makeFetcher();
  const store = createCatalogueStore({ fetcher, now: clock.now });
  const p = store.ensureFresh();
  calls[0].resolve([{ id: 'ancient' }]);
  await p;
  clock.advance(MAX_AGE_MS);
  const reload = store.ensureFresh();
  assert.equal(store.getSnapshot().status, 'loading');
  assert.equal(store.getSnapshot().activities.length, 0);
  calls[1].resolve([{ id: 'current' }]);
  await reload;
  assert.deepEqual(store.getSnapshot().activities.map((a) => a.id), ['current']);
});

test('G. refresh success replaces the whole catalogue atomically (published added, archived gone) and resets freshness', async () => {
  const clock = makeClock();
  const { fetcher, calls } = makeFetcher();
  const store = createCatalogueStore({ fetcher, now: clock.now });
  const seen = [];
  store.subscribe(() => seen.push(store.getSnapshot()));
  const p = store.ensureFresh();
  calls[0].resolve([{ id: 'kept' }, { id: 'archived-later' }]);
  await p;
  const before = store.getSnapshot().activities;
  clock.advance(FRESH_MS + 1);
  const r = store.ensureFresh();
  calls[1].resolve([{ id: 'kept' }, { id: 'newly-published' }]);
  await r;
  const after = store.getSnapshot();
  assert.deepEqual(after.activities.map((a) => a.id), ['kept', 'newly-published']);
  assert.notEqual(after.activities, before, 'a new array, so memoized ranking recomputes');
  assert.equal(after.refreshError, null);
  assert.ok(seen.every((s) => s.status === 'ready' || s.status === 'loading'));
  assert.ok(seen.slice(1).every((s) => s.activities.length === 2), 'no intermediate empty snapshot once loaded');
  assert.equal(store.ensureFresh(), null, 'fresh again after the refresh');
});

test('H. refresh failure keeps the existing cached activities (never 0) and exposes refreshError', async () => {
  const clock = makeClock();
  const { fetcher, calls } = makeFetcher();
  const store = createCatalogueStore({ fetcher, now: clock.now });
  const p = store.ensureFresh();
  calls[0].resolve([{ id: 'a' }, { id: 'b' }]);
  await p;
  clock.advance(FRESH_MS + 1);
  const r = store.ensureFresh();
  calls[1].reject(new Error('network down'));
  await settle(r);
  const snap = store.getSnapshot();
  assert.equal(snap.status, 'ready');
  assert.deepEqual(snap.activities.map((a) => a.id), ['a', 'b']);
  assert.equal(snap.refreshError.message, 'network down');
  assert.equal(snap.error, null, 'a failed refresh is not a load failure');
  assert.equal(resolveResultsView({ catalogueStatus: snap.status, userStateReady: true, loadError: null, resultCount: 2 }), RESULTS_VIEW.LOADED_WITH_RESULTS);
});

test('H. after a failed refresh, automatic triggers back off; an explicit retry does not', async () => {
  const clock = makeClock();
  const { fetcher, calls } = makeFetcher();
  const store = createCatalogueStore({ fetcher, now: clock.now });
  const p = store.ensureFresh();
  calls[0].resolve([{ id: 'a' }]);
  await p;
  clock.advance(FRESH_MS + 1);
  const r = store.ensureFresh();
  calls[1].reject(new Error('x'));
  await settle(r);
  clock.advance(RETRY_BACKOFF_MS - 1);
  assert.equal(store.ensureFresh(), null, 'focus/foreground inside the backoff window does not hammer the backend');
  const manual = store.refresh();
  assert.ok(manual);
  calls[2].resolve([{ id: 'a' }, { id: 'b' }]);
  await manual;
  assert.equal(store.getSnapshot().refreshError, null);
  assert.equal(store.getSnapshot().activities.length, 2);
});

test('error: no cache + request fails -> status error (LOAD_FAILED), then retry recovers', async () => {
  const { fetcher, calls } = makeFetcher();
  const store = createCatalogueStore({ fetcher });
  const p = store.ensureFresh();
  calls[0].reject(new Error('offline'));
  await settle(p);
  const snap = store.getSnapshot();
  assert.equal(snap.status, 'error');
  assert.equal(snap.error.message, 'offline');
  assert.equal(resolveResultsView({ catalogueStatus: snap.status, userStateReady: true, loadError: null, resultCount: 0 }), RESULTS_VIEW.LOAD_FAILED);
  const retry = store.refresh();
  assert.equal(store.getSnapshot().status, 'loading', 'retry shows loading again, not the error');
  calls[1].resolve([{ id: 'a' }]);
  await retry;
  assert.equal(store.getSnapshot().status, 'ready');
});

// --- I: route reuse still re-seeds filter state over the same cached data ---

test('I. reused /activities instance: Home broad Netanya -> animals -> Jerusalem all re-seed filters, share ONE catalogue load', async () => {
  const { fetcher, calls } = makeFetcher();
  const store = createCatalogueStore({ fetcher });
  // Mirror of app/activities.js: filters are seeded from homeFilters and re-seeded during render
  // whenever paramsChanged says a new push arrived; the catalogue is revalidated on focus.
  let lastSeen = null;
  let filters = null;
  const push = async (homeFiltersObj) => {
    const params = { homeFilters: JSON.stringify(homeFiltersObj), homeCoords: '', homeChildAges: '[]' };
    if (!lastSeen || paramsChanged(lastSeen, params)) {
      lastSeen = params;
      filters = normalizeFilters(JSON.parse(params.homeFilters));
    }
    const p = store.ensureFresh();
    if (p && calls.length === 1 && !store.getSnapshot().fetchedAt) { calls[0].resolve(CATALOG); await p; }
    return ids(applyFilters(store.getSnapshot().activities, filters, null, [], [], [], []));
  };
  assert.deepEqual(await push(cityFilters('נתניה')), ['net-park', 'net-zoo'], 'Home broad Netanya -> results');
  assert.deepEqual(await push(cityFilters('נתניה', { category: ANIMALS })), ['net-zoo'], 'Home animals -> fresh route filter applied');
  assert.deepEqual(await push(cityFilters('ירושלים')), ['jlm-museum', 'jlm-zoo'], 'Home Jerusalem -> fresh route filter applied, not stale Netanya/animals');
  assert.equal(calls.length, 1, 'all three pushes reuse the same cached catalogue');
});

test('I. app/activities.js keeps the render-time params re-seed (59cf41d/50bb0b4) and seeds nothing from the catalogue', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app/activities.js'), 'utf8');
  assert.match(src, /if \(paramsChanged\(lastSeenNavParams, \{ homeFilters, homeCoords, homeChildAges, openFilters, view, nearMe, spontaneous \}\)\) \{\s*setLastSeenNavParams[\s\S]*?setFilters\(normalizeFilters\(parseJson\(homeFilters, \{\}\)\)\);/);
  assert.doesNotMatch(src, /fetchApprovedActivities/, 'the screen no longer runs its own catalogue fetch');
});

// --- J: pagination never duplicates ---

// Fake PostgREST over a mutable table, supporting the keyset chain fetchApprovedLane uses
// (select/eq/gte|gt/lt/order/limit) plus public_profiles' .in(). `onAfterFirstPage` lets a test
// publish rows between the first page and the rest - exactly what continuous ingestion does.
function makePagingSupabase(initialRows, { onAfterFirstPage } = {}) {
  let rows = initialRows.slice();
  let firstDone = false;
  return {
    from() {
      return {
        select() {
          const filters = [];
          const b = {
            eq(c, v) { filters.push((r) => r[c] === v); return b; },
            gte(c, v) { filters.push((r) => r[c] >= v); return b; },
            gt(c, v) { filters.push((r) => r[c] > v); return b; },
            lt(c, v) { filters.push((r) => r[c] < v); return b; },
            order() { return b; },
            in() { return Promise.resolve({ data: [], error: null }); },
            limit(n) {
              const sorted = rows.filter((r) => filters.every((f) => f(r))).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
              const res = { data: sorted.slice(0, n), error: null };
              if (!firstDone) { firstDone = true; if (onAfterFirstPage) rows = onAfterFirstPage(rows); }
              return Promise.resolve(res);
            },
          };
          return b;
        },
      };
    },
  };
}
const approvedRows = (n, prefix) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${String(i).padStart(6, '0')}`, status: 'approved' }));

test('J. a row published mid-fetch (random UUID lands before the cursor) never yields a duplicate activity', async () => {
  // 2,500 rows; after the first page is read, 3 rows with ids sorting before everything are
  // published. With the old OFFSET paging this shifted every later page by 3 and re-delivered the
  // 3 rows at each page boundary; keyset paging continues from the last id, so nothing repeats.
  fakeSupabase = makePagingSupabase(approvedRows(2500, 'm'), {
    onAfterFirstPage: (rows) => rows.concat(approvedRows(3, 'a')),
  });
  const result = await fetchAllApprovedRows();
  const idsList = result.map((r) => r.id);
  assert.equal(new Set(idsList).size, idsList.length, 'no id appears twice');
});

test('J. a clean paged fetch returns every row exactly once', async () => {
  fakeSupabase = makePagingSupabase(approvedRows(3001, 'r'));
  const result = await fetchAllApprovedRows();
  assert.equal(result.length, 3001);
  assert.equal(new Set(result.map((r) => r.id)).size, 3001);
});

// --- K: public catalogue only ---

test('K. catalogue rows carry only public catalogue fields - no favourite/visited/hidden/note/user state', async () => {
  fakeSupabase = makePagingSupabase([{ id: 'p1', status: 'approved', name: 'גן', category: 'גן שעשועים', min_age: 2, max_age: 6, created_by: null }]);
  const [row] = await fetchApprovedActivities();
  for (const userField of ['favorite', 'visited', 'hidden', 'hasNote', 'note', 'notes', 'userId']) {
    assert.equal(Object.prototype.hasOwnProperty.call(row, userField), false, `${userField} must never be in the shared cache`);
  }
});

test('K. the cache modules persist nothing and never import user-specific data layers', () => {
  for (const file of ['lib/catalogueCache.js', 'lib/useActivitiesCatalogue.js']) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(code, /AsyncStorage|localStorage|sessionStorage|SecureStore|indexedDB/, `${file}: in-memory only`);
    assert.doesNotMatch(code, /interactions|preferences|auth\.getSession|fetchUser/, `${file}: no user state`);
  }
});

test('K. cached rows keep their locale-aware display getters (a language switch is not frozen by the cache)', async () => {
  fakeSupabase = makePagingSupabase([{ id: 'p2', status: 'approved', name: 'גן', category: 'גן שעשועים', min_age: 3, max_age: 3, created_by: 'u1' }]);
  const [row] = await fetchApprovedActivities();
  assert.equal(typeof Object.getOwnPropertyDescriptor(row, 'ageRange').get, 'function');
  await setLocale('en');
  const en = row.ageRange;
  await setLocale('he');
  const he = row.ageRange;
  assert.notEqual(en, he, 'the same cached object renders in the active language');
});
