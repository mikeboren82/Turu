// TuRu - the category STORAGE model and its drift guards (Phase G, 2026-09-21).
//
// The hole these close: 'קייטנה' was an intentional TuRu value - half of the commitment/restore
// gate, with display labels in both locales and two archived production rows holding it - that had
// never been added to categoryValues.categories. Every layer therefore disagreed about it. The
// sanitizer rejected it, the 0103 CHECK would have rejected the two rows, and "fixing" the data
// would have silently stripped those rows of their protection from being restored to approved.
//
// The resolution is that "what may be ASSIGNED" and "what may legally EXIST" are different
// questions, so constants/categoryValues.json now states both. These tests hold that line, and -
// because SQL cannot import JSON - they parse the CHECK constraint out of the migration file and
// fail if it drifts from the source of truth.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const categoryValues = require('../constants/categoryValues.json');
const semantics = require('../constants/categorySemantics.json');
const { sanitizeCategory } = require('../tools/import-tool/lib/categoryValidation.js');

const ASSIGNABLE = categoryValues.categories;
const STORAGE_ONLY = categoryValues.storageOnlyCategories;
const ARCHIVE = categoryValues.archiveCategories;
const VALID_STORAGE = [...ASSIGNABLE, ...STORAGE_ONLY];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MIGRATION = 'supabase/0103_activities_category_canonical_check.sql';

// Pull the allow-list straight out of the CHECK constraint. '' is SQL's escaped single quote
// (ג''ימבורי), so it must be unescaped rather than treated as a string boundary.
function categoriesInMigration() {
  const sql = read(MIGRATION);
  const start = sql.indexOf('check (category is null or category in (');
  assert.notEqual(start, -1, 'could not find the CHECK constraint in ' + MIGRATION);
  const body = sql.slice(start, sql.indexOf('));', start));
  return [...body.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
}

// --- the three sets are well-formed -----------------------------------------------------------
test('the three category sets are disjoint/nested exactly as documented', () => {
  assert.equal(new Set(ASSIGNABLE).size, ASSIGNABLE.length, 'categories has duplicates');
  assert.equal(new Set(STORAGE_ONLY).size, STORAGE_ONLY.length, 'storageOnlyCategories has duplicates');

  for (const c of STORAGE_ONLY) {
    assert.ok(!ASSIGNABLE.includes(c), `${c} is storage-only, so it must NOT be in categories (that would make it assignable)`);
    assert.ok(ARCHIVE.includes(c), `${c} is neither assignable nor user-facing, so it must at least be a declared archive category - otherwise it is an orphan value nothing recognises`);
  }
  for (const c of ARCHIVE) {
    assert.ok(VALID_STORAGE.includes(c), `${c} triggers the commitment gate but is not a valid stored value`);
  }
});

test('valid storage is exactly categories + storageOnlyCategories', () => {
  assert.equal(VALID_STORAGE.length, 32);
  assert.equal(new Set(VALID_STORAGE).size, 32, 'no value may appear in both sets');
});

// --- the 0103 constraint may not drift from the source of truth --------------------------------
test('DRIFT GUARD: the 0103 CHECK allow-list equals the valid-storage set', () => {
  const inSql = categoriesInMigration();
  assert.deepEqual([...inSql].sort(), [...VALID_STORAGE].sort(),
    'supabase/0103_activities_category_canonical_check.sql has drifted from constants/categoryValues.json');
  assert.equal(new Set(inSql).size, inSql.length, 'the SQL list repeats a value');
});

test('0103 still admits the legacy and transitional values that production rows hold', () => {
  const inSql = categoriesInMigration();
  // 'פארק שעשועים' is still the STORED value of ATTRACTION_COMPLEX (displayed "מתחם אטרקציות").
  assert.ok(inSql.includes('פארק שעשועים'), 'renaming the persisted value is a separate migration');
  assert.equal(semantics.concepts.ATTRACTION_COMPLEX.dbValue, 'פארק שעשועים');
  // Transitional: rows still hold these, so the constraint must not reject them at write time.
  for (const v of ['בעלי חיים', 'אטרקציה', 'חוג']) {
    assert.ok(inSql.includes(v), `${v} is transitional/assignable and must stay allowed`);
  }
});

test('0103 is APPLIED in production - the file header must say so', () => {
  assert.match(read(MIGRATION), /STATUS: APPLIED in production 2026-09-21/, 'the constraint went live 2026-09-21 (taxonomy write pilot)');
});

// --- קייטנה: valid to store, never assigned, never shown ---------------------------------------
test('קייטנה is a VALID STORED category', () => {
  assert.ok(VALID_STORAGE.includes('קייטנה'));
  assert.ok(categoriesInMigration().includes('קייטנה'), 'the DB constraint must accept the two archived camp rows');
});

test('REGRESSION: קייטנה is NOT assignable - adding it must not tell classifiers to generate camps', () => {
  assert.ok(!ASSIGNABLE.includes('קייטנה'),
    'categories is the list handed to the extraction model; קייטנה must stay out of it');
  const v = sanitizeCategory('קייטנה');
  assert.equal(v.category, null, 'ingestion must not be able to write it');
  assert.equal(v.rejected, true);
  // The model is offered `categories`, so a storage-only value can never be proposed in the first place.
  assert.match(read('supabase/functions/_shared/extraction.ts'),
    /export const CATEGORY_VALUES: string\[\] = categoryValues\.categories;/,
    'the extraction prompt must keep offering `categories`, never the valid-storage union');
  assert.match(read('tools/import-tool/server.js'), /categoryValues\.categories/,
    'the Node extraction twin must offer the same set');
});

test('REGRESSION: קייטנה is not user-facing', () => {
  // CATEGORY_OPTIONS = categories - archiveCategories, so a storage-only value can never surface.
  assert.ok(!ASSIGNABLE.includes('קייטנה'));
  assert.match(read('constants/filterSchema.js'),
    /categoryValues\.categories[\s\S]{0,200}?archiveCategories\.includes/,
    'CATEGORY_OPTIONS must keep deriving from categories minus archiveCategories');
});

test('REGRESSION: archived קייטנה rows stay protected from restore', () => {
  // The gate is `ARCHIVE_CATEGORIES.has(activity.category)`. Both copies must derive from the
  // shared set - and both camp values must remain in it - or archived camps become restorable.
  for (const v of ['חוג', 'קייטנה']) assert.ok(ARCHIVE.includes(v), `${v} must stay a commitment category`);

  const server = read('tools/import-tool/server.js');
  assert.match(server, /const ARCHIVE_CATEGORIES = new Set\(categoryValues\.archiveCategories\)/);
  assert.match(server, /ARCHIVE_ENTITY_TYPES\.has\(activity\.entity_type\) \|\| ARCHIVE_CATEGORIES\.has\(activity\.category\)/);

  const submit = read('lib/submitActivity.js');
  assert.match(submit, /const ARCHIVE_CATEGORIES = new Set\(categoryValues\.archiveCategories\)/,
    'lib/submitActivity.js must not go back to a hand-typed copy of the set');
  assert.doesNotMatch(submit, /new Set\(\['חוג'/, 'the hardcoded duplicate must stay gone');
  assert.match(submit, /ARCHIVE_ENTITY_TYPES\.has\(activity\.entity_type\) \|\| ARCHIVE_CATEGORIES\.has\(activity\.category\)/);
});

test('archive-only semantics have not leaked into the alias layer', () => {
  // An alias would let a model reach a commitment category by the back door, or let a search
  // phrase resolve onto one. Neither camp value may be a concept dbValue or a declared alias.
  for (const concept of Object.values(semantics.concepts)) {
    for (const v of ['קייטנה', 'חוג']) {
      assert.notEqual(concept.dbValue, v);
      assert.ok(!(concept.aliases || []).includes(v), `${v} must not be an alias of ${concept.dbValue}`);
      assert.ok(!(concept.recallAliases || []).includes(v), `${v} must not be a recall alias of ${concept.dbValue}`);
    }
  }
  assert.equal(sanitizeCategory('קייטנה').category, null, 'not reachable through alias normalization either');
});

// --- invented values stay rejected, declared aliases still normalize ---------------------------
test('REGRESSION: every non-canonical value found in production stays rejected by ingestion', () => {
  // These are the actual strings the AI extraction path wrote before Phase E closed the hole.
  for (const invented of ['חדשנות בחקלאות', 'לייזר טאג', 'הפעלה', 'ציור']) {
    const v = sanitizeCategory(invented);
    assert.equal(v.category, null, `${invented} must not reach activities.category`);
    assert.equal(v.rejected, true);
    assert.match(v.reason, /non_canonical_category/);
    assert.ok(!VALID_STORAGE.includes(invented), `${invented} must not have been quietly admitted to the storage set`);
  }
});

test('REGRESSION: גן חיות still normalizes to חיות וגני חיות', () => {
  const v = sanitizeCategory('גן חיות');
  assert.equal(v.category, 'חיות וגני חיות');
  assert.equal(v.rejected, false);
  assert.equal(v.reason, 'normalized_from_alias');
});

test('REGRESSION: מתחם אטרקציות still STORES as the legacy פארק שעשועים', () => {
  const v = sanitizeCategory('מתחם אטרקציות');
  assert.equal(v.category, 'פארק שעשועים', 'the display label must map to the stored value, not replace it');
  assert.equal(v.rejected, false);
});

// --- every layer agrees about the storage set --------------------------------------------------
test('MIRROR: the Deno copy of categoryValues.json carries the new set too', () => {
  assert.equal(read('supabase/functions/_shared/categoryValues.json'), read('constants/categoryValues.json'),
    'run: cp constants/categoryValues.json supabase/functions/_shared/categoryValues.json');
  const mirror = JSON.parse(read('supabase/functions/_shared/categoryValues.json'));
  assert.deepEqual(mirror.storageOnlyCategories, STORAGE_ONLY);
});

test('every valid stored category has a display label in both locales', () => {
  // A stored value with no label renders as the raw string, which is how a storage-only value
  // would become visibly wrong the moment an archived row is shown anywhere.
  for (const locale of ['he', 'en']) {
    const labels = JSON.parse(read(`lib/i18n/locales/${locale}/domain.json`)).categories;
    for (const c of VALID_STORAGE) assert.ok(labels[c], `${locale} is missing a label for ${c}`);
    assert.deepEqual(Object.keys(labels).sort(), [...VALID_STORAGE].sort(),
      `${locale}/domain.json categories must match the valid-storage set exactly`);
  }
});

test('the storage model is documented in the source of truth, not only here', () => {
  const doc = (categoryValues._doc || []).join('\n');
  for (const key of ['categories', 'storageOnlyCategories', 'archiveCategories']) {
    assert.match(doc, new RegExp(key), `_doc must explain ${key}`);
  }
});
