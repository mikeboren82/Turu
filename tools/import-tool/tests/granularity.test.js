// Entity Granularity Phase 1 (2026-09-22): the missing THIRD axis - "is this an independently
// actionable thing?" - alongside category (WHAT) and offering_access_type (WHO/HOW, 0106). See
// tools/import-tool/lib/granularity.js's header and the READ-ONLY forensic in project memory for
// the full rationale. These are the KNOWN POSITIVE REGRESSION CASES (Section 8) and NEGATIVE
// CONTROLS (Section 9) named directly in the task, reproduced here as structural fixtures - never
// by ID/name lookup, so the detector is proven on the SHAPE, not hardcoded to today's rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const { assessGranularity, blocksAutoPublish, needsGranularityAcknowledgement, granularityDecision, hasPlaceSiblingAtVenue, ACK_CHOICES } = require('../lib/granularity');

// ---- Section 8: known positive regression shapes ----
test('WRAPPER shape (16bc5416 "פעילויות בספארי"): title + description + 7-weekday saturation -> NOT_INDEPENDENT', () => {
  const c = {
    name: 'פעילויות בספארי', description: 'מגוון פעילויות לכל הגילאים בספארי, כולל הכרות עם סיפורים אישיים של בעלי החיים.',
    entity_type: 'אירוע_קבוע', schedule_type: 'recurring', recurring_days: ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'],
    price_type: 'free', price_amount: null,
  };
  const a = assessGranularity(c);
  assert.equal(a.verdict, 'not_independent');
  assert.equal(a.reason, 'wrapper');
  assert.ok(a.evidence.some((e) => e.code === 'wrapper_title'));
  assert.ok(a.evidence.some((e) => e.code === 'wrapper_description'));
  assert.ok(a.evidence.some((e) => e.code === 'weekday_saturation'));
  assert.equal(blocksAutoPublish(a), true);
});

test('production dry-run catch (2026-09-22): booking_requirement alone must NOT suppress a confirmed wrapper - "פעילויות בספארי" carries registration_required because its TOUR sub-item needs it, not because the wrapper row is one offering', () => {
  const c = {
    name: 'פעילויות בספארי', description: 'מגוון פעילויות לכל הגילאים בספארי, כולל הכרות עם סיפורים אישיים של בעלי החיים וסודות המטפלים. פעילויות ללא תשלום בשבתות וחגים, וסיורים מודרכים בתשלום בהזמנה מראש.',
    schedule_type: 'recurring', recurring_days: ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'],
    price_type: 'free', registration_url: null, booking_requirement: 'registration_required',
  };
  const a = assessGranularity(c);
  assert.equal(a.verdict, 'not_independent');
  assert.equal(a.suppressors.length, 0, 'booking_requirement alone must not suppress - only a concrete registration_url link does');
});

test('SUB-ENTITY shape (Midbarium zones, e.g. 8d11b080/ed84fa80/b1e9fad4/b285346c): zone title + zone description, no price -> NOT_INDEPENDENT', () => {
  const cases = [
    { name: 'קניון - אזור צוקים וטיפוס', description: 'אזור בפארק המדמה קניון מדברי עם צוקים תלולים. מציע בעלי חיים המתמחים בטיפוס.' },
    { name: 'נווה מדבר - אזור מעיינות ובעלי חיים', description: 'אזור בפארק המדמה נווה מדבר טבעי עם מקור מים.' },
    { name: 'ערבה - אזור מישור מדברי', description: 'אזור בפארק המדמה מישור מדברי עם תנאים קיצוניים.' },
    { name: 'חאן - אזור בעלי חיים מחוק', description: 'אזור בפארק המסמל את נקודת המפגש בין בני אדם לבעלי חיים.' },
  ];
  for (const base of cases) {
    const c = { ...base, entity_type: 'מקום_קבוע', schedule_type: 'fixed_hours', price_type: null };
    const a = assessGranularity(c);
    assert.equal(a.verdict, 'not_independent', `expected NOT_INDEPENDENT for "${base.name}"`);
    assert.equal(a.reason, 'sub_entity');
    assert.ok(a.evidence.some((e) => e.code === 'zone_title'));
    assert.ok(a.evidence.some((e) => e.code === 'zone_description'));
  }
});

test('parent_sibling_exists alone (venue-aware refinement) combines with a weak title signal to reach NOT_INDEPENDENT', () => {
  const c = { name: 'פינת ליטוף', description: 'חוויה נעימה לילדים', schedule_type: 'fixed_hours', price_type: null };
  const withoutSibling = assessGranularity(c, { siblingPlaceAtVenue: false });
  assert.equal(withoutSibling.verdict, 'uncertain', 'title alone is only UNCERTAIN, never confident');
  const withSibling = assessGranularity(c, { siblingPlaceAtVenue: true });
  assert.equal(withSibling.verdict, 'not_independent');
  assert.ok(withSibling.evidence.some((e) => e.code === 'parent_sibling_exists'));
});

test('production dry-run catch (2026-09-22): "מתחם" title+description alone, with NO venue at all, is UNCERTAIN not NOT_INDEPENDENT - "מתחם" can mean a self-contained facility, not only a zone inside something', () => {
  // real shape: "מתחם סטאר סנטר" / "ספקטרום - מתחם חדרי בריחה" - both venue_id null, both their own destination
  const c = { name: 'מתחם סטאר סנטר', description: 'מתחם קניות ופנאי הממוקם בתפר שבין אזור התעשייה ללב העיר', schedule_type: 'fixed_hours', price_type: null };
  const noVenueKnown = assessGranularity(c, { hasVenue: false });
  assert.equal(noVenueKnown.verdict, 'uncertain', 'no identifiable parent (Section 7) - never a confident block from text alone');
  const venueUnknownYet = assessGranularity(c); // hasVenue omitted - e.g. scan-source's first pass, before resolveVenue
  assert.equal(venueUnknownYet.verdict, 'not_independent', 'before venue resolution has even run, the structural signal still counts - the SECOND pass is what downgrades it once absence is confirmed');
});

test('hasVenue=false does not affect the WRAPPER path (wrapper never depends on venue)', () => {
  const c = { name: 'פעילויות בספארי', description: 'מגוון פעילויות לכל הגילאים', schedule_type: 'recurring', recurring_days: ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'], price_type: null };
  assert.equal(assessGranularity(c, { hasVenue: false }).verdict, 'not_independent');
});

// ---- Section 9: negative controls (must NOT be blocked) ----
test('NEGATIVE (b0ba1702 boating): own price + own fixed_hours -> INDEPENDENT despite no other signals needed', () => {
  const c = { name: 'שייט בסירה באגם הפארק', description: 'אטרקציית שייט בסירה באגם המלאכותי במרכז פארק רעננה.', entity_type: 'מקום_קבוע', schedule_type: 'fixed_hours', price_type: 'fixed', price_amount: 20 };
  const a = assessGranularity(c);
  assert.equal(a.verdict, 'independent');
  assert.ok(a.suppressors.some((s) => s.code === 'has_own_price'));
});

test('NEGATIVE (fdb70d6b "פינת חי בפארק רעננה"): zone-shaped TITLE but has its own price -> INDEPENDENT (suppressor wins)', () => {
  const c = { name: 'פינת חי בפארק רעננה', description: 'פינת חי חמודה עם בעלי חיים למגע.', entity_type: 'מקום_קבוע', schedule_type: 'fixed_hours', price_type: 'fixed', price_amount: 10 };
  const a = assessGranularity(c);
  assert.equal(a.verdict, 'independent', 'a genuine own price always suppresses, even with a zone-shaped title');
});

test('NEGATIVE: genuine dated Safari-style events are never flagged (own one_time date suppresses)', () => {
  const c1 = { name: 'מפגשים בספארי', description: 'מפגשים ייחודיים בספארי בתאריך 26.12.2026.', schedule_type: 'one_time', one_time_date: '2026-12-26', price_type: null };
  assert.equal(assessGranularity(c1).verdict, 'independent');
  const c2 = { name: 'יום ספארי למשרתי המילואים', description: 'יום ייחודי בספארי למשרתי המילואים.', schedule_type: 'one_time', one_time_date: '2026-09-24', price_type: 'free' };
  assert.equal(assessGranularity(c2).verdict, 'independent');
});

test('NEGATIVE: an activity with its own registration/booking link is never flagged', () => {
  const c = { name: 'סדנת יצירה שבועית', description: 'סדנה קבועה לילדים.', schedule_type: 'recurring', recurring_days: ['שני'], registration_url: 'https://example.com/register', price_type: null };
  assert.equal(assessGranularity(c).verdict, 'independent');
});

test('NEGATIVE: destination rows (מקום_קבוע place itself) with no wrapper/zone signals stay INDEPENDENT', () => {
  const c = { name: 'ספארי רמת גן', description: 'פארק חיות ופארק לאומי שבו ניתן לצפות בחיות בר במהלך סיור בנהיגה.', entity_type: 'מקום_קבוע', schedule_type: 'fixed_hours', price_type: 'fixed', price_amount: 99 };
  assert.equal(assessGranularity(c).verdict, 'independent');
});

test('NEGATIVE: a legitimate weekly recurring class (1-2 days) is never mistaken for weekday saturation', () => {
  const c = { name: 'שבתות חיות וחוויות', description: 'פעילות שבתית בספארי המתקיימת בימי שבת.', schedule_type: 'recurring', recurring_days: ['שבת'], price_type: null };
  assert.equal(assessGranularity(c).verdict, 'independent');
});

test('NEGATIVE: multi-occurrence offerings (several one_time schedules, no wrapper wording) stay INDEPENDENT', () => {
  const c = { name: 'הצגת ילדים מיוחדת', description: 'הצגה חד פעמית לילדים ולמשפחה.', schedule_type: 'one_time', one_time_date: '2026-10-05', price_type: 'fixed', price_amount: 60 };
  assert.equal(assessGranularity(c).verdict, 'independent');
});

// ---- Section 11: repertoire exclusion ----
test('REPERTOIRE EXCLUSION: an undated אירוע_קבוע standing-show record with no wrapper/zone wording is never NOT_INDEPENDENT', () => {
  // the Train Theater shape: entity_type=אירוע_קבוע, 0 schedules, plain show title/description
  const c = { name: 'המדריך להרפתקן', description: 'הצגת ילדים בתיאטרון הקרון.', entity_type: 'אירוע_קבוע', schedule_type: null, price_type: null };
  const a = assessGranularity(c);
  assert.notEqual(a.verdict, 'not_independent');
});

test('Do NOT classify from title alone: a single wrapper-shaped title with no other evidence is UNCERTAIN, never confidently blocked', () => {
  const c = { name: 'פעילויות לילדים בקניון', description: 'קניון עם חנויות שונות.', schedule_type: 'fixed_hours', price_type: null };
  const a = assessGranularity(c);
  assert.equal(a.verdict, 'uncertain');
});

// ---- vocabulary / gating plumbing ----
test('blocksAutoPublish: true for not_independent AND uncertain, false for independent', () => {
  assert.equal(blocksAutoPublish({ verdict: 'not_independent' }), true);
  assert.equal(blocksAutoPublish({ verdict: 'uncertain' }), true);
  assert.equal(blocksAutoPublish({ verdict: 'independent' }), false);
  assert.equal(needsGranularityAcknowledgement({ verdict: 'uncertain' }), true);
});

test('granularityDecision: no ack + independent -> proceed; no ack + blocked -> needs_granularity_acknowledgement', () => {
  assert.deepEqual(granularityDecision({ assessment: { verdict: 'independent', reason: null, evidence: [], suppressors: [] } }), { kind: 'proceed', granularity: 'independent' });
  const held = granularityDecision({ assessment: { verdict: 'not_independent', reason: 'wrapper', evidence: [{ code: 'x', label: 'y' }], suppressors: [] } });
  assert.equal(held.kind, 'needs_granularity_acknowledgement');
  assert.equal(held.proposedVerdict, 'not_independent');
  assert.deepEqual(held.choices, [...ACK_CHOICES]);
});

test('granularityDecision: reviewer acknowledgement outcomes - independent proceeds, wrapper/sub_area are ineligible (never a new activity), uncertain holds', () => {
  assert.deepEqual(granularityDecision({ assessment: {}, acknowledgedGranularity: 'independent' }), { kind: 'proceed', granularity: 'independent' });
  assert.deepEqual(granularityDecision({ assessment: {}, acknowledgedGranularity: 'wrapper' }), { kind: 'ineligible', granularity: 'wrapper' });
  assert.deepEqual(granularityDecision({ assessment: {}, acknowledgedGranularity: 'sub_area' }), { kind: 'ineligible', granularity: 'sub_area' });
  assert.deepEqual(granularityDecision({ assessment: {}, acknowledgedGranularity: 'uncertain' }), { kind: 'hold_uncertain', granularity: 'uncertain' });
  assert.equal(granularityDecision({ assessment: {}, acknowledgedGranularity: 'bogus' }).kind, 'invalid_acknowledgement');
});

// ---- hasPlaceSiblingAtVenue: DB-aware helper, never guesses ----
test('hasPlaceSiblingAtVenue: null venueId -> null (never guesses); a client error -> null, never throws', async () => {
  const client = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ count: 0, error: null }) }) }) }) }) };
  assert.equal(await hasPlaceSiblingAtVenue(client, null), null);
  const erroring = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ count: null, error: { message: 'x' } }) }) }) }) }) };
  assert.equal(await hasPlaceSiblingAtVenue(erroring, 'v1'), null);
});

test('hasPlaceSiblingAtVenue: true when a מקום_קבוע exists at the venue, false when count is 0', async () => {
  const makeClient = (count) => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ count, error: null }) }) }) }) }) });
  assert.equal(await hasPlaceSiblingAtVenue(makeClient(1), 'v1'), true);
  assert.equal(await hasPlaceSiblingAtVenue(makeClient(0), 'v1'), false);
});
