// בדיקות ל-lib/activities.js#fetchAllApprovedRows - במקור (2026-09-20, "Performance Phase 1")
// עימוד-מקבילי לפי OFFSET; מאז 2026-09-25 ("Activities Loading + Client Cache Performance")
// עימוד-keyset בשני "נתיבי-id" מקבילים (ראו ההערה ב-lib/activities.js). supabase מדומה (לא הרשת
// האמיתית) מדמה בדיוק את שרשרת ה-query שבה fetchApprovedLane משתמשת (select/eq/gte|gt/lt/order/
// limit). אותו require-hook (babel commonjs + סטאבים) כמו שאר הבדיקות.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');
const { addHook } = require('pirates');

const ROOT = path.resolve(__dirname, '..');

// makeFakeSupabase - thenable query-builder מינימלי: תומך רק במה ש-fetchApprovedLane בפועל קורא
// לו, לא API מלא של supabase-js. simulateGrowthRows (אופציונלי) מוסיף שורות ל-"מאגר" מיד אחרי
// הבקשה הראשונה - מדמה פרסום-מקביל תוך כדי שליפה, כדי לוודא ששורות חדשות שנופלות אחרי הסמן לא
// נחסרות ושום שורה לא מגיעה פעמיים. requests (מוחזר) - רישום של כל בקשה, לבדיקת צורת-הבקשות.
function makeFakeSupabase(initialRows, { simulateGrowthRows = null } = {}) {
  let rows = initialRows;
  let requestCount = 0;
  const requests = [];
  const fake = {
    requests,
    from() {
      return {
        select(_query, opts) {
          const state = { filters: [], count: !!(opts && opts.count) };
          const builder = {
            eq(col, val) { state.filters.push((r) => r[col] === val); state.eq = [col, val]; return builder; },
            gte(col, val) { state.filters.push((r) => r[col] >= val); state.gte = val; return builder; },
            gt(col, val) { state.filters.push((r) => r[col] > val); state.gt = val; return builder; },
            lt(col, val) { state.filters.push((r) => r[col] < val); state.lt = val; return builder; },
            order(col, o) { state.orderCol = col; state.orderAsc = !!o?.ascending; return builder; },
            range() { throw new Error('offset paging is no longer used'); },
            limit(n) {
              return {
                then(resolve) {
                  requestCount += 1;
                  requests.push({ ...state, limit: n });
                  const filtered = rows.filter((r) => state.filters.every((f) => f(r)));
                  filtered.sort((a, b) => {
                    if (a[state.orderCol] === b[state.orderCol]) return 0;
                    const cmp = a[state.orderCol] < b[state.orderCol] ? -1 : 1;
                    return state.orderAsc ? cmp : -cmp;
                  });
                  if (requestCount === 1 && simulateGrowthRows) rows = rows.concat(simulateGrowthRows);
                  resolve({ data: filtered.slice(0, n), error: null });
                },
              };
            },
          };
          return builder;
        },
      };
    },
  };
  return fake;
}

function makeRows(n, { status = 'approved', idPrefix = 'a' } = {}) {
  return Array.from({ length: n }, (_, i) => ({ id: `${idPrefix}${String(i).padStart(6, '0')}`, status, created_at: new Date(2026, 0, 1, 0, 0, i).toISOString() }));
}

function loadWithFakeSupabase(fakeSupabase) {
  const STUBS = {
    'react-native': { Platform: { OS: 'node' }, StyleSheet: { create: (s) => s } },
    '@react-native-async-storage/async-storage': { default: { getItem: async () => null, setItem: async () => {} } },
    './supabase': { supabase: fakeSupabase },
    '../lib/supabase': { supabase: fakeSupabase },
  };
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function resolve(request, ...rest) {
    return STUBS[request] ? `stub:${request}:${Math.random()}` : origResolve.call(this, request, ...rest);
  };
  const origLoad = Module._load;
  Module._load = function load(request, ...rest) {
    for (const [name, exp] of Object.entries(STUBS)) {
      if (request === name) { const m = new Module(`stub:${name}`); m.exports = { __esModule: true, ...exp }; return m.exports; }
    }
    return origLoad.call(this, request, ...rest);
  };
  addHook(
    (code, filename) => babel.transformSync(code, { filename, babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'] }).code,
    { exts: ['.js'], matcher: (f) => f.startsWith(path.join(ROOT, 'lib')) || f.startsWith(path.join(ROOT, 'constants')) },
  );
  // הסרת מהמטמון כדי שכל בדיקה תקבל instance טרי עם ה-fakeSupabase הנכון שלה (module-level state
  // כמו FETCH_LANES/PAGE_SIZE נשאר קבוע, רק ה-supabase המדומה משתנה).
  delete require.cache[require.resolve(path.join(ROOT, 'lib/activities.js'))];
  return require(path.join(ROOT, 'lib/activities.js'));
}

test('paging: exact page-boundary count (6000 = 6 full pages) returns all rows, no dup/missing', async () => {
  const rows = makeRows(6000);
  const { fetchAllApprovedRows } = loadWithFakeSupabase(makeFakeSupabase(rows));
  const result = await fetchAllApprovedRows();
  assert.equal(result.length, 6000);
  const ids = new Set(result.map((r) => r.id));
  assert.equal(ids.size, 6000, 'no duplicate rows across page boundaries');
  assert.deepEqual(result.map((r) => r.id), rows.map((r) => r.id), 'no missing rows, same set');
});

test('paging: non-multiple-of-1000 count (2500) fetches a final partial page correctly', async () => {
  const rows = makeRows(2500);
  const { fetchAllApprovedRows } = loadWithFakeSupabase(makeFakeSupabase(rows));
  const result = await fetchAllApprovedRows();
  assert.equal(result.length, 2500);
  assert.equal(new Set(result.map((r) => r.id)).size, 2500);
});

test('paging: zero-result catalogue returns an empty array without error', async () => {
  const { fetchAllApprovedRows } = loadWithFakeSupabase(makeFakeSupabase([]));
  const result = await fetchAllApprovedRows();
  assert.deepEqual(result, []);
});

test('paging: single small page (under 1000) works without triggering extra pages', async () => {
  const rows = makeRows(37);
  const { fetchAllApprovedRows } = loadWithFakeSupabase(makeFakeSupabase(rows));
  const result = await fetchAllApprovedRows();
  assert.equal(result.length, 37);
});

test('paging: order is deterministic (ascending by id) across repeated fetches', async () => {
  const rows = makeRows(1500);
  const { fetchAllApprovedRows } = loadWithFakeSupabase(makeFakeSupabase(rows));
  const run1 = await fetchAllApprovedRows();
  const run2 = await fetchAllApprovedRows();
  assert.deepEqual(run1.map((r) => r.id), run2.map((r) => r.id));
  const sorted = [...run1.map((r) => r.id)].sort();
  assert.deepEqual(run1.map((r) => r.id), sorted, 'ascending by id, matching the .order(\'id\',{ascending:true}) call');
});

test('paging: a large catalogue (12 pages) returns every row exactly once', async () => {
  const rows = makeRows(12000);
  const { fetchAllApprovedRows } = loadWithFakeSupabase(makeFakeSupabase(rows));
  const result = await fetchAllApprovedRows();
  assert.equal(result.length, 12000);
  assert.equal(new Set(result.map((r) => r.id)).size, 12000);
});

test('paging: rows published mid-fetch after the cursor are picked up, none duplicated', async () => {
  // 1000 rows exist when the first request runs; 500 more (ids sorting after all of them) are
  // published right after it - a live catalogue growing mid-fetch. The first page comes back full,
  // so the lane keeps paging from its cursor and finds the new rows.
  const initial = makeRows(1000, { idPrefix: 'a' });
  const grown = makeRows(500, { idPrefix: 'b' });
  const { fetchAllApprovedRows } = loadWithFakeSupabase(makeFakeSupabase(initial, { simulateGrowthRows: grown }));
  const result = await fetchAllApprovedRows();
  assert.equal(result.length, 1500, 'rows published after the cursor must not be silently dropped');
  assert.equal(new Set(result.map((r) => r.id)).size, 1500);
});

// UUID-shaped ids spread over the whole id space, like the real table.
function makeUuidRows(n) {
  return Array.from({ length: n }, (_, i) => {
    const head = Math.floor((i * 0xffffffff) / n).toString(16).padStart(8, '0');
    return { id: `${head}-0000-4000-8000-${String(i).padStart(12, '0')}`, status: 'approved' };
  });
}

test('paging: UUID ids are split into two disjoint lanes at 0x80..., together covering every row once', async () => {
  const rows = makeUuidRows(5537);
  const fake = makeFakeSupabase(rows);
  const { fetchAllApprovedRows } = loadWithFakeSupabase(fake);
  const result = await fetchAllApprovedRows();
  assert.equal(result.length, 5537);
  assert.equal(new Set(result.map((r) => r.id)).size, 5537);
  assert.deepEqual(result.map((r) => r.id), rows.map((r) => r.id).sort(), 'lane order + keyset order = ascending id');
  const firstPages = fake.requests.filter((r) => r.gt === undefined);
  assert.deepEqual(firstPages.map((r) => [r.gte, r.lt ?? null]).sort(), [
    ['00000000-0000-0000-0000-000000000000', '80000000-0000-0000-0000-000000000000'],
    ['80000000-0000-0000-0000-000000000000', null],
  ]);
});

test('paging: request shape - no count(*) query, no OFFSET, PK-ordered pages of at most 1000, status filter on every request', async () => {
  const fake = makeFakeSupabase(makeUuidRows(5537));
  const { fetchAllApprovedRows } = loadWithFakeSupabase(fake);
  await fetchAllApprovedRows();
  assert.ok(fake.requests.length >= 6 && fake.requests.length <= 8, `~6 pages for 5,537 rows, got ${fake.requests.length}`);
  for (const r of fake.requests) {
    assert.equal(r.count, false, 'no count=exact');
    assert.equal(r.limit, 1000);
    assert.equal(r.orderCol, 'id');
    assert.equal(r.orderAsc, true);
    assert.deepEqual(r.eq, ['status', 'approved']);
  }
});

test('paging: at most 2 requests are ever in flight, however many pages there are', async () => {
  const fake = makeFakeSupabase(makeUuidRows(12000));
  // Wrap the fake so each request resolves on a later tick and in-flight requests are counted.
  let inFlight = 0;
  let peak = 0;
  const origFrom = fake.from;
  fake.from = (...a) => {
    const t = origFrom(...a);
    const origSelect = t.select;
    t.select = (...s) => {
      const b = origSelect(...s);
      const origLimit = b.limit;
      b.limit = (n) => ({
        then(resolve) {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          setTimeout(() => { inFlight -= 1; origLimit(n).then(resolve); }, 1);
        },
      });
      for (const k of ['eq', 'gte', 'gt', 'lt', 'order']) {
        const orig = b[k];
        b[k] = (...x) => { orig(...x); return b; };
      }
      return b;
    };
    return t;
  };
  const { fetchAllApprovedRows } = loadWithFakeSupabase(fake);
  const result = await fetchAllApprovedRows();
  assert.equal(result.length, 12000);
  assert.equal(peak, 2);
});

test('paging: only approved rows are requested (status filter still applied)', async () => {
  const approved = makeRows(50, { status: 'approved', idPrefix: 'a' });
  const pending = makeRows(20, { status: 'pending', idPrefix: 'p' });
  const { fetchAllApprovedRows } = loadWithFakeSupabase(makeFakeSupabase([...approved, ...pending]));
  const result = await fetchAllApprovedRows();
  assert.equal(result.length, 50);
  assert.ok(result.every((r) => r.status === 'approved'));
});
