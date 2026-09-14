// Settlement-review identity helpers: the rules the 2026-09-14 safety sample fixed stay pinned.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAddress, nameSim, classifyKind, existingStreet } = require('../cleaner/settlementResolver');

test('parseAddress: multi-part addresses pick the numbered part, ranges keep the first number, street prefixes drop, corners are not streets', () => {
  assert.deepEqual(parseAddress('גן יוסי מילר, שדרות הנשיא וייצמן 658, אור עקיבא'), { street: 'הנשיא וייצמן', houseNumber: '658', city: 'אור עקיבא' });
  assert.deepEqual(parseAddress('אבני חושן 11-13, מודיעין מכבים רעות'), { street: 'אבני חושן', houseNumber: '11', city: 'מודיעין מכבים רעות' });
  assert.equal(parseAddress("רח' הרימון 4, בנימינה גבעת עדה").street, 'הרימון');
  assert.equal(parseAddress('פינת, שדרות הרצל, אשדוד').street, 'הרצל');
  assert.deepEqual(parseAddress('רמת השרון'), { street: null, houseNumber: null, city: 'רמת השרון' });
  assert.equal(parseAddress('המצוק 2, יוקנעם עילית, 2067108').city, 'יוקנעם עילית');
});

test('nameSim ignores park/playground stop-words, the definite article and the city tokens', () => {
  assert.equal(nameSim('פארק נוה-רבין', 'גן שעשועים – פארק נוה-רבין, אור יהודה', 'אור יהודה'), 1);
  assert.equal(nameSim('פארק שרונה', 'פארק שרונה, כפר יונה', 'כפר יונה'), 1);
  assert.ok(nameSim('פארק אבני החושן', 'גן שעשועים – אבני החושן, מודיעין-מכבים-רעות', 'מודיעין מכבים רעות') >= 0.66);
  assert.equal(nameSim('גן זמסקי', 'גן שעשועים – מאיר זמסקי, ראשון לציון', 'ראשון לציון'), 0.5);
  assert.equal(nameSim('גרביטי פארק', 'גן שעשועים – החרושת, כרמיאל', 'כרמיאל'), 0);
});

test('classifyKind: playground / park / attraction / kindergarten / garden', () => {
  assert.equal(classifyKind({ name: 'גן שעשועים הרימון', place_kind: null }), 'PLAYGROUND');
  assert.equal(classifyKind({ name: 'פארק רמון', place_kind: 'PARK' }), 'PARK');
  assert.equal(classifyKind({ name: 'גרביטי פארק כרמיאל gravity park', place_kind: 'PARK' }), 'ATTRACTION');
  assert.equal(classifyKind({ name: 'גן ילדים אורנים', place_kind: 'UNCERTAIN' }), 'NOT_RELEVANT');
  assert.equal(classifyKind({ name: 'גן הבנים', place_kind: 'UNCERTAIN' }), 'GARDEN');
  assert.equal(existingStreet({ name: 'גן שעשועים – הרב קירשטיין, עפולה', locations: { address: null } }), 'הרב קירשטיין');
});
