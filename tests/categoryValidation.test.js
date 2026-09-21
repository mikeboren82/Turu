// TuRu - Phase E: category allow-list enforcement + the taxonomy canaries (2026-09-21).
//
// The hole these close: the Phase D catalogue audit found two non-canonical values in production
// ('גן חיות', 'חדשנות בחקלאות'). CATEGORY_VALUES was handed to the model in the extraction prompt,
// but the model's ANSWER was never validated on the import-tool path, and there is no DB
// constraint behind it either. Anything the model invented went straight into activities.category.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const { sanitizeCategory } = require('../tools/import-tool/lib/categoryValidation.js');
const categoryValues = require('../constants/categoryValues.json');
const semantics = require('../constants/categorySemantics.json');

// --- allow-list behaviour ---------------------------------------------------------------------
test('canonical categories pass through untouched', () => {
  for (const c of ['גן שעשועים', 'פארק', 'פארק שעשועים', 'חיות וגני חיות', 'פינת חי', 'חווה', 'אחר']) {
    const v = sanitizeCategory(c);
    assert.equal(v.category, c, c);
    assert.equal(v.rejected, false);
  }
});

test('REGRESSION: "חדשנות בחקלאות" - an invented value found in production - cannot enter the catalogue', () => {
  const v = sanitizeCategory('חדשנות בחקלאות');
  assert.equal(v.category, null, 'must not reach activities.category');
  assert.equal(v.rejected, true);
  assert.match(v.reason, /non_canonical_category/);
});

test('REGRESSION: "גן חיות" - the other production value - normalizes to the new canonical animal category', () => {
  // Unlike חדשנות בחקלאות this one HAS a deterministic destination: it is a declared alias of
  // ANIMALS_ZOO, so normalizing it is evidence-bound, not a guess.
  const v = sanitizeCategory('גן חיות');
  assert.equal(v.category, 'חיות וגני חיות');
  assert.equal(v.rejected, false);
  assert.equal(v.normalizedFrom, 'גן חיות');
  assert.equal(v.reason, 'normalized_from_alias');
});

test('other declared aliases normalize deterministically', () => {
  assert.equal(sanitizeCategory('ספארי').category, 'חיות וגני חיות');
  assert.equal(sanitizeCategory('אקווריום').category, 'חיות וגני חיות');
  assert.equal(sanitizeCategory('לונה פארק').category, 'פארק שעשועים', 'legacy DB value, not the display label');
  assert.equal(sanitizeCategory('מתחם אטרקציות').category, 'פארק שעשועים', 'display label maps to the stored value');
});

test('unrecognised values are REJECTED, never silently dumped into "אחר"', () => {
  // 'אחר' is a legitimate category a model may deliberately choose, so using it as a catch-all
  // would hide exactly the corruption this guard exists to surface.
  for (const junk of ['משהו אחר לגמרי', 'Amusement Park', 'פארק שעשועים ענק', '']) {
    const v = sanitizeCategory(junk);
    if (junk === '') { assert.equal(v.rejected, false); assert.equal(v.category, null); continue; }
    assert.notEqual(v.category, 'אחר', `"${junk}" must not become אחר`);
    assert.equal(v.category, null);
    assert.equal(v.rejected, true);
  }
});

test('null / undefined are a legitimate "no category", not a rejection', () => {
  for (const empty of [null, undefined]) {
    const v = sanitizeCategory(empty);
    assert.equal(v.category, null);
    assert.equal(v.rejected, false, 'absence is not corruption');
  }
});

test('non-string input is rejected rather than coerced', () => {
  assert.equal(sanitizeCategory({ category: 'פארק' }).rejected, true);
  assert.equal(sanitizeCategory(42).rejected, true);
});

// --- the Deno twin must not drift -------------------------------------------------------------
test('MIRROR: the Deno sanitizeCategory twin implements the same contract', () => {
  const deno = fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/extraction.ts'), 'utf8');
  assert.match(deno, /export function sanitizeCategory/, 'Deno side must expose sanitizeCategory');
  assert.match(deno, /normalized_from_alias/, 'same alias-normalization reason code');
  assert.match(deno, /non_canonical_category/, 'same rejection reason code');
  assert.doesNotMatch(deno, /return \{ category: 'אחר'/, 'must never fall back to אחר');
});

test('MIRROR: categoryValues.json Deno copy stays byte-identical', () => {
  const a = fs.readFileSync(path.join(ROOT, 'constants/categoryValues.json'), 'utf8');
  const b = fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/categoryValues.json'), 'utf8');
  assert.equal(b, a);
});

// --- taxonomy canaries (section 16) ------------------------------------------------------------
// Deterministic fixtures, not live catalogue rows, so a future data fix cannot destabilise them.
const { classify } = require('../tools/import-tool/audit-category-taxonomy.js');

const FIXTURES = {
  parkSarona: { name: 'פארק שרונה, כפר יונה', description: 'פארק שכונתי מרכזי בשטח של כ-21 דונם, עם ציוד משחקים לילדים בכל הגילאים, מדשאה גדולה, במה ובריכת נוי.' },
  ordinaryPlayground: { name: 'גן שעשועים - רחוב הדקל', description: 'מתקני משחקים, מגלשה ונדנדות בשכונה.' },
  bigParkWithPlayground: { name: 'פארק נחל חדרה', description: 'פארק ירוק המשתרע בין שתי גדות הנחל עם מדשאות, מתקני משחקים לילדים, גשרים ומסלול הליכה.' },
  lunaPark: { name: 'לונה פארק תל אביב', description: 'פארק שעשועים המציע שפע של מתקנים לקטנים ולגדולים.' },
  midbarium: { name: 'מדבריום - פארק החיות', description: 'פארק חיות המאפשר מפגש חוויתי בין המבקר לבעלי החיים, חוויות טיול מדברית.' },
  jerusalemZoo: { name: 'גן החיות ואקווריום ישראל', description: 'גן חיות המציג מגוון רחב של בעלי חיים וכולל אקווריום.' },
  pettingCorner: { name: 'פינת חי בפארק רעננה', description: 'פינת חי קטנה עם עזים וארנבים לליטוף.' },
  farm: { name: 'חוות הנדיב', description: 'חווה חקלאית עם קטיף, חליבה וסיור בשדה.' },
};

test('CANARY: פארק שרונה -> PARK (a park containing play equipment is still a park)', () => {
  assert.equal(classify(FIXTURES.parkSarona).proposed, 'פארק');
});

test('CANARY: an ordinary playground -> PLAYGROUND', () => {
  assert.equal(classify(FIXTURES.ordinaryPlayground).proposed, 'גן שעשועים');
});

test('CANARY: a large park containing playground equipment -> PARK unless primary experience proves otherwise', () => {
  assert.equal(classify(FIXTURES.bigParkWithPlayground).proposed, 'פארק');
});

test('CANARY: לונה פארק תל אביב -> ATTRACTION_COMPLEX (legacy DB value)', () => {
  const c = classify(FIXTURES.lunaPark);
  assert.equal(c.proposed, 'מתחם אטרקציות');
  assert.equal(semantics.concepts.ATTRACTION_COMPLEX.dbValue, 'פארק שעשועים', 'stored value stays legacy');
});

test('CANARY: מדבריום -> ANIMALS_ZOO, never an attraction complex', () => {
  const c = classify(FIXTURES.midbarium);
  assert.equal(c.proposed, 'חיות וגני חיות');
  assert.notEqual(c.proposed, 'מתחם אטרקציות');
});

test('CANARY: גן החיות ואקווריום ירושלים -> ANIMALS_ZOO', () => {
  assert.equal(classify(FIXTURES.jerusalemZoo).proposed, 'חיות וגני חיות');
});

test('CANARY: פינת חי stays פינת חי - not absorbed into חיות וגני חיות', () => {
  // The three animal concepts each list the others under negativeSignals/notEvidence precisely so
  // that none can swallow another.
  assert.equal(semantics.concepts.PETTING_CORNER.dbValue, 'פינת חי');
  assert.ok(semantics.concepts.ANIMALS_ZOO.notEvidence.includes('פינת חי'), 'a petting corner is not zoo evidence');
  assert.ok(categoryValues.categories.includes('פינת חי'), 'still its own canonical category');
});

test('CANARY: חווה stays חווה - not absorbed into חיות וגני חיות', () => {
  assert.equal(semantics.concepts.FARM.dbValue, 'חווה');
  assert.ok(semantics.concepts.ANIMALS_ZOO.notEvidence.includes('חווה'), 'a farm is not zoo evidence');
  assert.ok(categoryValues.categories.includes('חווה'));
  assert.equal(classify(FIXTURES.farm).proposed !== 'חיות וגני חיות', true, 'farm evidence must not read as a zoo');
});

test('the bare words חיות / בעלי חיים are not evidence for any animal concept', () => {
  for (const key of ['ANIMALS_ZOO', 'PETTING_CORNER', 'FARM']) {
    const c = semantics.concepts[key];
    assert.ok(c.notEvidence.includes('חיות') || c.notEvidence.includes('בעלי חיים'),
      `${key} must treat the bare animal words as non-evidence`);
  }
});

test('the three animal concepts and אטרקציה/בעלי חיים remain separate canonical values', () => {
  for (const v of ['חיות וגני חיות', 'פינת חי', 'חווה', 'בעלי חיים', 'אטרקציה']) {
    assert.ok(categoryValues.categories.includes(v), `${v} must still exist`);
  }
  // אטרקציה is transitional and must NOT be an alias of the attraction complex: the Phase D audit
  // found only 2 of its 35 rows are ride-based (the dominant meaning is adventure/extreme).
  assert.equal(sanitizeCategory('אטרקציה').category, 'אטרקציה', 'stays itself, not remapped');
  assert.ok(!semantics.concepts.ATTRACTION_COMPLEX.aliases.includes('אטרקציה'),
    'אטרקציה must not be an alias of מתחם אטרקציות');
});
