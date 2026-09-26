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
  // 'כוכבים' (not 'הכוכבים'): article normalization 2026-09-27 also strips the per-token article
  assert.deepEqual(words('מצפה הכוכבים גבעתיים', 'גבעתיים'), ['כוכבים', 'מצפה']);
  assert.deepEqual(words('מצפה הכוכבים בגבעתיים', 'גבעתיים'), ['כוכבים', 'מצפה']);
  assert.equal(placeNameAgreement('מצפה הכוכבים', 'מצפה הכוכבים גבעתיים', 'גבעתיים'), 1);
});

test('city fold: קרית / קריית spellings reduce to the same semantic word set', () => {
  // article normalization 2026-09-27: 'התרבות' -> 'תרבות', and the approved rule ^ה(?=[א-ת]{2}) (same as
  // cleaner/matching.placeWords) cannot tell a root ה from an article, so 'היכל' -> 'יכל' - symmetric on both sides
  assert.deepEqual(words('היכל התרבות קרית גת', 'קריית גת'), ['יכל', 'תרבות']);
  assert.deepEqual(words('היכל התרבות קריית גת', 'קריית גת'), ['יכל', 'תרבות']);
  assert.deepEqual(words('היכל התרבות קריית גת', 'קרית גת'), ['יכל', 'תרבות']);
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

test('article gap CLOSED (2026-09-27): the library labels agree - and both reduce to the generic core, so they are still not level-3/4 evidence', () => {
  assert.equal(placeNameAgreement('ספרייה העירונית קרית אתא', 'הספרייה העירונית קריית אתא', 'קריית אתא'), 1);
  assert.deepEqual(words('ספרייה העירונית קרית אתא', 'קריית אתא'), ['ספריה']);
});

// ---------------------------------------------------------------- article normalization (2026-09-27)
// A leading definite article ה is stripped from EACH token when >= 2 Hebrew letters remain (cleaner/matching.placeWords
// rule), symmetrically on name AND city tokens. Fixtures: real production rows (read-only snapshot 2026-09-26).
test('article: "הבית אריאלה" and "בית אריאלה" reduce to the same core', () => {
  assert.deepEqual(words('הבית אריאלה', 'תל אביב יפו'), ['אריאלה', 'בית']);
  assert.deepEqual(words('בית אריאלה', 'תל אביב יפו'), ['אריאלה', 'בית']);
});

test('article: city tokens are normalized symmetrically - "הרצליה" is stripped, with and without a prefix letter', () => {
  assert.deepEqual(words('קניון שבעת הכוכבים הרצליה', 'הרצליה'), ['כוכבים', 'קניון', 'שבעת']);
  assert.deepEqual(words('קניון שבעת הכוכבים בהרצליה', 'הרצליה'), ['כוכבים', 'קניון', 'שבעת'], 'prefix-letter behaviour kept for an article-initial city');
});

test('article: two-letter remainder and a double article', () => {
  assert.equal(placeNameAgreement('הגן הבוטני', 'גן בוטני', 'עכו'), 1);
  assert.deepEqual(words('ההיכל', 'עכו'), ['היכל'], 'one article stripped, never two');
});

test('article: same-building tenants stay at agreement 0', () => {
  assert.equal(placeNameAgreement('ספריית הילדים והנוער', 'בית ספיר', 'כפר סבא'), 0);
  assert.equal(placeNameAgreement('מרכז קהילתי שז״ר', 'ספריית יד לבנים', 'גבעתיים'), 0);
});

test('PRE-INSERT GUARD: the near-threshold fair pair stays below 0.8; the Acre botanical pair ~147 m apart is still not one place', () => {
  assert.ok(placeNameAgreement('יריד חזרה לבית הספר - אופיס דיפו', 'יריד חזרה לבית ספר - קרביץ', 'תל אביב יפו') < 0.8);
  const a = { name: 'הגן הבוטני', category: 'טבע', city: 'עכו', lat: 32.9422765, lng: 35.0842244 };
  const b = { name: 'גן בוטני', category: 'טבע', city: 'עכו', lat: 32.9427008, lng: 35.0827256 };
  const v = samePlace(a, b);
  assert.equal(v.same, false); assert.match(v.why, /too far/);
});

test('FOLLOW_UP_LOCALITY_FILLER_FOLD (deliberately NOT fixed): "עיריית" folds to "עירית", which the filler list does not contain', () => {
  assert.ok(words('עיריית חולון', 'באר שבע').includes('עירית'));
});

// ---------------------------------------------------------------- lexical-ה regression pins (forensic 2026-09-26, MERGE_87D793C_AS_IS)
// The article rule ^ה(?=[א-ת]{2}) cannot tell a root ה (היכל, הדר, הוד, הנדיב) from an article. These pins fix the
// accepted behaviour so any future change to it is deliberate. Fixtures: real production venues / cities.
test('lexical ה: "היכל" is stripped symmetrically (-> "יכל"), so same-spelling hall names still agree fully', () => {
  assert.equal(placeNameAgreement('היכל התרבות אשקלון', 'היכל התרבות באשקלון', 'אשקלון'), 1);
  assert.deepEqual(words('היכל התרבות אשקלון', 'אשקלון'), ['יכל', 'תרבות']);
});

test('ACCEPTED LIMITATION (one strip only): "ההיכל התרבות לוד" keeps {היכל, תרבות} while the venue core is {יכל, תרבות} -> 0.5', () => {
  // unchanged from MAIN e2bbb9e (0.5 there too); "ההיכל" never occurs in production (construct phrases put the article on the 2nd noun)
  assert.deepEqual(words('ההיכל התרבות לוד', 'לוד'), ['היכל', 'תרבות']);
  assert.deepEqual(words('היכל התרבות לוד', 'לוד'), ['יכל', 'תרבות']);
  assert.equal(placeNameAgreement('ההיכל התרבות לוד', 'היכל התרבות לוד', 'לוד'), 0.5);
});

test('KNOWN_ACCEPTED_LEXICAL_HE_COLLISION: co-located "בית אלון" / "בית האלון" in one city are the same place (agreement 1)', () => {
  // KNOWN_ACCEPTED_LEXICAL_HE_COLLISION - this pins an ACCEPTED limitation of the per-token article rule; it does NOT
  // endorse broader lexical equivalence. Bounded by the 80 m gate; 0 such co-located pairs in production (2026-09-26).
  // If a real distinct pair appears, the planned fix is a narrow exception set (forensic option B), not a revert.
  const v = samePlace({ name: 'בית אלון', city: 'גבעתיים', lat: 32.0702, lng: 34.8036 }, { name: 'בית האלון', city: 'גבעתיים', lat: 32.0702, lng: 34.8036 });
  assert.equal(v.same, true); assert.equal(v.agreement, 1); assert.equal(v.km, 0);
});

test('lexical ה in CITY tokens: הוד השרון / הדר המושבות / הרצליה are stripped from the name, name words are not', () => {
  assert.deepEqual(words('היכל התרבות הוד השרון', 'הוד השרון'), ['יכל', 'תרבות']);
  assert.deepEqual(words('מתנס הדר המושבות', 'הדר המושבות'), ['מתנס'], 'generic core');
  assert.deepEqual(words('בקניון שבעת הכוכבים בהרצליה', 'הרצליה'), ['בקניון', 'כוכבים', 'שבעת'], 'בהרצליה removed, בקניון kept');
});

test('PRE-INSERT GUARD near-threshold: the back-to-school fair pair (0.67) stays below 0.8 - not one place even at 0 m; tenants stay distinct', () => {
  const at = { city: 'תל אביב יפו', lat: 32.0853, lng: 34.7818 };
  const a = 'יריד חזרה לבית הספר - אופיס דיפו', b = 'יריד חזרה לבית ספר - קרביץ';
  assert.ok(placeNameAgreement(a, b, at.city) < 0.8);
  assert.equal(samePlace({ ...at, name: a }, { ...at, name: b }).same, false);
  const ks = { city: 'כפר סבא', lat: 32.1776, lng: 34.9075 }, gv = { city: 'גבעתיים', lat: 32.0704, lng: 34.8062 };
  assert.equal(samePlace({ ...ks, name: 'ספריית הילדים והנוער' }, { ...ks, name: 'בית ספיר' }).same, false);
  assert.equal(samePlace({ ...gv, name: 'מרכז קהילתי שז״ר' }, { ...gv, name: 'ספריית יד לבנים' }).same, false);
});
