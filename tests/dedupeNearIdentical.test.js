// בדיקות ל-dedupeNearIdentical/pickDedupeLoser (lib/filterActivities.js, "Performance Phase 1"
// audit סעיף 2) - שובר-השוויון בין כמעט-כפולים (אותו שם, קרובים גיאוגרפית) חייב להישאר בלתי-
// תלוי בסדר-הכניסה של activities: fetchApprovedActivities עברה מ-order('created_at desc') ל-
// order('id') (מהירות שאילתה) - אם dedupeNearIdentical היה עדיין תלוי-בשקט ב"מי הופיע קודם
// במערך", המעבר הזה היה הופך בשקט את הזוכה מ"החדש ביותר" ל"הישן ביותר" בקבוצות עם completeness
// זהה. הבדיקות כאן מוודאות: (1) התוצאה זהה בדיוק לא משנה באיזה סדר הפעילויות מגיעות ל-ranker,
// ו-(2) עדיין "החדש ביותר שורד" בשוויון-completeness - אותה סמנטיקה בדיוק כמו לפני המעבר.
// אותו דפוס STUBS+babel-commonjs-hook כמו tests/homeDiscovery.test.js (filterActivities.js לא
// תלוי ב-supabase, אבל אותו hook עדיין נדרש כדי לתמוך ב-import/export syntax).
const test = require('node:test');
const assert = require('node:assert/strict');
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

const { rankActivitiesWithSmartRadius, normalizeFilters } = require('../lib/filterActivities');

const FILTERS = normalizeFilters({});

// שני מקומות פיזית-קרובים (בתוך NEAR_DUPLICATE_KM=0.75) עם אותו שם בדיוק (case/whitespace לא
// משנה, ראו dedupeNearIdentical) - completeness זהה בכוונה (imageUrl+description+openHours.start
// זהים) כדי לבדוק את ענף-השוויון הספציפי ב-pickDedupeLoser, לא את ענף ה"completeness גבוה יותר".
// Since 2026-09-27 a collapse also needs a shared identity signal (title+distance alone is not
// identity - tests/dedupeIdentity.test.js), so these pairs share one location row.
const dup = (id, { createdAt, lat = 32.08, lng = 34.78 } = {}) => ({
  id, locationId: 'loc-shared', title: 'גן שעשועים – רחוב הדוגמה, עיר-בדיקה', category: 'גן שעשועים', city: 'עיר-בדיקה',
  lat, lng, imageUrl: 'https://example.com/img.jpg', description: 'תיאור', openHours: { start: '08:00' },
  created_at: createdAt,
});

function run(activities) {
  return rankActivitiesWithSmartRadius(activities, FILTERS, null, [], [], [], null, null, []).activities;
}

test('dedupe tie-break: on equal completeness, the NEWER created_at survives - older-first array order', () => {
  const older = dup('older', { createdAt: '2026-01-01T00:00:00Z' });
  const newer = dup('newer', { createdAt: '2026-06-01T00:00:00Z' });
  const result = run([older, newer]);
  assert.equal(result.length, 1, 'near-duplicate pair collapses to one surviving activity');
  assert.equal(result[0].id, 'newer');
});

test('dedupe tie-break: identical outcome when input array order is reversed (newer-first)', () => {
  const older = dup('older', { createdAt: '2026-01-01T00:00:00Z' });
  const newer = dup('newer', { createdAt: '2026-06-01T00:00:00Z' });
  // אותם שני אובייקטים בדיוק, רק סדר-קלט הפוך - זה בדיוק התרחיש שהיה משתנה בשקט לפני התיקון
  // (fetchApprovedActivities יכולה להחזיר את שתי הפעילויות בכל סדר, תלוי ב-order('id') מול
  // order('created_at')). התוצאה חייבת להיות זהה ל-test הקודם.
  const result = run([newer, older]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'newer', 'winner must not depend on array/fetch order');
});

test('dedupe tie-break: fully-identical completeness AND created_at falls back to a stable id comparison, order-independent', () => {
  const a = dup('a-lower-id', { createdAt: '2026-01-01T00:00:00Z' });
  const b = dup('b-higher-id', { createdAt: '2026-01-01T00:00:00Z' });
  const resultAB = run([a, b]);
  const resultBA = run([b, a]);
  assert.equal(resultAB.length, 1);
  assert.equal(resultBA.length, 1);
  assert.equal(resultAB[0].id, resultBA[0].id, 'the final id tiebreak must pick the same winner regardless of input order');
});

test('dedupe: higher completeness always wins regardless of created_at or array order (unrelated to this fix)', () => {
  const rich = { ...dup('rich', { createdAt: '2026-01-01T00:00:00Z' }) };
  const poor = { ...dup('poor', { createdAt: '2026-06-01T00:00:00Z' }), imageUrl: null, description: null, openHours: {} };
  const result = run([poor, rich]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'rich', 'completeness still takes priority over created_at - unchanged by this fix');
});

test('dedupe: activities further apart than NEAR_DUPLICATE_KM (0.75km) are NOT merged', () => {
  const a = dup('far-a', { createdAt: '2026-01-01T00:00:00Z', lat: 32.08, lng: 34.78 });
  const b = dup('far-b', { createdAt: '2026-01-01T00:00:00Z', lat: 32.20, lng: 34.90 }); // ~15km away
  const result = run([a, b]);
  assert.equal(result.length, 2, 'distinct real places sharing a generic name must both survive');
});
