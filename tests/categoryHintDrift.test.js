// TuRu - Phase G.1 (2026-09-21): the NAME_CATEGORY / FAMILY_SUPPORTS hint tables and the
// placeholder-artwork maps each exist twice (Deno Edge Function + Node/CommonJS Cleaner) with an
// explicit "keep in lockstep" contract and nothing enforcing it. The Phase G audit found the Node
// NAME_CATEGORY twin had actually drifted - missing two birdwatching keywords ('צפרות', 'ציפורים')
// from the טבע rule - so a name-only hint that should have proposed 'טבע' silently proposed
// nothing on the Cleaner's Node path while the Deno/scan-source path got it right. These tests
// extract the real object/array literals out of both source files (not a hand-copied fixture, so
// a future edit that touches only one side is still caught) and fail on any divergence, plus prove
// the fixed behaviour at runtime rather than only at the text level.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const Module = require('module');
const babel = require('@babel/core');
const { addHook } = require('pirates');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// constants/filterSchema.js is ESM (import/export) and pulls in lib/i18n, which needs
// react-native / AsyncStorage stubbed the same way tests/i18n.test.js does. Same pattern here.
const STUBS = {
  'react-native': { Platform: { OS: 'node' }, StyleSheet: { create: (s) => s } },
  '@react-native-async-storage/async-storage': { default: { getItem: async () => null, setItem: async () => {} } },
};
STUBS['./supabase'] = { supabase: {} };
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

// Pulls a `const NAME = <literal>` declaration's value out of source text and evaluates just that
// literal (plain array/object syntax - a TS type annotation like `: [RegExp, string][]` sits
// between the name and the `=` and is skipped by starting the scan at `=`, never evaluated).
// Anchored on `const <name>` rather than a bare substring search, because several of these names
// also appear inside a "keep in lockstep" comment ABOVE the real declaration.
function extractLiteral(src, name) {
  const declMatch = new RegExp(`\\bconst\\s+${name}\\b`).exec(src);
  assert.ok(declMatch, `could not find "const ${name}"`);
  const decl = declMatch.index;
  const eq = src.indexOf('=', decl);
  let start = eq + 1;
  while (/\s/.test(src[start])) start++;
  // `new Set([...])` (AMBIGUOUS_CATEGORIES) vs a plain array/object literal (everything else).
  const isSet = src.startsWith('new Set(', start);
  if (isSet) { start += 'new Set('.length; while (/\s/.test(src[start])) start++; }
  const openers = { '[': ']', '{': '}' };
  const open = src[start];
  assert.ok(openers[open], `"${name}" must start with [ or { right after =`);
  let depth = 0, i = start;
  for (; i < src.length; i++) {
    if (src[i] === '[' || src[i] === '{') depth++;
    else if (src[i] === ']' || src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const literal = src.slice(start, i);
  // eslint-disable-next-line no-new-func -- trusted first-party source files, not user input
  const value = new Function(`return (${literal});`)();
  return isSet ? new Set(value) : value;
}

const denoHints = read('supabase/functions/_shared/categoryHints.ts');
const nodeHints = read('tools/import-tool/cleaner/fieldEnricher.js');
const denoPlaceholder = read('supabase/functions/_shared/placeholderGroup.ts');
const nodePlaceholder = read('tools/import-tool/placeholderGroup.js');

const denoNameCategory = extractLiteral(denoHints, 'NAME_CATEGORY');
const nodeNameCategory = extractLiteral(nodeHints, 'NAME_CATEGORY');
const denoFamilySupports = extractLiteral(denoHints, 'FAMILY_SUPPORTS');
const nodeFamilySupports = extractLiteral(nodeHints, 'FAMILY_SUPPORTS');
const denoDirectMap = extractLiteral(denoPlaceholder, 'DIRECT_MAP');
const nodeDirectMap = extractLiteral(nodePlaceholder, 'DIRECT_MAP');
const denoAmbiguous = extractLiteral(denoPlaceholder, 'AMBIGUOUS_CATEGORIES');
const nodeAmbiguous = extractLiteral(nodePlaceholder, 'AMBIGUOUS_CATEGORIES');
const denoKeywordGroups = extractLiteral(denoPlaceholder, 'KEYWORD_GROUPS');
const nodeKeywordGroups = extractLiteral(nodePlaceholder, 'KEYWORD_GROUPS');

const asPairs = (table) => table.map(([re, category]) => ({ source: re.source, flags: re.flags, category }));

// --- DRIFT GUARDS: parsed from the real source, not a hand-copied fixture -----------------------
test('DRIFT GUARD: NAME_CATEGORY is identical between the Deno and Node twins', () => {
  assert.deepEqual(asPairs(nodeNameCategory), asPairs(denoNameCategory),
    'tools/import-tool/cleaner/fieldEnricher.js NAME_CATEGORY has drifted from supabase/functions/_shared/categoryHints.ts');
});

test('REGRESSION: the Node NAME_CATEGORY twin was missing the birdwatching keywords - must not regress', () => {
  const natureRule = nodeNameCategory.find(([, category]) => category === 'טבע');
  assert.ok(natureRule, 'a טבע rule must exist');
  assert.match(natureRule[0].source, /צפרות/, 'the Node טבע rule dropped "צפרות" (ornithology) at some point - this was the actual Phase G drift');
  assert.match(natureRule[0].source, /ציפורים/, 'the Node טבע rule dropped "ציפורים" (birds)');
});

test('RUNTIME: the Node NAME_CATEGORY twin now proposes טבע from birdwatching-only evidence', () => {
  const { NAME_CATEGORY } = require('../tools/import-tool/cleaner/fieldEnricher.js');
  for (const name of ['צפרות בעמק החולה', 'תצפית בציפורים נודדות']) {
    const hit = NAME_CATEGORY.find(([re]) => re.test(name));
    assert.ok(hit, `"${name}" must match a NAME_CATEGORY rule`);
    assert.equal(hit[1], 'טבע', `"${name}" must propose טבע`);
  }
});

test('DRIFT GUARD: FAMILY_SUPPORTS is identical between the Deno and Node twins', () => {
  assert.deepEqual(nodeFamilySupports, denoFamilySupports);
});

test('DRIFT GUARD: placeholder DIRECT_MAP is identical between the Deno and Node twins', () => {
  assert.deepEqual(nodeDirectMap, denoDirectMap);
});

test('DRIFT GUARD: placeholder KEYWORD_GROUPS is identical between the Deno and Node twins', () => {
  assert.deepEqual(nodeKeywordGroups, denoKeywordGroups);
});

test('DRIFT GUARD: placeholder AMBIGUOUS_CATEGORIES is identical between the Deno and Node twins', () => {
  assert.deepEqual([...nodeAmbiguous].sort(), [...denoAmbiguous].sort());
});

// --- placeholder-map integrity: no unknown category keys may accumulate ------------------------
const categoryValues = require('../constants/categoryValues.json');
const VALID_STORAGE = new Set([...categoryValues.categories, ...categoryValues.storageOnlyCategories]);

test('REGRESSION: the placeholder orphan value הפעלה is gone from AMBIGUOUS_CATEGORIES', () => {
  // הפעלה was a non-canonical category value from the manual 2026-09-11 classification, predating
  // constants/categoryValues.json. The one production row that ever held it was normalized to אחר
  // in Phase F, and sanitizeCategory now rejects it permanently, so it can never reappear.
  assert.ok(!denoAmbiguous.has('הפעלה'), 'must be removed from the Deno placeholder map');
  assert.ok(!nodeAmbiguous.has('הפעלה'), 'must be removed from the Node placeholder map');
});

test('INTEGRITY: every key in the placeholder DIRECT_MAP is a valid stored category', () => {
  for (const key of Object.keys(denoDirectMap)) {
    assert.ok(VALID_STORAGE.has(key), `DIRECT_MAP key "${key}" is not a valid stored category - orphan or typo`);
  }
});

test('INTEGRITY: every AMBIGUOUS_CATEGORIES entry is a valid stored category (no orphans)', () => {
  // Unlike DIRECT_MAP (art per real category), this set only decides which categories fall back to
  // keyword analysis - historically a couple of dead/legacy strings ended up here (הפעלה). Anything
  // in this set going forward must be a real category, not a stray leftover from an older taxonomy.
  for (const cat of denoAmbiguous) {
    assert.ok(VALID_STORAGE.has(cat), `AMBIGUOUS_CATEGORIES entry "${cat}" is not a valid stored category - orphan or typo`);
  }
});

test('AMBIGUOUS_CATEGORIES stays exactly "valid storage minus DIRECT_MAP keys" (no accidental gaps)', () => {
  // classifyPlaceholderGroup falls back to keyword analysis for anything not in DIRECT_MAP anyway
  // (see the ! DIRECT_MAP[category] arm), so this documents the intended invariant rather than
  // asserting new runtime behaviour: nothing may be silently left with neither direct art nor a
  // keyword fallback path.
  const directKeys = new Set(Object.keys(denoDirectMap));
  const expectedAmbiguous = [...VALID_STORAGE].filter((c) => !directKeys.has(c));
  assert.deepEqual([...denoAmbiguous].sort(), expectedAmbiguous.sort());
});

// --- zoo category emoji --------------------------------------------------------------------------
test('every category shown in CATEGORY_OPTIONS has an emoji (no silent gaps like חיות וגני חיות)', () => {
  const { CATEGORY_OPTIONS } = require('../constants/filterSchema.js');
  for (const opt of CATEGORY_OPTIONS) assert.ok(opt.emoji, `"${opt.id}" is shown to users but has no emoji`);
});

test('REGRESSION: חיות וגני חיות has its own emoji, distinct from the other animal categories', () => {
  const { CATEGORY_OPTIONS } = require('../constants/filterSchema.js');
  const zoo = CATEGORY_OPTIONS.find((o) => o.id === 'חיות וגני חיות');
  assert.ok(zoo, 'חיות וגני חיות must be a user-facing category option');
  assert.ok(zoo.emoji, 'must have an emoji');
  const others = CATEGORY_OPTIONS.filter((o) => ['בעלי חיים', 'פינת חי', 'חווה'].includes(o.id)).map((o) => o.emoji);
  assert.ok(!others.includes(zoo.emoji), 'must not reuse another animal category\'s emoji (they are separate concepts, per categorySemantics.json)');
});
