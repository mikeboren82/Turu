// PLACE identity (wave 2) - failure class of the "חי פארק בכפר סבא" regression. One rule for the pre-insert
// guard and the DB-wide audit; entity semantics are part of the rule (never events, never playgrounds).
const test = require('node:test');
const assert = require('node:assert/strict');
const { samePlace, placeNameAgreement, findPlaceDuplicate } = require('../lib/placeIdentity');

const spot = { lat: 32.17735, lng: 34.90746, city: 'כפר סבא', category: 'פינת חי' };
test('regression: "חי פארק" and "חי פארק כפר סבא" on one spot are the same place', () => {
  const v = samePlace({ ...spot, name: 'חי פארק' }, { ...spot, name: 'חי פארק כפר סבא' });
  assert.equal(v.same, true); assert.equal(v.agreement, 1);
  assert.equal(placeNameAgreement('חי פארק בכפר סבא', 'חי פארק', 'כפר סבא'), 1, 'the city with a prefix letter is locality too');
  assert.equal(placeNameAgreement('מתנ״ס גוונים', 'מתנס גוונים', 'אריאל'), 1, 'gershayim variants');
});

test('same spot, different names = two tenants of one site, never merged', () => {
  const v = samePlace({ ...spot, name: 'פינת חי בפארק רעננה', city: 'רעננה' }, { ...spot, name: 'שייט בסירה באגם הפארק', city: 'רעננה' });
  assert.equal(v.same, false); assert.match(v.why, /different name/);
});

test('entity semantics: a dated event, a playground, a far place and another weekly series are never place duplicates', () => {
  const a = { ...spot, name: 'הצגת ילדים - פיטר פן' };
  assert.equal(samePlace({ ...a, schedule_type: 'one_time' }, a).same, false);
  assert.equal(samePlace({ ...a, activity_schedules: [{ schedule_type: 'one_time' }] }, a).same, false);
  assert.equal(samePlace({ ...spot, name: 'גן משחקים', category: 'גן שעשועים' }, { ...spot, name: 'גן משחקים', category: 'גן שעשועים' }).same, false);
  assert.equal(samePlace({ ...spot, name: 'חי פארק' }, { ...spot, name: 'חי פארק', lat: 32.18 }).same, false, '300 m away');
  const mon = { ...spot, name: 'סדרת תיאטרון סיפור לגילאי 2-4', activity_schedules: [{ schedule_type: 'recurring', day_of_week: 1, start_time: '17:00:00' }] };
  const tue = { ...mon, activity_schedules: [{ schedule_type: 'recurring', day_of_week: 2, start_time: '16:30:00' }] };
  assert.equal(samePlace(mon, tue).same, false); assert.match(samePlace(mon, tue).why, /different recurring schedule/);
  assert.equal(samePlace(mon, { ...mon }).same, true, 'the same series stored twice is a duplicate');
});

test('pre-insert guard: finds the published twin, ignores events / playgrounds / candidates without coordinates', async () => {
  const rows = [{ id: 'live-1', name: 'חי פארק', category: 'פינת חי', locations: { city: 'כפר סבא', lat: 32.17735, lng: 34.90746 }, activity_schedules: [] }];
  const client = { from: () => { const c = new Proxy({}, { get(_o, k) { if (k === 'then') return (res) => res({ data: rows, error: null }); return () => c; } }); return c; } };
  const hit = await findPlaceDuplicate(client, { name: 'חי פארק כפר סבא', category: 'פינת חי', city: 'כפר סבא', lat: 32.17736, lng: 34.90747 });
  assert.equal(hit.id, 'live-1');
  assert.equal(await findPlaceDuplicate(client, { name: 'חי פארק כפר סבא', city: 'כפר סבא', lat: 32.17736, lng: 34.90747, schedule_type: 'one_time' }), null);
  assert.equal(await findPlaceDuplicate(client, { name: 'חי פארק כפר סבא', city: 'כפר סבא', lat: null, lng: null }), null);
  assert.equal(await findPlaceDuplicate(client, { name: 'גן משחקים', category: 'גן שעשועים', city: 'כפר סבא', lat: 32.17736, lng: 34.90747 }), null);
});
