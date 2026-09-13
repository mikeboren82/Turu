// Run: node --test tests/   (from tools/import-tool). Pins the Node mirror to the same cases as
// supabase/functions/_shared/venues.test.ts / extraction.test.ts so the two runtimes can't drift.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeVenueAlias, repairHebrewGershayim, repairUnescapedQuotes, repairModelJson } = require('../venueNaming');

test('repairUnescapedQuotes / repairModelJson mirror the Deno repair', () => {
  const broken = '[{"name": "סדנה", "description": "הסדנה "מדע לילדים" מתאימה", "city": "חיפה"}]';
  assert.equal(JSON.parse(repairUnescapedQuotes(broken))[0].description, 'הסדנה "מדע לילדים" מתאימה');
  const valid = '[{"a":"ב, ג","c":["ד","ה"],"f":"x\\"y"}]';
  assert.equal(repairUnescapedQuotes(valid), valid);
  assert.equal(JSON.parse(repairModelJson('[{"name":"גן החיות התנ"כי - "הגן הגדול""}]'))[0].name, 'גן החיות התנ״כי - "הגן הגדול"');
});

test('normalizeVenueAlias mirrors the Deno normalizer', () => {
  assert.equal(normalizeVenueAlias('קניון רננים'), 'רננים');
  assert.equal(normalizeVenueAlias('רננים'), 'רננים');
  assert.equal(normalizeVenueAlias('מרכז מסחרי רוטשטיין'), 'רוטשטיין');
  assert.equal(normalizeVenueAlias('מרכז רוטשטיין'), 'רוטשטיין');
  assert.equal(normalizeVenueAlias("רוטשטיינ'ס - קדימה צורן"), 'רוטשטיינס קדימה צורן');
  assert.equal(normalizeVenueAlias('מתנ"ס גן יבנה'), 'מתנס גן יבנה');
  assert.equal(normalizeVenueAlias('הספרייה העירונית'), 'ספרייה העירונית');
  assert.equal(normalizeVenueAlias(null), '');
});

test('repairHebrewGershayim mirrors the Deno repair', () => {
  assert.equal(repairHebrewGershayim('"name": "גן החיות התנ"כי"'), '"name": "גן החיות התנ״כי"');
  assert.equal(repairHebrewGershayim('{"a":"ב","c":"ד"}'), '{"a":"ב","c":"ד"}');
  assert.equal(JSON.parse(repairHebrewGershayim('[{"name":"מתנ"ס ע"ש רבין"}]'))[0].name, 'מתנ״ס ע״ש רבין');
});
