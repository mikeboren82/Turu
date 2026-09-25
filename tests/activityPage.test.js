// Tests for lib/activityPage.js - the public activity page's data/navigation layer
// (app/activity/[id].js). Everything IO-related is injected, so these exercise exactly what a shared
// link opened cold goes through: only the URL's id, no navigation state, possibly no session.
// Same require-hook (babel commonjs + stubs) as tests/homeLocationParity.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
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
  normalizeActivityIdParam, loadActivityPage, loadActivityExtras, isPubliclyShareable,
  buildDiscoveryFiltersForActivity, buildDiscoveryParamsForActivity,
} = require('../lib/activityPage');
const { buildActivityShareUrl } = require('../lib/shareActivity');
const { normalizeFilters } = require('../lib/filterActivities');
const { DEFAULT_FILTERS } = require('../constants/filterSchema');

const UUID = '3f2b9c1e-8a4d-4e6f-9b2a-1c3d5e7f9a0b';
const ACTIVITY = { id: UUID, title: 'גן המדע', city: 'רחובות', region: 'השפלה', status: 'approved' };

// A recording fake: every call is kept so tests can prove what was (not) fetched.
function spy(impl) {
  const fn = async (...args) => { fn.calls.push(args); return impl(...args); };
  fn.calls = [];
  return fn;
}

// --- B/C. Direct entry: the URL id alone is enough ---

test('B. direct route opened with only the activity id -> fetches by exactly that id and renders it; nothing else is required', async () => {
  const fetchActivity = spy(() => ACTIVITY);
  const result = await loadActivityPage(UUID, { fetchActivity });
  assert.equal(result.status, 'ok');
  assert.equal(result.activity, ACTIVITY);
  assert.deepEqual(fetchActivity.calls, [[UUID]]);
});

test('C. refresh / pasted link: expo-router param shapes (array, surrounding whitespace, upper-case) all hydrate the same canonical id', async () => {
  for (const raw of [UUID, [UUID], `  ${UUID}  `, UUID.toUpperCase()]) {
    const fetchActivity = spy(() => ACTIVITY);
    const result = await loadActivityPage(raw, { fetchActivity });
    assert.equal(result.status, 'ok', `param ${JSON.stringify(raw)}`);
    assert.deepEqual(fetchActivity.calls, [[UUID]]);
  }
});

test('C. loading the same id twice (a refresh) gives the same result - no hidden state between loads', async () => {
  const deps = { fetchActivity: async () => ACTIVITY };
  assert.deepEqual(await loadActivityPage(UUID, deps), await loadActivityPage(UUID, deps));
});

// --- F. Missing / failing activity ---

test('F. malformed id -> not_found WITHOUT querying (a non-uuid used to reach Postgres and surface as a generic load error)', async () => {
  for (const raw of ['abc', '123', '', undefined, null, [], 'undefined', `${UUID}x`, '../admin']) {
    const fetchActivity = spy(() => { throw new Error('must not be called'); });
    const result = await loadActivityPage(raw, { fetchActivity });
    assert.equal(result.status, 'not_found', `param ${JSON.stringify(raw)}`);
    assert.equal(fetchActivity.calls.length, 0);
  }
});

test('F. well-formed but unknown id, or a row RLS hides from this viewer (pending/rejected/archived/expired) -> not_found', async () => {
  const result = await loadActivityPage(UUID, { fetchActivity: async () => null });
  assert.deepEqual(result, { status: 'not_found', id: UUID, activity: null });
});

test('F. network/server failure -> error (retryable), never thrown out of the loader', async () => {
  const result = await loadActivityPage(UUID, { fetchActivity: async () => { throw new Error('Failed to fetch'); } });
  assert.equal(result.status, 'error');
  assert.equal(result.activity, null);
  assert.equal(result.id, UUID);
});

// --- E. Unauthenticated viewing ---

test('E. anonymous visitor: the primary load has no session dependency at all - the activity renders with no login', async () => {
  // loadActivityPage takes only fetchActivity; there is no session input to fail.
  const result = await loadActivityPage(UUID, { fetchActivity: async () => ACTIVITY });
  assert.equal(result.status, 'ok');
});

test('E. anonymous visitor: extras skip every personal fetch but still load public community notes', async () => {
  const deps = {
    getSessionUserId: spy(() => null),
    fetchFlags: spy(() => { throw new Error('must not be called'); }),
    fetchPersonalNote: spy(() => { throw new Error('must not be called'); }),
    fetchProfile: spy(() => { throw new Error('must not be called'); }),
    fetchCommunityNotes: spy(() => [{ id: 'n1', note: 'היה כיף' }]),
  };
  const extras = await loadActivityExtras(UUID, deps);
  assert.equal(extras.userId, null);
  assert.equal(extras.flags, null);
  assert.equal(extras.note, '');
  assert.equal(extras.profile, null);
  assert.deepEqual(extras.communityNotes, [{ id: 'n1', note: 'היה כיף' }]);
  assert.equal(deps.fetchFlags.calls.length + deps.fetchPersonalNote.calls.length + deps.fetchProfile.calls.length, 0);
});

test('E. every secondary failure falls back on its own - it can never produce an error page for an activity that loaded', async () => {
  const boom = async () => { throw new Error('network'); };
  const loggedIn = await loadActivityExtras(UUID, {
    getSessionUserId: async () => 'user-1', fetchFlags: boom, fetchPersonalNote: boom, fetchProfile: boom, fetchCommunityNotes: boom,
  });
  assert.deepEqual(loggedIn, { userId: 'user-1', flags: null, note: '', profile: null, communityNotes: [] });
  const sessionDown = await loadActivityExtras(UUID, {
    getSessionUserId: boom, fetchFlags: boom, fetchPersonalNote: boom, fetchProfile: boom, fetchCommunityNotes: async () => [],
  });
  assert.equal(sessionDown.userId, null, 'a failed session lookup degrades to anonymous, not to an error');
});

test('E. logged-in visitor: personal data is fetched for this user and this activity id', async () => {
  const deps = {
    getSessionUserId: async () => 'user-1',
    fetchFlags: spy(() => ({ isFavorite: true, isVisited: false, isHidden: false, isPlanned: true })),
    fetchPersonalNote: spy(() => 'להביא כובע'),
    fetchProfile: spy(() => ({ role: 'user', benefit_clubs: [] })),
    fetchCommunityNotes: spy(() => []),
  };
  const extras = await loadActivityExtras(UUID, deps);
  assert.deepEqual(deps.fetchFlags.calls, [['user-1', UUID]]);
  assert.deepEqual(deps.fetchPersonalNote.calls, [['user-1', UUID]]);
  assert.deepEqual(deps.fetchProfile.calls, [['user-1']]);
  assert.equal(extras.note, 'להביא כובע');
  assert.equal(extras.flags.isPlanned, true);
});

// --- Sharing only what a recipient can open ---

test('isPubliclyShareable: approved -> shareable; pending/rejected/archived (visible only to admin/creator) -> not shareable', () => {
  assert.equal(isPubliclyShareable({ ...ACTIVITY, status: 'approved' }), true);
  for (const status of ['pending', 'rejected', 'archived']) {
    assert.equal(isPubliclyShareable({ ...ACTIVITY, status }), false, status);
  }
});

test('isPubliclyShareable: status not selected (list rows) is unknown, not private; no activity -> false', () => {
  assert.equal(isPubliclyShareable({ ...ACTIVITY, status: null }), true);
  assert.equal(isPubliclyShareable({ ...ACTIVITY, status: undefined }), true);
  assert.equal(isPubliclyShareable(null), false);
});

// --- H. Discovery CTA ---

test('H. discovery CTA from an activity with a city -> results in city mode for that city (Smart Radius covers "this area"), no category', () => {
  const filters = buildDiscoveryFiltersForActivity(ACTIVITY);
  assert.deepEqual(filters.location, { ...DEFAULT_FILTERS.location, mode: 'city', city: 'רחובות' });
  assert.deepEqual(filters.category, []);
});

test('H. discovery CTA falls back to region, then to no location at all', () => {
  assert.deepEqual(buildDiscoveryFiltersForActivity({ ...ACTIVITY, city: '  ' }).location, { ...DEFAULT_FILTERS.location, mode: 'region', region: ['השפלה'] });
  assert.deepEqual(buildDiscoveryFiltersForActivity({ ...ACTIVITY, city: null, region: null }).location, DEFAULT_FILTERS.location);
  assert.deepEqual(buildDiscoveryFiltersForActivity(null).location, DEFAULT_FILTERS.location);
});

test('H/G. discovery params use the canonical /activities payload and carry no device coords or child ages', () => {
  const params = buildDiscoveryParamsForActivity(ACTIVITY);
  assert.deepEqual(Object.keys(params).sort(), ['homeChildAges', 'homeCoords', 'homeFilters']);
  assert.equal(params.homeCoords, '');
  assert.equal(params.homeChildAges, '[]');
  // /activities hydrates homeFilters through normalizeFilters - the round trip must keep the location.
  const hydrated = normalizeFilters(JSON.parse(params.homeFilters));
  assert.equal(hydrated.location.mode, 'city');
  assert.equal(hydrated.location.city, 'רחובות');
});

// --- I. Existing in-app navigation keeps working ---

test('I. the public share path is the same /activity/<id> path every in-app caller already pushes, served by app/activity/[id].js', () => {
  process.env.EXPO_PUBLIC_SITE_URL = 'https://wabbit.expo.app';
  const { pathname } = new URL(buildActivityShareUrl(UUID));
  assert.equal(pathname, `/activity/${UUID}`);
  delete process.env.EXPO_PUBLIC_SITE_URL;
  assert.ok(fs.existsSync(path.join(ROOT, 'app', 'activity', '[id].js')), 'route file backing the contract');
  // Every in-app caller uses the literal `/activity/${id}` template (ActivityCard, maps, saved, profile).
  const card = fs.readFileSync(path.join(ROOT, 'components', 'ActivityCard.js'), 'utf8');
  assert.ok(card.includes('router.push(`/activity/${id}`)'));
});

test('I. ids that in-app navigation passes (real uuids from the DB) are accepted unchanged by the page', () => {
  assert.equal(normalizeActivityIdParam(UUID), UUID);
});
