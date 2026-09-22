// WHO MAY ATTEND (Phase 1, 2026-09-21) - offering_access_type. Regression matrix from the forensic
// design: the shapes are the semantic equivalents of the production cases (a zoo's birthday package,
// a team-building day, a science museum's birthday row, four genuine wildlife programmes, 11 venues
// that merely advertise birthdays, 57 schedule-less legitimate rows). No real venue names, ids or
// domains - the rule must be general or it is wrong.
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeAccessType, assessAccessType, blocksAutoPublish, approvalDecision, ACCESS_TYPE_VALUES, ACK_CHOICES, nameHead } = require('../lib/accessType');
const { ineligibleForPublicCatalogue, isCommitmentActivity } = require('../lib/catalogueEligibility');
const { missingTemporalEvidence } = require('../lib/temporalEvidence');
const { ARCHIVE_REASONS } = require('../lib/activityArchive');

// ---- fixtures (synthetic, general) -------------------------------------------------------------
const ZOO_BIRTHDAY = { name: 'יום הולדת בגן החיות', description: 'חוגגים יום הולדת בין החיות - חוויה משפחתית ייחודית לציון יום ההולדת.', entity_type: 'אירוע_קבוע', category: 'חיות וגני חיות', family_fit: ['מתאים ליום הולדת'], booking_requirement: 'advance_booking', offering_access_type: 'private_group' };
const TEAM_BUILDING = { name: 'ימי גיבוש בפארק המים', description: 'ימי גיבוש וקבוצות - אתר מתאים לאירוח קבוצות חינוכיות וארגוניות.', entity_type: 'אירוע_קבוע', category: 'פעילות מים', family_fit: ['מתאים לקבוצות'], offering_access_type: 'private_group' };
const MUSEUM_BIRTHDAY = { name: 'יום הולדת במוזיאון המדע', description: 'חגיגת יום הולדת במוזיאון - אירוע מיוחד לחגיגת ימי הולדת בתוך המוזיאון.', entity_type: 'אירוע_קבוע', category: 'אחר', family_fit: ['מתאים ליום הולדת'], booking_requirement: 'advance_booking' };
const HALL_RENTAL = { name: 'השכרת אולם לאירועים', description: 'האולם מתאים לאירועים פרטיים, מחיר לקבוצה, הצעת מחיר בהתאמה אישית.', entity_type: 'אירוע_קבוע', category: 'אחר', offering_access_type: 'private_group' };
const CUSTOM_GROUP_TOUR = { name: 'חבילת סיור פרטי לקבוצות', description: 'סיור סגור לקבוצות מאורגנות בלבד, מינימום 20 משתתפים, במועד שתבחרו.', entity_type: 'אירוע_קבוע', category: 'טבע', offering_access_type: 'private_group' };
const MORNING_TOUR = { name: 'סיור בוקר בפארק החיות', description: 'סיור בנהיגה בשעות הבוקר לצפייה בחיות בר בפעילותן.', entity_type: 'אירוע_קבוע', category: 'חיות וגני חיות', booking_requirement: 'advance_booking', family_fit: ['מתאים לילד ולהורה'], offering_access_type: 'public' };
const NIGHT_TOUR = { name: 'סיור לילה בפארק החיות', description: 'סיור בשעות הלילה, חוויה ייחודית לצפייה בחיות בתנאי לילה.', entity_type: 'אירוע_קבוע', category: 'חיות וגני חיות', booking_requirement: 'advance_booking', family_fit: ['מתאים לילד ולהורה'] }; // model gave nothing
const SATURDAY_PROGRAMME = { name: 'שבתות של חיות', description: 'פעילות שבתית המתקיימת בימי שבת, עם סיורים לצפייה בחיות.', entity_type: 'אירוע_קבוע', category: 'חיות וגני חיות', schedule_type: 'recurring', recurring_days: ['שבת'], family_fit: ['מתאים לילד ולהורה', 'מתאים לקבוצות'], offering_access_type: 'public' };
const DATED_ENCOUNTER = { name: 'מפגש עם חיות הבר', description: 'מפגשים ייחודיים בתאריך 26.12.2026, חוויות קרובות עם חיות ופעילויות משפחתיות.', entity_type: 'אירוע', category: 'חיות וגני חיות', schedule_type: 'one_time', one_time_date: '2026-12-26', offering_access_type: 'public' };
const ZOO_VENUE_WITH_BIRTHDAYS = { name: 'פארק החיות הגדול', description: 'פארק חיות שבו ניתן לצפות בחיות בר. הפארק מציע סיורים, אירועים משפחתיים, יום הולדת וביקורים לקבוצות חינוך.', entity_type: 'מקום_קבוע', category: 'חיות וגני חיות', schedule_type: 'fixed_hours', family_fit: ['מתאים לילד ולהורה', 'מתאים לקבוצות', 'מתאים ליום הולדת'], offering_access_type: 'public' };
const RESERVED_TOUR = { name: 'סיור מודרך בעיר העתיקה', description: 'סיור מודרך למשפחות, בהרשמה מראש.', entity_type: 'אירוע_קבוע', category: 'טבע', booking_requirement: 'registration_required', registration_url: 'https://example.org/book', offering_access_type: 'public' };
const REGISTERED_WORKSHOP = { name: 'סדנת יצירה למשפחות', description: 'סדנה בהרשמה מראש, מספר המקומות מוגבל.', entity_type: 'אירוע_קבוע', category: 'סדנה', booking_requirement: 'registration_required', offering_access_type: 'public' };
const TICKETED_EVENT = { name: 'הצגת ילדים בהיכל התרבות', description: 'מופע לילדים, כרטיסים מראש.', entity_type: 'אירוע', category: 'הצגה', schedule_type: 'one_time', one_time_date: '2026-11-02', price_type: 'fixed', price_amount: 45, offering_access_type: 'public' };
const RECURRING_CLASS = { name: 'חוג ג\'ודו לילדים', description: 'חוג שבועי בימי שלישי.', entity_type: 'פעילות', category: 'חוג', schedule_type: 'recurring', recurring_days: ['שלישי'], offering_access_type: 'public' };
const SCHEDULELESS_PUBLIC = { name: 'תערוכה: איך עושה אור?', description: 'תערוכה אינטראקטיבית בגן המדע, כלולה במחיר הכניסה.', entity_type: 'אירוע_קבוע', category: 'מוזיאון לילדים', booking_requirement: 'walk_in' };
const EVENT_IN_HALL = { name: 'הפנינג חג לכל המשפחה', description: 'אירוע משפחתי באולם היכל התרבות, עם פעילויות לכל המשפחה.', entity_type: 'אירוע', category: 'פעילות קהילתית', schedule_type: 'one_time', one_time_date: '2026-10-05', family_fit: ['מתאים לילד ולהורה', 'מתאים לקבוצות'], offering_access_type: 'public' };
const PLAY_CENTRE_WITH_BIRTHDAY_TAG = { name: 'משחקיית הג\'ונגל', description: 'משחקייה ענקית לילדים ומשפחות, אפשרות לחגיגת ימי הולדת.', entity_type: 'מקום_קבוע', category: 'משחקייה', schedule_type: 'fixed_hours', family_fit: ['מתאים לילד ולהורה', 'מתאים ליום הולדת'] };
const AMBIGUOUS_VENUE_NAMED_AS_PARTY = { name: 'מתחם הנינג\'ה - מתחם ימי הולדת', description: 'מתחם נינג\'ה המציע מסלולים וחדר יומולדת, מתאים לילדים ומבוגרים.', entity_type: 'מקום_קבוע', category: 'אטרקציה', schedule_type: 'fixed_hours', price_type: 'fixed', price_amount: 999, family_fit: ['מתאים ליום הולדת', 'מתאים לאחים בגילאים שונים'], offering_access_type: 'private_group' };

const MATRIX = [
  ['private birthday package at a zoo', ZOO_BIRTHDAY, 'private_group', true],
  ['corporate team-building at an attraction', TEAM_BUILDING, 'private_group', true],
  ['venue/hall rental', HALL_RENTAL, 'private_group', true],
  ['custom private group tour', CUSTOM_GROUP_TOUR, 'private_group', true],
  ['public morning wildlife tour', MORNING_TOUR, 'public', false],
  ['public recurring Saturday animal programme', SATURDAY_PROGRAMME, 'public', false],
  ['public dated wildlife encounter', DATED_ENCOUNTER, 'public', false],
  ['wildlife venue that ALSO advertises birthdays', ZOO_VENUE_WITH_BIRTHDAYS, 'public', false],
  ['public guided tour requiring reservation', RESERVED_TOUR, 'public', false],
  ['workshop requiring registration', REGISTERED_WORKSHOP, 'public', false],
  ['public ticketed event', TICKETED_EVENT, 'public', false],
  ['recurring public class (access axis only)', RECURRING_CLASS, 'public', false],
  ['event held in a hall', EVENT_IN_HALL, 'public', false],
];

test('regression matrix: every semantic shape gets the expected access and auto-publish outcome', () => {
  for (const [label, fx, expected, held] of MATRIX) {
    const a = assessAccessType(fx);
    assert.equal(a.access, expected, `${label}: expected ${expected}, got ${a.access} (${JSON.stringify(a.evidence.map((e) => e.code))} / ${JSON.stringify(a.suppressors.map((s) => s.code))})`);
    assert.equal(blocksAutoPublish(a), held, `${label}: auto-publish held should be ${held}`);
  }
});

test('non-Safari private-hire shape (science-museum birthday row) with NO model answer: suspicious unknown -> held for review, never archived', () => {
  const a = assessAccessType(MUSEUM_BIRTHDAY);
  assert.equal(a.access, 'unknown');
  assert.equal(a.suspicious, true);
  assert.ok(a.evidence.some((e) => e.code === 'subject_private_service'));
  assert.equal(blocksAutoPublish(a), true);
  assert.equal(ineligibleForPublicCatalogue({ ...MUSEUM_BIRTHDAY, offering_access_type: a.access }).ineligible, false, 'a suspicion is not a verdict');
});

test('schedule-less but genuine public offering: unknown, NOT suspicious, ordinary behaviour preserved', () => {
  const a = assessAccessType(SCHEDULELESS_PUBLIC);
  assert.equal(a.access, 'unknown');
  assert.equal(a.suspicious, false);
  assert.equal(blocksAutoPublish(a), false);
  const night = assessAccessType(NIGHT_TOUR);
  assert.equal(night.access, 'unknown'); assert.equal(night.suspicious, false); assert.equal(blocksAutoPublish(night), false);
});

test('place row with birthday-related amenities and the birthday tag is public; the venue is not the package', () => {
  const a = assessAccessType(PLAY_CENTRE_WITH_BIRTHDAY_TAG);
  assert.equal(a.access, 'unknown'); assert.equal(a.suspicious, false);
  assert.ok(a.suppressors.some((s) => s.code === 'place_row'));
  assert.ok(a.suppressors.some((s) => s.code === 'secondary_mention_only'));
  assert.equal(blocksAutoPublish(a), false);
});

test('model says private_group on a PLACE row named as a party zone -> mixed (unsafe single verdict), held, never private', () => {
  const a = assessAccessType(AMBIGUOUS_VENUE_NAMED_AS_PARTY);
  assert.equal(a.access, 'mixed');
  assert.equal(blocksAutoPublish(a), true);
  assert.equal(ineligibleForPublicCatalogue({ ...AMBIGUOUS_VENUE_NAMED_AS_PARTY, offering_access_type: a.access }).ineligible, false);
});

test('model says private_group with no structural evidence at all -> mixed: the LLM alone never produces a private verdict', () => {
  const a = assessAccessType({ name: 'סיור בוקר', description: 'סיור נעים בבוקר.', entity_type: 'אירוע_קבוע', offering_access_type: 'private_group' });
  assert.equal(a.access, 'mixed');
});

test('model says public but strong structural private evidence -> mixed (conflict goes to a human)', () => {
  const a = assessAccessType({ ...ZOO_BIRTHDAY, offering_access_type: 'public' });
  assert.equal(a.access, 'mixed');
  assert.equal(blocksAutoPublish(a), true);
});

test('sanitizeAccessType: canonical values, case/whitespace, unknown degrades safely, null is honest unknown', () => {
  assert.deepEqual(ACCESS_TYPE_VALUES, ['public', 'private_group', 'mixed', 'unknown']);
  for (const v of ACCESS_TYPE_VALUES) assert.equal(sanitizeAccessType(v).access, v);
  assert.equal(sanitizeAccessType(' Private_Group ').access, 'private_group');
  assert.deepEqual(sanitizeAccessType(null), { access: 'unknown', rejected: false, reason: null });
  assert.deepEqual(sanitizeAccessType(''), { access: 'unknown', rejected: false, reason: null });
  const bad = sanitizeAccessType('vip');
  assert.equal(bad.access, 'unknown'); assert.equal(bad.rejected, true); assert.match(bad.reason, /non_canonical/);
  assert.equal(sanitizeAccessType(42).rejected, true);
});

test('nameHead: the subject is the last dash-separated segment', () => {
  assert.equal(nameHead('יום הולדת בספארי'), 'יום הולדת בספארי');
  assert.equal(nameHead('פארק החיות - יום הולדת בפארק'), 'יום הולדת בפארק');
  assert.equal(nameHead('מרכז: סיור לילה'), 'סיור לילה');
});

// ---- manual approval decision -------------------------------------------------------------------
test('generic approve on a private candidate -> needs_access_acknowledgement with evidence and the three choices', () => {
  const d = approvalDecision({ assessment: assessAccessType(ZOO_BIRTHDAY) });
  assert.equal(d.kind, 'needs_access_acknowledgement');
  assert.equal(d.proposed, 'private_group');
  assert.ok(d.evidence.length >= 1);
  assert.deepEqual(d.choices, [...ACK_CHOICES]);
  assert.ok(!d.choices.includes('unknown'), 'unknown is never a final publish decision');
});

test('generic approve on a public candidate proceeds with access=public; ordinary unknown proceeds with unknown', () => {
  assert.deepEqual(approvalDecision({ assessment: assessAccessType(MORNING_TOUR) }), { kind: 'proceed', access: 'public' });
  assert.deepEqual(approvalDecision({ assessment: assessAccessType(SCHEDULELESS_PUBLIC) }), { kind: 'proceed', access: 'unknown' });
});

test('acknowledged public -> publish path; acknowledged private_group -> catalogue-ineligible; acknowledged mixed -> hold', () => {
  const a = assessAccessType(ZOO_BIRTHDAY);
  assert.deepEqual(approvalDecision({ assessment: a, acknowledgedAccessType: 'public' }), { kind: 'proceed', access: 'public' });
  assert.deepEqual(approvalDecision({ assessment: a, acknowledgedAccessType: 'private_group' }), { kind: 'ineligible', access: 'private_group' });
  assert.deepEqual(approvalDecision({ assessment: a, acknowledgedAccessType: 'mixed' }), { kind: 'hold_mixed', access: 'mixed' });
  assert.equal(approvalDecision({ assessment: a, acknowledgedAccessType: 'unknown' }).kind, 'invalid_acknowledgement');
  assert.equal(approvalDecision({ assessment: a, acknowledgedAccessType: 'vip' }).kind, 'invalid_acknowledgement');
});

test('the verdict that is persisted is the reviewer\'s, and only private_group reaches the catalogue gate as ineligible', () => {
  for (const [ack, ineligible, reason] of [['public', false, null], ['private_group', true, 'private_hire_policy']]) {
    const d = approvalDecision({ assessment: assessAccessType(ZOO_BIRTHDAY), acknowledgedAccessType: ack });
    const e = ineligibleForPublicCatalogue({ ...ZOO_BIRTHDAY, offering_access_type: d.access });
    assert.equal(e.ineligible, ineligible); assert.equal(e.reason, reason);
  }
  assert.ok(ARCHIVE_REASONS.includes('private_hire_policy'), 'the verified archive path accepts the new reason');
});

// ---- eligibility axes are independent -----------------------------------------------------------
test('commitment policy is unchanged: חוג / קייטנה / entity_type פעילות are excluded by COMMITMENT, not by access', () => {
  for (const fx of [RECURRING_CLASS, { entity_type: 'אירוע_קבוע', category: 'קייטנה' }, { entity_type: 'פעילות', category: 'ספורט' }]) {
    const e = ineligibleForPublicCatalogue({ ...fx, offering_access_type: 'public' });
    assert.equal(e.ineligible, true); assert.equal(e.reason, 'commitment_policy'); assert.equal(e.commitment, true); assert.equal(e.access, false);
    assert.equal(isCommitmentActivity(fx), true);
  }
  assert.equal(ineligibleForPublicCatalogue({ entity_type: 'אירוע_קבוע', category: 'הצגה' }).ineligible, false);
});

test('access policy is independent of category and entity_type, and null/unknown/mixed/public are all eligible', () => {
  for (const v of [null, undefined, 'unknown', 'mixed', 'public']) assert.equal(ineligibleForPublicCatalogue({ entity_type: 'אירוע_קבוע', category: 'חיות וגני חיות', offering_access_type: v }).ineligible, false, String(v));
  const e = ineligibleForPublicCatalogue({ entity_type: 'אירוע_קבוע', category: 'חיות וגני חיות', offering_access_type: 'private_group' });
  assert.equal(e.ineligible, true); assert.equal(e.reason, 'private_hire_policy'); assert.equal(e.commitment, false);
  // both axes at once: the existing label wins, so historical rows keep their reason
  assert.equal(ineligibleForPublicCatalogue({ entity_type: 'פעילות', category: 'חוג', offering_access_type: 'private_group' }).reason, 'commitment_policy');
});

test('missingTemporalEvidence stays a separate axis: the same temporal gap on a private and a public row', () => {
  assert.equal(missingTemporalEvidence({ entity_type: 'אירוע_קבוע' }), 'awaiting_schedule');
  assert.equal(missingTemporalEvidence(ZOO_BIRTHDAY), missingTemporalEvidence(NIGHT_TOUR), 'temporal evidence cannot tell them apart');
  assert.notEqual(assessAccessType(ZOO_BIRTHDAY).access, assessAccessType(NIGHT_TOUR).access, 'access can');
  assert.equal(missingTemporalEvidence(SATURDAY_PROGRAMME), null);
  assert.equal(missingTemporalEvidence({ ...ZOO_BIRTHDAY, schedule_type: 'recurring', recurring_days: ['שישי'] }), null, 'a private page listing a weekday clears temporal evidence...');
  assert.equal(assessAccessType({ ...ZOO_BIRTHDAY, schedule_type: 'recurring', recurring_days: ['שישי'] }).access, 'mixed', '...but access still holds it for a human');
});

test('restore safety: a final private_group verdict cannot re-enter the catalogue without changing the verdict', () => {
  // the PATCH guard evaluates the effective access (patched value if present, else the stored one)
  const effective = (cur, patch) => (Object.prototype.hasOwnProperty.call(patch, 'offering_access_type') ? patch.offering_access_type : cur.offering_access_type);
  const cur = { entity_type: 'אירוע_קבוע', category: 'אחר', offering_access_type: 'private_group' };
  assert.equal(effective(cur, { status: 'approved' }), 'private_group', 'a bare status flip does not bypass');
  assert.equal(effective(cur, { status: 'approved', offering_access_type: 'public' }), 'public', 'an explicit verdict change does');
  assert.equal(ineligibleForPublicCatalogue({ ...cur, offering_access_type: effective(cur, { status: 'approved' }) }).ineligible, true);
});
