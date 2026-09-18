// בדיקות ל-lib/searchIntent.js + lib/smartSearch.js#intentToFilters + matchesFreeText
// (lib/filterActivities.js): פירוק-עמימות בין "שם פעילות" ל"מקום" בחיפוש החופשי.
//
// באג המקור (2026-09-17): "זהבה" → המנתח החזיר location.city:"זהבה" (יישוב שלא קיים), הטקסט
// הגולמי נאכל, והתוצאה הייתה 0 פעילויות - למרות שיש 4 פעילויות מאושרות בשם "זהבה ושלושת הדובים".
// ה-intent-ים כאן הם *פלט אמיתי* של ה-Edge Function (נמדד מול הפונקציה החיה, לא המצאה).
// אותו require-hook (babel commonjs + סטאבים) כמו tests/matchReasons.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');
const { addHook } = require('pirates');

const ROOT = path.resolve(__dirname, '..');
const STUBS = {
  'react-native': { Platform: { OS: 'node' }, StyleSheet: { create: (s) => s } },
  '@react-native-async-storage/async-storage': { default: { getItem: async () => null, setItem: async () => {} } },
  './supabase': { supabase: { from: () => ({ select: () => ({ ilike: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) } },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  return STUBS[request] ? `stub:${request}` : origResolve.call(this, request, ...rest);
};
for (const [name, exp] of Object.entries(STUBS)) {
  const m = new Module(`stub:${name}`);
  m.exports = { __esModule: true, ...exp };
  m.loaded = true;
  Module._cache[`stub:${name}`] = m;
}
addHook(
  (code, filename) => babel.transformSync(code, { filename, babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'] }).code,
  { exts: ['.js'], matcher: (f) => f.startsWith(path.join(ROOT, 'lib')) || f.startsWith(path.join(ROOT, 'constants')) },
);

const { hasGeographicCue, hasChildReferenceCue, resolveLocationIntent, normalizeSearchText } = require('../lib/searchIntent');
const { intentToFilters, parseSmartSearchQuery, needsAreaClarification } = require('../lib/smartSearch');
const {
  applyFilters, rankActivities, applyFiltersWithSmartRadius, locationWithDrivingTime, locationWithAnyDistance,
  locationWithNoRestriction, travelSelection,
} = require('../lib/filterActivities');
const { DEFAULT_FILTERS, DEFAULT_PRECISE_RADIUS_KM } = require('../constants/filterSchema');
const { requestCurrentPosition, applyCurrentPositionResult } = require('../lib/currentPosition');
// אותו אובייקט-מודול בדיוק ש-lib/smartSearch.js קיבל (המפתח הוא ה-specifier שבתוך lib/).
const supabaseStub = Module._cache['stub:./supabase'].exports;

// מחליף את אובייקט ה-supabase עצמו (לא require חדש) - הקוד המתומלל קורא דרך אותו module object.
function stubSupabase({ intent, settlementRows = [] }) {
  const calls = { settlementQueries: 0 };
  supabaseStub.supabase = {
    functions: { invoke: async () => ({ data: { intent }, error: null }) },
    from: () => ({
      select: () => ({
        ilike: () => ({
          limit: async () => { calls.settlementQueries += 1; return { data: settlementRows, error: null }; },
        }),
      }),
    }),
  };
  return calls;
}

// intent "ריק" בצורה שה-Edge Function מחזירה בפועל (sanitizeIntent + resolveDateLabel).
function intentOf(overrides = {}) {
  return {
    category: null,
    location: { city: null, region: null, street: null, relation: null, coords: null, geocodeFailed: false, cityVerified: false },
    when: { option: null, date: null },
    timeRange: null, age: null, childNameMentioned: null,
    priceHint: null, durationHint: null, placeTypeHint: null,
    // בכוונה *בלי* residualQuery: ברירת-המחדל היא החוזה הפרוס כיום (שרת ישן). בדיקות החוזה החדש
    // מעבירות residualQuery במפורש (גם null) - נוכחות המפתח היא מה שמזהה שרת מעודכן.
    amenityHints: [], benefitsHint: null, vagueIntent: [],
    ...overrides,
    location: { city: null, region: null, street: null, relation: null, coords: null, geocodeFailed: false, cityVerified: false, ...(overrides.location || {}) },
  };
}

// קטלוג-מיני שמשקף פעילויות אמיתיות מהמאגר (השמות נלקחו כלשונם מ-activities המאושרות).
const CATALOG = [
  { id: '1', title: 'זהבה ושלושת הדובים – בכיכובה של נתי הגעתי', description: 'הצגה לילדים', category: 'הצגה', locationName: 'היכל התרבות', city: 'תל אביב', region: 'גוש דן והמרכז' },
  { id: '2', title: 'זהבה ושלושת הדובים - תיאטרון סיפור', description: null, category: 'הצגה', locationName: 'מתנ"ס', city: 'רעננה', region: 'השרון' },
  { id: '3', title: 'גן שעשועים – שדרות ששת הימים, אילת', description: null, category: 'גן שעשועים', locationName: null, city: 'אילת', region: 'הדרום והנגב' },
  { id: '4', title: 'פארק נחל לכיש', description: 'פארק גדול', category: 'פארק', locationName: null, city: 'אשדוד', region: 'הדרום והנגב' },
];

function search(filters) {
  return applyFilters(CATALOG, filters, null, [], [], [], []).map((a) => a.id);
}

// ---------------------------------------------------------------------------
// hasGeographicCue - הראיה הלשונית
// ---------------------------------------------------------------------------

test('geographic cue: bare token has no geographic evidence', () => {
  assert.equal(hasGeographicCue('זהבה', 'זהבה'), false);
  assert.equal(hasGeographicCue('זהבה ושלושת הדובים', 'זהבה'), false);
});

test('geographic cue: attached ב/ל/מ prefix is evidence', () => {
  assert.equal(hasGeographicCue('פעילויות בזהבה', 'זהבה'), true);
  assert.equal(hasGeographicCue('מה יש בזהבה', 'זהבה'), true);
  assert.equal(hasGeographicCue('נוסעים לזהבה', 'זהבה'), true);
});

test('geographic cue: standalone preposition before the place is evidence', () => {
  assert.equal(hasGeographicCue('זהבה ליד חיפה', 'חיפה'), true);
  assert.equal(hasGeographicCue('פעילויות באזור חיפה', 'חיפה'), true);
  assert.equal(hasGeographicCue('playgrounds near haifa', 'haifa'), true);
});

test('geographic cue is boundary-aware: a place name inside a longer word is not a cue', () => {
  // "אור" בתוך "מאורות" - אסור שייחשב "מ+אור" (מקום). גבול-מילה משני הצדדים מונע את זה.
  assert.equal(hasGeographicCue('מאורות הבמה', 'אור'), false);
  assert.equal(hasGeographicCue('הזהבה של דנה', 'זהבה'), false); // ה' לבדה אינה ראיה גאוגרפית
});

test('normalization collapses gershayim/geresh and hyphens without stripping Hebrew prefixes', () => {
  assert.equal(normalizeSearchText('מתנ"ס  גוש-דן'), 'מתנס גוש דן');
  assert.equal(normalizeSearchText('יו״ש'), 'יוש');
  assert.equal(normalizeSearchText('בזהבה'), 'בזהבה'); // הקידומת נשמרת - היא הראיה עצמה
});

// ---------------------------------------------------------------------------
// resolveLocationIntent - הכרעת ההשערות
// ---------------------------------------------------------------------------

test('unverified place with no geographic cue is demoted to text', () => {
  const r = resolveLocationIntent({ rawQuery: 'זהבה', city: 'זהבה', cityVerified: false });
  assert.equal(r.keepLocation, false);
  assert.equal(r.demotedCity, 'זהבה');
  assert.equal(r.reason, 'unverified-no-geo-cue');
});

test('verified settlement stays a location - no overcorrection', () => {
  const r = resolveLocationIntent({ rawQuery: 'שדרות', city: 'שדרות', cityVerified: true });
  assert.equal(r.keepLocation, true);
  assert.equal(r.reason, 'verified');
});

test('unverified place WITH explicit geographic language stays a location', () => {
  const r = resolveLocationIntent({ rawQuery: 'פעילויות בזהבה', city: 'זהבה', cityVerified: false });
  assert.equal(r.keepLocation, true);
  assert.equal(r.reason, 'unverified-but-explicit-geo');
});

// ---------------------------------------------------------------------------
// מטריצת השאילתות הנדרשת (A-J) - דרך intentToFilters, על intent-ים אמיתיים מה-Edge Function
// ---------------------------------------------------------------------------

test('A. "זהבה" -> no location filter, raw text preserved, the show is found', () => {
  const intent = intentOf({ location: { city: 'זהבה', cityVerified: false }, rawQuery: 'זהבה' });
  const filters = intentToFilters(intent, {});
  assert.equal(filters.location.mode, null, 'לא נכפה מיקום');
  assert.equal(filters.q, 'זהבה', 'הטקסט הגולמי נשמר');
  assert.deepEqual(search(filters), ['1', '2']);
});

test('B. "זהבה ושלושת הדובים" (full title) matches the show', () => {
  const intent = intentOf({ rawQuery: 'זהבה ושלושת הדובים' });
  const filters = intentToFilters(intent, {});
  assert.equal(filters.location.mode, null);
  assert.deepEqual(search(filters), ['1', '2']);
});

test('C. "הצגה זהבה" -> category + the entity name kept as text (vagueIntent verbatim)', () => {
  // פלט אמיתי של המנתח: category="הצגה", אין עיר, ו"זהבה" נזרק ל-vagueIntent.
  const intent = intentOf({ category: 'הצגה', vagueIntent: ['זהבה'], rawQuery: 'הצגה זהבה' });
  const filters = intentToFilters(intent, {});
  assert.deepEqual(filters.category, ['הצגה']);
  assert.equal(filters.q, 'זהבה');
  assert.deepEqual(search(filters), ['1', '2']);
});

test('D. "שלושת הדובים" -> pure text search (parser returned nothing at all)', () => {
  const intent = intentOf({ rawQuery: 'שלושת הדובים' });
  const filters = intentToFilters(intent, {});
  assert.equal(filters.q, 'שלושת הדובים');
  assert.deepEqual(search(filters), ['1', '2']);
});

test('E. "זהבה דובים" -> token matching finds the show even though the phrase is not contiguous', () => {
  const intent = intentOf({ rawQuery: 'זהבה דובים' });
  const filters = intentToFilters(intent, {});
  assert.equal(filters.q, 'זהבה דובים');
  assert.deepEqual(search(filters), ['1', '2']);
});

test('F. "פעילויות בזהבה" -> genuine location intent is respected', () => {
  const intent = intentOf({ location: { city: 'זהבה', cityVerified: false }, rawQuery: 'פעילויות בזהבה' });
  const filters = intentToFilters(intent, {});
  assert.equal(filters.location.mode, 'city');
  assert.equal(filters.location.city, 'זהבה');
  assert.equal(filters.q, '', 'לא מסננים גם בטקסט - זו בקשה גאוגרפית');
});

test('G. "מה יש בזהבה" -> location intent stays strong', () => {
  const intent = intentOf({ location: { city: 'זהבה', cityVerified: false }, rawQuery: 'מה יש בזהבה' });
  const filters = intentToFilters(intent, {});
  assert.equal(filters.location.mode, 'city');
  assert.equal(filters.location.city, 'זהבה');
});

test('H. "זהבה ליד חיפה" -> Haifa is the location AND זהבה survives as text (residual contract)', () => {
  // פלט אמיתי מהמנתח (נמדד 2026-09-18): category:"בעלי חיים", city:"חיפה", street:null,
  // vagueIntent:[] - כלומר בלי residual_query הטקסט "זהבה" נמחק לגמרי (ראו הבדיקה הבאה).
  const intent = intentOf({
    category: 'בעלי חיים',
    location: { city: 'חיפה', cityVerified: true },
    residualQuery: 'זהבה',
    rawQuery: 'זהבה ליד חיפה',
  });
  const filters = intentToFilters(intent, {});
  assert.equal(filters.location.mode, 'city');
  assert.equal(filters.location.city, 'חיפה');
  assert.equal(filters.q, 'זהבה', 'הטקסט המעורב נשמר לצד המיקום');
});

test('H(old server). without residual_query the mixed text is lost - this is WHY the contract changed', () => {
  // תיעוד מדויק של החוזה הפרוס כיום. אם יום אחד הבדיקה הזו "תישבר" - סימן שהפונקציה עודכנה.
  const intent = intentOf({ category: 'בעלי חיים', location: { city: 'חיפה', cityVerified: true }, rawQuery: 'זהבה ליד חיפה' });
  assert.equal(intentToFilters(intent, {}).q, '');
});

test('residual_query is rejected unless it is quoted verbatim from the query (anti-hallucination)', () => {
  const invented = intentOf({ location: { city: 'חיפה', cityVerified: true }, residualQuery: 'מתקני מים', rawQuery: 'פעילויות בחיפה' });
  assert.equal(intentToFilters(invented, {}).q, '', 'ערך שלא מצוטט מהשאילתה נפסל');
  const quoted = intentOf({ location: { city: 'חיפה', cityVerified: true }, residualQuery: 'מתקני מים', rawQuery: 'משהו עם מתקני מים בחיפה' });
  assert.equal(intentToFilters(quoted, {}).q, 'מתקני מים');
});

test('I. explicit WHERE=נתניה + query "זהבה" -> Netanya stays the location, זהבה stays text', () => {
  const intent = intentOf({ location: { city: 'זהבה', cityVerified: false }, rawQuery: 'זהבה' });
  const filters = intentToFilters(intent, { fallbackLocation: { mode: 'city', city: 'נתניה', region: [], radiusKm: null, coords: null } });
  assert.equal(filters.location.mode, 'city');
  assert.equal(filters.location.city, 'נתניה', 'הבחירה המפורשת נשארת');
  assert.equal(filters.q, 'זהבה');
});

test('J. explicit WHERE=חיפה + "פעילות באילת" -> the verified city from the text still wins (unchanged)', () => {
  const intent = intentOf({ location: { city: 'אילת', cityVerified: true }, rawQuery: 'פעילות באילת' });
  const filters = intentToFilters(intent, { fallbackLocation: { mode: 'city', city: 'חיפה', region: [], radiusKm: null, coords: null } });
  assert.equal(filters.location.mode, 'city');
  assert.equal(filters.location.city, 'אילת');
  assert.equal(filters.q, '');
});

// ---------------------------------------------------------------------------
// פיקסטורות-עמימות אמיתיות נוספות מהמאגר (לא רק "זהבה")
// ---------------------------------------------------------------------------

test('real fixture: "שדרות" is both a city and the word "boulevard" - bare query keeps the city', () => {
  // שדרות הוא יישוב אמיתי, ולכן חיפוש-מקום נשאר חיפוש-מקום (אין תיקון-יתר לכיוון השני).
  const intent = intentOf({ location: { city: 'שדרות', cityVerified: true }, rawQuery: 'שדרות' });
  const filters = intentToFilters(intent, {});
  assert.equal(filters.location.mode, 'city');
  assert.equal(filters.q, '');
});

test('real fixture: a made-up place name never silently filters everything away', () => {
  // כל שם-עצם פרטי שהמנתח עלול לנחש כעיר (לא רק "זהבה") - בלי אימות ובלי רמז גאוגרפי הוא טקסט.
  for (const name of ['נתי הגעתי', 'תיאטרון סיפור', 'לכיש']) {
    const intent = intentOf({ location: { city: name, cityVerified: false }, rawQuery: name });
    const filters = intentToFilters(intent, {});
    assert.equal(filters.location.mode, null, `${name} לא הפך לפילטר-מיקום`);
    assert.equal(filters.q, name);
  }
});

test('real fixture: vague query must NOT become a text filter (would return nothing)', () => {
  // פלט אמיתי: "משהו כיף לילדים" → intent ריק + vagueIntent:["כיפי"] (לא מילולי בשאילתה).
  const intent = intentOf({ vagueIntent: ['כיפי'], rawQuery: 'משהו כיף לילדים' });
  const filters = intentToFilters(intent, {});
  assert.equal(filters.q, '', 'חיפוש מעורפל נשאר רחב, לא מסונן לאפס תוצאות');
  assert.equal(search(filters).length, CATALOG.length);
});

test('structured intent (category + verified city) is unchanged - no text over-filtering', () => {
  const intent = intentOf({ category: 'פארק', location: { city: 'אשדוד', cityVerified: true }, rawQuery: 'פארקים באשדוד' });
  const filters = intentToFilters(intent, {});
  assert.equal(filters.q, '');
  assert.deepEqual(filters.category, ['פארק']);
  assert.deepEqual(search(filters), ['4']);
});

// ---------------------------------------------------------------------------
// matchesFreeText - התאמת טוקנים/גבולות
// ---------------------------------------------------------------------------

test('free text: partial titles, prefixed tokens and reordering all find the activity', () => {
  for (const q of ['זהבה', 'שלושת הדובים', 'זהבה דובים', 'זהבה ושלושת', 'הדובים זהבה']) {
    assert.deepEqual(search({ q }), ['1', '2'], `q="${q}"`);
  }
});

test('free text: city/category remain searchable (existing behaviour kept)', () => {
  assert.deepEqual(search({ q: 'אשדוד' }), ['4']);
  assert.deepEqual(search({ q: 'גן שעשועים' }), ['3']);
});

test('free text: a query that matches nothing returns nothing (no accidental match-all)', () => {
  assert.deepEqual(search({ q: 'קרקס מעופף' }), []);
});

// ---------------------------------------------------------------------------
// מטריצת כוונה-מעורבת (TEXT + LOCATION) - סעיף 2026-09-18.
// האינווריאנט: זיהוי מימד אחד לא מוחק חלקים משמעותיים אחרים של השאילתה.
// ה-intent-ים משקפים את הפלט האמיתי של המנתח + residual_query החדש.
// ---------------------------------------------------------------------------

const MIXED = [
  { n: 1, raw: 'זהבה ליד חיפה', category: 'בעלי חיים', city: 'חיפה', residual: 'זהבה', expectQ: 'זהבה' },
  { n: 2, raw: 'פיטר פן ליד נתניה', category: 'הצגה', city: 'נתניה', residual: 'פיטר פן', expectQ: 'פיטר פן' },
  { n: 3, raw: 'קרקס בחיפה', category: 'הצגה', city: 'חיפה', residual: 'קרקס', expectQ: 'קרקס' },
  // 4: "קטיף" כבר מיוצג ע"י category "חווה" - המודל מתבקש להחזיר null, ואסור לכפות q שיצמצם.
  { n: 4, raw: 'קטיף ליד חדרה', category: 'חווה', city: 'חדרה', residual: null, expectQ: '' },
  // 5: "פעילויות" היא מילת-מילוי גנרית - null, אחרת היינו מסננים על מילה שלא מופיעה בשום כותרת.
  { n: 5, raw: 'פעילויות בחיפה', category: null, city: 'חיפה', residual: null, expectQ: '' },
];

for (const c of MIXED) {
  test(`mixed ${c.n}. "${c.raw}" -> q=${JSON.stringify(c.expectQ)} + location=${c.city}`, () => {
    const intent = intentOf({
      category: c.category,
      location: { city: c.city, cityVerified: true },
      residualQuery: c.residual,
      rawQuery: c.raw,
    });
    const filters = intentToFilters(intent, {});
    assert.equal(filters.location.mode, 'city');
    assert.equal(filters.location.city, c.city, 'המיקום נשמר');
    assert.equal(filters.q, c.expectQ);
    if (c.category) assert.deepEqual(filters.category, [c.category], 'הקטגוריה לא נפגעה');
  });
}

test('mixed 10. explicit WHERE=נתניה + "פיטר פן ליד חיפה" -> text preserved; inferred Haifa still overrides', () => {
  // התנהגות קיימת ולא שונתה: מיקום מאומת מהטקסט גובר על fallbackLocation. זהו קונפליקט אמיתי
  // (סעיף 10 בבקשה) - מתועד כאן כדי שכל שינוי עתידי בקדימות ייתפס ע"י הבדיקה, לא "יומצא" בשקט.
  const intent = intentOf({
    category: 'הצגה', location: { city: 'חיפה', cityVerified: true }, residualQuery: 'פיטר פן', rawQuery: 'פיטר פן ליד חיפה',
  });
  const filters = intentToFilters(intent, { fallbackLocation: { mode: 'city', city: 'נתניה', region: [], radiusKm: null, coords: null } });
  assert.equal(filters.q, 'פיטר פן', 'הטקסט נשמר גם בתוך קונפליקט מיקום');
  assert.equal(filters.location.city, 'חיפה', 'התנהגות קיימת: הטקסט המפורש גובר');
});

// ---------------------------------------------------------------------------
// חוזה חדש (residualQuery + קטגוריה מבוססת-ראיה) - הפלט האמיתי של המודל עם הפרומפט המעודכן
// (נמדד 2026-09-18 בהערכה אופליין מול אותו מודל/temperature כמו בפרודקשן).
// ---------------------------------------------------------------------------

test('new contract: filler with a verbatim vagueIntent word does NOT become q ("משהו כיף בחיפה")', () => {
  const intent = intentOf({ location: { city: 'חיפה', cityVerified: true }, residualQuery: null, vagueIntent: ['כיף'], rawQuery: 'משהו כיף בחיפה' });
  const filters = intentToFilters(intent, {});
  assert.equal(filters.q, '', 'residualQuery:null הוא "לא נשאר טקסט" מפורש - vagueIntent לא מקודם');
  assert.equal(filters.location.city, 'חיפה');
});

test('new contract: bare name with residualQuery:null still searches the name (nothing structured was extracted)', () => {
  // פלט אמיתי: "זהבה" → הכל null, כולל residual_query. כלל "אין שום מבנה → כל השאילתה" מכסה את זה.
  const intent = intentOf({ residualQuery: null, rawQuery: 'זהבה' });
  const filters = intentToFilters(intent, {});
  assert.equal(filters.q, 'זהבה');
  assert.deepEqual(search(filters), ['1', '2']);
});

test('new contract: speculative category suppressed server-side -> the show is still found', () => {
  // "זהבה ליד חיפה" → category:null (לא "בעלי חיים"), residual:"זהבה". קטלוג עם הופעה של זהבה בחיפה:
  const catalog = [...CATALOG, { id: '5', title: 'זהבה ושלושת הדובים', description: null, category: 'הצגה', locationName: null, city: 'חיפה', region: 'חיפה והקריות' }];
  const good = intentToFilters(intentOf({ location: { city: 'חיפה', cityVerified: true }, residualQuery: 'זהבה', rawQuery: 'זהבה ליד חיפה' }), {});
  assert.deepEqual(applyFilters(catalog, good, null, [], [], [], []).map((a) => a.id), ['5']);
  // לעומת זאת, עם הקטגוריה שהומצאה בפרודקשן היום - התוצאה הנכונה הייתה נעלמת:
  const invented = intentToFilters(intentOf({ category: 'בעלי חיים', location: { city: 'חיפה', cityVerified: true }, residualQuery: 'זהבה', rawQuery: 'זהבה ליד חיפה' }), {});
  assert.deepEqual(applyFilters(catalog, invented, null, [], [], [], []).map((a) => a.id), []);
});

test('explicit WHAT stays authoritative: WHAT=בעלי חיים + "זהבה" -> category בעלי חיים, q זהבה', () => {
  const intent = intentOf({ residualQuery: null, rawQuery: 'זהבה' });
  const filters = intentToFilters(intent, { fallbackCategory: ['בעלי חיים'] });
  assert.deepEqual(filters.category, ['בעלי חיים']);
  assert.equal(filters.q, 'זהבה');
});

test('old server during rollout: vagueIntent fallback still recovers "הצגה זהבה"', () => {
  // אין מפתח residualQuery → חוזה ישן → כלל ה-fallback פעיל (אותה התנהגות כמו לפני השינוי).
  const intent = intentOf({ category: 'הצגה', vagueIntent: ['זהבה'], rawQuery: 'הצגה זהבה' });
  assert.equal(intentToFilters(intent, {}).q, 'זהבה');
});

// ---------------------------------------------------------------------------
// פילטרים אפקטיביים (2026-09-18, רגרסיית פרודקשן v19): שדה שהמנתח מילא אינו בהכרח פילטר.
// כל ה-intent-ים כאן מילה-במילה מ-smart_search_logs (tests/fixtures/smartSearchV19Intents.json).
// ---------------------------------------------------------------------------

const V19 = require('./fixtures/smartSearchV19Intents.json').intents;
const REAL_SETTLEMENTS = new Set(['חיפה', 'נתניה', 'חדרה', 'ירושלים']);
// בדיוק מה ש-parseSmartSearchQuery מוסיף: rawQuery + cityVerified (כאן מאומת מול יישובים אמיתיים).
function prod(query) {
  const it = V19[query];
  assert.ok(it, `missing production fixture for "${query}"`);
  const city = it.location.city;
  return { ...it, rawQuery: query, location: { ...it.location, cityVerified: !!city && REAL_SETTLEMENTS.has(city) } };
}
function yearsAgo(n) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 10);
}

test('A. PRODUCTION REGRESSION: "זהבה" with childNameMentioned and no such child -> q=זהבה, not the whole catalog', () => {
  const filters = intentToFilters(prod('זהבה'), { children: [] });
  assert.equal(filters.q, 'זהבה');
  assert.equal(filters.location.mode, null);
  assert.deepEqual(filters.category, []);
  assert.deepEqual(filters.age, []);
  assert.deepEqual(search(filters), ['1', '2'], 'the Goldilocks shows, not all 4 catalog items');
});

test('A2. same regression for a logged-in parent whose children have other names (profile ages still apply)', () => {
  const children = [{ name: 'נועם', birthdate: yearsAgo(5) }];
  const filters = intentToFilters(prod('זהבה'), { children });
  assert.equal(filters.q, 'זהבה', 'an unresolved name must not swallow the text');
  assert.deepEqual(filters.age, ['4-6'], 'existing default: all profile children ages, unchanged');
});

test('B. REAL RESOLVED CHILD: a mentioned name that matches a profile child keeps existing personalization', () => {
  const children = [{ name: 'נועם', birthdate: yearsAgo(5) }, { name: 'דנה', birthdate: yearsAgo(11) }];
  const intent = { ...prod('זהבה'), childNameMentioned: 'נועם', rawQuery: 'משהו לנועם' };
  const filters = intentToFilters(intent, { children });
  assert.deepEqual(filters.age, ['4-6'], "only Noam's age band - the existing resolveAge behaviour");
  assert.equal(filters.q, '', 'a resolved child IS an effective filter, so the raw query is not forced into q');
});

test('C. UNKNOWN HUMAN NAME: a bare name that is no profile child is searched as text', () => {
  const intent = { ...prod('זהבה'), childNameMentioned: 'פיטר', rawQuery: 'פיטר' };
  assert.equal(intentToFilters(intent, { children: [{ name: 'נועם', birthdate: yearsAgo(5) }] }).q, 'פיטר');
});

test('C2. an explicit age that maps to no band is not an effective filter either (same class of bug)', () => {
  // ageRangeToBands מחזיר null לגיל שנופל בין ה-bands השלמים (1.5 - בין "0-1" ל-"2-3").
  const intent = { ...prod('זהבה'), childNameMentioned: null, age: { min: 1.5, max: 1.5 } };
  const filters = intentToFilters(intent, { children: [] });
  assert.equal(filters.q, 'זהבה');
  assert.deepEqual(filters.age, []);
});

test('C3. an explicit age that DOES resolve is still an effective filter (no over-correction)', () => {
  const intent = { ...prod('זהבה'), childNameMentioned: null, age: { min: 5, max: 5 }, rawQuery: 'לילד בן 5' };
  const filters = intentToFilters(intent, { children: [] });
  assert.deepEqual(filters.age, ['4-6']);
  assert.equal(filters.q, '');
});

// הבאים הם פלט אמיתי של פרומפט v19 בהערכה אופליין (אותו מודל/temperature, אותו sanitizeIntent),
// ממופים לצורת ה-intent של השרת בדיוק כפי ש-index.ts עושה (resolveDateLabel דטרמיניסטי).
test('C4. "זהבה מחר": unresolved name next to a REAL filter (date) still survives as text', () => {
  // v19: childName:"זהבה", dateLabel:"tomorrow". לפני התיקון התאריך "נחשב מבנה" והשם נבלע לגמרי.
  const intent = { ...prod('זהבה'), when: { option: 'tomorrow', date: '2026-09-19' }, rawQuery: 'זהבה מחר' };
  const filters = intentToFilters(intent, { children: [] });
  assert.equal(filters.q, 'זהבה');
  assert.deepEqual(filters.when.options, ['tomorrow']);
});

test('C5. "משהו לדנה": a child reference for a child NOT in the profile does not become a text search', () => {
  // v19: childName:"דנה", vagueIntent:["משהו כללי"]. "לדנה" = עבור ילדה (אורח/ת בלי פרופיל), לא חיפוש המילה.
  const intent = { ...prod('זהבה'), childNameMentioned: 'דנה', vagueIntent: ['משהו כללי'], rawQuery: 'משהו לדנה' };
  const filters = intentToFilters(intent, { children: [] });
  assert.equal(filters.q, '', 'no q="דנה" - that would return almost nothing');
});

test('child-reference cue: "לX"/"עם X"/"בשביל X" are references, a bare or unrelated name is not', () => {
  assert.equal(hasChildReferenceCue('משהו לדנה', 'דנה'), true);
  assert.equal(hasChildReferenceCue('פארק עם אבישי', 'אבישי'), true);
  assert.equal(hasChildReferenceCue('משהו בשביל נועם', 'נועם'), true);
  assert.equal(hasChildReferenceCue('זהבה', 'זהבה'), false);
  assert.equal(hasChildReferenceCue('זהבה מחר', 'זהבה'), false);
  assert.equal(hasChildReferenceCue('הזהבה של אבא', 'זהבה'), false, 'boundary-aware, ה is not a reference');
});

const V19_EXPECT = [
  // [query, q, location city, category]
  ['שלושת הדובים', 'שלושת הדובים', null, []],
  ['זהבה ליד חיפה', 'זהבה', 'חיפה', []],
  ['פיטר פן ליד נתניה', 'פיטר פן', 'נתניה', []],
  ['קרקס בחיפה', 'קרקס', 'חיפה', []],
  ['קטיף ליד חדרה', '', 'חדרה', ['חווה']],
  ["ג'ימבורי בנתניה", '', 'נתניה', ["ג'ימבורי"]],
  ['מוזיאון בירושלים', '', 'ירושלים', ['מוזיאון לילדים']],
  ['חיות ליד נתניה', '', 'נתניה', ['בעלי חיים']],
  ['פעילויות בחיפה', '', 'חיפה', []],
  ['משהו כיף בחיפה', '', 'חיפה', []],
  ['ספר הג׳ונגל', 'ספר הג׳ונגל', null, []],
];
for (const [query, q, city, category] of V19_EXPECT) {
  test(`D-I. production v19 "${query}" -> q=${JSON.stringify(q)} city=${city} category=${JSON.stringify(category)}`, () => {
    const filters = intentToFilters(prod(query), { children: [] });
    assert.equal(filters.q, q, 'residual_query stays preferred; never the whole raw query for mixed queries');
    assert.equal(filters.location.city || null, city);
    assert.deepEqual(filters.category, category);
  });
}

test('J. explicit WHAT + text-inferred category: current precedence preserved (known follow-up)', () => {
  const filters = intentToFilters(prod("ג'ימבורי בנתניה"), { fallbackCategory: ['בעלי חיים'] });
  assert.deepEqual(filters.category, ["ג'ימבורי"], 'inferred, evidence-backed category still wins - NOT changed here');
  const noInference = intentToFilters(prod('זהבה'), { fallbackCategory: ['בעלי חיים'] });
  assert.deepEqual(noInference.category, ['בעלי חיים']);
  assert.equal(noInference.q, 'זהבה');
});

test('K. explicit WHERE + conflicting text location: current behaviour preserved (conflict UX deferred)', () => {
  const filters = intentToFilters(prod('זהבה ליד חיפה'), { fallbackLocation: { mode: 'city', city: 'נתניה', region: [], radiusKm: null, coords: null } });
  assert.equal(filters.location.city, 'חיפה');
  assert.equal(filters.q, 'זהבה');
});

// ---------------------------------------------------------------------------
// אינטגרציית מסך הבית: חיפוש חופשי בלי הקשר גאוגרפי → בורר-המיקום הקנוני (LocationQuickPicker).
// הזרימה המלאה: טקסט → intent אמיתי של v19 → השער (needsAreaClarification) → הבחירה בבורר נכתבת
// ל-filters.location (אותו state של WHERE) → handleClarifyConfirm → goToSmartSearchResults →
// intentToFilters עם fallbackLocation = filters.location. המיקומים כאן נבנים *בדיוק* כמו שהבורר
// בונה אותם (commitLocation → locationWithDrivingTime; "בלי מיקום" → locationWithNoRestriction).
// ---------------------------------------------------------------------------

const PICKED_NOTHING = { ...DEFAULT_FILTERS.location };
// עיר שהוקלדה בבורר: commitLocation → travelMode ריק → locationWithDrivingTime(…, 15); צ'יפ דקות →
// locationWithDrivingTime(value, N) - בדיוק כמו LocationQuickPicker.
const pickCity = (city, minutes = 15) => locationWithDrivingTime({ ...PICKED_NOTHING, mode: 'city', city }, minutes);
const pickGps = () => locationWithDrivingTime({ ...PICKED_NOTHING, mode: 'current' }, 15);
const pickNoLocation = (prev = PICKED_NOTHING) => locationWithNoRestriction(prev);

for (const [query, expectedQ] of [['זהבה', 'זהבה'], ['שלושת הדובים', 'שלושת הדובים'], ['ספר הג׳ונגל', 'ספר הג׳ונגל']]) {
  test(`HOME CLARIFY: "${query}" + picker city חולון -> q="${expectedQ}", location=חולון`, () => {
    const pending = prod(query);
    assert.equal(needsAreaClarification(pending, PICKED_NOTHING), true, 'unknown location: the canonical picker opens');
    const filters = intentToFilters(pending, { children: [], fallbackLocation: pickCity('חולון') });
    assert.equal(filters.q, expectedQ, 'the original search text is preserved');
    assert.equal(filters.location.mode, 'city');
    assert.equal(filters.location.city, 'חולון', 'the user-selected city is the location, not text');
  });
}

for (const minutes of [15, 30, 45]) {
  test(`PICKER A-C: "זהבה" + חולון + driving ${minutes} min -> q=זהבה, existing driving semantics kept`, () => {
    const picked = pickCity('חולון', minutes);
    const filters = intentToFilters(prod('זהבה'), { children: [], fallbackLocation: picked });
    assert.equal(filters.q, 'זהבה');
    assert.equal(filters.location.city, 'חולון');
    assert.equal(filters.location.travelMode, 'driving');
    assert.equal(filters.location.travelMinutes, minutes);
    assert.deepEqual(filters.location, picked, 'the picker location passes through untouched (no parallel travel logic)');
  });
}

test('PICKER D: "זהבה" + use my location -> q=זהבה, GPS mode kept', () => {
  const filters = intentToFilters(prod('זהבה'), { children: [], fallbackLocation: pickGps() });
  assert.equal(filters.q, 'זהבה');
  assert.equal(filters.location.mode, 'current');
});

for (const [query, expectedQ] of [['זהבה', 'זהבה'], ['שלושת הדובים', 'שלושת הדובים'], ['ספר הג׳ונגל', 'ספר הג׳ונגל']]) {
  test(`PICKER E-G: "${query}" + בלי מיקום -> q preserved, explicit nationwide, no geographic reference`, () => {
    const filters = intentToFilters(prod(query), { children: [], fallbackLocation: pickNoLocation() });
    assert.equal(filters.q, expectedQ);
    assert.equal(filters.location.mode, 'nationwide');
    assert.equal(filters.location.city, '');
    assert.deepEqual(filters.location.region, []);
    assert.equal(filters.location.coords, null);
    assert.equal(filters.location.radiusKm, null);
    assert.equal('travelMode' in filters.location, false, 'no walking/driving without an origin');
  });
}

test('PICKER E: "זהבה" + בלי מיקום finds the Goldilocks shows in every city (no geographic restriction)', () => {
  const filters = intentToFilters(prod('זהבה'), { children: [], fallbackLocation: pickNoLocation() });
  assert.deepEqual(search(filters), ['1', '2'], 'תל אביב and רעננה both included');
});

test('NO LOOP: after choosing בלי מיקום the gate does not reopen the picker (unknown != explicit no-location)', () => {
  assert.equal(needsAreaClarification(prod('זהבה'), PICKED_NOTHING), true, 'unknown → ask');
  assert.equal(needsAreaClarification(prod('זהבה'), pickNoLocation()), false, 'explicit no-location → proceed');
  assert.equal(needsAreaClarification(prod('שלושת הדובים'), pickNoLocation()), false);
});

test('NO LOCATION replaces stale geography completely (saved city / GPS / previous region are not reused)', () => {
  for (const prev of [pickCity('חיפה', 45), pickGps(), { ...PICKED_NOTHING, mode: 'region', region: ['השרון'] }]) {
    const loc = pickNoLocation(prev);
    assert.equal(loc.mode, 'nationwide');
    assert.equal(loc.city, '');
    assert.deepEqual(loc.region, []);
    assert.equal(loc.coords, null);
    assert.equal('travelMode' in loc, false);
  }
});

test('RESULTS EDIT: בלי מיקום removes only geography - category/age/date filters are preserved', () => {
  const before = { ...DEFAULT_FILTERS, q: '', category: ['הצגה'], age: ['4-6'], when: { options: ['weekend'], date: null }, location: pickCity('רעננה') };
  const after = { ...before, location: pickNoLocation(before.location) }; // FiltersSheet: onChange('location', v)
  assert.deepEqual(after.category, ['הצגה']);
  assert.deepEqual(after.age, ['4-6']);
  assert.deepEqual(after.when, { options: ['weekend'], date: null });
  assert.equal(after.location.mode, 'nationwide');
  // category+age still filter; the city no longer does: both shows (תל אביב + רעננה) qualify by location
  const loc = applyFilters(CATALOG, { ...DEFAULT_FILTERS, category: ['הצגה'], location: after.location }, null, [], [], [], []).map((a) => a.id);
  assert.deepEqual(loc, ['1', '2']);
});

test('NATIONWIDE RANKING: no hidden GPS origin - device coords do not change the order, and it is deterministic', () => {
  const near = { id: 'near', title: 'הצגה א', category: 'הצגה', city: 'חולון', region: 'גוש דן והמרכז', lat: 32.01, lng: 34.78 };
  const far = { id: 'far', title: 'הצגה ב', category: 'הצגה', city: 'אילת', region: 'הדרום והנגב', lat: 29.55, lng: 34.95 };
  const acts = [far, near];
  const filters = { ...DEFAULT_FILTERS, location: pickNoLocation() };
  const gps = { latitude: 32.0, longitude: 34.77 }; // right next to "near"
  const withGps = rankActivities(acts, filters, gps, [], [], [], null, null, []).map((a) => a.id);
  const without = rankActivities(acts, filters, null, [], [], [], null, null, []).map((a) => a.id);
  assert.deepEqual(withGps, without, 'GPS does not pull nearby activities up when the user chose no location');
  assert.deepEqual(rankActivities(acts, filters, gps, [], [], [], null, null, []).map((a) => a.id), withGps, 'stable across calls');
});

test('EXISTING CONTEXT: a location in the text itself never opens the picker ("זהבה ליד חיפה", "פעילויות בחיפה")', () => {
  assert.equal(needsAreaClarification(prod('זהבה ליד חיפה'), PICKED_NOTHING), false);
  assert.equal(needsAreaClarification(prod('פעילויות בחיפה'), PICKED_NOTHING), false);
});

// ---------------------------------------------------------------------------
// סעיף "כמה רחוק" בבורר: "לא משנה לי המרחק" (travelMode 'any') מול נסיעה בלי זמן מפורש.
// A = נסיעה בלי דקות (לחיצה חוזרת על הצ'יפ שנבחר: travelMode 'driving', travelMinutes null).
// G = "לא משנה לי המרחק" / "ללא הגבלת זמן" (locationWithAnyDistance).
// ---------------------------------------------------------------------------

const HAIFA = { lat: 32.794, lng: 34.9896 };
const TRAVEL_CATALOG = [
  { id: 'h1', title: 'הצגה בחיפה', category: 'הצגה', city: 'חיפה', region: 'חיפה והקריות', lat: 32.795, lng: 34.99 },
  { id: 'h2', title: 'סדנה בחיפה', category: 'סדנה', city: 'חיפה', region: 'חיפה והקריות', lat: 32.8, lng: 34.98 },
  { id: 'ka', title: 'פארק בקריית אתא', category: 'פארק', city: 'קריית אתא', region: 'חיפה והקריות', lat: 32.806, lng: 35.106 }, // ~11 ק"מ
  { id: 'ta', title: 'מוזיאון בתל אביב', category: 'מוזיאון', city: 'תל אביב', region: 'גוש דן והמרכז', lat: 32.08, lng: 34.78 }, // ~80 ק"מ
];
const ids = (list) => list.map((a) => a.id).sort();
const withLocation = (location) => ({ ...DEFAULT_FILTERS, location });
const drivingNoTime = (loc) => ({ ...locationWithDrivingTime(loc, 30), travelMinutes: null }); // A
const noTimeLimit = (loc) => locationWithAnyDistance(locationWithDrivingTime(loc, 30)); // G

test('TRAVEL A vs G (city חיפה): same filtering, ranking and Smart Radius - they differ only in label state', () => {
  const a = drivingNoTime({ ...PICKED_NOTHING, mode: 'city', city: 'חיפה' });
  const g = noTimeLimit({ ...PICKED_NOTHING, mode: 'city', city: 'חיפה' });
  assert.deepEqual([a.mode, a.city, a.travelMode, a.travelMinutes, a.radiusKm], ['city', 'חיפה', 'driving', null, null]);
  assert.deepEqual([g.mode, g.city, g.travelMode, g.travelMinutes, g.radiusKm], ['city', 'חיפה', 'any', 30, null]);
  assert.deepEqual(ids(applyFilters(TRAVEL_CATALOG, withLocation(a), null, [], [], [], [])), ['h1', 'h2']);
  assert.deepEqual(ids(applyFilters(TRAVEL_CATALOG, withLocation(g), null, [], [], [], [])), ['h1', 'h2']);
  const rank = (loc) => rankActivities(TRAVEL_CATALOG, withLocation(loc), null, [], [], [], null, HAIFA, []).map((x) => x.id);
  assert.deepEqual(rank(a), rank(g));
  const radius = (loc) => applyFiltersWithSmartRadius(TRAVEL_CATALOG, withLocation(loc), null, [], [], [], HAIFA, []);
  assert.deepEqual(ids(radius(a).activities), ids(radius(g).activities));
  assert.equal(radius(a).radiusExpanded, radius(g).radiusExpanded);
});

test('TRAVEL A vs G (my location): NOT equivalent - driving keeps a 10 km radius, "no time limit" removes it', () => {
  const gps = { latitude: HAIFA.lat, longitude: HAIFA.lng };
  const a = drivingNoTime({ ...PICKED_NOTHING, mode: 'current' });
  const g = noTimeLimit({ ...PICKED_NOTHING, mode: 'current' });
  assert.equal(a.radiusKm, DEFAULT_PRECISE_RADIUS_KM);
  assert.equal(g.radiusKm, null);
  assert.deepEqual(ids(applyFilters(TRAVEL_CATALOG, withLocation(a), gps, [], [], [], [])), ['h1', 'h2'], 'within 10 km only');
  assert.deepEqual(ids(applyFilters(TRAVEL_CATALOG, withLocation(g), gps, [], [], [], [])), ['h1', 'h2', 'ka', 'ta'], 'no distance limit');
  // Smart Radius: A widens to 15 km (adds קריית אתא) but never reaches תל אביב; G has nothing to widen.
  const origin = HAIFA;
  assert.deepEqual(ids(applyFiltersWithSmartRadius(TRAVEL_CATALOG, withLocation(a), gps, [], [], [], origin, []).activities), ['h1', 'h2', 'ka']);
  // G keeps the origin: everything, nearest first.
  const ranked = rankActivities(TRAVEL_CATALOG, withLocation(g), gps, [], [], [], null, origin, []).map((x) => x.id);
  assert.equal(ranked[ranked.length - 1], 'ta', 'farthest ranks last - the origin still orders results');
});

test('TRAVEL B-D: 15/30/45 min are display-only - each applies the same precise radius (existing semantics)', () => {
  for (const minutes of [15, 30, 45]) {
    const loc = locationWithDrivingTime({ ...PICKED_NOTHING, mode: 'current' }, minutes);
    assert.equal(loc.travelMode, 'driving');
    assert.equal(loc.travelMinutes, minutes);
    assert.equal(loc.radiusKm, DEFAULT_PRECISE_RADIUS_KM);
  }
});

test('TRAVEL SELECTION: one source of truth for what the picker shows as selected', () => {
  const city = { ...PICKED_NOTHING, mode: 'city', city: 'חיפה' };
  assert.deepEqual(travelSelection(locationWithDrivingTime(city, 30)), { walking: false, driving: true, minutes: 30, noTimeLimit: false });
  assert.deepEqual(travelSelection(noTimeLimit(city)), { walking: false, driving: true, minutes: null, noTimeLimit: true }, 'no-time-limit lives in the driving row; stale 30 is not shown');
  assert.deepEqual(travelSelection(drivingNoTime(city)), { walking: false, driving: true, minutes: null, noTimeLimit: false });
  const walking = { ...locationWithDrivingTime({ ...PICKED_NOTHING, mode: 'current' }, 45), travelMode: 'walking', radiusKm: 0.75 };
  assert.deepEqual(travelSelection(walking), { walking: true, driving: false, minutes: null, noTimeLimit: false }, 'remembered 45 is not shown while walking');
  const none = { walking: false, driving: false, minutes: null, noTimeLimit: false };
  assert.deepEqual(travelSelection(PICKED_NOTHING), none, 'unknown location: no travel selection');
  assert.deepEqual(travelSelection(pickNoLocation(locationWithDrivingTime(city, 30))), none, 'no location: no travel selection');
});

test('TRAVEL J: בלי מיקום drops every travel field - no stale restriction and no origin', () => {
  for (const prev of [pickCity('חיפה', 30), noTimeLimit({ ...PICKED_NOTHING, mode: 'current' }), { ...pickGps(), travelMode: 'walking', radiusKm: 0.75 }]) {
    const loc = pickNoLocation(prev);
    assert.equal('travelMode' in loc, false);
    assert.equal('travelMinutes' in loc, false, 'a previous 30 min cannot come back later');
    assert.equal(loc.radiusKm, null);
    assert.equal(loc.coords, null);
    assert.deepEqual(ids(applyFilters(TRAVEL_CATALOG, withLocation(loc), { latitude: HAIFA.lat, longitude: HAIFA.lng }, [], [], [], [])), ['h1', 'h2', 'ka', 'ta']);
    assert.equal(applyFiltersWithSmartRadius(TRAVEL_CATALOG, withLocation(loc), null, [], [], [], null, []).radiusExpanded, null);
  }
});

test('TRAVEL K: בלי מיקום → חיפה starts from the normal default (driving 15), not the old 30', () => {
  const nationwide = pickNoLocation(pickCity('חיפה', 30));
  const typed = { ...nationwide, mode: 'city', city: 'חיפה' };
  assert.equal(typed.travelMode, undefined, 'nothing to restore - the picker applies its first-time default');
  const picked = locationWithDrivingTime(typed, 15); // commitLocation: travelMode undefined → driving 15
  assert.deepEqual(travelSelection(picked), { walking: false, driving: true, minutes: 15, noTimeLimit: false });
});

test('SMART SEARCH: "זהבה" + חולון + no time limit keeps q and the origin city', () => {
  const picked = noTimeLimit({ ...PICKED_NOTHING, mode: 'city', city: 'חולון' });
  const filters = intentToFilters(prod('זהבה'), { children: [], fallbackLocation: picked });
  assert.equal(filters.q, 'זהבה');
  assert.equal(filters.location.city, 'חולון');
  assert.equal(filters.location.travelMode, 'any');
});

// ---------------------------------------------------------------------------
// "השתמשו במיקום שלי": 'current' נשמר רק אחרי הרשאה + מיקום שמיש של *הבקשה הזו*.
// אותו רצף בדיוק כמו useCurrentLocation ב-LocationQuickPicker: requestCurrentPosition →
// applyCurrentPositionResult → (commitLocation: travelMode ריק → נסיעה 15).
// ---------------------------------------------------------------------------

const fakeLocation = ({ status = 'granted', canAskAgain, permissionThrows = false, position, positionThrows = false, hang = false } = {}) => {
  const calls = { permission: 0, position: 0 };
  return {
    calls,
    requestForegroundPermissionsAsync: async () => {
      calls.permission += 1;
      if (permissionThrows) throw new Error('permission request failed');
      return { status, canAskAgain };
    },
    getCurrentPositionAsync: () => {
      calls.position += 1;
      if (hang) return new Promise(() => {});
      if (positionThrows) return Promise.reject(new Error('location unavailable'));
      return Promise.resolve(position ?? { coords: { latitude: HAIFA.lat, longitude: HAIFA.lng } });
    },
  };
};
// הבורר: תוצאה → מיקום (כישלון = אותו אובייקט בדיוק) → ברירת-המחדל של commitLocation
const tapMyLocation = async (prev, api, opts) => {
  const result = await requestCurrentPosition(api, opts);
  const next = applyCurrentPositionResult(prev, result);
  const location = result.ok && next.location.travelMode === undefined ? locationWithDrivingTime(next.location, 15) : next.location;
  return { result, location, coords: next.coords };
};
const FAILURES = {
  denied: () => fakeLocation({ status: 'denied' }),
  blocked: () => fakeLocation({ status: 'denied', canAskAgain: false }),
  permissionRequestFails: () => fakeLocation({ permissionThrows: true }),
  positionFails: () => fakeLocation({ positionThrows: true }),
  unusableCoords: () => fakeLocation({ position: { coords: { latitude: NaN, longitude: 34.9 } } }),
  outOfRangeCoords: () => fakeLocation({ position: { coords: { latitude: 190, longitude: 34.9 } } }),
  noCoords: () => fakeLocation({ position: {} }),
};

test('GPS A: no location + permission denied -> nothing committed, "denied" feedback, no position lookup', async () => {
  const api = fakeLocation({ status: 'denied' });
  const { result, location, coords } = await tapMyLocation(PICKED_NOTHING, api);
  assert.deepEqual(result, { ok: false, error: 'denied' });
  assert.equal(location, PICKED_NOTHING, 'the very same location object - untouched');
  assert.equal(location.mode, null, 'still UNKNOWN - not current, not nationwide');
  assert.equal(coords, null);
  assert.equal(api.calls.position, 0, 'permission alone is never treated as success');
});

test('GPS A: permanently blocked permission reports "blocked" (Open Settings on native), still no state change', async () => {
  const { result, location } = await tapMyLocation(PICKED_NOTHING, fakeLocation({ status: 'denied', canAskAgain: false }));
  assert.deepEqual(result, { ok: false, error: 'blocked' });
  assert.equal(location.mode, null);
});

test('GPS B: permission granted but the position lookup fails -> nothing committed', async () => {
  const { result, location, coords } = await tapMyLocation(PICKED_NOTHING, fakeLocation({ positionThrows: true }));
  assert.deepEqual(result, { ok: false, error: 'locationFailed' });
  assert.equal(location.mode, null);
  assert.equal(coords, null);
});

test('GPS B: a lookup that never returns times out instead of leaving the picker "locating" forever', async () => {
  const { result, location } = await tapMyLocation(PICKED_NOTHING, fakeLocation({ hang: true }), { timeoutMs: 20 });
  assert.deepEqual(result, { ok: false, error: 'locationFailed' });
  assert.equal(location.mode, null);
});

test('GPS B: every failure kind leaves UNKNOWN unknown (never current, never nationwide)', async () => {
  for (const [kind, make] of Object.entries(FAILURES)) {
    const { result, location } = await tapMyLocation(PICKED_NOTHING, make());
    assert.equal(result.ok, false, kind);
    assert.equal(location, PICKED_NOTHING, `${kind}: untouched`);
  }
});

test('GPS C: permission + valid position -> current mode, the fresh coordinates, the existing driving default', async () => {
  const { result, location, coords } = await tapMyLocation(PICKED_NOTHING, fakeLocation());
  assert.equal(result.ok, true);
  assert.deepEqual(coords, { latitude: HAIFA.lat, longitude: HAIFA.lng });
  assert.equal(location.mode, 'current');
  assert.equal(location.travelMode, 'driving');
  assert.equal(location.travelMinutes, 15);
  assert.equal(location.radiusKm, DEFAULT_PRECISE_RADIUS_KM);
});

test('GPS D: existing city חיפה + failed attempt -> חיפה (and its travel choice) preserved exactly', async () => {
  const haifa = pickCity('חיפה', 30);
  for (const make of Object.values(FAILURES)) {
    const { location } = await tapMyLocation(haifa, make());
    assert.equal(location, haifa);
    assert.deepEqual([location.mode, location.city, location.travelMinutes], ['city', 'חיפה', 30]);
  }
});

test('GPS D: explicit בלי מיקום + failed attempt stays nationwide; a failure never CREATES nationwide', async () => {
  const nationwide = pickNoLocation();
  assert.equal((await tapMyLocation(nationwide, fakeLocation({ status: 'denied' }))).location, nationwide);
  assert.notEqual((await tapMyLocation(PICKED_NOTHING, fakeLocation({ status: 'denied' }))).location.mode, 'nationwide');
});

test('GPS E: old coordinates in memory do not turn a failed NEW attempt into a success', async () => {
  const earlier = await tapMyLocation(pickCity('חיפה'), fakeLocation()); // an earlier success this session
  assert.ok(earlier.coords, 'old coordinates exist');
  const afterCity = pickCity('נתניה'); // the user later moved to a city
  const retry = await tapMyLocation(afterCity, fakeLocation({ positionThrows: true }));
  assert.equal(retry.result.ok, false);
  assert.equal(retry.coords, null, 'the failed attempt yields no coordinates of its own');
  assert.equal(retry.location, afterCity, 'not switched back to "my location" on the strength of the old fix');
});

test('GPS F-H: "זהבה" + GPS denied keeps q pending; then חולון or בלי מיקום completes it without retyping', async () => {
  const pending = prod('זהבה');
  assert.equal(needsAreaClarification(pending, PICKED_NOTHING), true);
  const { location: afterDenied } = await tapMyLocation(PICKED_NOTHING, fakeLocation({ status: 'denied' }));
  assert.equal(needsAreaClarification(pending, afterDenied), true, 'F: still no location - the picker stays open, nothing to confirm yet');
  // G
  const withCity = intentToFilters(pending, { children: [], fallbackLocation: pickCity('חולון', 15) });
  assert.deepEqual([withCity.q, withCity.location.mode, withCity.location.city], ['זהבה', 'city', 'חולון']);
  // H
  const nationwide = intentToFilters(pending, { children: [], fallbackLocation: pickNoLocation(afterDenied) });
  assert.deepEqual([nationwide.q, nationwide.location.mode], ['זהבה', 'nationwide']);
});

test('GPS I: "זהבה" + GPS success -> q kept, current mode, and the origin really drives distance filtering', async () => {
  const { location, coords } = await tapMyLocation(PICKED_NOTHING, fakeLocation());
  const filters = intentToFilters(prod('זהבה'), { children: [], fallbackLocation: location });
  assert.equal(filters.q, 'זהבה');
  assert.equal(filters.location.mode, 'current');
  // the coordinates Results receives (homeCoords) filter by distance: Tel Aviv (~80 km) is out
  assert.deepEqual(ids(applyFilters(TRAVEL_CATALOG, withLocation(filters.location), coords, [], [], [], [])), ['h1', 'h2']);
});

test('GPS J: "my location" is only ever committed together with usable fresh coordinates', async () => {
  for (const prev of [PICKED_NOTHING, pickCity('חיפה'), pickNoLocation(), { ...PICKED_NOTHING, mode: 'region', region: ['השרון'] }]) {
    for (const make of Object.values(FAILURES)) {
      const { location, coords } = await tapMyLocation(prev, make());
      assert.equal(location.mode === 'current', false, 'no failure can produce current mode');
      assert.equal(coords, null);
    }
    const ok = await tapMyLocation(prev, fakeLocation());
    assert.equal(ok.location.mode, 'current');
    assert.ok(Number.isFinite(ok.coords.latitude) && Number.isFinite(ok.coords.longitude));
  }
});

test('HOME CLARIFY: why the channel matters - injecting the chosen city into the MODEL intent loses the text', () => {
  // ההתנהגות הישנה של handleClarifyCity (מתועדת כדי שלא תחזור): העיר נראית כמו ניחוש-מודל ומודחת.
  const pending = prod('זהבה');
  const old = intentToFilters({ ...pending, location: { ...pending.location, city: 'חולון' } }, { children: [] });
  assert.equal(old.q, 'חולון');
  assert.equal(old.location.mode, null);
});

test('PROVENANCE: a model-inferred unverified city without geographic wording is still demoted', () => {
  const inferred = intentOf({ location: { city: 'זהבה', cityVerified: false }, rawQuery: 'זהבה' });
  const filters = intentToFilters(inferred, {});
  assert.equal(filters.location.mode, null);
  assert.equal(filters.q, 'זהבה');
});

test('PROVENANCE: the same unverified city is kept when it came from the user (citySource:user)', () => {
  const fromUser = intentOf({ location: { city: 'זהבה', cityVerified: false, citySource: 'user' }, rawQuery: 'זהבה' });
  assert.equal(intentToFilters(fromUser, {}).location.city, 'זהבה', 'provenance, not verification, decides here');
});

test('PROVENANCE: explicit WHERE chosen before the search is authoritative and skips the area question', () => {
  const where = { mode: 'city', city: 'נתניה', region: [], radiusKm: null, coords: null };
  assert.equal(needsAreaClarification(prod('זהבה'), where), false);
  const filters = intentToFilters(prod('זהבה'), { children: [], fallbackLocation: where });
  assert.equal(filters.location.city, 'נתניה');
  assert.equal(filters.q, 'זהבה');
});

test('PROVENANCE: GPS/current location also skips the area question (existing semantics)', () => {
  assert.equal(needsAreaClarification(prod('זהבה'), { mode: 'current', radiusKm: 10 }), false);
  assert.equal(needsAreaClarification(prod('זהבה ליד חיפה'), null), false, 'a location in the text itself never asks');
});

test('STREET CLARIFY: a user-typed city returned via cityOverride is user-sourced - never re-verified or demoted', async () => {
  // "משחקייה ברחוב הרצל" → השרת ביקש עיר → המשתמש הקליד "רמת אביב" (לא יישוב בטבלת settlements).
  const serverIntent = intentOf({ category: 'משחקייה', location: { city: 'רמת אביב', street: 'הרצל', relation: 'exact', coords: { lat: 32.11, lng: 34.8 } } });
  const calls = stubSupabase({ intent: serverIntent, settlementRows: [] });
  const { intent } = await parseSmartSearchQuery('משחקייה ברחוב הרצל', { cityOverride: 'רמת אביב', pendingIntent: {} });
  assert.equal(calls.settlementQueries, 0, 'no verification for a user-provided city');
  assert.equal(intent.location.citySource, 'user');
  const filters = intentToFilters(intent, {});
  assert.equal(filters.location.mode, 'address', 'the geocoded street is kept, not dropped');
  assert.equal(filters.q, '');
});

test('STREET CLARIFY: a city the model returns that is NOT the override stays model-sourced (checked as usual)', async () => {
  // שם ייחודי: verifyCityInCatalog שומר cache ברמת-המודול, ו"זהבה" נבדק בבדיקה מאוחרת יותר.
  const calls = stubSupabase({ intent: intentOf({ location: { city: 'דובילנד' } }), settlementRows: [] });
  const { intent } = await parseSmartSearchQuery('דובילנד', { cityOverride: 'חולון', pendingIntent: {} });
  assert.equal(intent.location.citySource, undefined);
  assert.equal(calls.settlementQueries, 1);
  assert.equal(intentToFilters(intent, {}).location.mode, null, 'still demoted');
});

// ---------------------------------------------------------------------------
// parseSmartSearchQuery - התפר שמעשיר את ה-intent (rawQuery + cityVerified)
// ---------------------------------------------------------------------------

test('parseSmartSearchQuery annotates the raw query and verifies an unknown city against the catalog', async () => {
  const calls = stubSupabase({ intent: intentOf({ location: { city: 'זהבה' } }), settlementRows: [] });
  const { intent } = await parseSmartSearchQuery('זהבה');
  assert.equal(intent.rawQuery, 'זהבה');
  assert.equal(intent.location.cityVerified, false, 'אין יישוב כזה');
  assert.equal(calls.settlementQueries, 1);
  assert.equal(intentToFilters(intent, {}).q, 'זהבה');
});

test('parseSmartSearchQuery marks a real settlement as verified and keeps it as a location', async () => {
  stubSupabase({ intent: intentOf({ location: { city: 'שדרות' } }), settlementRows: [{ name_he: 'שדרות' }] });
  const { intent } = await parseSmartSearchQuery('שדרות');
  assert.equal(intent.location.cityVerified, true);
  assert.equal(intentToFilters(intent, {}).location.city, 'שדרות');
});

test('parseSmartSearchQuery skips the catalog lookup entirely when the query has geographic language', async () => {
  // אופטימיזציה: עם רמז לשוני ההכרעה זהה בלי קשר לאימות - אין סיבה לשלם round-trip.
  const calls = stubSupabase({ intent: intentOf({ location: { city: 'חיפה' } }), settlementRows: [{ name_he: 'חיפה' }] });
  const { intent } = await parseSmartSearchQuery('משחקייה בחיפה');
  assert.equal(calls.settlementQueries, 0, 'לא בוצעה שאילתת-אימות');
  assert.equal(intentToFilters(intent, {}).location.city, 'חיפה');
});
