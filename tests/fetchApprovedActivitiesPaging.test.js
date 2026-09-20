// בדיקות ל-lib/activities.js#fetchAllApprovedRows (2026-09-20, "Performance Phase 1" audit
// סעיף 1/2/9) - עימוד-מקבילי במקום לולאה סריאלית. supabase מדומה (לא הרשת האמיתית) מדמה בדיוק
// את שרשרת ה-query שבה fetchApprovedActivitiesPage משתמשת (select/eq/order/range), כולל
// {count:'exact'} על הדף הראשון. אותו require-hook (babel commonjs + סטאבים) כמו שאר הבדיקות.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');
const { addHook } = require('pirates');

const ROOT = path.resolve(__dirname, '..');

// makeFakeSupabase - thenable query-builder מינימלי: תומך רק במה ש-fetchApprovedActivitiesPage
// בפועל קורא לו (from/select/eq/order/range), לא API מלא של supabase-js. simulateGrowth (אופציונלי)
// מוסיף שורות ל-"מאגר" אחרי הקריאה הראשונה (עם count) - מדמה כתיבות-מתחרות בין ספירת-הדף-הראשון
// לשליפת-הדפים-האחרונים, כדי לבדוק את רשת-הביטחון (הלולאה הסריאלית האחרונה ב-fetchAllApprovedRows).
function makeFakeSupabase(initialRows, { simulateGrowthRows = null } = {}) {
  let rows = initialRows;
  let countCallCount = 0;
  return {
    from() {
      return {
        select(_query, opts) {
          const withCount = !!(opts && opts.count === 'exact');
          const state = {};
          const builder = {
            eq(col, val) { state.eqCol = col; state.eqVal = val; return builder; },
            order(col, o) { state.orderCol = col; state.orderAsc = !!o?.ascending; return builder; },
            range(from, to) {
              return {
                then(resolve) {
                  if (withCount) {
                    countCallCount += 1;
                    if (countCallCount === 1 && simulateGrowthRows) rows = rows.concat(simulateGrowthRows);
                  }
                  let filtered = state.eqCol ? rows.filter((r) => r[state.eqCol] === state.eqVal) : rows.slice();
                  filtered.sort((a, b) => {
                    if (a[state.orderCol] === b[state.orderCol]) return 0;
                    const cmp = a[state.orderCol] < b[state.orderCol] ? -1 : 1;
                    return state.orderAsc ? cmp : -cmp;
                  });
                  const page = filtered.slice(from, to + 1);
                  const result = { data: page, error: null };
                  if (withCount) result.count = filtered.length;
                  resolve(result);
                },
              };
            },
          };
          return builder;
        },
      };
    },
  };
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
  // כמו MAX_CONCURRENT_PAGES/PAGE_SIZE נשאר קבוע, רק ה-supabase המדומה משתנה).
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

test('paging: batches beyond MAX_CONCURRENT_PAGES(8) still return every row exactly once (12 pages)', async () => {
  const rows = makeRows(12000);
  const { fetchAllApprovedRows } = loadWithFakeSupabase(makeFakeSupabase(rows));
  const result = await fetchAllApprovedRows();
  assert.equal(result.length, 12000);
  assert.equal(new Set(result.map((r) => r.id)).size, 12000);
});

test('paging: safety-net catches rows inserted between the first count and the last known page', async () => {
  // 1000 rows exist when the first (count-carrying) request runs; 500 more rows are added
  // "concurrently" (simulateGrowthRows) right after that count is read - reproducing a live
  // catalogue growing mid-fetch. pageCount is computed from the STALE count (1), so the normal
  // batch loop fetches nothing extra; the trailing while-loop (pages[last].length===PAGE_SIZE)
  // must notice page 0 came back full and keep paging until it finds the new rows.
  const initial = makeRows(1000, { idPrefix: 'a' });
  const grown = makeRows(500, { idPrefix: 'b' });
  const { fetchAllApprovedRows } = loadWithFakeSupabase(makeFakeSupabase(initial, { simulateGrowthRows: grown }));
  const result = await fetchAllApprovedRows();
  assert.equal(result.length, 1500, 'the 500 rows added after the count snapshot must not be silently dropped');
  assert.equal(new Set(result.map((r) => r.id)).size, 1500);
});

test('paging: only approved rows are requested (status filter still applied)', async () => {
  const approved = makeRows(50, { status: 'approved', idPrefix: 'a' });
  const pending = makeRows(20, { status: 'pending', idPrefix: 'p' });
  const { fetchAllApprovedRows } = loadWithFakeSupabase(makeFakeSupabase([...approved, ...pending]));
  const result = await fetchAllApprovedRows();
  assert.equal(result.length, 50);
  assert.ok(result.every((r) => r.status === 'approved'));
});
