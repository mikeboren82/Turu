// בדיקות ל-checkNearMePermission/requestNearMePermission (lib/currentPosition.js, Home Refactor
// Phase 2C): שכבת הרשאה/מיקום הצרה שחולצה מ-handleNearMePress/confirmNearMePermission
// ב-app/index.js. LocationApi מוזרק (fake, לא expo-location אמיתי) בדיוק כמו requestCurrentPosition
// הקיים - כך שהבדיקות רצות בלי מכשיר/הרשאה אמיתית. אותו דפוס babel-commonjs hook כמו שאר
// בדיקות lib/ בפרויקט.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const babel = require('@babel/core');
const { addHook } = require('pirates');

const ROOT = path.resolve(__dirname, '..');
addHook(
  (code, filename) => babel.transformSync(code, { filename, babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'] }).code,
  { exts: ['.js'], matcher: (f) => f.startsWith(path.join(ROOT, 'lib')) },
);

const { checkNearMePermission, requestNearMePermission } = require('../lib/currentPosition');

const fakeLocation = (getForegroundResult, requestForegroundResult) => ({
  getForegroundPermissionsAsync: async () => getForegroundResult,
  requestForegroundPermissionsAsync: async () => requestForegroundResult,
});

// --- checkNearMePermission (handleNearMePress: a silent status check, never prompts) ---

test('checkNearMePermission: already granted -> {status: "granted"} (handleNearMePress skips the explainer and goes straight to goNearMe)', async () => {
  const result = await checkNearMePermission(fakeLocation({ status: 'granted', canAskAgain: true }));
  assert.deepEqual(result, { status: 'granted' });
});

test('checkNearMePermission: not granted but canAskAgain explicitly false -> {status: "blocked"} (shows the blocked error, no modal)', async () => {
  const result = await checkNearMePermission(fakeLocation({ status: 'denied', canAskAgain: false }));
  assert.deepEqual(result, { status: 'blocked' });
});

test('checkNearMePermission: not granted, canAskAgain undefined (e.g. web) -> {status: "prompt"}, NOT "blocked" (the explainer modal opens instead of a false "open settings" error)', async () => {
  const result = await checkNearMePermission(fakeLocation({ status: 'undetermined', canAskAgain: undefined }));
  assert.deepEqual(result, { status: 'prompt' });
});

test('checkNearMePermission: not granted, canAskAgain true -> {status: "prompt"} (normal first-time-ask path)', async () => {
  const result = await checkNearMePermission(fakeLocation({ status: 'denied', canAskAgain: true }));
  assert.deepEqual(result, { status: 'prompt' });
});

// --- requestNearMePermission (confirmNearMePermission: actually prompts the system dialog) ---

test('requestNearMePermission: system prompt granted -> {status: "granted"} (confirmNearMePermission proceeds to goNearMe automatically)', async () => {
  const result = await requestNearMePermission(fakeLocation(null, { status: 'granted', canAskAgain: true }));
  assert.deepEqual(result, { status: 'granted' });
});

test('requestNearMePermission: denied with canAskAgain explicitly false -> {status: "blocked"} (blocked error copy, not the generic denied copy)', async () => {
  const result = await requestNearMePermission(fakeLocation(null, { status: 'denied', canAskAgain: false }));
  assert.deepEqual(result, { status: 'blocked' });
});

test('requestNearMePermission: denied with canAskAgain true/undefined -> {status: "denied"} (generic denied copy, the prompt has already happened so there is no "prompt" outcome here)', async () => {
  assert.deepEqual(await requestNearMePermission(fakeLocation(null, { status: 'denied', canAskAgain: true })), { status: 'denied' });
  assert.deepEqual(await requestNearMePermission(fakeLocation(null, { status: 'denied', canAskAgain: undefined })), { status: 'denied' });
});
