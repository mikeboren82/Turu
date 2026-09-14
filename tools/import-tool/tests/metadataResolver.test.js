// Metadata resolver pure helpers: dates with inferred year, explicit age evidence, name -> category map.
const test = require('node:test');
const assert = require('node:assert/strict');
const { datesIn, agesIn, NAME_CATEGORY } = require('../cleaner/fieldEnricher');

test('datesIn: dd.mm.yyyy, dd/mm, year inferred forward, junk ignored, deduped', () => {
  assert.deepEqual(datesIn('יום שני, 14.09.2026 17:00 - 18:00', '2026-09-14'), ['2026-09-14']);
  assert.deepEqual(datesIn('ב-3/10 בשעה 17:30', '2026-09-14'), ['2026-10-03']);
  assert.deepEqual(datesIn('ב-3/1 בשעה 17:30', '2026-09-14'), ['2027-01-03']);
  assert.deepEqual(datesIn('גילאי 3-6, 40 ש"ח, 99.99', '2026-09-14'), []);
  assert.deepEqual(datesIn('20.09.2026 ו-21.09.2026 ושוב 20.09.2026', '2026-09-14'), ['2026-09-20', '2026-09-21']);
});

test('agesIn: ranges, minimum with plus, early-childhood words, none', () => {
  assert.deepEqual(agesIn('הצגה לגילאי 3-6'), { min_age: 3, max_age: 6, evidence: 'לגילאי 3-6' });
  assert.equal(agesIn('מגיל 5+').min_age, 5);
  assert.deepEqual(agesIn('סדנה לגיל הרך').min_age, 0);
  assert.equal(agesIn('מופע לכל המשפחה'), null);
  assert.equal(agesIn('הרצאה בת 45 דקות'), null);
});

test('NAME_CATEGORY: specific before generic, canonical values only', () => {
  const cat = (n) => (NAME_CATEGORY.find(([re]) => re.test(n)) || [])[1] || null;
  assert.equal(cat('שעת סיפור בספרייה'), 'שעת סיפור');
  assert.equal(cat('ג׳ימבורי משפחתי'), "ג'ימבורי");
  assert.equal(cat('סדנת שוקולד לראש השנה'), 'בישול');
  assert.equal(cat('סדנת יצירה מחימר'), 'יצירה');
  assert.equal(cat('סדנה להכנת נרות'), 'סדנה');
  assert.equal(cat('הדבורה מאיה - הצגה'), 'הצגה');
  assert.equal(cat('פינק ליידי'), null);
});
