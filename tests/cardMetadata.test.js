// Tests for lib/cardMetadata.js - the Card Metadata Policy (2026-09-25): which of an activity's
// known facts show in the compact card stats row, per presentation kind, and the "unknown is never
// shown as false/unspecified" rule. Same require-hook (babel commonjs + supabase/react-native stubs)
// as tests/matchReasons.test.js, since this module also reaches lib/activities.js#formatPrice.
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
  './supabase': { supabase: {} },
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

const { getCardPresentationKind, buildCardStatFacts, noRegistrationFact } = require('../lib/cardMetadata');
const { setLocale } = require('../lib/i18n');

setLocale('he', { persist: false });

const OPEN_ALL_DAY = { openHours: { start: '00:00', end: '23:59' } };
const keys = (facts) => facts.map((f) => f.key);

// --- Classification (kind) ---

test('kind: exact category allowlists classify playground/workshop/performance; category wins over entity_type', () => {
  assert.equal(getCardPresentationKind({ category: 'גן שעשועים' }), 'playground');
  assert.equal(getCardPresentationKind({ category: 'פארק' }), 'playground');
  assert.equal(getCardPresentationKind({ category: 'סדנה' }), 'workshop');
  assert.equal(getCardPresentationKind({ category: 'חוג' }), 'workshop');
  assert.equal(getCardPresentationKind({ category: 'הצגה' }), 'performance');
  assert.equal(getCardPresentationKind({ category: 'הצגה', entity_type: 'אירוע' }), 'performance', 'category beats entity_type');
});

test('kind: פארק שעשועים (amusement park) is NOT playground - it is a different, commercial concept', () => {
  assert.notEqual(getCardPresentationKind({ category: 'פארק שעשועים' }), 'playground');
});

test('kind: entity_type classifies one-time event / recurring programme when category does not match anything more specific', () => {
  assert.equal(getCardPresentationKind({ category: 'מוזיאון לילדים', entity_type: 'אירוע' }), 'event');
  assert.equal(getCardPresentationKind({ category: 'מוזיאון לילדים', entity_type: 'אירוע_קבוע' }), 'programme');
});

test('kind: unrecognized category and entity_type -> venue (safe default, not a wrong specific guess)', () => {
  assert.equal(getCardPresentationKind({ category: 'אחר', entity_type: 'מקום_קבוע' }), 'venue');
  assert.equal(getCardPresentationKind({}), 'venue');
  assert.equal(getCardPresentationKind(null), 'venue');
});

// --- Regression examples from the task (A/B: playground cards; G/H: unknown-vs-explicit) ---

test('A/B. גן שעשועים with no price/hours/booking data at all -> zero stat facts, never filler text', () => {
  const facts = buildCardStatFacts({ category: 'גן שעשועים' });
  assert.deepEqual(facts, []);
});

test('F. playground with explicit price_type=free -> "free" shows', () => {
  const facts = buildCardStatFacts({ category: 'גן שעשועים', price_type: 'free' });
  assert.deepEqual(keys(facts), ['price']);
  assert.equal(facts[0].text, 'חינם');
});

test('playground: reliable open-now status shows (2nd slot) when schedule data is real', () => {
  const facts = buildCardStatFacts({ category: 'גן שעשועים', price_type: 'free', ...OPEN_ALL_DAY });
  assert.deepEqual(keys(facts), ['price', 'openNow']);
});

test('playground: never shows a "closed" fact - no schedule data or genuinely closed both omit silently', () => {
  assert.deepEqual(buildCardStatFacts({ category: 'גן שעשועים' }), []);
  assert.deepEqual(buildCardStatFacts({ category: 'גן שעשועים', openHours: { start: '09:00', end: '10:00' } }), []); // outside this window "now" -> not open
});

test('G. unknown registration state (booking_requirement null/undefined) never produces a registration fact, for any kind', () => {
  for (const activity of [{ category: 'סדנה' }, { category: 'הצגה' }, { category: 'גן שעשועים' }, {}]) {
    assert.equal(noRegistrationFact(activity), null, JSON.stringify(activity));
    assert.ok(!keys(buildCardStatFacts(activity)).includes('registration'));
  }
});

test('H. unknown price (no price_type) never becomes "free" or any other price claim', () => {
  assert.deepEqual(buildCardStatFacts({ category: 'סדנה', price_type: null }), []);
  assert.deepEqual(buildCardStatFacts({ category: 'סדנה', price_type: 'fixed', price_amount: null }), [], 'fixed with no amount is unknown, not free');
});

// --- Priority matrices per kind (task section 6) ---

test('C/E. WORKSHOP: price then explicit registration requirement (age is a separate always-shown slot, not part of this list)', () => {
  const facts = buildCardStatFacts({ category: 'סדנה', price_type: 'fixed', price_amount: 60, booking_requirement: 'registration_required' });
  assert.deepEqual(keys(facts), ['price', 'registration']);
  assert.equal(facts[1].text, 'בהרשמה מראש');
});

test('WORKSHOP: booking_requirement explicitly not-required is NOT surfaced as a workshop stat (only "required" is a candidate here)', () => {
  const facts = buildCardStatFacts({ category: 'סדנה', price_type: 'free', booking_requirement: 'walk_in' });
  assert.deepEqual(keys(facts), ['price']);
});

test('D. PERFORMANCE: time then registration - ticket/booking is the pre-existing separate requiresTicket badge, not duplicated here', () => {
  const facts = buildCardStatFacts({ category: 'הצגה', ...OPEN_ALL_DAY, booking_requirement: 'advance_booking' });
  assert.deepEqual(keys(facts), ['hours', 'registration']);
});

test('E. ONE-TIME EVENT: time then price; registration is not in the top 2 for a one-off', () => {
  const facts = buildCardStatFacts({ entity_type: 'אירוע', ...OPEN_ALL_DAY, price_type: 'free', booking_requirement: 'registration_required' });
  assert.deepEqual(keys(facts), ['hours', 'price']);
});

test('F. recurring programme and the venue default both keep price then hours - the pre-existing order, now omitting unknowns', () => {
  assert.deepEqual(keys(buildCardStatFacts({ entity_type: 'אירוע_קבוע', price_type: 'free', ...OPEN_ALL_DAY })), ['price', 'hours']);
  assert.deepEqual(keys(buildCardStatFacts({ category: 'מוזיאון לילדים', price_type: 'fixed', price_amount: 30, ...OPEN_ALL_DAY })), ['price', 'hours']);
});

test('at most 2 stat facts are ever returned, even when 3+ candidates all resolve', () => {
  const facts = buildCardStatFacts({ category: 'סדנה', price_type: 'free', booking_requirement: 'registration_required' });
  assert.ok(facts.length <= 2);
});
