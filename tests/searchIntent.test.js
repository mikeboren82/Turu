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
const { intentToFilters, parseSmartSearchQuery } = require('../lib/smartSearch');
const { applyFilters } = require('../lib/filterActivities');
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
