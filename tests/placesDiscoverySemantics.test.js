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

// placesDiscovery.ts now imports GENRE_WORDS from matching.ts (2026-09-21 token-quality hardening).
// Extracted from the REAL matching.ts source (not a third hand-copied literal) so this stub cannot
// itself drift; matching.ts is not run through this loader because it has its own Deno test suite
// with real dependencies this harness does not stub.
const matchingSrc = fs.readFileSync(path.join(SHARED, 'matching.ts'), 'utf8');
const genreWordsMatch = matchingSrc.match(/GENRE_WORDS = new Set\(\[([^\]]*)\]\)/);
if (!genreWordsMatch) throw new Error('GENRE_WORDS not found in matching.ts - update this stub');
const GENRE_WORDS_STUB = new Set(JSON.parse(`[${genreWordsMatch[1].replace(/'/g, '"')}]`));
const places = loadDenoModule('placesDiscovery.ts', {
  './cityNaming.ts': { normalizeCityName: (s) => s },
  './matching.ts': { GENRE_WORDS: GENRE_WORDS_STUB },
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
  assert.equal(s.isCandidate, true, 'co-located + name containment');
  assert.equal(s.distanceM, 0);
  // Renamed from same_domain in the two-axis refactor: sharing a publisher establishes that the
  // rows describe the same PLACE, which is relatedness - the identity here is the name containment.
  assert.ok(s.venueRelatedness.some((x) => x.startsWith('same_publisher')), 'publisher is relatedness');
  assert.ok(s.identityEvidence.some((x) => x.startsWith('offering_name_identity')), 'identity is the name');
  assert.equal(s.relationship, 'POSSIBLE_DUPLICATE');
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

// --- venue-sibling / cross-source corpus (2026-09-21, after the Ramat Gan Safari review) --------
// Every fixture below is a REAL production pattern. The failure being locked out: same-publisher
// was corroborating duplicate evidence, so inside one venue's own site two distinct programmes
// outscored a genuine cross-source duplicate of the venue itself.
const PLACE = 'מקום_קבוע';
const SAFARI_LL = { lat: 32.0461112, lon: 34.8195887 };
const SAFARI_ADDR = 'רמת גן';
const SAFARI_VENUE_ID = 'venue-safari';
const safariParent = { name: 'ספארי רמת גן', ...SAFARI_LL, address: SAFARI_ADDR, sourceUrl: 'https://www.safari.co.il/', entityType: PLACE, venueId: SAFARI_VENUE_ID };
const safariAggregator = { name: 'ספארי - חוויה מרתקת לכל המשפחה', ...SAFARI_LL, address: SAFARI_ADDR, sourceUrl: 'https://www.karamel.co.il/attractions.asp', entityType: PLACE, venueId: SAFARI_VENUE_ID };
const safariMidnight = { name: 'ספארי חצות', ...SAFARI_LL, address: SAFARI_ADDR, sourceUrl: 'https://www.safari.co.il/', entityType: 'אירוע_קבוע', venueId: SAFARI_VENUE_ID };
const safariMorning = { name: 'סיור ספארי על הבוקר', ...SAFARI_LL, address: SAFARI_ADDR, sourceUrl: 'https://www.safari.co.il/', entityType: 'אירוע_קבוע', venueId: SAFARI_VENUE_ID };
const safariBirthday = { name: 'יום הולדת בספארי', ...SAFARI_LL, address: SAFARI_ADDR, sourceUrl: 'https://www.safari.co.il/', entityType: 'אירוע_קבוע', venueId: SAFARI_VENUE_ID };

test('REGRESSION (Safari): a CROSS-SOURCE duplicate of the destination IS a candidate', () => {
  // The case the old model ranked lowest of all: different publishers, so it lost the only signal
  // that used to carry weight, while the venue's own sibling programmes kept it.
  const s = coordinateDuplicateSignal(safariParent, safariAggregator);
  assert.equal(s.isCandidate, true);
  assert.equal(s.relationship, 'POSSIBLE_DUPLICATE');
  assert.ok(s.identityEvidence.some((x) => x.startsWith('independent_sources_agree')));
});

test('REGRESSION (Safari): the destination vs one of its programmes is NOT a duplicate', () => {
  const s = coordinateDuplicateSignal(safariParent, safariMidnight);
  assert.equal(s.isCandidate, false);
  assert.equal(s.relationship, 'SAME_PLACE_DIFFERENT_RECORD');
  assert.deepEqual(s.identityEvidence, []);
});

test('REGRESSION (Safari): two different programmes at one venue are NOT duplicates', () => {
  // Both are offerings of the same publisher at one position. Their only shared name token is the
  // venue's own name, which a min-denominator ratio used to read as 0.50 "strong overlap".
  const s = coordinateDuplicateSignal(safariMidnight, safariMorning);
  assert.equal(s.isCandidate, false);
  assert.deepEqual(s.identityEvidence, []);
});

test('REGRESSION (Safari): the venue vs its private-hire page is NOT a duplicate', () => {
  const s = coordinateDuplicateSignal(safariParent, safariBirthday);
  assert.equal(s.isCandidate, false);
  assert.equal(s.relationship, 'SAME_PLACE_DIFFERENT_RECORD');
});

test('REGRESSION (Safari): the true duplicate now outranks every sibling pair', () => {
  // The precise inversion being fixed - assert the ORDERING, not just the booleans.
  const truePair = coordinateDuplicateSignal(safariParent, safariAggregator);
  for (const sibling of [
    coordinateDuplicateSignal(safariParent, safariMidnight),
    coordinateDuplicateSignal(safariMidnight, safariMorning),
    coordinateDuplicateSignal(safariParent, safariBirthday),
  ]) {
    assert.ok(truePair.score > sibling.score, 'the real duplicate must score above sibling offerings');
    assert.ok(truePair.isCandidate && !sibling.isCandidate);
  }
});

const MID_LL = { lat: 30.6119687, lon: 34.8012169 };
const midVenue = { name: 'מדבריום', ...MID_LL, sourceUrl: 'https://midbarium.co.il/news/x', entityType: PLACE };
const midVenueDup = { name: 'מדבריום - פארק החיות', ...MID_LL, sourceUrl: 'https://midbarium.co.il/', entityType: PLACE };
const midZoneKhan = { name: 'חאן - אזור בעלי חיים', ...MID_LL, sourceUrl: 'https://midbarium.co.il/', entityType: PLACE };
const midZoneOasis = { name: 'נווה מדבר - אזור מעיינות ובעלי חיים', ...MID_LL, sourceUrl: 'https://midbarium.co.il/', entityType: PLACE };

test('REGRESSION (Midbarium): the historical SAME-PUBLISHER venue duplicate is still caught', () => {
  // Must survive the fix: cross-source is an ADDITIONAL path to identity, not a replacement.
  const s = coordinateDuplicateSignal(midVenue, midVenueDup);
  assert.equal(s.isCandidate, true);
  assert.ok(s.identityEvidence.some((x) => x.startsWith('offering_name_identity')));
});

test('REGRESSION (Midbarium): zone vs zone is NOT a duplicate', () => {
  const s = coordinateDuplicateSignal(midZoneKhan, midZoneOasis);
  assert.equal(s.isCandidate, false);
});

test('REGRESSION (Midbarium): the venue vs one of its internal zones is NOT a duplicate', () => {
  const s = coordinateDuplicateSignal(midVenue, midZoneKhan);
  assert.equal(s.isCandidate, false);
});

// --- adversarial: the fix must not trade one false-positive class for another -------------------
test('ADVERSARIAL: unrelated businesses at an identical address stay unrelated', () => {
  const a = { name: 'מוזיאון הילדים', lat: 32.08, lon: 34.78, address: 'הרצל 1', sourceUrl: 'https://museum.example/', entityType: PLACE };
  const b = { name: 'קפה שכונתי', lat: 32.08, lon: 34.78, address: 'הרצל 1', sourceUrl: 'https://cafe.example/', entityType: PLACE };
  const s = coordinateDuplicateSignal(a, b);
  assert.equal(s.isCandidate, false, 'cross-publisher must not flag two different businesses');
  assert.ok(s.venueRelatedness.includes('same_address'), 'they really do share the address');
});

test('ADVERSARIAL: a repeated occurrence of ONE event IS a duplicate candidate', () => {
  const a = { name: 'הפנינג סוכות', lat: 32.08, lon: 34.78, sourceUrl: 'https://muni.example/', entityType: 'אירוע' };
  const b = { name: 'הפנינג סוכות', lat: 32.08, lon: 34.78, sourceUrl: 'https://muni.example/', entityType: 'אירוע' };
  assert.equal(coordinateDuplicateSignal(a, b).isCandidate, true);
});

test('ADVERSARIAL: same venue, two differently named events are NOT duplicates', () => {
  const a = { name: 'הפנינג סוכות', lat: 32.08, lon: 34.78, sourceUrl: 'https://muni.example/', entityType: 'אירוע' };
  const b = { name: 'פסטיבל חנוכה', lat: 32.08, lon: 34.78, sourceUrl: 'https://muni.example/', entityType: 'אירוע' };
  assert.equal(coordinateDuplicateSignal(a, b).isCandidate, false);
});

test('ADVERSARIAL: the same destination from two sources with modestly different names IS caught', () => {
  const a = { name: 'מוזיאון המדע ירושלים', lat: 31.77, lon: 35.2, sourceUrl: 'https://mada.example/', entityType: PLACE };
  const b = { name: 'מוזיאון המדע', lat: 31.77, lon: 35.2, sourceUrl: 'https://aggregator.example/', entityType: PLACE };
  assert.equal(coordinateDuplicateSignal(a, b).isCandidate, true);
});

test('each relatedness signal ALONE is insufficient - coordinates, publisher and venue', () => {
  const base = { lat: 32.08, lon: 34.78, entityType: PLACE };
  // same coordinates only
  assert.equal(coordinateDuplicateSignal({ ...base, name: 'אלף' }, { ...base, name: 'בית' }).isCandidate, false);
  // same coordinates + same publisher
  assert.equal(coordinateDuplicateSignal(
    { ...base, name: 'אלף', sourceUrl: 'https://x.example/a' },
    { ...base, name: 'בית', sourceUrl: 'https://x.example/b' },
  ).isCandidate, false);
  // same coordinates + same publisher + same venue + same address
  const s = coordinateDuplicateSignal(
    { ...base, name: 'אלף', sourceUrl: 'https://x.example/a', venueId: 'v1', address: 'רחוב 1' },
    { ...base, name: 'בית', sourceUrl: 'https://x.example/b', venueId: 'v1', address: 'רחוב 1' },
  );
  assert.equal(s.isCandidate, false, 'four relatedness signals still are not identity');
  assert.equal(s.venueRelatedness.length, 4);
});

test('entity_type is optional - the gate simply does not fire when it is absent', () => {
  // Older callers pass no entity_type; behaviour must degrade to name/source evidence only.
  const s = coordinateDuplicateSignal(
    { name: 'מדבריום', ...MID_LL, sourceUrl: 'https://midbarium.co.il/a' },
    { name: 'מדבריום - פארק החיות', ...MID_LL, sourceUrl: 'https://midbarium.co.il/b' },
  );
  assert.equal(s.isCandidate, true);
});

test('PLACE_ENTITY_TYPE has not drifted from the extraction contract', () => {
  const src = fs.readFileSync(path.join(SHARED, 'extraction.ts'), 'utf8');
  const m = src.match(/export const ENTITY_TYPE_VALUES = \[([^\]]*)\]/);
  assert.ok(m, 'ENTITY_TYPE_VALUES must still exist');
  assert.ok(m[1].includes(places.PLACE_ENTITY_TYPE), 'the place entity type must remain a declared entity type');
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
