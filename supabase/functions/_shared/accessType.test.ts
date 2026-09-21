// WHO MAY ATTEND (Phase 1, 2026-09-21) - Deno twin of tools/import-tool/tests/accessType.test.js.
// The fixture table below is the same as the Node one; a divergence between the two runtimes is a bug.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sanitizeAccessType, assessAccessType, blocksAutoPublish, accessGuidanceBlock, ACCESS_TYPE_VALUES } from "./accessType.ts";
import { missingTemporalEvidence, buildExtractionSystemPrompt } from "./extraction.ts";

const ZOO_BIRTHDAY = { name: 'יום הולדת בגן החיות', description: 'חוגגים יום הולדת בין החיות - חוויה משפחתית ייחודית לציון יום ההולדת.', entity_type: 'אירוע_קבוע', family_fit: ['מתאים ליום הולדת'], offering_access_type: 'private_group' };
const TEAM_BUILDING = { name: 'ימי גיבוש בפארק המים', description: 'ימי גיבוש וקבוצות - אתר מתאים לאירוח קבוצות חינוכיות וארגוניות.', entity_type: 'אירוע_קבוע', family_fit: ['מתאים לקבוצות'], offering_access_type: 'private_group' };
const MUSEUM_BIRTHDAY = { name: 'יום הולדת במוזיאון המדע', description: 'חגיגת יום הולדת במוזיאון - אירוע מיוחד לחגיגת ימי הולדת בתוך המוזיאון.', entity_type: 'אירוע_קבוע', family_fit: ['מתאים ליום הולדת'] };
const MORNING_TOUR = { name: 'סיור בוקר בפארק החיות', description: 'סיור בנהיגה בשעות הבוקר לצפייה בחיות בר בפעילותן.', entity_type: 'אירוע_קבוע', family_fit: ['מתאים לילד ולהורה'], offering_access_type: 'public' };
const NIGHT_TOUR = { name: 'סיור לילה בפארק החיות', description: 'סיור בשעות הלילה, חוויה ייחודית לצפייה בחיות בתנאי לילה.', entity_type: 'אירוע_קבוע', family_fit: ['מתאים לילד ולהורה'] };
const SATURDAY_PROGRAMME = { name: 'שבתות של חיות', description: 'פעילות שבתית המתקיימת בימי שבת, עם סיורים לצפייה בחיות.', entity_type: 'אירוע_קבוע', schedule_type: 'recurring', recurring_days: ['שבת'], family_fit: ['מתאים לילד ולהורה', 'מתאים לקבוצות'], offering_access_type: 'public' };
const DATED_ENCOUNTER = { name: 'מפגש עם חיות הבר', description: 'מפגשים ייחודיים בתאריך 26.12.2026, חוויות קרובות עם חיות ופעילויות משפחתיות.', entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: '2026-12-26', offering_access_type: 'public' };
const ZOO_VENUE_WITH_BIRTHDAYS = { name: 'פארק החיות הגדול', description: 'פארק חיות שבו ניתן לצפות בחיות בר. הפארק מציע סיורים, אירועים משפחתיים, יום הולדת וביקורים לקבוצות חינוך.', entity_type: 'מקום_קבוע', schedule_type: 'fixed_hours', family_fit: ['מתאים לילד ולהורה', 'מתאים לקבוצות', 'מתאים ליום הולדת'], offering_access_type: 'public' };
const RESERVED_TOUR = { name: 'סיור מודרך בעיר העתיקה', description: 'סיור מודרך למשפחות, בהרשמה מראש.', entity_type: 'אירוע_קבוע', registration_url: 'https://example.org/book', offering_access_type: 'public' };
const TICKETED_EVENT = { name: 'הצגת ילדים בהיכל התרבות', description: 'מופע לילדים, כרטיסים מראש.', entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: '2026-11-02', price_type: 'fixed', price_amount: 45, offering_access_type: 'public' };
const SCHEDULELESS_PUBLIC = { name: 'תערוכה: איך עושה אור?', description: 'תערוכה אינטראקטיבית בגן המדע, כלולה במחיר הכניסה.', entity_type: 'אירוע_קבוע' };
const EVENT_IN_HALL = { name: 'הפנינג חג לכל המשפחה', description: 'אירוע משפחתי באולם היכל התרבות, עם פעילויות לכל המשפחה.', entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: '2026-10-05', offering_access_type: 'public' };
const PLAY_CENTRE = { name: 'משחקיית הג\'ונגל', description: 'משחקייה ענקית לילדים ומשפחות, אפשרות לחגיגת ימי הולדת.', entity_type: 'מקום_קבוע', schedule_type: 'fixed_hours', family_fit: ['מתאים לילד ולהורה', 'מתאים ליום הולדת'] };

Deno.test("regression matrix: private shapes are held, public shapes pass (same table as the Node twin)", () => {
  const rows: [string, Record<string, unknown>, string, boolean][] = [
    ['zoo birthday package', ZOO_BIRTHDAY, 'private_group', true],
    ['team building', TEAM_BUILDING, 'private_group', true],
    ['morning tour', MORNING_TOUR, 'public', false],
    ['saturday programme', SATURDAY_PROGRAMME, 'public', false],
    ['dated encounter', DATED_ENCOUNTER, 'public', false],
    ['zoo venue also advertising birthdays', ZOO_VENUE_WITH_BIRTHDAYS, 'public', false],
    ['reserved tour', RESERVED_TOUR, 'public', false],
    ['ticketed event', TICKETED_EVENT, 'public', false],
    ['event in a hall', EVENT_IN_HALL, 'public', false],
  ];
  for (const [label, fx, expected, held] of rows) {
    const a = assessAccessType(fx);
    assertEquals(a.access, expected, label);
    assertEquals(blocksAutoPublish(a), held, `${label} held`);
  }
});

Deno.test("science-museum birthday shape without a model answer is a suspicious unknown (held); schedule-less public is an ordinary unknown (not held)", () => {
  const m = assessAccessType(MUSEUM_BIRTHDAY);
  assertEquals(m.access, 'unknown'); assertEquals(m.suspicious, true); assertEquals(blocksAutoPublish(m), true);
  for (const fx of [SCHEDULELESS_PUBLIC, NIGHT_TOUR, PLAY_CENTRE]) {
    const a = assessAccessType(fx);
    assertEquals(a.access, 'unknown'); assertEquals(a.suspicious, false); assertEquals(blocksAutoPublish(a), false);
  }
});

Deno.test("the LLM alone never yields private_group; a conflict with structural evidence yields mixed", () => {
  assertEquals(assessAccessType({ name: 'סיור בוקר', description: 'סיור נעים.', entity_type: 'אירוע_קבוע', offering_access_type: 'private_group' }).access, 'mixed');
  assertEquals(assessAccessType({ ...ZOO_BIRTHDAY, offering_access_type: 'public' }).access, 'mixed');
});

Deno.test("sanitizeAccessType mirrors the Node twin", () => {
  assertEquals(ACCESS_TYPE_VALUES, ['public', 'private_group', 'mixed', 'unknown']);
  assertEquals(sanitizeAccessType(' Private_Group ').access, 'private_group');
  assertEquals(sanitizeAccessType(null), { access: 'unknown', rejected: false, reason: null });
  assertEquals(sanitizeAccessType('vip').rejected, true);
  assertEquals(sanitizeAccessType(42).rejected, true);
});

Deno.test("temporal evidence is a separate axis and the extraction prompt carries the access guidance", () => {
  assertEquals(missingTemporalEvidence(ZOO_BIRTHDAY), missingTemporalEvidence(NIGHT_TOUR));
  const g = accessGuidanceBlock();
  assert(g.includes('offering_access_type') && g.includes('private_group') && g.includes('מארח ימי הולדת'));
  assert(buildExtractionSystemPrompt().includes('offering_access_type'), 'the live prompt asks the model who may attend');
});
