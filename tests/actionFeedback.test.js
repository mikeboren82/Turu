// בדיקות ל-lib/interactions.js: toggleWithFeedback (מועדפים/"כבר הייתי כאן") ו-
// hideActivityWithFeedback (הסתרה+ביטול) - תגובה מיידית, שחזור-מצב בכשל, והתאמה בין
// התצוגה למצב השמור גם כשה"ביטול" עצמו נכשל. supabase מוחלף בסטאב מקומי (בלי רשת אמיתית);
// lib/toast.js.showToast מנוטר (לא מוחלף מודול שלם) כדי לבדוק אילו הודעות/actionLabel הוצגו.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');
const { addHook } = require('pirates');

const ROOT = path.resolve(__dirname, '..');

// error.value כאן נשלט מכל טסט (בודק הצלחה/כשל) - insert/delete("...").eq().eq() בשני
// המקרים מסתיימים ב-{ error }, בדיוק כמו lib/interactions.js#toggleRow מצפה.
const dbError = { value: null };
const STUBS = {
  'react-native': { Platform: { OS: 'node' }, StyleSheet: { create: (s) => s } },
  '@react-native-async-storage/async-storage': {
    default: { getItem: async () => null, setItem: async () => {} },
  },
  './supabase': {
    supabase: {
      from: () => ({
        insert: async () => ({ error: dbError.value }),
        delete: () => ({ eq: () => ({ eq: async () => ({ error: dbError.value }) }) }),
      }),
    },
  },
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

const interactions = require('../lib/interactions');
const toastModule = require('../lib/toast');

// מחליף רק את הפונקציה על ה-module.exports (לא require חדש) - הקוד המתומלל של
// lib/interactions.js קורא ל-showToast דרך אותו אובייקט-מודול, אז ההחלפה נתפסת.
const toastCalls = [];
toastModule.showToast = (message, opts) => toastCalls.push({ message, ...opts });

function makeSetState() {
  let value = new Set();
  const history = [];
  const setState = (updater) => { value = updater(value); history.push(new Set(value)); };
  return { setState, get: () => value, history };
}

test.beforeEach(() => { dbError.value = null; toastCalls.length = 0; });

test('toggleWithFeedback: success flips state once, shows no toast', async () => {
  const { setState, get } = makeSetState();
  await new Promise((resolve) => {
    interactions.toggleWithFeedback(setState, 'a1', true, async () => { resolve(); });
  });
  assert.equal(get().has('a1'), true);
  await new Promise((r) => setTimeout(r, 0)); // let the .catch microtask (not taken) settle
  assert.equal(toastCalls.length, 0);
});

test('toggleWithFeedback: failure rolls back to the previous state and shows a clear message', async () => {
  const { setState, get } = makeSetState();
  await new Promise((resolve) => {
    interactions.toggleWithFeedback(setState, 'a1', true, async () => { throw new Error('network'); });
    setTimeout(resolve, 10);
  });
  assert.equal(get().has('a1'), false); // reverted
  assert.equal(toastCalls.length, 1);
  assert.equal(toastCalls[0].message, 'לא הצלחנו לשמור את השינוי, נסו שוב');
  assert.equal(toastCalls[0].actionLabel, undefined);
});

test('hideActivityWithFeedback: hides optimistically, then offers Undo on success', async () => {
  const { setState, get } = makeSetState();
  interactions.hideActivityWithFeedback(setState, 'user1', 'act1');
  assert.equal(get().has('act1'), true); // optimistic, before the network call even resolves
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(get().has('act1'), true); // still hidden after success
  assert.equal(toastCalls.length, 1);
  assert.equal(toastCalls[0].message, 'הפעילות הוסתרה');
  assert.equal(toastCalls[0].actionLabel, 'ביטול');
  assert.equal(typeof toastCalls[0].onAction, 'function');
});

test('hideActivityWithFeedback: Undo action restores the activity (successful undo)', async () => {
  const { setState, get } = makeSetState();
  interactions.hideActivityWithFeedback(setState, 'user1', 'act1');
  await new Promise((r) => setTimeout(r, 10));
  toastCalls[0].onAction(); // user tapped "ביטול"
  assert.equal(get().has('act1'), false); // optimistic un-hide immediately
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(get().has('act1'), false); // stays visible - undo succeeded
});

test('hideActivityWithFeedback: hide itself fails -> reverts and shows an error (no dangling "hidden" state)', async () => {
  dbError.value = new Error('insert failed');
  const { setState, get } = makeSetState();
  interactions.hideActivityWithFeedback(setState, 'user1', 'act1');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(get().has('act1'), false); // reverted - never silently stays "hidden" in the UI
  assert.equal(toastCalls.length, 1);
  assert.equal(toastCalls[0].message, 'לא הצלחנו להסתיר את הפעילות, נסו שוב');
  assert.equal(toastCalls[0].actionLabel, undefined);
});

test('hideActivityWithFeedback: Undo fails -> activity stays hidden (view matches saved state) and shows an error', async () => {
  const { setState, get } = makeSetState();
  interactions.hideActivityWithFeedback(setState, 'user1', 'act1');
  await new Promise((r) => setTimeout(r, 10)); // hide succeeds
  dbError.value = new Error('delete failed'); // now make the undo's persist call fail
  toastCalls[0].onAction();
  assert.equal(get().has('act1'), false); // optimistic un-hide fires immediately...
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(get().has('act1'), true); // ...but reverts back to hidden once the undo fails
  assert.equal(toastCalls.length, 2);
  assert.equal(toastCalls[1].message, 'לא הצלחנו לבטל את ההסתרה, נסו שוב');
});

test('hiding several activities in a row: each is independently and correctly hidden', async () => {
  const { setState, get } = makeSetState();
  interactions.hideActivityWithFeedback(setState, 'user1', 'act1');
  interactions.hideActivityWithFeedback(setState, 'user1', 'act2');
  interactions.hideActivityWithFeedback(setState, 'user1', 'act3');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual([...get()].sort(), ['act1', 'act2', 'act3']);
  // showToast replaces the previous toast (a simple snackbar, not a stacking queue) - the last
  // call's Undo targets the last-hidden activity; earlier hides remain correctly hidden regardless.
  assert.equal(toastCalls.length, 3);
  assert.equal(toastCalls.at(-1).message, 'הפעילות הוסתרה');
});
