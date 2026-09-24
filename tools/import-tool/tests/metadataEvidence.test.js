// Metadata evidence safety (2026-09-24, verify_location pilot #7). The Cleaner's metadata enricher read whole pages -
// header, mega-menu, footer - and the bare phrase "גיל הרך" in a municipal menu item ("רשות הצעירים והגיל הרך") became
// HIGH "explicit ages 0-5" for an evening orchestra concert, which the canonical relevance rule then accepted as
// first-party child evidence. Age tags <a>13-18</a><br><a>6-12</a> were flattened to "13-186-12" and missed.
// Pinned here: content-only evidence, bound early-childhood wording, compact age tags, provenance, and the canonical
// policy's refusal of legacy / invalidated enrichment.
const test = require('node:test');
const assert = require('node:assert/strict');
const { agesIn, resolveIncomingMetadata } = require('../cleaner/fieldEnricher');
const { contentText } = require('../lib/pageExtract');
const { evaluatePublishPolicy, withoutUntrustedEnrichment } = require('../lib/publishPolicy');

// ---- page fixtures (shaped like the two sites in the pilot; text shortened) ----
const HAIFA_MENU = '<header><div class="services_menu"><ul class="menu"><li class="menu-item"><a href="/youth">רשות הצעירים והגיל הרך</a></li><li><a href="/culture">תרבות</a></li></ul></div></header>';
const HAIFA_FOOTER = '<footer><ul class="footer_menu"><li><a href="/youth">רשות הצעירים והגיל הרך</a></li></ul></footer>';
const page = (title, main, { head = '', foot = '' } = {}) => `<html><head><title>${title}</title></head><body>${head}<main>${main}</main>${foot}</body></html>`;
const listing = (name, href, extra = '') => page('אירועים', `<div class="events"><div class="event"><h3><a href="${href}">${name}</a></h3>${extra}</div></div>`, { head: HAIFA_MENU, foot: HAIFA_FOOTER });

// a stub Supabase client: records every incoming_activities update, answers "1 row written"
function stubClient() {
  const writes = [];
  const chain = (payload) => { const q = { eq: () => q, in: () => q, select: async () => ({ data: [{ id: 'r1' }], error: null }), then: (res) => res({ data: null, error: null }) }; writes.push(payload); return q; };
  return { writes, from: () => ({ update: chain }) };
}
async function enrich({ name, description, listingHtml, detailUrl, detailHtml, audience }) {
  const LIST = 'https://city.example/events/';
  const cache = new Map([['page:' + LIST, { ok: true, html: listingHtml }], ['page:' + detailUrl, { ok: true, html: detailHtml }]]);
  const client = stubClient();
  const row = { id: 'r1', status: 'needs_review', page_url: LIST, source: {}, validation_issues: ['קהל יעד לא ברור'], extracted_data: { name, description, schedule_type: 'one_time', one_time_date: '2026-10-06', entity_type: 'אירוע', ...(audience ? { audience } : {}) } };
  const r = await resolveIncomingMetadata(client, row, { today: '2026-09-24', cache });
  return { r, written: client.writes.map((w) => w.extracted_data).filter(Boolean).pop() || null };
}

// ---- 1. age parser ----
test('explicit age ranges, en-dash, union of ranges printed together, TURU one-span semantics', () => {
  const span = (t) => { const a = agesIn(t); return a && [a.min_age, a.max_age]; };
  assert.deepEqual(span('6-12'), [6, 12]);
  assert.deepEqual(span('13-18'), [13, 18]);
  assert.deepEqual(span('6–12'), [6, 12]);
  assert.deepEqual(span('13–18'), [13, 18]);
  assert.deepEqual(span('גילאי 6-12, 13-18'), [6, 18]);
  assert.deepEqual(span('הצגה לגילאי 3-6'), [3, 6]);
  assert.deepEqual(span('לגילאי 4+'), [4, null]);
  assert.deepEqual(span('מגיל 5'), [5, null]);
  assert.equal(agesIn('גילאי 6-12, 13-18').evidence, 'גילאי 6-12, 13-18');
  assert.equal(agesIn('6-12').kind, 'explicit_age');
});

test('adjacent / run-together age tags split into their ranges (never one nonsensical span, never missed)', () => {
  for (const t of ['6-1213-18', '13-186-12', '13-18 \n6-12']) {
    const a = agesIn(t);
    assert.deepEqual([a.min_age, a.max_age], [6, 18], t);
    assert.equal(a.evidence.split(', ').length, 2, t);
  }
});

test('numbers that are not ages: dates, times, hours, phone numbers, grades, durations', () => {
  for (const t of ['18-28.09.26', '10-12.10', '2026-10-06', '10:00-12:00', 'בין השעות 10-12', '050-1234567', 'כיתות 1-6', 'הרצאה בת 45 דקות', 'מופע לכל המשפחה']) assert.equal(agesIn(t), null, t);
});

test('a range printed far from the first one (another event on the page) is not merged in', () => {
  const a = agesIn('הצגה לגילאי 3-6 ' + 'מידע נוסף על המקום והחניה בסביבה, '.repeat(3) + 'סדנה אחרת 9-12');
  assert.deepEqual([a.min_age, a.max_age], [3, 6]);
});

// ---- 2. bare "גיל הרך" ----
test('bare "גיל הרך" and department / menu names are NOT age evidence', () => {
  for (const t of ['גיל הרך', 'רשות הצעירים והגיל הרך', 'תחום הגיל הרך', 'האגף לגיל הרך מזמין את התושבים', 'המחלקה לגיל הרך', 'פעוטות', 'תינוקות']) assert.equal(agesIn(t), null, t);
});

test('early-childhood wording bound to the event still counts (0-5, child wording)', () => {
  for (const [t, ev] of [['סדנת תנועה לגיל הרך', 'לגיל הרך'], ['שעת סיפור לילדים בגיל הרך והוריהם', 'בגיל הרך'], ['מפגש הורה ופעוט', 'הורה ופעוט'], ['חוג מוזיקה לפעוטות', 'לפעוטות']]) {
    assert.deepEqual(agesIn(t), { min_age: 0, max_age: 5, evidence: ev, kind: 'child_wording' }, t);
  }
});

// ---- 3. content-only text ----
test('contentText drops header, footer, nav and mega-menus; separators keep adjacent tags apart', () => {
  const html = `<body>${HAIFA_MENU}<div class="mega-menu"><a>תחום הגיל הרך</a></div><nav><a>גיל הרך</a></nav><main><div class="ages"><a href="/age/youth/">13-18</a><br><a href="/age/children/">6-12</a><br></div></main>${HAIFA_FOOTER}</body>`;
  const t = contentText(html, { separators: true });
  assert.ok(!t.includes('גיל הרך'), t);
  assert.match(t, /13-18\s+6-12/);
  assert.equal(contentText(html), '13-186-12', 'without separators the old flattening glues the tags (location evidence keeps it)');
});

// ---- 4. end to end: the enricher on pages ----
test('A. CHAPLIN: adult evening concert, "גיל הרך" only in header / mega-menu / footer -> no age, no child audience', async () => {
  const name = 'זמנים מודרניים: תזמורת המהפכה פוגשת את צ׳פלין';
  const detail = page(name, `<h1>${name}</h1><p>מתי? יום ג' 06/10/2026, שעה 20:30</p><p>איפה? אודיטוריום חיפה שד' הנשיא 142, חיפה</p><p>90 שנה אחרי הבכורה הקולנועית, תזמורת המהפכה מלווה בשידור חי את הסרט.</p>`, { head: HAIFA_MENU, foot: HAIFA_FOOTER });
  const { r, written } = await enrich({ name, description: 'הופעה של תזמורת המהפכה בשילוב סרט צ׳פלין קלאסי באודיטוריום חיפה.', listingHtml: listing(name, '/event/chaplin/'), detailUrl: 'https://city.example/event/chaplin/', detailHtml: detail });
  assert.equal(r.fields.audience, undefined, JSON.stringify(r.fields));
  assert.ok(r.remaining.includes('קהל יעד לא ברור'));
  assert.equal(written?.min_age ?? null, null);
});

test('B. COOKIE WORKSHOP: event-local tags 13-18 + 6-12 -> 6..18 HIGH event-local, never 0-5 from the "תחום הגיל הרך" menu', async () => {
  const name = 'סדנת עוגיות בצק פריך';
  const menu = '<header><div class="header-menu-container"><div class="block-menu"><ul><li><a href="/early">תחום הגיל הרך</a></li></ul></div></div></header>';
  const detail = page(name, `<h1>${name}</h1><div class="place"><a href="/place/safra/">מרכז קהילתי ספרא</a></div><p class="date">30.09.26</p><div class="ages"><a href="/age/youth/">13-18</a><br><a href="/age/children/">6-12</a><br></div><p>בסדנה זו נלמד להכין בצק פריך שלב אחרי שלב</p>`, { head: menu });
  const { r, written } = await enrich({ name, description: 'סדנת בישול לעיצוב עוגיות בצק פריך.', listingHtml: listing(name, '/events/cookies/'), detailUrl: 'https://city.example/events/cookies/', detailHtml: detail });
  assert.equal(r.fields.audience.evidence, 'explicit ages: 13-18, 6-12');
  assert.equal(r.fields.audience.confidence, 'HIGH');
  assert.equal(r.fields.audience.provenance, 'event_local_explicit_age');
  assert.deepEqual([written.min_age, written.max_age], [6, 18]);
});

test('C. SHIRI MAIMON 2027: navigation "גיל הרך" does not make a pop concert a child event', async () => {
  const name = 'שירי מימון - מופע להקה 2027';
  const detail = page(name, `<h1>${name}</h1><p>שירי מימון במופע להקה חדש עם כל הלהיטים. כרטיסים בקופה.</p>`, { head: HAIFA_MENU, foot: HAIFA_FOOTER });
  const { r } = await enrich({ name, description: 'מופע להקה של שירי מימון', listingHtml: listing(name, '/event/shiri/'), detailUrl: 'https://city.example/event/shiri/', detailHtml: detail });
  assert.equal(r.fields.audience, undefined);
});

test('D. genuine toddler event: event-local "לגיל הרך" is still recognized, as child wording (MEDIUM)', async () => {
  const name = 'שעת סיפור ותנועה';
  const detail = page(name, `<h1>${name}</h1><p>שעת סיפור ותנועה לגיל הרך בספרייה העירונית, בליווי הורה.</p>`, { head: HAIFA_MENU, foot: HAIFA_FOOTER });
  const { r, written } = await enrich({ name, description: 'שעת סיפור בספרייה', listingHtml: listing(name, '/event/story/'), detailUrl: 'https://city.example/event/story/', detailHtml: detail });
  assert.equal(r.fields.audience.evidence, 'explicit ages: לגיל הרך');
  assert.equal(r.fields.audience.provenance, 'event_local_child_wording');
  assert.equal(r.fields.audience.confidence, 'MEDIUM');
  assert.deepEqual([written.min_age, written.max_age], [0, 5]);
});

test('adults-only workshop whose content also has a child word: no audience is resolved (a person decides)', async () => {
  const name = 'סדנת ציור בהדרכת שרה נבון';
  const detail = page(name, `<h1>${name}</h1><p>מתאים גם למתחילים. עלות מפגש 45 ש"ח. שימו לב: הסדנא מיועדת למבוגרים בלבד</p><p>בקרוב: מפגש הורה ופעוט</p>`, { head: HAIFA_MENU });
  const { r } = await enrich({ name, description: 'סדנת ציור בלובי היכל התרבות', listingHtml: listing(name, '/event/paint/'), detailUrl: 'https://city.example/event/paint/', detailHtml: detail });
  assert.equal(r.fields.audience, undefined, JSON.stringify(r.fields));
  assert.equal(r.unresolved['קהל יעד לא ברור'], 'adult markers next to the extracted audience - a person decides');
});

test('model audience "children" is not confirmed by an event page that says adults only', async () => {
  const name = 'סדנת קרמיקה';
  const detail = page(name, '<h1>' + name + '</h1><p>סדנת קרמיקה בסטודיו. הסדנה מיועדת למבוגרים בלבד.</p>', { head: HAIFA_MENU });
  const { r } = await enrich({ name, description: 'סדנת קרמיקה', audience: 'children', listingHtml: listing(name, '/event/clay/'), detailUrl: 'https://city.example/event/clay/', detailHtml: detail });
  assert.equal(r.fields.audience, undefined, JSON.stringify(r.fields));
});

test('child event with explicit ages in its own card on the listing page', async () => {
  const name = 'הצגת ילדים מה באמת';
  const { r, written } = await enrich({ name, description: 'הצגה', listingHtml: listing(name, '/event/show/', '<p class="age">לגילאי 3-8</p>'), detailUrl: 'https://city.example/event/show/', detailHtml: page(name, `<h1>${name}</h1><p>הצגה וסדנת יצירה</p>`) });
  assert.equal(r.fields.audience.scope, 'event_card');
  assert.deepEqual([written.min_age, written.max_age], [3, 8]);
});

// ---- 5. canonical policy: stored enrichment evidence ----
const base = { name: 'זמנים מודרניים: תזמורת המהפכה פוגשת את צ׳פלין', description: 'הופעה של תזמורת המהפכה בשילוב סרט צ׳פלין קלאסי באודיטוריום חיפה.', category: 'מוזיקה', entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: '2026-10-06', city: 'חיפה', location_name: 'אודיטוריום חיפה', lat: 32.80, lng: 34.98 };
const ctx = { source: { source_trust_score: 85, name: 'עיריית חיפה', seed_url: 'https://www.haifa.muni.il/' }, issues: ['מחיר'], today: '2026-09-24', minTrust: 80, maxDaysAhead: 180, row: { status: 'new', match_type: 'new' } };
const legacy = { ...base, audience: 'children', min_age: 0, max_age: 5, cleaner_fields: { audience: { value: 'children', evidence: 'explicit ages: גיל הרך', confidence: 'HIGH' } } };

test('E. a perfectly located row cannot publish on legacy chrome-derived ages: HELD relevance_review', () => {
  const r = evaluatePublishPolicy(legacy, ctx);
  assert.equal(r.decision, 'HELD');
  assert.deepEqual(r.reasons.map((x) => x.code), ['relevance_review']);
  // without the guard the same row was ELIGIBLE (the pilot #7 publication)
  assert.equal(evaluatePublishPolicy({ ...legacy, cleaner_fields: { audience: { ...legacy.cleaner_fields.audience, provenance: 'event_local_explicit_age' } } }, ctx).decision, 'ELIGIBLE');
});

test('an invalidated enrichment record is set aside too; event-local provenance and extraction ages are kept', () => {
  assert.equal(evaluatePublishPolicy({ ...legacy, cleaner_fields: { audience: { ...legacy.cleaner_fields.audience, invalidated: true } } }, ctx).decision, 'HELD');
  const kept = { ...base, name: 'סדנת עוגיות בצק פריך', description: 'סדנת בישול', category: 'בישול', audience: 'children', min_age: 6, max_age: 18, cleaner_fields: { audience: { value: 'children', evidence: 'explicit ages: 13-18, 6-12', confidence: 'HIGH', provenance: 'event_local_explicit_age' } } };
  assert.equal(withoutUntrustedEnrichment(kept), kept);
  assert.equal(evaluatePublishPolicy(kept, ctx).decision, 'ELIGIBLE');
  const legacyNumeric = { ...kept, cleaner_fields: { audience: { value: 'children', evidence: 'explicit ages: 6-12', confidence: 'HIGH' } } };
  assert.equal(withoutUntrustedEnrichment(legacyNumeric), legacyNumeric);
  const noEnrichment = { ...base, audience: 'children', min_age: 0, max_age: 5 };
  assert.equal(withoutUntrustedEnrichment(noEnrichment), noEnrichment, 'extraction ages are not this guard\'s business');
});

test('the guard only removes the ages the legacy record wrote; the audience label stays', () => {
  const out = withoutUntrustedEnrichment({ ...legacy, min_age: 3, max_age: 6, audience: 'family' });
  assert.deepEqual([out.min_age, out.max_age, out.audience], [3, 6, 'family']);
  const out2 = withoutUntrustedEnrichment(legacy);
  assert.deepEqual([out2.min_age, out2.max_age, out2.audience], [null, null, 'children']);
  // clearing the label would have been MORE permissive: the relevance rule checks adult markers for a child label
  const cpr = { ...base, name: 'קורס החייאת תינוקות', description: 'קורס החייאת תינוקות להורים', category: 'סדנה', audience: 'children', min_age: 0, max_age: 5, cleaner_fields: { audience: { value: 'children', evidence: 'explicit ages: תינוקות', confidence: 'HIGH' } } };
  assert.equal(evaluatePublishPolicy(cpr, ctx).decision, 'HELD');
});

test('legacy clock times read as ages ("10:00-22:00" -> "00 - 22") are not evidence; a plausible legacy range is kept', () => {
  const flamenco = { ...base, name: 'מופעים מהעולם: ערב פלמנקו ספרדי', description: 'ערב פלמנקו באתר הביזנטי', audience: 'family', min_age: 0, max_age: 22, cleaner_fields: { audience: { value: 'family', evidence: 'explicit ages: 00 - 22', confidence: 'HIGH' } } };
  assert.deepEqual(evaluatePublishPolicy(flamenco, ctx).reasons.map((x) => x.code), ['relevance_review']);
  for (const ev of ['09-23', '00–18', '15-22', '10-22']) {
    const [lo, hi] = ev.split(/[-–]/).map(Number);
    assert.equal(withoutUntrustedEnrichment({ ...flamenco, min_age: lo, max_age: hi, cleaner_fields: { audience: { value: 'family', evidence: 'explicit ages: ' + ev } } }).min_age, null, ev);
  }
  const plausible = { ...flamenco, min_age: 6, max_age: 12, cleaner_fields: { audience: { value: 'children', evidence: 'explicit ages: 6-12' } } };
  assert.equal(withoutUntrustedEnrichment(plausible), plausible);
});
