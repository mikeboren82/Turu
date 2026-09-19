// MISCLASSIFIED (0096): indoor play / amusement / non-place filed as a public playground.
// The two named production regressions are FAILURE-CLASS fixtures: they are caught by rule, not by id.
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyPlayVenue } = require('../lib/playVenueClassifier');

test('regressions: פאנקי מאנקי כפר יונה and ג\'ימבו פליי are indoor play, HIGH', () => {
  for (const n of ['פאנקי מאנקי כפר יונה', "ג'ימבו פליי", 'ג׳ימבו פליי', 'פאנקי וורלד - באר טוביה', 'Kids Land משחקיית קידס לנד', 'פארק 770 - רשת משחקיות', 'JNF Indoor Playground']) {
    const k = classifyPlayVenue(n); assert.ok(k, n); assert.equal(k.kind, 'indoor_play', n); assert.equal(k.confidence, 'HIGH'); assert.equal(k.category, 'משחקייה'); assert.equal(k.indoor_outdoor, 'indoor');
  }
  assert.equal(classifyPlayVenue("ג'ימבורי השרון").category, "ג'ימבורי");
});

test('a real public playground is never reclassified - including names that merely contain "משחקים"', () => {
  for (const n of ['גן משחקים', 'מגרש משחקים', 'גינת משחקים ברוש', 'גן שעשועים – הרצל, רעננה', 'Playground', 'Kids Playground', 'Childrens playground', 'פארק המשחקים רמות', 'גן המשחקים בפארק יצחק ולד', 'מגרש משחקים, הפיראטים', 'גן משחקים אתגרי', null, '']) assert.equal(classifyPlayVenue(n), null, String(n));
});

test('an equipment company is not a place; an amusement park is its own category; ropes/extreme parks are only MEDIUM', () => {
  for (const n of ['אורן מתקני משחקים בע"מ', 'פארק דיזיין מתקני משחקים וציוד פנים בע"מ', 'Happy Play Ltd']) { const k = classifyPlayVenue(n); assert.equal(k.kind, 'not_a_place', n); assert.equal(k.confidence, 'HIGH'); }
  assert.equal(classifyPlayVenue('לונה פארק בילו סנטר').category, 'פארק שעשועים');
  for (const n of ['פארק חבלים', 'מתחם חבלים (קומפן)', 'פארק אקסטרים אגוז']) { const k = classifyPlayVenue(n); assert.equal(k.confidence, 'MEDIUM', n); assert.equal(k.category, null); }
});

// Google settlement-scanner cohort (place_kind PARK / UNCERTAIN, 2026-09-19): names proving another existing category
test('petting zoos, botanical gardens and pump tracks / skate parks are HIGH reclassifications; nature sites are MEDIUM; "גינה"/"גן" stay playgrounds', () => {
  assert.equal(classifyPlayVenue('פינת חי').category, 'פינת חי');
  assert.equal(classifyPlayVenue('פינת החי העירונית').confidence, 'HIGH');
  assert.equal(classifyPlayVenue('הגן הבוטני').category, 'טבע');
  assert.equal(classifyPlayVenue('פאמפטרק ע"ש גבי לרנר ז"ל').category, 'ספורט');
  assert.equal(classifyPlayVenue('סקייט פארק חולון').category, 'ספורט');
  const nature = classifyPlayVenue("שלולית חורף - חורשת הסרג'נטים"); assert.equal(nature.confidence, 'MEDIUM'); assert.equal(nature.category, null);
  for (const n of ['גינת היובל', 'גן הבנים', 'Habanim Garden', 'גני מעלה המפל', 'הפארק הגדול']) assert.equal(classifyPlayVenue(n), null, n + ' - a public garden may well be a playground; never reclassified on the name alone');
});

// Failure class of the "חוות ארץ האיילים" regression ("367, ביתר עילית"): a highway reference number is not a street.
test('a bare road number is never a street - not in an address, not in a generated playground title', () => {
  const { parseStreetAddress, generatePlaygroundDisplayName } = require('../playgroundNaming');
  assert.deepEqual(parseStreetAddress('367, ביתר עילית'), { street: null, houseNumber: null });
  assert.deepEqual(parseStreetAddress('4311'), { street: null, houseNumber: null });
  assert.deepEqual(parseStreetAddress('הרצל 12, רעננה'), { street: 'הרצל', houseNumber: '12' });
  assert.deepEqual(parseStreetAddress('האורן, כרמי יוסף'), { street: 'האורן', houseNumber: null });
  assert.equal(generatePlaygroundDisplayName({ officialName: null, address: '3565, נוקדים', city: 'נוקדים' }).name, 'גן שעשועים – נוקדים');
  assert.equal(generatePlaygroundDisplayName({ officialName: null, address: 'הרצל 12, רעננה', city: 'רעננה' }).name, 'גן שעשועים – הרצל 12, רעננה');
});
