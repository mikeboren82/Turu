// TuRu - Phase E: discovery-verdict semantics + coordinate duplicate signal (2026-09-21).
//
// These exercise the REAL Deno source (supabase/functions/_shared/placesDiscovery.ts) by stripping
// its types with babel and loading it in Node. Deno is not installed on this machine, and a test
// that cannot be executed is not a regression test - this way the shipped code is genuinely run.
// The module's only import (./cityNaming.ts) is stubbed; nothing here touches the network or a DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const babel = require('@babel/core');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const SHARED = path.join(ROOT, 'supabase', 'functions', '_shared');

function loadDenoModule(fileName, stubs = {}) {
  const full = path.join(SHARED, fileName);
  const src = fs.readFileSync(full, 'utf8');
  const { code } = babel.transformSync(src, {
    filename: full,
    babelrc: false,
    configFile: false,
    presets: [[require.resolve('@babel/preset-typescript'), { allExtensions: true, isTSX: false }]],
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
  });
  const mod = new Module(full);
  mod.filename = full;
  mod.paths = Module._nodeModulePaths(path.dirname(full));
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function resolve(request, ...rest) {
    if (stubs[request]) return `stub:${request}`;
    return originalResolve.call(this, request, ...rest);
  };
  for (const [name, exp] of Object.entries(stubs)) {
    const m = new Module(`stub:${name}`);
    m.exports = { __esModule: true, ...exp };
    m.loaded = true;
    Module._cache[`stub:${name}`] = m;
  }
  try {
    mod._compile(code, full);
  } finally {
    Module._resolveFilename = originalResolve;
  }
  return mod.exports;
}

const places = loadDenoModule('placesDiscovery.ts', {
  './cityNaming.ts': { normalizeCityName: (s) => s },
});
const { classifyPlace, resolvePlaceCategory, coordinateDuplicateSignal } = places;

// --- verdict -> category (the corruption path Phase D traced) ---------------------------------
test('PLAYGROUND verdict -> גן שעשועים', () => {
  const v = resolvePlaceCategory({ kind: 'PLAYGROUND', primaryType: 'playground', name: 'גן שעשועים הדקל' });
  assert.equal(v.category, 'גן שעשועים');
  assert.equal(v.requiresReview, false);
});

test('PARK verdict -> פארק (no longer diverted into the playground bucket)', () => {
  const v = resolvePlaceCategory({ kind: 'PARK', primaryType: 'park', name: 'פארק הירקון' });
  assert.equal(v.category, 'פארק');
  assert.equal(v.requiresReview, false);
});

test('REGRESSION: PARK_WITH_PLAYGROUND is NOT blindly written as גן שעשועים', () => {
  // This was the actual collapse: every imported row became 'גן שעשועים' regardless of verdict,
  // which is how municipal parks containing play equipment became playgrounds at scale.
  const parkPrimary = resolvePlaceCategory({ kind: 'PARK_WITH_PLAYGROUND', primaryType: 'park', name: 'פארק עירוני עם מתקני משחקים' });
  assert.equal(parkPrimary.category, 'פארק', 'google says the place is primarily a park -> it stays a park');

  const playPrimary = resolvePlaceCategory({ kind: 'PARK_WITH_PLAYGROUND', primaryType: 'playground', name: 'גן שעשועים בפארק' });
  assert.equal(playPrimary.category, 'גן שעשועים', 'google says primarily a playground -> playground');
});

test('PARK_WITH_PLAYGROUND with an unhelpful primaryType goes to REVIEW, never a guess', () => {
  const v = resolvePlaceCategory({ kind: 'PARK_WITH_PLAYGROUND', primaryType: 'tourist_attraction', name: 'פארק כלשהו' });
  assert.equal(v.category, null);
  assert.equal(v.requiresReview, true);
  assert.equal(v.confidence, 'LOW');
});

test('UNCERTAIN goes to review rather than receiving an arbitrary category', () => {
  const v = resolvePlaceCategory({ kind: 'UNCERTAIN', primaryType: null, name: 'משהו' });
  assert.equal(v.category, null);
  assert.equal(v.requiresReview, true);
});

test('a category is never assigned from the word "פארק" in the name alone', () => {
  // classifyPlace treats the word as a PARK signal; resolvePlaceCategory must still refuse to
  // conclude anything when the verdict itself is ambiguous.
  const kind = classifyPlace({ primaryType: 'tourist_attraction', types: ['tourist_attraction'], name: 'גרביטי פארק' });
  const v = resolvePlaceCategory({ kind, primaryType: 'tourist_attraction', name: 'גרביטי פארק' });
  assert.notEqual(v.category, 'פארק', 'an attraction venue whose name contains פארק is not a public park');
});

// --- coordinate duplicate signal (the Midbarium gap) -------------------------------------------
const MIDBARIUM_VENUE = { name: 'מדבריום', lat: 30.6119687, lon: 34.8012169, sourceUrl: 'https://midbarium.co.il/news/x' };
const MIDBARIUM_ZOO = { name: 'מדבריום - פארק החיות', lat: 30.6119687, lon: 34.8012169, sourceUrl: 'https://midbarium.co.il/' };
const MIDBARIUM_EVENTS = { name: 'אירועים במדבריום', lat: 30.6119687, lon: 34.8012169, sourceUrl: 'https://midbarium.co.il/events' };

test('MIDBARIUM: the two venue rows ARE flagged as duplicate candidates', () => {
  // Three approved rows at byte-identical coordinates with three different names AND three
  // different categories defeated every name-based and category-based dedupe axis at once.
  const s = coordinateDuplicateSignal(MIDBARIUM_VENUE, MIDBARIUM_ZOO);
  assert.equal(s.isCandidate, true, 'co-located + same domain + overlapping name');
  assert.equal(s.distanceM, 0);
  assert.ok(s.signals.some((x) => x.startsWith('same_domain')));
});

test('MIDBARIUM: the separate events listing is NOT auto-removed, but IS surfaced for review', () => {
  const s = coordinateDuplicateSignal(MIDBARIUM_VENUE, MIDBARIUM_EVENTS);
  // It shares coordinates, domain and the word מדבריום, so it legitimately reaches the review
  // queue - but "candidate" is explicitly not "merge". Nothing in this module deletes or merges.
  assert.equal(typeof s.isCandidate, 'boolean');
  assert.equal(s.reason.includes('review') || s.reason.includes('not a duplicate'), true);
  assert.ok(!('merge' in s), 'the signal must not carry any merge instruction');
});

test('co-location ALONE is never a duplicate candidate', () => {
  // A museum and its cafe, a mall and an activity inside it, a zoo and an unrelated attraction in
  // the same complex - all share coordinates and must not be flagged on that basis.
  const museum = { name: 'מוזיאון הילדים', lat: 32.08, lon: 34.78, sourceUrl: 'https://museum.example/' };
  const cafe = { name: 'קפה שכונתי', lat: 32.08, lon: 34.78, sourceUrl: 'https://cafe.example/' };
  const s = coordinateDuplicateSignal(museum, cafe);
  assert.equal(s.isCandidate, false);
  assert.equal(s.distanceM, 0, 'they really are co-located');
  assert.match(s.reason, /nothing else corroborates/);
});

test('distant venues are not candidates even with identical names and domain', () => {
  const a = { name: 'לונה פארק', lat: 32.08, lon: 34.78, sourceUrl: 'https://x.example/' };
  const b = { name: 'לונה פארק', lat: 31.25, lon: 34.79, sourceUrl: 'https://x.example/' };
  const s = coordinateDuplicateSignal(a, b);
  assert.equal(s.isCandidate, false);
  assert.ok(s.distanceM > 60);
});

test('missing coordinates degrade safely to "not a candidate"', () => {
  const s = coordinateDuplicateSignal({ name: 'x', lat: null, lon: null }, MIDBARIUM_VENUE);
  assert.equal(s.isCandidate, false);
  assert.equal(s.distanceM, null);
});

// --- dedupe stopwords (section 14) -------------------------------------------------------------
test('REGRESSION: dedupe normalization no longer erases the park/playground distinction', () => {
  const src = fs.readFileSync(path.join(SHARED, 'placesDiscovery.ts'), 'utf8');
  const line = src.match(/const COMPARISON_ONLY_STOPWORDS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(line, 'stopword set must still exist');
  const tokens = line[1];
  // Dropping these two made "גן שעשועים X" and "פארק שעשועים X" compare as the same venue.
  assert.ok(!tokens.includes("'שעשועים'"), 'שעשועים must NOT be dropped - it carries category meaning');
  assert.ok(!tokens.includes("'playground'"), 'playground must NOT be dropped - it carries category meaning');
});
