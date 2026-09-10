// בדיקות ל-playgroundNaming.js - node test-playground-naming.js (בלי framework, assert טהור).
const assert = require('assert');
const { isGenericPlaygroundName, extractStreetOnly, generatePlaygroundDisplayName } = require('./playgroundNaming');

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
});

run('short real official name kept as-is (not treated as generic)', () => {
  const r = generatePlaygroundDisplayName({ officialName: 'גן הפעמון', address: null, city: 'תל אביב' });
  assert.strictEqual(r.name, 'גן הפעמון');
  assert.strictEqual(r.tier, 'official');
});

run('no official name + street + city -> street-based name', () => {
  const r = generatePlaygroundDisplayName({ officialName: null, address: 'תל חי 12, ירושלים', city: 'ירושלים' });
  assert.strictEqual(r.name, 'גן שעשועים ברחוב תל חי, ירושלים');
  assert.strictEqual(r.tier, 'street');
});

run('street without house number still works', () => {
  const r = generatePlaygroundDisplayName({ officialName: null, address: 'הרצל, רעננה', city: 'רעננה' });
  assert.strictEqual(r.name, 'גן שעשועים ברחוב הרצל, רעננה');
});

run('generic "גן שעשועים - X" existing name treated as generic, replaced by street', () => {
  const r = generatePlaygroundDisplayName({ officialName: 'גן שעשועים - תל חי', address: 'תל חי 12, ירושלים', city: 'ירושלים' });
  assert.strictEqual(r.name, 'גן שעשועים ברחוב תל חי, ירושלים');
  assert.strictEqual(r.tier, 'street');
});

run('generic region-dash name treated as generic', () => {
  assert.strictEqual(isGenericPlaygroundName('גן שעשועים ציבורי - ירושלים והסביבה'), true);
});

run('bare "גן שעשועים" treated as generic', () => {
  assert.strictEqual(isGenericPlaygroundName('גן שעשועים'), true);
});

run('no street but city -> city-based name', () => {
  const r = generatePlaygroundDisplayName({ officialName: null, address: null, city: 'כפר סבא' });
  assert.strictEqual(r.name, 'גן שעשועים בכפר סבא');
  assert.strictEqual(r.tier, 'city');
});

run('no street, no city -> no invented name (tier no_data)', () => {
  const r = generatePlaygroundDisplayName({ officialName: null, address: null, city: null });
  assert.strictEqual(r.name, null);
  assert.strictEqual(r.tier, 'no_data');
});

run('existing generic name with no recoverable location -> no_data, not left as garbage', () => {
  const r = generatePlaygroundDisplayName({ officialName: 'גן שעשועים ציבורי - הצפון והעמק', address: null, city: null });
  assert.strictEqual(r.name, null);
  assert.strictEqual(r.tier, 'no_data');
});

run('extractStreetOnly strips house number and city', () => {
  assert.strictEqual(extractStreetOnly('ויצמן 7, כפר סבא'), 'ויצמן');
  assert.strictEqual(extractStreetOnly('ויצמן, כפר סבא'), 'ויצמן');
  assert.strictEqual(extractStreetOnly(null), null);
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
