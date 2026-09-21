// GENERAL ZERO-ROW UPDATE HARDENING (2026-09-21) - lib/verifiedWrite.js (app-side twin of
// tools/import-tool/lib/verifiedWrite.js/tests/verifiedWrite.test.js - same scenarios, same mock
// shape, kept in sync deliberately per the twin's own header comment). Also exercises the primitive's
// only current app-side caller, lib/activities.js#updateActivityAsAdmin, which used to fire a plain
// update().eq('id', id) with only `error` checked - exactly the shape that let RLS silently no-op an
// admin edit while the caller still resolved as if it had written.
// אותו require-hook (babel commonjs + סטאבים) כמו tests/activityAge.test.js, אך כאן ה-supabase stub
// מפנה למימוש מתחלף (currentClientImpl) כדי שכל טסט יוכל להזריק תגובת-mock משלו ל-updateActivityAsAdmin.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');
const { addHook } = require('pirates');

const ROOT = path.resolve(__dirname, '..');
let currentClientImpl = null;
const STUBS = {
  'react-native': { Platform: { OS: 'node' }, StyleSheet: { create: (s) => s } },
  '@react-native-async-storage/async-storage': { default: { getItem: async () => null, setItem: async () => {} } },
  './supabase': { supabase: { from: (...args) => currentClientImpl.from(...args) } },
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

const { OUTCOME, verifiedFieldUpdate, verifiedConditionalUpdate, fieldsMatch, fieldGuard, isSuccess, isNoopOk, describe } = require('../lib/verifiedWrite');

function makeClient({ updateResult, readResult, updateThrows } = {}) {
  const calls = [];
  function from(table) {
    return {
      update(patch) {
        calls.push({ op: 'update', table, patch });
        const builder = {
          eq() { return builder; },
          is() { return builder; },
          select() {
            calls.push({ op: 'update.select' });
            return updateThrows ? Promise.reject(updateThrows) : Promise.resolve(updateResult);
          },
        };
        return builder;
      },
      select(cols) {
        calls.push({ op: 'read.select', table, cols });
        const builder = { eq() { return builder; }, maybeSingle: () => Promise.resolve(readResult) };
        return builder;
      },
    };
  }
  return { calls, from };
}

test('1. successful update -> SUCCESS', async () => {
  const c = makeClient({ updateResult: { data: [{ id: 'a1' }], error: null } });
  const r = await verifiedFieldUpdate(c, { table: 'activities', id: 'a1', patch: { name: 'x' } });
  assert.equal(r.outcome, OUTCOME.SUCCESS);
  assert.equal(isSuccess(r), true);
});

test('2. error=null + zero rows is never blind SUCCESS', async () => {
  const c = makeClient({ updateResult: { data: [], error: null }, readResult: { data: { id: 'a1' }, error: null } });
  const r = await verifiedFieldUpdate(c, { table: 'activities', id: 'a1', patch: { name: 'x' }, guardStillHolds: () => true });
  assert.equal(isSuccess(r), false);
  assert.equal(r.outcome, OUTCOME.WRITE_DENIED);
});

test('3. target missing -> ROW_NOT_FOUND', async () => {
  const c = makeClient({ updateResult: { data: [], error: null }, readResult: { data: null, error: null } });
  const r = await verifiedFieldUpdate(c, { table: 'activities', id: 'gone', patch: { name: 'x' } });
  assert.equal(r.outcome, OUTCOME.ROW_NOT_FOUND);
});

test('6. desired value already present -> NO_CHANGE_ALREADY_SATISFIED', async () => {
  const c = makeClient({ updateResult: { data: [], error: null }, readResult: { data: { id: 'a1', category: 'ספורט' }, error: null } });
  const r = await verifiedConditionalUpdate(c, { table: 'activities', id: 'a1', patch: { category: 'ספורט' }, expectedOld: { category: 'תרבות' } });
  assert.equal(r.outcome, OUTCOME.NO_CHANGE_ALREADY_SATISFIED);
  assert.equal(isNoopOk(r), true);
});

test('7. thrown transport error is classified, not swallowed', async () => {
  const c = makeClient({ updateThrows: new Error('fetch failed') });
  const r = await verifiedFieldUpdate(c, { table: 'activities', id: 'a1', patch: { name: 'x' } });
  assert.equal(r.outcome, OUTCOME.OTHER_FAILURE);
});

test('fieldGuard/fieldsMatch null-safety matches the Node twin', () => {
  assert.equal(fieldsMatch({ venue_id: null }, { venue_id: null }), true);
  const calls = [];
  fieldGuard({ venue_id: null })({ is: (k, v) => { calls.push([k, v]); return { is: () => {} }; } });
  assert.deepEqual(calls[0], ['venue_id', null]);
});

test('describe() never claims success for a non-SUCCESS outcome', async () => {
  const c = makeClient({ updateResult: { data: [], error: null }, readResult: { data: null, error: null } });
  const r = await verifiedFieldUpdate(c, { table: 'activities', id: 'gone', patch: { x: 1 } });
  assert.match(describe(r), /^NOT written: ROW_NOT_FOUND/);
});

// --- updateActivityAsAdmin: the endpoint's only current app-side caller ---
const { updateActivityAsAdmin } = require('../lib/activities');

function adminClient({ activityWrite, locationWrite, relinkWrite, readActivity, readLocation, insertLocation } = {}) {
  function from(table) {
    return {
      update(patch) {
        const isRelink = table === 'activities' && 'location_id' in patch;
        const builder = {
          eq() { return builder; },
          select() {
            if (table === 'activities') return Promise.resolve(isRelink ? relinkWrite : activityWrite);
            return Promise.resolve(locationWrite);
          },
        };
        return builder;
      },
      select() {
        const row = table === 'activities' ? readActivity : readLocation;
        const builder = { eq() { return builder; }, maybeSingle: () => Promise.resolve({ data: row || null, error: null }) };
        return builder;
      },
      insert() {
        return { select: () => ({ single: () => Promise.resolve(insertLocation || { data: { id: 'new-loc-1' }, error: null }) }) };
      },
    };
  }
  return { from };
}

test('10. admin edit endpoint path does not return false success: a silently-denied activities write throws', async () => {
  currentClientImpl = adminClient({
    activityWrite: { data: [], error: null },
    readActivity: { id: 'a1', name: 'old' },
  });
  await assert.rejects(
    () => updateActivityAsAdmin({ id: 'a1', locationId: null }, { name: 'new' }, null),
    /WRITE_DENIED/,
  );
});

test('a genuinely successful admin field edit resolves without throwing', async () => {
  currentClientImpl = adminClient({ activityWrite: { data: [{ id: 'a1' }], error: null } });
  await assert.doesNotReject(() => updateActivityAsAdmin({ id: 'a1', locationId: null }, { name: 'new' }, null));
});

test('11. a silently-denied location_id relink (new location created, but the relink write is denied) also throws, not just logs', async () => {
  currentClientImpl = adminClient({
    relinkWrite: { data: [], error: null },
    readActivity: { id: 'a1', location_id: null },
  });
  await assert.rejects(
    () => updateActivityAsAdmin({ id: 'a1', locationId: null }, {}, { name: 'New Place', city: 'תל אביב' }),
    /WRITE_DENIED|location relink/,
  );
});
