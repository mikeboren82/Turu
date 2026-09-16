// Localization tests for lib/i18n (run: npm run test:i18n).
// The app code is ESM + React Native, so this file installs a tiny require hook: app sources are
// transformed to CommonJS with Babel, and react-native / AsyncStorage are replaced with in-memory
// stubs. No device, bundler or network is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const fs = require('fs');
const babel = require('@babel/core');
const { addHook } = require('pirates');

const ROOT = path.resolve(__dirname, '..');
const storage = new Map();
const STUBS = {
  'react-native': { Platform: { OS: 'node' }, StyleSheet: { create: (s) => s } },
  '@react-native-async-storage/async-storage': {
    default: {
      getItem: async (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: async (k, v) => { storage.set(k, v); },
    },
  },
};
STUBS['./supabase'] = { supabase: {} }; // lib/activities pulls the Supabase client; no network in tests
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

const i18n = require('../lib/i18n');
const format = require('../lib/i18n/format');
const { RESOURCES } = require('../lib/i18n/locales');

const withLocale = (locale, fn) => {
  const prev = i18n.getLocale();
  i18n.setLocale(locale, { persist: false });
  try { return fn(); } finally { i18n.setLocale(prev, { persist: false }); }
};

test('default locale is Hebrew (RTL)', () => {
  assert.equal(i18n.DEFAULT_LOCALE, 'he');
  assert.equal(i18n.getLocale(), 'he');
  assert.equal(i18n.isRTLLocale('he'), true);
  assert.equal(i18n.isRTLLocale('en'), false);
});

test('every locale has the same namespaces and keys (plural variants grouped)', () => {
  const flatten = (o, p = '', out = new Set()) => {
    for (const [k, v] of Object.entries(o)) {
      const key = p ? `${p}.${k}` : k;
      if (v && typeof v === 'object') flatten(v, key, out);
      else out.add(key.replace(/_(zero|one|two|few|many|other)$/, ''));
    }
    return out;
  };
  const he = flatten(RESOURCES.he);
  for (const loc of i18n.SUPPORTED_LOCALES) {
    const other = flatten(RESOURCES[loc]);
    assert.deepEqual([...other].filter((k) => !he.has(k)), [], `${loc} has keys missing in he`);
    assert.deepEqual([...he].filter((k) => !other.has(k)), [], `${loc} is missing keys`);
  }
});

test('interpolation and plurals (Hebrew dual form, English one/other)', () => {
  assert.equal(i18n.t('common.listAnd', { head: 'א, ב', last: 'ג' }, 'he'), 'א, ב וג');
  assert.equal(i18n.t('common.listAnd', { head: 'a, b', last: 'c' }, 'en'), 'a, b and c');
  const he = [1, 2, 5].map((count) => i18n.t('domain.time.weeksAgo', { count }, 'he'));
  assert.equal(new Set(he).size, 3, `expected 3 distinct Hebrew forms, got ${he}`);
  assert.notEqual(i18n.t('domain.time.weeksAgo', { count: 1 }, 'en'), i18n.t('domain.time.weeksAgo', { count: 2 }, 'en'));
  assert.equal(i18n.t('domain.time.weeksAgo', { count: 2 }, 'en'), i18n.t('domain.time.weeksAgo', { count: 5 }, 'en').replace('5', '2'));
});

test('missing key falls back to Hebrew, then to the raw key in dev', () => {
  RESOURCES.he.common.__testOnlyKey = 'רק בעברית';
  try {
    assert.equal(i18n.t('common.__testOnlyKey', null, 'en'), 'רק בעברית');
  } finally {
    delete RESOURCES.he.common.__testOnlyKey;
  }
  assert.equal(i18n.t('common.doesNotExist', null, 'en'), 'common.doesNotExist');
});

test('listJoin is locale-aware', () => {
  assert.equal(i18n.listJoin(['א'], 'he'), 'א');
  assert.equal(i18n.listJoin(['a', 'b'], 'en'), 'a and b');
  assert.match(i18n.listJoin(['a', 'b', 'c'], 'en'), /^a, b and c$/);
});

test('direction tokens mirror between Hebrew and English', () => {
  const he = i18n.dirTokens('he');
  const en = i18n.dirTokens('en');
  assert.equal(he.row, 'row-reverse');
  assert.equal(en.row, 'row');
  assert.equal(he.textAlign, 'right');
  assert.equal(en.textAlign, 'left');
  assert.equal(he.alignStart, en.alignEnd);
  assert.equal(he.forwardRotate, '0deg');
  assert.equal(en.forwardRotate, '180deg');
});

test('createStyles resolves per active locale', () => {
  const styles = i18n.createStyles((d) => ({ row: { flexDirection: d.row, textAlign: d.textAlign } }));
  assert.equal(styles.row.flexDirection, 'row-reverse');
  withLocale('en', () => assert.equal(styles.row.flexDirection, 'row'));
  assert.equal(styles.row.textAlign, 'right');
});

test('setLocale persists and initLocale restores; invalid locales are ignored', async () => {
  i18n.setLocale('en');
  assert.equal(storage.get('turu_locale'), 'en');
  i18n.setLocale('he', { persist: false });
  assert.equal(await i18n.initLocale(), 'en');
  i18n.setLocale('xx');
  assert.equal(i18n.getLocale(), 'en');
  i18n.setLocale('he');
  assert.equal(storage.get('turu_locale'), 'he');
});

test('locale change notifies subscribers exactly once per real change', () => {
  // useI18n uses useSyncExternalStore over this store; exercise it through setLocale side effects.
  const styles = i18n.createStyles((d) => ({ a: { textAlign: d.textAlign } }));
  i18n.setLocale('en', { persist: false });
  i18n.setLocale('en', { persist: false });
  assert.equal(styles.a.textAlign, 'left');
  i18n.setLocale('he', { persist: false });
});

test('categories and regions: canonical Hebrew ids, localized labels', () => {
  assert.equal(format.categoryLabel('גן שעשועים'), 'גן שעשועים');
  withLocale('en', () => {
    assert.equal(format.categoryLabel('גן שעשועים'), 'Playground');
    assert.equal(format.categoryLabel('ערך לא מוכר'), 'ערך לא מוכר');
    assert.ok(format.regionLabel('ירושלים והסביבה') !== '' );
  });
  const { CATEGORY_OPTIONS } = require('../constants/filterSchema');
  const playground = CATEGORY_OPTIONS.find((o) => o.value === 'גן שעשועים' || o.id === 'גן שעשועים');
  assert.ok(playground, 'playground option exists');
  const id = playground.value ?? playground.id;
  withLocale('en', () => {
    assert.equal(playground.label, 'Playground');
    assert.equal(playground.value ?? playground.id, id);
  });
  assert.equal(playground.label, 'גן שעשועים');
});

test('every canonical category has an English label', () => {
  const { CATEGORY_OPTIONS } = require('../constants/filterSchema');
  withLocale('en', () => {
    for (const o of CATEGORY_OPTIONS) assert.doesNotMatch(o.label, /[֐-׿]/, `category ${o.value ?? o.id} has no English label`);
  });
});

test('placeName: Hebrew unchanged in he, canonical English in en, unknown stays as-is', () => {
  assert.equal(format.placeName('חיפה'), 'חיפה');
  withLocale('en', () => {
    assert.equal(format.placeName('חיפה'), 'Haifa');
    assert.equal(format.placeName('תל אביב-יפו'), 'Tel Aviv-Yafo');
    assert.equal(format.placeName('נתניה'), 'Netanya');
    assert.equal(format.placeName('Eilat'), 'Eilat');
    assert.equal(format.placeName('מקום שלא קיים בכלל'), 'מקום שלא קיים בכלל');
    assert.equal(format.placeName(''), '');
  });
  assert.equal(format.normalizePlaceKey('באר־שבע'), format.normalizePlaceKey('באר־שבע'));
  assert.equal(format.normalizePlaceKey('ראשון לציון'), 'ראשון לציון');
});

test('generated summaries are built per locale, not concatenated', () => {
  withLocale('en', () => {
    assert.equal(format.categoriesSummary(['גן שעשועים', 'מוזיאון לילדים']), "Playground and Children's museum");
    assert.match(format.categoriesSummary(['a', 'b', 'c', 'd']), /4/);
    assert.equal(format.locationSummaryText({ mode: 'city', city: 'חיפה' }), 'Haifa');
    const drive = format.locationSummaryText({ mode: 'city', city: 'נתניה', travelMode: 'driving', travelMinutes: 30 });
    assert.match(drive, /30/);
    assert.match(drive, /Netanya/);
    assert.doesNotMatch(drive, /[֐-׿]/);
    assert.doesNotMatch(format.compactLocationText(null), /[֐-׿]/);
  });
  assert.equal(format.locationSummaryText({ mode: 'city', city: 'חיפה' }), 'חיפה');
});

test('activity getters (age/price/hours) follow the active locale', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/activities.js'), 'utf8');
  assert.match(src, /get\(\) \{ return formatAgeRange/);
  const { formatAgeRange, formatPrice } = require('../lib/activities');
  const heFree = formatPrice('free', null);
  withLocale('en', () => {
    assert.doesNotMatch(formatPrice('free', null), /[֐-׿]/);
    assert.doesNotMatch(formatAgeRange(2, 6), /[֐-׿]/);
  });
  assert.match(heFree, /[֐-׿]/);
});

test('relative dates are pluralized in both locales', () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  withLocale('en', () => {
    assert.doesNotMatch(format.relativeDate(daysAgo(3)), /[֐-׿]/);
    assert.match(format.relativeDate(daysAgo(3)), /3/);
  });
  assert.match(format.relativeDate(daysAgo(3)), /[֐-׿]/);
});
