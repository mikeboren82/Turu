// בדיקות ל-playgroundNaming.js - node test-playground-naming.js (בלי framework, assert טהור).
const assert = require('assert');
const { isGenericPlaygroundName, parseStreetAddress, generatePlaygroundDisplayName } = require('./playgroundNaming');

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    process.exitCode = 1;
  }
}

run('official name kept as-is', () => {
  const r = generatePlaygroundDisplayName({ officialName: 'גן השעשועים ע"ש יצחק רבין', address: 'תל חי 5, ירושלים', city: 'ירושלים' });
  assert.strictEqual(r.name, 'גן השעשועים ע"ש יצחק רבין');
  assert.strictEqual(r.tier, 'official');
  assert.strictEqual(r.nameSource, 'official');
});

run('short real official name kept as-is (not treated as generic)', () => {
  const r = generatePlaygroundDisplayName({ officialName: 'גן הפעמון', address: null, city: 'תל אביב' });
  assert.strictEqual(r.name, 'גן הפעמון');
  assert.strictEqual(r.tier, 'official');
});

run('no official name + street + house number + city -> street-based name with number', () => {
  const r = generatePlaygroundDisplayName({ officialName: null, address: 'תל חי 12, ירושלים', city: 'ירושלים' });
  assert.strictEqual(r.name, 'גן שעשועים – תל חי 12, ירושלים');
  assert.strictEqual(r.tier, 'street');
  assert.strictEqual(r.nameSource, 'generated_from_address');
});

run('street without house number still works', () => {
  const r = generatePlaygroundDisplayName({ officialName: null, address: 'הרצל, רעננה', city: 'רעננה' });
  assert.strictEqual(r.name, 'גן שעשועים – הרצל, רעננה');
});

run('house number with trailing Hebrew letter (e.g. 12א) kept intact', () => {
  const r = generatePlaygroundDisplayName({ officialName: null, address: 'ויצמן 12א, כפר סבא', city: 'כפר סבא' });
  assert.strictEqual(r.name, 'גן שעשועים – ויצמן 12א, כפר סבא');
});

run('generic "גן שעשועים - X" existing name treated as generic, replaced by street', () => {
  const r = generatePlaygroundDisplayName({ officialName: 'גן שעשועים - תל חי', address: 'תל חי 12, ירושלים', city: 'ירושלים' });
  assert.strictEqual(r.name, 'גן שעשועים – תל חי 12, ירושלים');
  assert.strictEqual(r.tier, 'street');
});

run('previously-generated en-dash street name is idempotent (not re-flagged as generic)', () => {
  const r = generatePlaygroundDisplayName({ officialName: 'גן שעשועים – תל חי 12, ירושלים', address: 'תל חי 12, ירושלים', city: 'ירושלים' });
  assert.strictEqual(r.name, 'גן שעשועים – תל חי 12, ירושלים');
  assert.strictEqual(r.tier, 'official'); // לא תואם אף דפוס-גנרי -> נשאר יציב, לא נוצר מחדש בכל הרצה
});

run('generic region-dash name treated as generic', () => {
  assert.strictEqual(isGenericPlaygroundName('גן שעשועים ציבורי - ירושלים והסביבה'), true);
});

run('bare "גן שעשועים" treated as generic', () => {
  assert.strictEqual(isGenericPlaygroundName('גן שעשועים'), true);
});

run('technical/garbage values treated as generic (null/undefined/URL/UUID)', () => {
  assert.strictEqual(isGenericPlaygroundName('null'), true);
  assert.strictEqual(isGenericPlaygroundName('undefined'), true);
  assert.strictEqual(isGenericPlaygroundName('https://example.com/playground'), true);
  assert.strictEqual(isGenericPlaygroundName('550e8400-e29b-41d4-a716-446655440000'), true);
  assert.strictEqual(isGenericPlaygroundName('   '), true);
  assert.strictEqual(isGenericPlaygroundName(null), true);
});

run('no street but city -> city-based name', () => {
  const r = generatePlaygroundDisplayName({ officialName: null, address: null, city: 'כפר סבא' });
  assert.strictEqual(r.name, 'גן שעשועים – כפר סבא');
  assert.strictEqual(r.tier, 'city');
});

run('no street, no city -> no invented name (tier no_data, nameSource null)', () => {
  const r = generatePlaygroundDisplayName({ officialName: null, address: null, city: null });
  assert.strictEqual(r.name, null);
  assert.strictEqual(r.tier, 'no_data');
  assert.strictEqual(r.nameSource, null);
});

run('existing generic name with no recoverable location -> no_data, not left as garbage', () => {
  const r = generatePlaygroundDisplayName({ officialName: 'גן שעשועים ציבורי - הצפון והעמק', address: null, city: null });
  assert.strictEqual(r.name, null);
  assert.strictEqual(r.tier, 'no_data');
});

run('parseStreetAddress splits street and house number, strips city', () => {
  assert.deepStrictEqual(parseStreetAddress('ויצמן 7, כפר סבא'), { street: 'ויצמן', houseNumber: '7' });
  assert.deepStrictEqual(parseStreetAddress('ויצמן, כפר סבא'), { street: 'ויצמן', houseNumber: null });
  assert.deepStrictEqual(parseStreetAddress(null), { street: null, houseNumber: null });
});

run('English "Playground" treated as generic', () => {
  assert.strictEqual(isGenericPlaygroundName('Playground'), true);
  assert.strictEqual(isGenericPlaygroundName('playground'), true);
});

run('idempotency: running twice on an already-good street-based name keeps it identical', () => {
  const first = generatePlaygroundDisplayName({ officialName: null, address: 'תל חי 12, ירושלים', city: 'ירושלים' });
  const second = generatePlaygroundDisplayName({ officialName: first.name, address: 'תל חי 12, ירושלים', city: 'ירושלים' });
  assert.strictEqual(second.name, first.name);
  assert.strictEqual(second.tier, 'official'); // already looks official-ish (not matching generic patterns) -> stable
});

console.log('\nDone.');
