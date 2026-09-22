// TuRu - granularity: IS THIS ONE INDEPENDENTLY ACTIONABLE THING? (Phase 1, 2026-09-22).
// Node/CommonJS twin of supabase/functions/_shared/granularity.ts. Same deliberate-duplication
// arrangement as accessType.js/categoryValidation.js: two runtimes cannot share one module, so the
// pair must be changed together (tests/granularity.test.js here, granularity.test.ts there).
//
// WHY. The READ-ONLY Entity Granularity forensic (2026-09-22) found a missing THIRD axis. TURU
// already has category (WHAT the experience is) and offering_access_type (WHO/HOW it is accessible,
// 0106) - nothing anywhere asks "is this independently actionable?" entity_type is assigned purely
// by SCHEDULE SHAPE (fixed_hours/recurring/one_time), never by actionability. Result: an index/
// wrapper row ("פעילויות בספארי" - 7 recurring weekday schedules, "מגוון פעילויות") and a sub-area/
// zone row (4 Midbarium zones: "אזור בפארק המדמה...", no own price, no own hours distinct from the
// parent) pass every existing gate cleanly. 5 of the 56 approved rows created since the temporal
// gate (2026-09-19) were exactly this failure - ~9% of recent intake, still leaking.
//
// PRODUCT PRINCIPLE (same as accessType, Phase 1 of this axis too): nothing here archives or
// rejects automatically. The assessment only (a) blocks AUTO-publish, (b) shows the reviewer why,
// (c) records the reviewer's explicit verdict. A CONFIRMED wrapper/sub-area incoming candidate is
// simply never turned into an activity (mirrors accessType's private_group 'ineligible' path) -
// never a new standalone row invented for it. Historical cleanup (the 5 known regression rows) is
// explicitly OUT OF SCOPE for this phase; see project memory for the forensic's cleanup batches.
//
// THE TWO QUESTIONS (forensic design, 2026-09-22), applied to the SUBJECT of the row - never to the
// parent venue's amenities in general:
//   WRAPPER    does this row represent MANY things ("activities at X") rather than ONE participation
//              unit? Signals: index/catalogue-shaped title or description, and/or a synthetic
//              6-7-weekday recurring schedule (the extractor turning "things happen here" into
//              "open all week", never a real weekly class).
//   SUB-ENTITY does this row describe an AREA/ZONE/EXHIBIT inside a larger destination rather than
//              a separately choosable offering? Signals: zone-shaped title/description ("אזור
//              בפארק...", "מתחם...") combined with no evidence of its own price/hours/booking.
// Either question needs >= 2 independent signals to reach NOT_INDEPENDENT - one signal alone (a
// title match by itself) is only UNCERTAIN, per the forensic's explicit "do not classify from title
// alone" finding. A genuine own price, own booking action, or own one_time date ALWAYS suppresses
// both questions back to INDEPENDENT, regardless of evidence count - exactly like accessType's
// suppressors, and exactly why b0ba1702 (boating, own price+hours) and fdb70d6b (own price) are
// negative controls the detector must never flag.
const GRANULARITY_VALUES = Object.freeze(['independent', 'not_independent', 'uncertain']);
const GRANULARITY_LABEL_HE = Object.freeze({ independent: 'עצמאית', not_independent: 'לא עצמאית (עטיפה / תת-אזור)', uncertain: 'לא ברור' });
const REASON_LABEL_HE = Object.freeze({ wrapper: 'עטיפה/אינדקס של כמה פעילויות', sub_entity: 'תת-אזור/מתקן בתוך יעד גדול יותר', null: null });
// the review-queue GATING issue label - never soft, same vocabulary as ACCESS_ISSUE_LABEL/TEMPORAL_ISSUE_LABEL
const GRANULARITY_ISSUE_LABEL = 'יחידת פעילות';
// the Cleaner case issue type (supabase/0107, prepared but NOT applied - see that file's header)
const CLEANER_ISSUE = 'not_independently_actionable';
// the reviewer's four explicit outcomes (Section 12): 'independent' proceeds, 'wrapper'/'sub_area'
// mean the row is never published as its own activity, 'uncertain' holds it in review
const ACK_CHOICES = Object.freeze(['independent', 'wrapper', 'sub_area', 'uncertain']);

// --- structural evidence (conservative, explains itself, never a verdict on its own) -------------
// index/catalogue TITLE shape: "<word> ב/ל<place>", "מה עושים ב-", "מגוון X", "לוח אירועים", a
// combined-ticket bundle. Validated against the live catalogue (forensic Section D): caught the 4
// known title-shaped wrappers with 0 false positives on the 5,647-row approved set.
const WRAPPER_TITLE = /(פעילויות\s+ב|פעילויות\s+ל|אירועים\s+ב|מה\s+עושים|אטרקציות\s+ב|חוגים\s+ב|מגוון\s+פעילויות|לוח\s+אירועים|רפרטואר|כרטיס\s+משולב)/;
// index/catalogue DESCRIPTION shape: the text itself reads like a menu of several offerings, not one
const WRAPPER_DESC = /(מגוון\s+פעילויות|מגוון\s+אירועים|מגוון\s+סדנאות|כל\s+הפעילויות|לוח\s+האירועים|תוכניה|רפרטואר|מגוון\s+אטרקציות|פעילויות\s+שונות|אטרקציות\s+שונות|מגוון\s+חוגים)/;
// zone/area/exhibit TITLE shape: "אזור X", "מתחם X", "פינת X" etc. Deliberately weak alone (Section
// 3: "do NOT classify from title alone") - see fdb70d6b (פינת חי, has its own price) below.
const ZONE_TITLE = /(?:^|\s)(אזור|מתחם|פינת|אגף|ביתן|תחנת|עמדת)\s/;
// zone/area DESCRIPTION shape: the text explicitly frames the row as PART of a larger place
const ZONE_DESC = /^(אזור|מתחם|פינה|אגף|ביתן)\s|אזור\s+ב(פארק|מתחם|גן|מוזיאון)|(?:חלק|אזור)\s+מ(תוך)?\s*(ה)?(פארק|מתחם|אתר|יעד)/;

function nDays(recurringDays) {
  return Array.isArray(recurringDays) ? new Set(recurringDays.filter((d) => typeof d === 'string' && d.trim())).size : 0;
}

/**
 * Deterministic, structural-only assessment (Section 3: no LLM opinion field - a pure function of
 * the candidate's own extracted fields). `siblingPlaceAtVenue` is an OPTIONAL boolean the caller
 * supplies after a venue-aware DB lookup (Section 7); omit it when unavailable, never guess.
 * `hasVenue` is OPTIONAL too: true/false once venue resolution has run, null/omitted before it has
 * (e.g. scan-source's first structural pass, before resolveVenue). A "sub_entity" verdict claims
 * the row is PART OF a larger destination - Section 7: "if the likely parent cannot be identified
 * safely, route to review rather than guessing" - so when a venue lookup has already run and found
 * NONE (hasVenue === false), a confident NOT_INDEPENDENT from title+description text alone is
 * downgraded to UNCERTAIN: there is no parent to point to. Caught in the production dry-run
 * (2026-09-22): "מתחם" (complex/facility) is genuinely ambiguous in Hebrew between "a zone inside
 * a larger place" and "a self-contained facility that IS the destination" ("מתחם קניות ופנאי" - a
 * small mall, its own place, venue_id null) - this gate is what keeps those out of NOT_INDEPENDENT.
 * -> { verdict, reason, evidence[], suppressors[] }  (evidence/suppressors are { code, label })
 */
function assessGranularity(c = {}, { siblingPlaceAtVenue = null, hasVenue = null } = {}) {
  const name = String(c.name || '');
  const description = String(c.description || '');

  const evidence = [];
  const wrapperTitle = WRAPPER_TITLE.test(name);
  if (wrapperTitle) evidence.push({ code: 'wrapper_title', label: `הכותרת בנויה כרשימת/עטיפת-פעילויות ("${name}")` });
  const wrapperDesc = WRAPPER_DESC.test(description);
  if (wrapperDesc) evidence.push({ code: 'wrapper_description', label: 'התיאור מתאר מגוון פעילויות, לא פעילות אחת' });
  const weekdaySaturation = c.schedule_type === 'recurring' && nDays(c.recurring_days) >= 6;
  if (weekdaySaturation) evidence.push({ code: 'weekday_saturation', label: 'לוח זמנים "פתוח כל השבוע" (6-7 ימים) - סימן ל"יש כאן פעילויות" ולא לחוג אמיתי' });

  const zoneTitle = ZONE_TITLE.test(name);
  if (zoneTitle) evidence.push({ code: 'zone_title', label: `הכותרת מתארת אזור/מתחם בתוך מקום גדול יותר ("${name}")` });
  const zoneDesc = ZONE_DESC.test(description);
  if (zoneDesc) evidence.push({ code: 'zone_description', label: 'התיאור מגדיר את השורה כאזור/חלק בתוך יעד גדול יותר' });
  if (siblingPlaceAtVenue === true) evidence.push({ code: 'parent_sibling_exists', label: 'קיימת כבר שורת "מקום קבוע" נפרדת באותו venue' });

  // suppressors: any one of these ALWAYS wins, regardless of evidence count (own price/booking/date
  // is direct proof of an independent participation decision - exactly the forensic's doctrine)
  const suppressors = [];
  const hasOwnPrice = ['fixed', 'range'].includes(c.price_type);
  if (hasOwnPrice) suppressors.push({ code: 'has_own_price', label: 'יש לשורה מחיר/כרטיס משלה' });
  // a concrete registration LINK proves one specific booking action; booking_requirement alone is a
  // generic categorical tag ("does something here need registration?") that a wrapper describing
  // several sub-offerings can carry too (real false negative caught in the production dry-run,
  // 2026-09-22: "פעילויות בספארי" - a confirmed wrapper - has booking_requirement=registration_required
  // because ITS TOUR SUB-ITEM needs registration, not because the wrapper row itself is one offering).
  const hasBooking = typeof c.registration_url === 'string' && /^https?:\/\//i.test(c.registration_url);
  if (hasBooking) suppressors.push({ code: 'has_booking_action', label: 'יש קישור הרשמה/פעולת הזמנה עצמאית' });
  const hasOwnDate = c.schedule_type === 'one_time' && !!c.one_time_date;
  if (hasOwnDate) suppressors.push({ code: 'has_one_time_date', label: 'אירוע עם תאריך משלו - החלטת השתתפות עצמאית מטבעה' });

  const wrapperScore = [wrapperTitle, wrapperDesc, weekdaySaturation].filter(Boolean).length;
  const subEntityScore = [zoneTitle, zoneDesc, siblingPlaceAtVenue === true].filter(Boolean).length;
  const hasSuppressor = suppressors.length > 0;

  let verdict, reason = null;
  if (hasSuppressor) { verdict = 'independent'; }
  else if (wrapperScore >= 2) { verdict = 'not_independent'; reason = 'wrapper'; }
  else if (subEntityScore >= 2 && hasVenue !== false) { verdict = 'not_independent'; reason = 'sub_entity'; }
  else if (subEntityScore >= 2) { verdict = 'uncertain'; reason = 'sub_entity'; } // hasVenue===false: no parent to point to (Section 7) - never guess
  else if (wrapperScore === 1) { verdict = 'uncertain'; reason = 'wrapper'; }
  else if (subEntityScore === 1) { verdict = 'uncertain'; reason = 'sub_entity'; }
  else { verdict = 'independent'; }

  return { verdict, reason, evidence, suppressors };
}

// AUTO-PUBLISH: only 'independent' may pass. 'not_independent' AND 'uncertain' both hold for review
// (Section 5: "Candidates classified UNCERTAIN: do not auto-reject; route to review") - neither is
// ever archived/rejected automatically, only kept out of the auto-approve fast path.
function blocksAutoPublish(assessment) {
  return assessment.verdict !== 'independent';
}
function needsGranularityAcknowledgement(assessment) { return blocksAutoPublish(assessment); }

// MANUAL APPROVAL: the pure decision behind the /api/incoming/:id/approve granularity step, same
// shape as accessType.js#approvalDecision. -> { kind: 'proceed' | 'needs_granularity_acknowledgement'
//   | 'ineligible' | 'hold_uncertain' | 'invalid_acknowledgement', ... }
// 'ineligible' means: the reviewer confirmed wrapper/sub_area - the Cleaner/reviewer must NEVER
// invent a new standalone activity for it (Section 6); the caller rejects the incoming row instead.
function granularityDecision({ assessment, acknowledgedGranularity = null } = {}) {
  if (acknowledgedGranularity != null) {
    const v = String(acknowledgedGranularity).trim().toLowerCase();
    if (!ACK_CHOICES.includes(v)) return { kind: 'invalid_acknowledgement', error: `acknowledged_granularity must be one of ${ACK_CHOICES.join('/')}` };
    if (v === 'independent') return { kind: 'proceed', granularity: 'independent' };
    if (v === 'uncertain') return { kind: 'hold_uncertain', granularity: 'uncertain' };
    return { kind: 'ineligible', granularity: v }; // 'wrapper' | 'sub_area'
  }
  if (needsGranularityAcknowledgement(assessment)) {
    return { kind: 'needs_granularity_acknowledgement', proposedVerdict: assessment.verdict, proposedReason: assessment.reason,
      evidence: assessment.evidence, suppressors: assessment.suppressors, choices: [...ACK_CHOICES] };
  }
  return { kind: 'proceed', granularity: 'independent' };
}

// VENUE-AWARE REFINEMENT (Section 7): "does a מקום_קבוע destination already exist at this venue?"
// Deliberately separate from assessGranularity (which stays a pure function) because it needs a DB
// round trip - callers run it AFTER venue resolution (scan-source resolves venue_id well after
// sanitizeCandidate) and re-assess with the result. Returns null (never guesses) when there is no
// venue to check, matching Section 7: "If the likely parent cannot be identified safely: route to
// review rather than guessing" - null routes into assessGranularity as "unknown", never as false.
async function hasPlaceSiblingAtVenue(client, venueId, excludeActivityId = null) {
  if (!venueId) return null;
  let q = client.from('activities').select('id', { count: 'exact', head: true }).eq('venue_id', venueId).eq('entity_type', 'מקום_קבוע').eq('status', 'approved');
  if (excludeActivityId) q = q.neq('id', excludeActivityId);
  const { count, error } = await q;
  if (error) return null;
  return (count || 0) > 0;
}

module.exports = {
  GRANULARITY_VALUES, GRANULARITY_LABEL_HE, REASON_LABEL_HE, GRANULARITY_ISSUE_LABEL, CLEANER_ISSUE, ACK_CHOICES,
  assessGranularity, blocksAutoPublish, needsGranularityAcknowledgement, granularityDecision, hasPlaceSiblingAtVenue,
};
