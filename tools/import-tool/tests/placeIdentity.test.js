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

// ---------------------------------------------------------------- city-word fold (Option A, 2026-09-26)
// City tokens now get the SAME fold as name tokens (יי->י, וו->ו, geresh/gershayim dropped). Unfolded, "גבעתיים" and
// "קריית" never equalled the folded name words "גבעתים"/"קרית", so the city was never stripped. Fixtures are the real
// production venues (read-only snapshot 2026-09-26).
const { placeNameWords } = require('../lib/placeIdentity');
const words = (n, c) => [...placeNameWords(n, c)].sort();

test('city fold: Givatayim is stripped from a Givatayim venue name, plain and with a prefix letter', () => {
  assert.deepEqual(words('מצפה הכוכבים גבעתיים', 'גבעתיים'), ['הכוכבים', 'מצפה']);
  assert.deepEqual(words('מצפה הכוכבים בגבעתיים', 'גבעתיים'), ['הכוכבים', 'מצפה']);
  assert.equal(placeNameAgreement('מצפה הכוכבים', 'מצפה הכוכבים גבעתיים', 'גבעתיים'), 1);
});

test('city fold: קרית / קריית spellings reduce to the same semantic word set', () => {
  assert.deepEqual(words('היכל התרבות קרית גת', 'קריית גת'), ['היכל', 'התרבות']);
  assert.deepEqual(words('היכל התרבות קריית גת', 'קריית גת'), ['היכל', 'התרבות']);
  assert.deepEqual(words('היכל התרבות קריית גת', 'קרית גת'), ['היכל', 'התרבות']);
});

test('city fold: a city without יי/וו behaves exactly as before, and only the city (never a name word) is stripped', () => {
  assert.equal(placeNameAgreement('חי פארק בכפר סבא', 'חי פארק', 'כפר סבא'), 1);
  assert.deepEqual(words('מרכז קהילתי שז״ר גבעתיים', 'גבעתיים'), ['מרכז', 'קהילתי', 'שזר']);
});

test('PRE-INSERT GUARD: two tenants of one Givatayim spot stay distinct (ספריית יד לבנים / מרכז קהילתי שז״ר share coordinates in production)', () => {
  const at = { lat: 32.0622, lng: 34.817, city: 'גבעתיים', category: 'ספרייה' };
  assert.equal(samePlace({ ...at, name: 'ספריית יד לבנים גבעתיים' }, { ...at, name: 'מרכז קהילתי שז״ר גבעתיים' }).same, false);
  assert.equal(samePlace({ ...at, name: 'מקלט רמב״ם גבעתיים' }, { ...at, name: 'בית אלון גבעתיים' }).same, false, 'X גבעתיים vs Y גבעתיים: the shared city is no longer a shared word');
});

test('PRE-INSERT GUARD: the fold only adds the intended positive - the same name with and without the city', () => {
  const at = { lat: 32.0698, lng: 34.8152, city: 'גבעתיים', category: 'מדע' };
  assert.equal(samePlace({ ...at, name: 'מצפה הכוכבים' }, { ...at, name: 'מצפה הכוכבים גבעתיים' }).same, true);
  assert.equal(samePlace({ ...spot, name: 'חי פארק' }, { ...spot, name: 'חי פארק כפר סבא' }).same, true, 'existing positive unchanged');
  // nearby distinct branches: two Givatayim venues ~350 m apart with different names
  assert.equal(samePlace({ lat: 32.0704, lng: 34.8062, city: 'גבעתיים', name: 'מקלט רמב״ם' }, { lat: 32.0702, lng: 34.8036, city: 'גבעתיים', name: 'בית אלון' }).same, false);
});

test('ARTICLE GAP (FOLLOW-UP_ARTICLE_NORMALIZATION, deliberately NOT fixed): the definite article still separates the library labels', () => {
  assert.ok(placeNameAgreement('ספרייה העירונית קרית אתא', 'הספרייה העירונית קריית אתא', 'קריית אתא') < 0.8);
});
