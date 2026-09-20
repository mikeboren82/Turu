// בדיקות ל-lib/shareActivity.js: בניית קישור-שיתוף וטקסט ההודעה (פונקציות טהורות) - פעילות עם כל
// הפרטים, בלי עיר, בלי גילאים, בלי מחיר/שעות, עברית/RTL, אנגלית/LTR, ושאין מידע אישי בתוכן/בקישור.
// אותו require-hook (babel commonjs + סטאב react-native/AsyncStorage) כמו tests/matchReasons.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');
const { addHook } = require('pirates');

const ROOT = path.resolve(__dirname, '..');
const STUBS = {
  'react-native': { Platform: { OS: 'node' }, StyleSheet: { create: (s) => s } },
  '@react-native-async-storage/async-storage': {
    default: { getItem: async () => null, setItem: async () => {} },
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

const { buildActivityShareUrl, buildActivityShareMessage, isProductionShareUrl } = require('../lib/shareActivity');
const { t, formatDate, setLocale } = require('../lib/i18n');

setLocale('he', { persist: false });

const FULL_ACTIVITY = {
  id: 'act-1',
  title: 'גן המדע',
  locationName: 'מוזיאון המדע',
  city: 'רחובות',
  min_age: 4,
  max_age: 10,
  price_type: 'fixed',
  price_amount: 40,
  booking_requirement: 'registration_required',
  openHours: { start: '09:00', end: '18:00' },
  nextDate: null,
};

test('buildActivityShareUrl: without EXPO_PUBLIC_SITE_URL falls back to the app scheme (dev-only, not localhost/device)', () => {
  delete process.env.EXPO_PUBLIC_SITE_URL;
  const url = buildActivityShareUrl('act-1');
  assert.equal(url, 'wabbit://activity/act-1');
  assert.equal(isProductionShareUrl(url), false);
  assert.ok(!/localhost|127\.0\.0\.1|192\.168\.|exp:\/\//.test(url));
});

test('buildActivityShareUrl: with EXPO_PUBLIC_SITE_URL builds a real https link by stable id, no trailing slash duplication', () => {
  process.env.EXPO_PUBLIC_SITE_URL = 'https://wabbit.expo.app/';
  const url = buildActivityShareUrl('act-1');
  assert.equal(url, 'https://wabbit.expo.app/activity/act-1');
  assert.equal(isProductionShareUrl(url), true);
  delete process.env.EXPO_PUBLIC_SITE_URL;
});

test('buildActivityShareUrl: contains no secrets, tokens or personal params - just base + stable id', () => {
  process.env.EXPO_PUBLIC_SITE_URL = 'https://wabbit.expo.app';
  const url = buildActivityShareUrl('act-1');
  assert.ok(!/[?&](token|user|uid|session)=/.test(url));
  delete process.env.EXPO_PUBLIC_SITE_URL;
});

test('buildActivityShareMessage: activity with all details -> title, place, up to 2 details, link, no undefined/empty leaks', () => {
  const url = 'https://wabbit.expo.app/activity/act-1';
  const message = buildActivityShareMessage(FULL_ACTIVITY, { url, t, formatDate });
  assert.ok(message.includes('גן המדע'));
  assert.ok(message.includes('מוזיאון המדע · רחובות'));
  assert.ok(message.includes(url));
  assert.ok(!/undefined|null|NaN/.test(message));
  // עד 2 פרטים בלבד בשורת הפרטים (לא רשימת תגים ארוכה) - כאן: גיל + מחיר (השעות/ההרשמה לא נכנסות)
  const detailsLine = message.split('\n')[4];
  assert.equal(detailsLine, 'מתאים לגילאי 4–10 · ₪40');
});

test('buildActivityShareMessage: activity without a city/location -> place line omitted entirely, no dangling separator', () => {
  const activity = { ...FULL_ACTIVITY, locationName: null, city: null };
  const message = buildActivityShareMessage(activity, { url: 'https://wabbit.expo.app/activity/act-1', t, formatDate });
  assert.ok(!message.includes('·  ·'));
  assert.ok(!message.split('\n').some((line) => line.trim() === '·'));
});

test('buildActivityShareMessage: activity without known ages -> no age detail, and never claims "all ages"', () => {
  const activity = { ...FULL_ACTIVITY, min_age: null, max_age: null };
  const message = buildActivityShareMessage(activity, { url: 'https://wabbit.expo.app/activity/act-1', t, formatDate });
  assert.ok(!message.includes('כל הגילאים'));
  assert.ok(!message.includes('גיל'));
});

test('buildActivityShareMessage: activity without price/hours info -> those details are skipped, not shown as "not specified"/"open now"', () => {
  const activity = { ...FULL_ACTIVITY, price_type: 'unknown', price_amount: null, openHours: null, nextDate: null, booking_requirement: null };
  const message = buildActivityShareMessage(activity, { url: 'https://wabbit.expo.app/activity/act-1', t, formatDate });
  assert.ok(!message.includes('לא צוין'));
  assert.ok(!message.includes('שעות לא צוינו'));
  const detailsLine = message.split('\n')[4];
  assert.equal(detailsLine, 'מתאים לגילאי 4–10'); // only the age detail remains
});

test('buildActivityShareMessage: Hebrew locale keeps the friendly intro/closing lines', () => {
  setLocale('he', { persist: false });
  const message = buildActivityShareMessage(FULL_ACTIVITY, { url: 'https://wabbit.expo.app/activity/act-1', t: (k, p) => t(k, p, 'he'), formatDate: (v, o) => formatDate(v, o, 'he') });
  assert.ok(message.startsWith('מצאתי פעילות שנראית מתאימה לנו ב-TURU 😊'));
  assert.ok(message.endsWith('מה דעתך?'));
});

test('buildActivityShareMessage: English locale produces English content with the same structure', () => {
  const tEn = (k, p) => t(k, p, 'en');
  const formatDateEn = (v, o) => formatDate(v, o, 'en');
  const message = buildActivityShareMessage(FULL_ACTIVITY, { url: 'https://wabbit.expo.app/activity/act-1', t: tEn, formatDate: formatDateEn });
  assert.ok(message.startsWith('Found an activity that looks great for us on TURU 😊'));
  assert.ok(message.endsWith('What do you think?'));
  assert.ok(message.includes('Suitable for ages 4–10'));
});

test('buildActivityShareMessage: never includes personal data (no note/favorite/child fields exist on the input to leak)', () => {
  const activity = { ...FULL_ACTIVITY, personalNote: 'הערה פרטית סודית', favorite: true, recommendedBy: { nickname: 'דנה' } };
  const message = buildActivityShareMessage(activity, { url: 'https://wabbit.expo.app/activity/act-1', t, formatDate });
  assert.ok(!message.includes('הערה פרטית סודית'));
  assert.ok(!message.includes('דנה'));
});
