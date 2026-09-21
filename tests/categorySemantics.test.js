// TuRu - Park / Playground / Attraction-Complex taxonomy + alias layer (Phase C, 2026-09-21).
//
// These replace an assumption that used to be written into the code itself
// (scan-settlement-gaps: "'פארק שעשועים' מילה נרדפת ל-'גן שעשועים' - אותו מושג ממש"), which was the
// root of a real misclassification chain. Everything here is deterministic and fixture-based - no
// live catalogue rows, so the suite cannot be destabilised by a future data fix.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const babel = require('@babel/core');
const { addHook } = require('pirates');

const ROOT = path.resolve(__dirname, '..');
addHook(
  (code, filename) => babel.transformSync(code, { filename, babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'] }).code,
  { exts: ['.js'], matcher: (f) => f.startsWith(path.join(ROOT, 'lib')) || f.startsWith(path.join(ROOT, 'constants')) },
);

const {
  resolveCategoryIntent, conceptForDbValue, conceptDbValue,
  aliasPhrasesForConcept, activityMatchesAliasPhrase, textContainsPhrase,
} = require('../lib/categorySemantics.js');

// --- the mirror contract ---------------------------------------------------------------------
// categorySemantics.json exists twice on purpose (Edge Functions deploy as a self-contained
// bundle and cannot import from the repo root) - exactly the arrangement categoryValues.json
// already uses. That copy was previously maintained by hand with nothing to catch drift.
test('MIRROR: the Deno copy of categorySemantics.json is byte-identical to the root source of truth', () => {
  const root = fs.readFileSync(path.join(ROOT, 'constants/categorySemantics.json'), 'utf8');
  const mirror = fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/categorySemantics.json'), 'utf8');
  assert.equal(mirror, root, 'run: cp constants/categorySemantics.json supabase/functions/_shared/categorySemantics.json');
});

test('MIRROR: the Deno copy of categoryValues.json is byte-identical too (pre-existing, previously unchecked)', () => {
  const root = fs.readFileSync(path.join(ROOT, 'constants/categoryValues.json'), 'utf8');
  const mirror = fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/categoryValues.json'), 'utf8');
  assert.equal(mirror, root);
});

test('every concept dbValue is a legal category value (no drift from categoryValues.json)', () => {
  const legal = require('../constants/categoryValues.json').categories;
  for (const key of ['PARK', 'PLAYGROUND', 'ATTRACTION_COMPLEX']) {
    assert.ok(legal.includes(conceptDbValue(key)), `${key} -> ${conceptDbValue(key)} must exist in categoryValues.json`);
  }
});

// --- the rename ------------------------------------------------------------------------------
test('ATTRACTION_COMPLEX still STORES the legacy value while the product concept is מתחם אטרקציות', () => {
  // Deliberate: renaming a persisted value is a data migration, not a code edit (product decision 3).
  assert.equal(conceptDbValue('ATTRACTION_COMPLEX'), 'פארק שעשועים');
  assert.equal(conceptForDbValue('פארק שעשועים'), 'ATTRACTION_COMPLEX');
});

test('the Hebrew display label for the stored value is now מתחם אטרקציות', () => {
  const he = require('../lib/i18n/locales/he/domain.json');
  assert.equal(he.categories['פארק שעשועים'], 'מתחם אטרקציות');
});

// --- alias resolution ------------------------------------------------------------------------
const ATTRACTION_ALIASES = [
  'מתחם אטרקציות', 'מתחמי אטרקציות', 'פארק שעשועים', 'פארקי שעשועים',
  'לונה פארק', 'לונה-פארק', 'לונהפארק',
];
for (const alias of ATTRACTION_ALIASES) {
  test(`ALIAS: "${alias}" resolves to ATTRACTION_COMPLEX`, () => {
    const intent = resolveCategoryIntent(alias);
    assert.ok(intent, 'must resolve to a concept');
    assert.equal(intent.concept, 'ATTRACTION_COMPLEX');
    assert.equal(intent.dbValue, 'פארק שעשועים');
  });
}

for (const [query, concept] of [['פארק', 'PARK'], ['פארקים', 'PARK']]) {
  test(`ALIAS: "${query}" resolves to PARK, never to the attraction complex`, () => {
    assert.equal(resolveCategoryIntent(query).concept, concept);
  });
}

for (const query of ['גן שעשועים', 'גני שעשועים']) {
  test(`ALIAS: "${query}" resolves to PLAYGROUND, never to the attraction complex`, () => {
    assert.equal(resolveCategoryIntent(query).concept, 'PLAYGROUND');
  });
}

// --- negative collision cases ----------------------------------------------------------------
// The whole point of longest-phrase-first ordering: the bare word "פארק" is an alias of PARK and
// sits INSIDE two attraction aliases, so a naive matcher resolves everything to PARK (or worse,
// resolves "פארק" to the attraction complex and turns every park query into a rides query).
test('COLLISION: "פארק שעשועים" is NOT read as the bare "פארק" alias', () => {
  assert.equal(resolveCategoryIntent('פארק שעשועים').concept, 'ATTRACTION_COMPLEX');
});

test('COLLISION: "לונה פארק" is NOT read as the bare "פארק" alias', () => {
  assert.equal(resolveCategoryIntent('לונה פארק').concept, 'ATTRACTION_COMPLEX');
});

test('COLLISION: "גן שעשועים" is NOT read as the attraction complex despite sharing "שעשועים"', () => {
  assert.equal(resolveCategoryIntent('גן שעשועים').concept, 'PLAYGROUND');
});

test('COLLISION: a query with no category vocabulary resolves to nothing (never a default)', () => {
  assert.equal(resolveCategoryIntent('משהו כיף לילדים'), null);
  assert.equal(resolveCategoryIntent('זהבה'), null);
  assert.equal(resolveCategoryIntent(''), null);
});

// --- composition with the rest of the query ---------------------------------------------------
// The alias matcher must consume ONLY its own phrase, so geography/time parsing is untouched.
for (const [query, concept] of [
  ['לונה פארק בנתניה', 'ATTRACTION_COMPLEX'],
  ['פארקי שעשועים בשבת', 'ATTRACTION_COMPLEX'],
  ['מתחם אטרקציות מחר', 'ATTRACTION_COMPLEX'],
  ['לונה פארק קרוב אליי', 'ATTRACTION_COMPLEX'],
  ['פארק בנתניה', 'PARK'],
  ['גן שעשועים בכפר יונה', 'PLAYGROUND'],
  ['בלונה פארק', 'ATTRACTION_COMPLEX'], // attached Hebrew prefix
]) {
  test(`COMPOSES: "${query}" -> ${concept}`, () => {
    assert.equal(resolveCategoryIntent(query).concept, concept);
  });
}

// --- semantic canaries (deterministic fixtures, not live rows) --------------------------------
const PARK_SARONA = {
  title: 'פארק שרונה, כפר יונה',
  description: 'פארק שכונתי מרכזי בשכונת שרונה בכפר יונה, בשטח של כ-21 דונם, עם ציוד משחקים לילדים בכל הגילאים, מדשאה גדולה, במה ובריכת נוי.',
  category: 'פארק',
};
const LUNA_PARK_TA = {
  title: 'לונה פארק תל אביב',
  description: 'פארק שעשועים המציע שפע של מתקנים לקטנים ולגדולים, חווית בילוי משפחתית.',
  category: 'פארק שעשועים',
};
const ORDINARY_PLAYGROUND = {
  title: 'גן שעשועים - רחוב הדקל',
  description: 'מתקני משחקים, מגלשה ונדנדות בשכונה.',
  category: 'גן שעשועים',
};
const MIDBARIUM = {
  title: 'מדבריום - פארק החיות',
  description: 'פארק חיות ראשון מסוגו המאפשר מפגש חוויתי ייחודי בין המבקר לבעלי החיים, חוויות טיול מדברית.',
  category: 'פארק',
};

const attractionPhrases = aliasPhrasesForConcept('ATTRACTION_COMPLEX');

test('CANARY: פארק שרונה is a PARK - an ordinary park with play equipment is not an attraction complex', () => {
  assert.equal(resolveCategoryIntent(PARK_SARONA.title).concept, 'PARK');
  assert.equal(
    activityMatchesAliasPhrase(PARK_SARONA, attractionPhrases), false,
    'neither its name nor its description carries an attraction-complex phrase',
  );
});

test('CANARY: לונה פארק תל אביב IS an attraction complex, by name and by stored category', () => {
  assert.equal(resolveCategoryIntent(LUNA_PARK_TA.title).concept, 'ATTRACTION_COMPLEX');
  assert.equal(activityMatchesAliasPhrase(LUNA_PARK_TA, attractionPhrases), true);
  assert.equal(conceptForDbValue(LUNA_PARK_TA.category), 'ATTRACTION_COMPLEX');
});

test('CANARY: an ordinary playground is a PLAYGROUND and never an attraction complex', () => {
  assert.equal(resolveCategoryIntent(ORDINARY_PLAYGROUND.title).concept, 'PLAYGROUND');
  assert.equal(activityMatchesAliasPhrase(ORDINARY_PLAYGROUND, attractionPhrases), false);
});

test('CANARY: מדבריום is NOT an attraction complex - an animal experience, however large or ticketed', () => {
  // Product correction (decision 5D): size / ticketing / being a destination are not signals.
  assert.notEqual(resolveCategoryIntent(MIDBARIUM.title)?.concept, 'ATTRACTION_COMPLEX');
  assert.equal(activityMatchesAliasPhrase(MIDBARIUM, attractionPhrases), false);
});

// --- phrase matching is phrase matching, not token soup ---------------------------------------
test('RECALL PRECISION: a record that merely contains both words separately is NOT alias evidence', () => {
  // This is the difference between reaching 17 records and reaching 170 on the live catalogue.
  const decoy = { title: 'גן שעשועים בפארק העירוני', description: 'מתקני משחקים לצד מדשאות הפארק.' };
  assert.equal(activityMatchesAliasPhrase(decoy, attractionPhrases), false);
});

test('RECALL PRECISION: PARK recalls on its stored category only - the bare word is not evidence', () => {
  // "פארק" is fine to TYPE but a bad thing to conclude a record FROM: "גרביטי פארק" is an
  // attraction complex, not a public park. Measured on the live catalogue: allowing the bare word
  // to recall took "פארק" from 23 stored matches to 244.
  assert.deepEqual(aliasPhrasesForConcept('PARK'), [], 'no text-recall phrases for PARK');
  const gravity = { title: 'גרביטי פארק - נתניה', description: 'מתחם בילוי משפחתי עם שלל מתקנים.' };
  assert.equal(activityMatchesAliasPhrase(gravity, aliasPhrasesForConcept('PARK')), false);
});

test('RECALL PRECISION: the attraction complex still recalls on all of its specific phrases', () => {
  const phrases = aliasPhrasesForConcept('ATTRACTION_COMPLEX');
  assert.ok(phrases.includes('לונה פארק'));
  assert.ok(phrases.includes('מתחם אטרקציות'));
  assert.ok(phrases.includes('פארק שעשועים'));
});

test('textContainsPhrase respects word boundaries and Hebrew prefixes', () => {
  assert.equal(textContainsPhrase('הופעה בלונה פארק הערב', 'לונה פארק'), true);
  assert.equal(textContainsPhrase('לונה-פארק', 'לונה פארק'), true, 'dashes normalize to spaces');
  assert.equal(textContainsPhrase('פארק', 'לונה פארק'), false);
});
