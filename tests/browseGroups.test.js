// User-facing browse groups (2026-09-25) - constants/browseGroups.json + lib/browseGroups.js.
// A PRESENTATION-ONLY union over canonical categories. These tests pin: the drift guard (every
// canonical value exactly once), group-tap/partial/multi selection semantics, the browse-aware
// summary, "[] means all" (never a collapsed full selection), the Smart Search alias reset, and that
// search, cards, placeholders and excludeCategory stay canonical. Same babel-commonjs require hook +
// react-native/AsyncStorage/supabase stubs as tests/filterSummaries.test.js and tests/i18n.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
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
require.extensions['.jpg'] = (mod, filename) => { mod.exports = filename; };

const browseData = require('../constants/browseGroups.json');
const categoryValues = require('../constants/categoryValues.json');
const {
  groupOf, membersOf, isInternalCategory, groupSelectionState, isCompleteGroupSelection, toggleGroupSelection,
  toggleCategorySelection, hasMemberLevel, BROWSE_GROUP_OPTIONS, homeDefaultGroups, withManualCategorySelection,
  browseSelectionItems, browseSelectionCount, browseSummary, browseGroupLabel,
} = require('../lib/browseGroups');
const { categorySummary, buildActiveChips, buildResultsSummary } = require('../lib/filterSummaries');
const { DEFAULT_FILTERS, CATEGORY_FILTER_OPTIONS, CATEGORY_OPTIONS } = require('../constants/filterSchema');
const { applyFilters, normalizeFilters, countActiveFilters } = require('../lib/filterActivities');
const { intentToFilters } = require('../lib/smartSearch');
const { placeholderImageFor, PLACEHOLDER_IMAGES } = require('../lib/placeholderImages');
const i18n = require('../lib/i18n');
const { categoryLabel } = require('../lib/i18n/format');
const { RESOURCES } = require('../lib/i18n/locales');

const withLocale = (locale, fn) => {
  const prev = i18n.getLocale();
  i18n.setLocale(locale, { persist: false });
  try { return fn(); } finally { i18n.setLocale(prev, { persist: false }); }
};
const sorted = (a) => [...a].sort();
const CANONICAL = [...categoryValues.categories, ...categoryValues.storageOnlyCategories];
const ALL_MEMBERS = browseData.groups.flatMap((g) => g.members);

// ================================================================================================
// 1. DRIFT GUARD - every canonical value appears EXACTLY ONCE across groups[].members ∪ internal.
//    A new canonical category fails here until it is assigned - there is no silent fallback.
// ================================================================================================

test('drift: every canonical/storage-only category is placed exactly once (one group or internal)', () => {
  const placements = [...ALL_MEMBERS, ...browseData.internal];
  for (const value of CANONICAL) {
    const n = placements.filter((p) => p === value).length;
    assert.equal(n, 1, `"${value}" appears ${n} times in browseGroups.json (must be exactly 1)`);
  }
});

test('drift: no member / internal value is outside the canonical set (no invented categories)', () => {
  for (const value of [...ALL_MEMBERS, ...browseData.internal]) {
    assert.ok(CANONICAL.includes(value), `"${value}" is not a canonical category`);
  }
  assert.equal(ALL_MEMBERS.length + browseData.internal.length, CANONICAL.length);
});

test('drift: group ids are unique, stable ASCII snake_case, each with an emoji, members and an order', () => {
  const ids = browseData.groups.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate group id');
  for (const g of browseData.groups) {
    assert.match(g.id, /^[a-z][a-z0-9_]*$/, `group id "${g.id}" must be stable ASCII`);
    assert.ok(typeof g.emoji === 'string' && g.emoji.trim().length > 0, `${g.id} lacks an emoji`);
    assert.ok(Array.isArray(g.members) && g.members.length > 0, `${g.id} has no members`);
    assert.equal(typeof g.homeDefault, 'boolean', `${g.id} homeDefault must be boolean`);
    assert.equal(typeof g.order, 'number', `${g.id} order must be a number`);
    assert.equal(g.label, undefined, 'labels live in i18n, never in the JSON');
  }
  const orders = browseData.groups.map((g) => g.order);
  assert.equal(new Set(orders).size, orders.length, 'duplicate order');
});

test('drift: every group has a label in every locale; English labels carry no Hebrew', () => {
  for (const [locale, res] of Object.entries(RESOURCES)) {
    for (const g of browseData.groups) {
      const label = res.domain?.browseGroups?.[g.id];
      assert.ok(typeof label === 'string' && label.trim(), `${locale}: domain.browseGroups.${g.id} missing`);
      if (locale !== 'he') assert.doesNotMatch(label, /[֐-׿]/, `${locale}: ${g.id} label has Hebrew`);
    }
    assert.deepEqual(sorted(Object.keys(res.domain.browseGroups)), sorted(browseData.groups.map((g) => g.id)),
      `${locale}: no stray browseGroups keys`);
  }
});

test('drift: internal = archive categories + the אחר catch-all; internal values are never group members', () => {
  assert.deepEqual(sorted(browseData.internal), sorted(['אחר', ...categoryValues.archiveCategories]));
  for (const v of browseData.internal) {
    assert.equal(groupOf(v), null);
    assert.equal(isInternalCategory(v), true);
  }
  // every user-facing filter option (the old flat 28 chips) is reachable through exactly one group
  for (const o of CATEGORY_FILTER_OPTIONS) assert.ok(groupOf(o.id), `${o.id} has no browse group`);
});

test('mapping: the exact canonical -> group table (ספורט inside water_attractions; festivals two members)', () => {
  const expected = {
    playgrounds_parks: ['גן שעשועים', 'פארק'],
    shows: ['הצגה', 'מוזיקה', 'ריקוד'],
    cinema: ['קולנוע לילדים'],
    indoor_play: ['משחקייה', "ג'ימבורי", 'טרמפולינות'],
    animals: ['חיות וגני חיות', 'חווה', 'פינת חי', 'בעלי חיים'],
    nature: ['טבע'],
    museums_science: ['מוזיאון לילדים', 'מדע'],
    workshops: ['סדנה', 'יצירה', 'בישול'],
    story_hour: ['שעת סיפור', 'ספרייה'],
    water_attractions: ['פעילות מים', 'בריכה', 'פארק שעשועים', 'אטרקציה', 'חדרי בריחה', 'ספורט'],
    festivals_events: ['פעילות קהילתית', 'פעילות עירונית'],
  };
  assert.deepEqual(BROWSE_GROUP_OPTIONS.map((g) => g.id), Object.keys(expected), 'picker order');
  for (const [id, members] of Object.entries(expected)) {
    assert.deepEqual(membersOf(id), members, id);
    for (const m of members) assert.equal(groupOf(m), id);
  }
  assert.equal(groupOf('גן שעשועים') === groupOf('פארק שעשועים'), false, 'playground vs amusement park stay apart');
  assert.deepEqual(membersOf('nope'), []);
  assert.equal(groupOf('not-a-category'), null);
});

test('membersOf returns a fresh copy (callers cannot corrupt the contract)', () => {
  const m = membersOf('shows');
  m.push('x');
  assert.deepEqual(membersOf('shows'), ['הצגה', 'מוזיקה', 'ריקוד']);
});

// ================================================================================================
// 2. HOME "מה עוד מעניין אתכם?" - six fixed tiles; a tile tap = the group's full member union.
// ================================================================================================

test('Home: exactly six fixed default tiles, in the specified order (not count-based)', () => {
  assert.deepEqual(homeDefaultGroups().map((g) => g.id),
    ['playgrounds_parks', 'shows', 'indoor_play', 'animals', 'workshops', 'water_attractions']);
  const src = fs.readFileSync(path.join(ROOT, 'app/index.js'), 'utf8');
  assert.match(src, /const DISCOVERY_TILES = homeDefaultGroups\(\);/, 'Home tiles come from the static contract');
  assert.match(src, /handleDiscoveryTilePress\(tile\.id\)/);
  assert.match(src, /const categories = membersOf\(groupId\);/);
});

test('Home: a tile tap produces filters.category = [...group.members] (the semantic defect is fixed)', () => {
  for (const g of homeDefaultGroups()) {
    const f = { ...withManualCategorySelection(DEFAULT_FILTERS, membersOf(g.id)), location: DEFAULT_FILTERS.location };
    assert.deepEqual(f.category, g.members, g.id);
    assert.deepEqual(f.categoryAliasPhrases, []);
    assert.equal(countActiveFilters(f), 1, 'the category dimension still counts once');
  }
  // the old defect: "חיות, חוות וגני חיות" used to filter only 'חווה'
  assert.deepEqual(membersOf('animals'), ['חיות וגני חיות', 'חווה', 'פינת חי', 'בעלי חיים']);
});

test('Home: group unions match every member in applyFilters (membership, never volume)', () => {
  const rows = CANONICAL.map((c, i) => ({ id: `r${i}`, title: `row ${i}`, category: c }));
  const ids = (cats) => applyFilters(rows, { ...DEFAULT_FILTERS, category: cats }, null, [], [], [], [])
    .map((a) => a.category);
  assert.deepEqual(sorted(ids(membersOf('playgrounds_parks'))), sorted(['גן שעשועים', 'פארק']));
  assert.deepEqual(sorted(ids(membersOf('workshops'))), sorted(['סדנה', 'יצירה', 'בישול']));
  assert.deepEqual(sorted(ids(membersOf('animals'))), sorted(['חיות וגני חיות', 'חווה', 'פינת חי', 'בעלי חיים']));
  const two = [...membersOf('shows'), ...membersOf('cinema')];
  assert.deepEqual(sorted(ids(two)), sorted(['הצגה', 'מוזיקה', 'ריקוד', 'קולנוע לילדים']), 'multi-group union');
});

// ================================================================================================
// 3-6. Picker semantics: group toggle, partial selection, multiple groups, single-member groups.
// ================================================================================================

test('group toggle: tap selects all members; tap again (fully selected) deselects all of them', () => {
  const on = toggleGroupSelection('shows', []);
  assert.deepEqual(on, ['הצגה', 'מוזיקה', 'ריקוד']);
  assert.equal(groupSelectionState('shows', on), 'all');
  assert.equal(isCompleteGroupSelection('shows', on), true);
  assert.deepEqual(toggleGroupSelection('shows', on), []);
});

test('partial selection: visible partial state; tapping a partial group completes it (never clears)', () => {
  const partial = toggleCategorySelection('מוזיקה', toggleGroupSelection('shows', []));
  assert.deepEqual(partial, ['הצגה', 'ריקוד']);
  assert.equal(groupSelectionState('shows', partial), 'partial');
  assert.equal(isCompleteGroupSelection('shows', partial), false);
  assert.deepEqual(sorted(toggleGroupSelection('shows', partial)), sorted(['הצגה', 'מוזיקה', 'ריקוד']));
  assert.equal(groupSelectionState('shows', ['הצגה']), 'partial');
  assert.equal(groupSelectionState('shows', []), 'none');
});

test('multiple groups: toggles compose, each group toggles only its own members', () => {
  let sel = toggleGroupSelection('shows', []);
  sel = toggleGroupSelection('animals', sel);
  sel = toggleCategorySelection('טבע', sel);
  assert.equal(groupSelectionState('shows', sel), 'all');
  assert.equal(groupSelectionState('animals', sel), 'all');
  sel = toggleGroupSelection('shows', sel);
  assert.deepEqual(sorted(sel), sorted([...membersOf('animals'), 'טבע']));
});

test('group toggle preserves foreign values (other groups, exact picks, stale/internal saved values)', () => {
  const saved = ['אחר', 'הצגה'];
  const on = toggleGroupSelection('workshops', saved);
  assert.deepEqual(on, ['אחר', 'הצגה', 'סדנה', 'יצירה', 'בישול']);
  assert.deepEqual(toggleGroupSelection('workshops', on), ['אחר', 'הצגה']);
});

test('single-member / duplicate-label groups get no second level (cinema, nature, festivals_events)', () => {
  for (const locale of ['he', 'en']) {
    withLocale(locale, () => {
      const levelled = BROWSE_GROUP_OPTIONS.filter((g) => hasMemberLevel(g.id)).map((g) => g.id);
      assert.deepEqual(levelled, ['playgrounds_parks', 'shows', 'indoor_play', 'animals', 'museums_science',
        'workshops', 'story_hour', 'water_attractions'], locale);
    });
  }
  // festivals: the group label IS the canonical display label since a0fc65c - an expanded layer
  // would repeat it. Pinned in both locales so the two labels can never silently diverge.
  for (const locale of ['he', 'en']) {
    withLocale(locale, () => {
      assert.equal(browseGroupLabel('festivals_events'), categoryLabel('פעילות קהילתית'), locale);
      assert.equal(browseGroupLabel('cinema'), categoryLabel('קולנוע לילדים'), locale);
    });
  }
  // a single-member group tap is still the value itself
  assert.deepEqual(toggleGroupSelection('nature', []), ['טבע']);
  assert.deepEqual(toggleGroupSelection('festivals_events', []), ['פעילות קהילתית', 'פעילות עירונית']);
});

// ================================================================================================
// 7. Summary semantics (rules A-G) - active chips, results phrase, Home pill, profile default.
// ================================================================================================

test('summary A: all members of one group -> the group label', () => {
  assert.equal(browseSummary(membersOf('playgrounds_parks')), 'גני שעשועים ופארקים');
  assert.equal(browseSummary(sorted(membersOf('water_attractions'))), 'מים, אטרקציות ואקסטרים', 'order-insensitive');
  withLocale('en', () => assert.equal(browseSummary(membersOf('animals')), 'Animals, farms & zoos'));
});

test('summary B: one canonical category -> its canonical label (unchanged behaviour)', () => {
  assert.equal(browseSummary(['הצגה']), 'הצגה');
  assert.equal(browseSummary(['טבע']), 'טבע', 'a complete single-member group reads as its value');
  assert.equal(browseSummary(['פעילות קהילתית']), 'פסטיבלים ואירועים');
  assert.equal(browseSummary(['גן שעשועים']), 'גן שעשועים', 'never widened to the group label');
});

test('summary C: partial group -> canonical member labels', () => {
  assert.equal(browseSummary(['הצגה', 'מוזיקה']), i18n.listJoin(['הצגה', 'מוזיקה']));
});

test('summary D/E: two complete groups -> both labels; three or more -> "N קבוצות"', () => {
  const two = [...membersOf('shows'), ...membersOf('workshops')];
  assert.equal(browseSummary(two), i18n.listJoin(['הצגות ומופעים', 'סדנאות ויצירה']));
  const four = [...two, ...membersOf('animals'), ...membersOf('indoor_play')];
  assert.equal(browseSummary(four), '4 קבוצות');
  withLocale('en', () => assert.equal(browseSummary(four), '4 groups'));
});

test('summary F: complete group + partial members -> "first +N"', () => {
  const mixed = [...membersOf('shows'), 'פארק', 'טבע'];
  assert.equal(browseSummary(mixed), 'הצגות ומופעים +2');
  assert.equal(browseSummary(['פארק', ...membersOf('shows')]), 'פארק +1', 'first = first selected');
});

test('summary G: internal/stale values are tolerated and never surfaced', () => {
  assert.equal(browseSummary(['אחר', 'הצגה']), 'הצגה');
  assert.equal(browseSummary(['חוג', ...membersOf('shows')]), 'הצגות ומופעים');
  const onlyInternal = browseSummary(['אחר']);
  assert.doesNotMatch(onlyInternal, /אחר/);
  assert.equal(onlyInternal, 'קטגוריה אחת');
  assert.doesNotMatch(browseSummary(['legacy-value', 'קייטנה']), /legacy|קייטנה/);
  assert.equal(browseSelectionItems(['אחר', 'הצגה']).hiddenCount, 1);
  assert.equal(browseSelectionCount([...membersOf('water_attractions'), 'הצגה']), 2, 'a complete group counts once');
});

test('summary: many exact members keep the pre-browse "N קטגוריות" form; [] stays "הכל"', () => {
  assert.equal(browseSummary(['הצגה', 'פארק', 'טבע', 'מדע']), '4 קטגוריות');
  assert.equal(browseSummary([]), 'הכל');
  assert.equal(browseSummary(undefined), 'הכל');
});

test('summary is wired into categorySummary / active chips / results phrase', () => {
  const f = { ...DEFAULT_FILTERS, category: membersOf('animals') };
  assert.equal(categorySummary(f.category), 'חיות, חוות וגני חיות');
  assert.equal(buildActiveChips(f).find((c) => c.key === 'category').text, 'חיות, חוות וגני חיות');
  assert.match(buildResultsSummary(f), /חיות, חוות וגני חיות/);
});

// ================================================================================================
// 9-10. Empty-array semantics: [] = ALL; a full browse selection is NOT collapsed into [].
// ================================================================================================

test('[] means no category restriction (all rows, including internal-category rows)', () => {
  const rows = CANONICAL.map((c, i) => ({ id: `r${i}`, title: `row ${i}`, category: c }));
  assert.equal(applyFilters(rows, { ...DEFAULT_FILTERS, category: [] }, null, [], [], [], []).length, rows.length);
});

test('selecting all 11 groups is NOT [] - it excludes internal rows and summarises as groups', () => {
  let sel = [];
  for (const g of BROWSE_GROUP_OPTIONS) sel = toggleGroupSelection(g.id, sel);
  assert.notDeepEqual(sel, []);
  assert.equal(sel.length, ALL_MEMBERS.length);
  assert.deepEqual(sorted(sel), sorted(ALL_MEMBERS));
  const rows = CANONICAL.map((c, i) => ({ id: `r${i}`, title: `row ${i}`, category: c }));
  const kept = applyFilters(rows, { ...DEFAULT_FILTERS, category: sel }, null, [], [], [], []).map((a) => a.category);
  for (const internal of browseData.internal) assert.ok(!kept.includes(internal), `${internal} must not match`);
  // 9 multi-member groups + the two single-member values (cinema, nature) -> rule F "first +N"
  assert.equal(browseSummary(sel), 'גני שעשועים ופארקים +10');
  assert.notEqual(browseSummary(sel), browseSummary([]));
  const src = fs.readFileSync(path.join(ROOT, 'components/QuickPicker.js'), 'utf8');
  assert.match(src, /const isAllSelected = value\.length === 0;/, '"הכל" is still exactly the empty array');
});

// ================================================================================================
// 11. Manual browse interaction resets Smart Search soft-recall alias phrases.
// ================================================================================================

test('alias reset: a group tap after a Smart Search drops the stale categoryAliasPhrases', () => {
  const intent = {
    category: null,
    location: { city: null, region: null, street: null, relation: null, coords: null, geocodeFailed: false },
    when: { option: null, date: null }, timeRange: null, age: null, childNameMentioned: null,
    priceHint: null, durationHint: null, placeTypeHint: null, amenityHints: [], benefitsHint: null,
    residualQuery: null, vagueIntent: [], rawQuery: 'לונה פארק',
  };
  const searched = intentToFilters(intent, { children: [] });
  assert.deepEqual(searched.category, ['פארק שעשועים'], 'search still resolves to ONE canonical value');
  assert.ok(searched.categoryAliasPhrases.length > 0, 'fixture really carries alias phrases');

  const tapped = withManualCategorySelection(searched, toggleGroupSelection('playgrounds_parks', searched.category));
  assert.deepEqual(tapped.categoryAliasPhrases, []);
  assert.deepEqual(tapped.category, ['פארק שעשועים', 'גן שעשועים', 'פארק']);

  // what the reset prevents: a row matching ONLY through the stale alias text
  const aliasOnly = { id: 'a', title: 'לונה פארק בעיר', category: 'אחר' };
  const leaked = applyFilters([aliasOnly], { ...tapped, categoryAliasPhrases: searched.categoryAliasPhrases }, null, [], [], [], []);
  assert.equal(leaked.length, 1, 'with a stale alias the union over-recalls');
  assert.equal(applyFilters([aliasOnly], tapped, null, [], [], [], []).length, 0);
});

test('alias reset is wired at every manual category entry point (Home, Activities, Profile, FiltersSheet)', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const f of ['app/index.js', 'app/activities.js']) {
    assert.match(read(f), /onChange=\{\(v\) => setFilters\(\(prev\) => withManualCategorySelection\(prev, v\)\)\}/, f);
  }
  assert.match(read('app/profile.js'), /setHomeDefaultsDraft\(\(prev\) => withManualCategorySelection\(prev, v\)\)/);
  assert.match(read('app/index.js'), /withManualCategorySelection\(DEFAULT_FILTERS, categories\)/, 'tile / all-categories navigation');
  assert.match(read('components/FiltersSheet.js'), /onChange\('categoryAliasPhrases', \[\]\)/);
});

// ================================================================================================
// 12, 17. Backward compatibility + excludeCategory stays canonical and flat.
// ================================================================================================

test('old canonical saved filters load unchanged (shape, values) and summarise sensibly', () => {
  const saved = normalizeFilters({ category: ['הצגה'] });
  assert.deepEqual(saved.category, ['הצגה']);
  assert.deepEqual(Object.keys(saved).sort(), Object.keys(DEFAULT_FILTERS).sort(), 'no new filter keys');
  assert.equal(categorySummary(saved.category), 'הצגה');
  const legacy = normalizeFilters({ category: ['אחר', 'חוג', 'גן שעשועים', 'פארק'] });
  assert.deepEqual(legacy.category, ['אחר', 'חוג', 'גן שעשועים', 'פארק'], 'stale values are kept, not migrated');
  assert.equal(categorySummary(legacy.category), 'גני שעשועים ופארקים');
  const viaUrl = normalizeFilters(JSON.parse(JSON.stringify({ ...DEFAULT_FILTERS, category: membersOf('shows') })));
  assert.deepEqual(viaUrl.category, ['הצגה', 'מוזיקה', 'ריקוד'], 'homeFilters JSON round-trip carries the union');
});

test('excludeCategory stays canonical: hiding one value never hides its group siblings', () => {
  const rows = [
    { id: 'show', title: 's', category: 'הצגה' },
    { id: 'music', title: 'm', category: 'מוזיקה' },
  ];
  const kept = applyFilters(rows, { ...DEFAULT_FILTERS, excludeCategory: ['הצגה'] }, null, [], [], [], []);
  assert.deepEqual(kept.map((a) => a.id), ['music']);
  const src = fs.readFileSync(path.join(ROOT, 'app/activities.js'), 'utf8');
  const hidePicker = src.slice(src.indexOf('visible={hideCategoriesModalOpen}'), src.indexOf('onClose={handleConfirmHide}'));
  assert.ok(hidePicker.includes('options={CATEGORY_FILTER_OPTIONS}'), 'hide picker keeps the flat canonical options');
  assert.ok(!hidePicker.includes('groups='), 'hide picker has no browse groups');
});

// ================================================================================================
// 13-16. Search, cards and placeholders stay canonical.
// ================================================================================================

test('search layer never consults browse groups (Smart Search, semantics, matching, server)', () => {
  const files = [
    'lib/smartSearch.js', 'lib/categorySemantics.js', 'lib/searchIntent.js', 'lib/filterActivities.js',
    'lib/placeholderImages.js', 'lib/activities.js', 'components/ActivityCard.js', 'app/activity/[id].js',
    'app/add-activity.js',
  ];
  for (const f of files) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /browseGroups/, `${f} must stay canonical`);
  }
  const sharedDir = path.join(ROOT, 'supabase/functions/_shared');
  if (fs.existsSync(sharedDir)) assert.ok(!fs.readdirSync(sharedDir).some((n) => /browse/i.test(n)), 'no Deno mirror');
});

test('card badge / detail label is the canonical label, never the group label', () => {
  for (const value of ALL_MEMBERS) {
    const group = groupOf(value);
    if (membersOf(group).length > 1 && group !== 'festivals_events') {
      assert.notEqual(categoryLabel(value), browseGroupLabel(group), `${value} would show a group label`);
    }
  }
  assert.equal(categoryLabel('גן שעשועים'), 'גן שעשועים');
  assert.notEqual(categoryLabel('גן שעשועים'), 'גני שעשועים ופארקים');
  const card = fs.readFileSync(path.join(ROOT, 'components/ActivityCard.js'), 'utf8');
  assert.match(card, /\{categoryLabel\(type\)\}/, 'ActivityCard badge still renders categoryLabel(activity category)');
});

test('placeholders: גן שעשועים stays on swings, פארק שעשועים on rides, regardless of browse selection', () => {
  const PLAY = PLACEHOLDER_IMAGES.PLAY_AND_FUN;
  const swings = new Set([PLAY[0], PLAY[1]]);
  const selected = toggleGroupSelection('water_attractions', toggleGroupSelection('playgrounds_parks', []));
  assert.ok(selected.includes('גן שעשועים') && selected.includes('פארק שעשועים'));
  for (let i = 0; i < 20; i += 1) {
    assert.ok(swings.has(placeholderImageFor('PLAY_AND_FUN', `s${i}`, 'גן שעשועים')));
    assert.equal(placeholderImageFor('PLAY_AND_FUN', `s${i}`, 'פארק שעשועים'), PLAY[2]);
  }
});

// ================================================================================================
// 18. i18n parity for everything this feature added.
// ================================================================================================

test('i18n: browse labels, summary.groups plural and picker a11y strings exist in he and en', () => {
  for (const res of Object.values(RESOURCES)) {
    assert.ok(res.domain.summary.groups_one && res.domain.summary.groups_other);
    for (const k of ['expand', 'collapse', 'partial']) assert.ok(res.filters.browse[k], `filters.browse.${k}`);
  }
  assert.equal(RESOURCES.he.domain.browseGroups.playgrounds_parks, 'גני שעשועים ופארקים');
  assert.equal(RESOURCES.he.domain.browseGroups.water_attractions, 'מים, אטרקציות ואקסטרים');
  assert.ok(CATEGORY_OPTIONS.length > 0);
});
