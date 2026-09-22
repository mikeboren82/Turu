// Repertoire Phase 1 (2026-09-22): "dated candidate + existing standing programme at the same
// venue + same programme identity -> UPDATE (attach), not NEW activity." See
// cleaner/matching.js#isStandingProgrammeMatch's header for the full rationale and
// project_repertoire_doctrine_2026-09-22.md for the forensic this implements. These are the KNOWN
// REGRESSION CASES (Section 10) and NEGATIVE CONTROLS (Section 11) named in the task, reproduced
// as structural fixtures - never by ID/name lookup, so the rule is proven on the SHAPE.
const test = require('node:test');
const assert = require('node:assert/strict');
const { isStandingProgrammeMatch, titleMatchesStandingProgramme } = require('../cleaner/matching');

const standingBase = () => ({
  id: 'standing-1', name: 'המדריך להרפתקן', entity_type: 'אירוע_קבוע', venue_id: 'venue-train-theater',
  schedule_type: null, price_type: null, price_amount: null, min_age: null, max_age: null,
  organizer_name: 'תיאטרון הקרון', duration_minutes: null,
});
const candidateBase = () => ({
  name: 'המדריך להרפתקן', venue_id: 'venue-train-theater', price_type: null, price_amount: null,
  min_age: null, max_age: null, organizer_name: 'תיאטרון הקרון', duration_minutes: null,
});

// ---- Section 10: Train Theater regression cases ----
test('EXACT PAIR (המדריך להרפתקן shape): dated candidate at the same venue matches its standing programme', () => {
  assert.equal(isStandingProgrammeMatch(candidateBase(), standingBase()), true);
});

test('FUZZY PAIR (אקווקוודלה shape): "X" candidate matches standing "X | subtitle" via the conservative prefix rule', () => {
  const standing = { ...standingBase(), name: 'אקווקוודלה' };
  const candidate = { ...candidateBase(), name: 'אקווקוודלה | הצגה חדשה' };
  assert.equal(isStandingProgrammeMatch(candidate, standing), true);
});

test('an already-attached standing programme (schedule_type one_time from a prior Phase-1 run) can still receive ANOTHER performance', () => {
  const standing = { ...standingBase(), schedule_type: 'one_time' };
  assert.equal(isStandingProgrammeMatch(candidateBase(), standing), true);
});

// ---- Section 11: negative controls ----
test('NEGATIVE: same title at a DIFFERENT venue stays separate', () => {
  const candidate = { ...candidateBase(), venue_id: 'venue-somewhere-else' };
  assert.equal(isStandingProgrammeMatch(candidate, standingBase()), false);
});

test('NEGATIVE: touring production in another city (different venue_id) never attaches', () => {
  const candidate = { ...candidateBase(), venue_id: 'venue-tel-aviv-branch' };
  assert.equal(isStandingProgrammeMatch(candidate, standingBase()), false);
});

test('NEGATIVE: same venue, genuinely different production with a similar-looking title (a number suggests a sequel) is refused', () => {
  const candidate = { ...candidateBase(), name: 'אקווקוודלה 2 המסע הבא' };
  const standing = { ...standingBase(), name: 'אקווקוודלה' };
  assert.equal(isStandingProgrammeMatch(candidate, standing), false);
});

test('NEGATIVE: a long, unrelated suffix (more than 3 words) is refused even with a matching prefix', () => {
  const candidate = { ...candidateBase(), name: 'אקווקוודלה משהו לגמרי אחר וארוך מדי בשביל להיות תת-כותרת' };
  const standing = { ...standingBase(), name: 'אקווקוודלה' };
  assert.equal(isStandingProgrammeMatch(candidate, standing), false);
});

test('NEGATIVE: a fully generic/trivial standing title never serves as a fuzzy-match prefix', () => {
  const candidate = { ...candidateBase(), name: 'הצגה חדשה לגמרי' };
  const standing = { ...standingBase(), name: 'הצגה' };
  assert.equal(isStandingProgrammeMatch(candidate, standing), false);
});

test('NEGATIVE: ordinary one-time event (existing row is entity_type אירוע, not אירוע_קבוע) never matches', () => {
  const standing = { ...standingBase(), entity_type: 'אירוע' };
  assert.equal(isStandingProgrammeMatch(candidateBase(), standing), false);
});

test('NEGATIVE: a real weekly recurring series (existing schedule_type=recurring) is a different class, not an attach target', () => {
  const standing = { ...standingBase(), schedule_type: 'recurring' };
  assert.equal(isStandingProgrammeMatch(candidateBase(), standing), false);
});

test('NEGATIVE: standing row with no venue_id at all is never guessed', () => {
  const standing = { ...standingBase(), venue_id: null };
  assert.equal(isStandingProgrammeMatch(candidateBase(), standing), false);
});

test('NEGATIVE: candidate with no venue_id is never guessed either', () => {
  const candidate = { ...candidateBase(), venue_id: null };
  assert.equal(isStandingProgrammeMatch(candidate, standingBase()), false);
});

// ---- Section 12: field-conflict guard ----
test('FIELD CONFLICT: a materially different price refuses the match - a different offering, never auto-folded', () => {
  const standing = { ...standingBase(), price_type: 'fixed', price_amount: 40 };
  const candidate = { ...candidateBase(), price_type: 'fixed', price_amount: 90 };
  assert.equal(isStandingProgrammeMatch(candidate, standing), false);
});

test('FIELD CONFLICT: a materially different min_age/max_age refuses the match', () => {
  const standing = { ...standingBase(), min_age: 3, max_age: 8 };
  const candidate = { ...candidateBase(), min_age: 12, max_age: 18 };
  assert.equal(isStandingProgrammeMatch(candidate, standing), false);
});

test('FIELD CONFLICT: a materially different organizer refuses the match', () => {
  const standing = { ...standingBase(), organizer_name: 'תיאטרון הקרון' };
  const candidate = { ...candidateBase(), organizer_name: 'מפיק אחר לגמרי' };
  assert.equal(isStandingProgrammeMatch(candidate, standing), false);
});

test('FIELD CONFLICT: a materially different duration refuses the match', () => {
  const standing = { ...standingBase(), duration_minutes: 45 };
  const candidate = { ...candidateBase(), duration_minutes: 120 };
  assert.equal(isStandingProgrammeMatch(candidate, standing), false);
});

test('no conflict when one side simply lacks the field (null on either side never conflicts)', () => {
  const standing = { ...standingBase(), price_type: null, organizer_name: null };
  const candidate = { ...candidateBase(), price_type: 'fixed', price_amount: 40, organizer_name: 'תיאטרון הקרון' };
  assert.equal(isStandingProgrammeMatch(candidate, standing), true);
});

// ---- titleMatchesStandingProgramme direct tests ----
test('titleMatchesStandingProgramme: exact match always succeeds regardless of genericity', () => {
  assert.equal(titleMatchesStandingProgramme('המדריך להרפתקן', 'המדריך להרפתקן'), true);
});
test('titleMatchesStandingProgramme: empty/missing titles never match', () => {
  assert.equal(titleMatchesStandingProgramme('', 'המדריך להרפתקן'), false);
  assert.equal(titleMatchesStandingProgramme('המדריך להרפתקן', null), false);
});
