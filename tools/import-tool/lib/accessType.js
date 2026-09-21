// TuRu - offering access type: WHO MAY ATTEND a row (Phase 1, 2026-09-21).
// Node/CommonJS twin of supabase/functions/_shared/accessType.ts. Same deliberate-duplication
// arrangement as categoryValidation.js: two runtimes cannot share one module, so the pair must be
// changed together (tests/accessType.test.js here, accessType.test.ts there, same fixture table).
//
// WHY. A birthday package, a team-building day or a hall rental is a real page on a real venue's
// site, extracts cleanly, and passes every existing gate (trust, completeness, temporal evidence,
// child relevance) - none of them ask who the offering is FOR. Two such rows were published for
// the Ramat Gan safari and one is live for a science museum ("יום הולדת במדעטק"). This axis is
// orthogonal to category (what the experience is), to entity_type, and to temporal evidence
// (57 schedule-less rows in production are legitimate public content).
//
// PRODUCT PRINCIPLE. At ~0.04% base rate a wrong private verdict is far likelier than a right one,
// so nothing here archives. The assessment only (a) blocks AUTO-publish, (b) shows the reviewer
// why, and (c) records the reviewer's explicit verdict. Archival happens only after that verdict
// reaches the catalogue gate (lib/catalogueEligibility.js).
//
// THE TWO TESTS (forensic design, 2026-09-21), applied to the SUBJECT OF THE ROW - never to the
// venue's amenities:
//   individual admission     can one ordinary family attend / reserve / buy for itself?
//   pre-existing occurrence  does the offering exist independently of that family's booking?
// "Venue X also hosts birthdays" is an attribute of X. "Birthday package at X" is a row whose
// subject IS the package. Only the second can be private_group.
const categoryValues = require('../../../constants/categoryValues.json');

const ACCESS_TYPE_VALUES = Object.freeze(categoryValues.accessTypes);
const ACCESS_TYPE_SET = new Set(ACCESS_TYPE_VALUES);
const ACCESS_LABEL_HE = Object.freeze({ public: 'ציבורי', private_group: 'פרטי / לקבוצה', mixed: 'מעורב', unknown: 'לא ברור' });
// the review-queue issue label (a GATING issue, like the temporal ones - never soft)
const ACCESS_ISSUE_LABEL = 'גישה';
// the choices a reviewer may give; 'unknown' is never a final publish decision
const ACK_CHOICES = Object.freeze(['public', 'private_group', 'mixed']);

// --- sanitization (the model's ANSWER is validated, exactly like sanitizeCategory) ---------------
// -> { access, rejected, reason }. null/'' is not an error: it is honestly 'unknown'.
function sanitizeAccessType(raw) {
  if (raw === null || raw === undefined || raw === '') return { access: 'unknown', rejected: false, reason: null };
  if (typeof raw !== 'string') return { access: 'unknown', rejected: true, reason: 'access_type_not_a_string' };
  const v = raw.trim().toLowerCase();
  if (!v) return { access: 'unknown', rejected: false, reason: null };
  if (ACCESS_TYPE_SET.has(v)) return { access: v, rejected: false, reason: null };
  return { access: 'unknown', rejected: true, reason: `non_canonical_access_type:${v}` };
}

// --- structural evidence (conservative, explains itself, never a verdict on its own) -------------
// The NAME HEAD is the subject: the whole name, or the segment after a " - " / " – " / ":" split when
// the name is "<venue> - <thing>". A private-service noun in HEAD position means the row's subject is
// the service. The same noun in the description only means the venue offers it.
const PRIVATE_HEAD = /^(?:חגיגת\s+)?(?:יום|ימי)\s*הולדת|^יומולדת|^(?:יום|ימי)\s*גיבוש|^גיבוש\b|^אירועי?\s+(?:חברה|חברות)|^השכר(?:ה|ת)\b|^חבילת\b|^חבילה\b|^בר\s*מצווה|^בת\s*מצווה|^אירוע\s+פרטי|^אירועים\s+פרטיים|^מסיב(?:ה|ת|ות)\b/;
const PRIVATE_LEXICON = /(?:יום|ימי)\s*הולדת|יומולדת|גיבוש|השכר(?:ה|ת)|אירועי?\s+חברה|בר\s*מצווה|בת\s*מצווה|אירועים?\s+פרטיים?/;
const PUBLIC_HEAD = /^(?:הצג(?:ה|ת|ות)|סיור(?:ים|י)?|סדנ(?:ה|ת|אות)|מופע|פסטיבל|תערוכ(?:ה|ת)|הקרנ(?:ה|ות)|קונצרט|שעת\s+סיפור|חוג|קייטנ(?:ה|ת)|מחנ(?:ה|ות)|יריד|טיול|מרוץ|הרצא(?:ה|ת)|משחקיי(?:ה|ת)|תיאטרון|פעילות)\b/;
const GROUP_PRICING = /מחיר\s+לקבוצה|לקבוצה\s+של\s+\d+|מינימום\s+\d+\s*(?:משתתפים|ילדים|אנשים|איש)|החל\s+מ-?\s*\d+\s*(?:משתתפים|ילדים|אנשים|איש)|עד\s+\d+\s+(?:משתתפים|ילדים)\s+ב-?\s*\d/;
const QUOTE_COMMERCE = /הצעת\s+מחיר|בהתאמה\s+אישית|לפי\s+דרישה/;
const BY_REQUEST_ONLY = /(?:רק|אך\s+ורק)\s+בתיאום\s+מראש|בתיאום\s+מראש\s+בלבד|לפי\s+בקשה|במועד\s+שתבחרו|בתאריך\s+שתבחרו|בהזמנה\s+מראש\s+בלבד/;
const INSTITUTIONAL = /לגני\s+ילדים\s+ובתי\s+ספר|לבתי\s+ספר\s+וגנים|למוסדות|לחברות\s+וארגונים|לארגונים|קבוצות\s+(?:חינוכיות|ארגוניות)|לקבוצות\s+מאורגנות\s+בלבד|לקבוצות\s+בלבד/;
const SERVICE_TAGS = new Set(['מתאים ליום הולדת', 'מתאים לקבוצות']);

function nameHead(name) {
  const n = String(name || '').trim();
  // separator = dash/colon followed by whitespace ("מרכז: סיור", "פארק - חבילה"); a hyphen glued on
  // both sides ("בר-מצווה") is part of a word and does not split
  const parts = n.split(/\s*[-–:]\s+/);
  return (parts.length > 1 ? parts[parts.length - 1] : n).trim();
}

// -> { access, modelAccess, evidence[], suppressors[], privateSignals, strong, suspicious }
//    evidence / suppressors are { code, label } for the review UI (label in Hebrew, never raw JSON)
function assessAccessType(c = {}) {
  const name = String(c.name || '');
  const description = String(c.description || '');
  const head = nameHead(name);
  const text = `${name} ${description}`;
  const ff = Array.isArray(c.family_fit) ? c.family_fit : [];
  const modelAccess = sanitizeAccessType(c.offering_access_type).access;

  const evidence = [];
  const subject = PRIVATE_HEAD.test(head);
  if (subject) evidence.push({ code: 'subject_private_service', label: `נושא השורה הוא שירות פרטי/קבוצתי ("${head}")` });
  if (GROUP_PRICING.test(text)) evidence.push({ code: 'group_pricing', label: 'תמחור לקבוצה / מינימום משתתפים' });
  if (QUOTE_COMMERCE.test(text)) evidence.push({ code: 'quote_commerce', label: 'הצעת מחיר / התאמה אישית' });
  const byRequest = BY_REQUEST_ONLY.test(text);
  if (byRequest) evidence.push({ code: 'occurrence_by_request', label: 'מתקיים רק בתיאום/לפי בקשה' });
  if (INSTITUTIONAL.test(text)) evidence.push({ code: 'institutional_target', label: 'מיועד למוסדות / קבוצות מאורגנות' });
  if (ff.length && ff.every((t) => SERVICE_TAGS.has(t))) evidence.push({ code: 'family_fit_service_only', label: 'family_fit מכיל רק תגי יום הולדת/קבוצות' });

  const suppressors = [];
  if (c.entity_type === 'מקום_קבוע') suppressors.push({ code: 'place_row', label: 'שורת מקום קבוע - המקום עצמו, לא חבילה' });
  const hasGroupPricing = evidence.some((e) => e.code === 'group_pricing');
  if (['fixed', 'range'].includes(c.price_type) && !hasGroupPricing && (Number(c.price_amount) > 0 || Number(c.price_min) > 0)) suppressors.push({ code: 'public_per_person_price', label: 'מחיר ציבורי לאדם' });
  if (typeof c.registration_url === 'string' && /^https?:\/\//i.test(c.registration_url)) suppressors.push({ code: 'public_registration_link', label: 'קישור הרשמה/כרטיסים ציבורי' });
  const hasOccurrence = (c.schedule_type === 'one_time' && !!c.one_time_date) || (c.schedule_type === 'recurring' && Array.isArray(c.recurring_days) && c.recurring_days.length > 0) || c.schedule_type === 'fixed_hours';
  if (hasOccurrence && !byRequest) suppressors.push({ code: 'independent_occurrence', label: 'מועד/שעות ציבוריים שאינם תלויים בלקוח' });
  if (!subject && PRIVATE_LEXICON.test(description) && !PRIVATE_LEXICON.test(name)) suppressors.push({ code: 'secondary_mention_only', label: 'שירות פרטי מוזכר רק בתיאור, לא כנושא' });
  if (!subject && PUBLIC_HEAD.test(head)) suppressors.push({ code: 'public_subject_head', label: `נושא ציבורי ("${head}")` });

  const privateSignals = evidence.length;
  const strong = subject || byRequest;
  const hasSuppressor = suppressors.length > 0;

  let access;
  let suspicious = false;
  if (modelAccess === 'private_group') access = privateSignals >= 1 && !hasSuppressor ? 'private_group' : 'mixed';
  else if (modelAccess === 'mixed') access = 'mixed';
  else if (modelAccess === 'public') access = strong && privateSignals >= 2 && !hasSuppressor ? 'mixed' : 'public';
  else { access = 'unknown'; suspicious = strong && privateSignals >= 2 && !hasSuppressor; }

  return { access, modelAccess, evidence, suppressors, privateSignals, strong, suspicious };
}

// AUTO-PUBLISH: only 'public' may pass; private_group / mixed are held; a suspicious unknown is held;
// an ordinary unknown keeps today's behaviour (the caller's other gates decide).
function blocksAutoPublish(assessment) {
  return assessment.access === 'private_group' || assessment.access === 'mixed' || assessment.suspicious === true;
}
function needsAccessAcknowledgement(assessment) { return blocksAutoPublish(assessment); }

// MANUAL APPROVAL: the pure decision behind POST /api/incoming/:id/approve. A generic Approve click
// is never read as an access verdict; the reviewer must choose explicitly when the row is suspect.
// -> { kind: 'proceed', access } | { kind: 'needs_access_acknowledgement', ... } | { kind: 'ineligible', access }
//    | { kind: 'hold_mixed', access } | { kind: 'invalid_acknowledgement', error }
function approvalDecision({ assessment, acknowledgedAccessType = null }) {
  if (acknowledgedAccessType != null) {
    const v = sanitizeAccessType(acknowledgedAccessType).access;
    if (!ACK_CHOICES.includes(v) || String(acknowledgedAccessType).trim().toLowerCase() !== v) {
      return { kind: 'invalid_acknowledgement', error: `acknowledged_access_type must be one of ${ACK_CHOICES.join('/')}` };
    }
    if (v === 'public') return { kind: 'proceed', access: 'public' };
    if (v === 'private_group') return { kind: 'ineligible', access: 'private_group' };
    return { kind: 'hold_mixed', access: 'mixed' };
  }
  if (needsAccessAcknowledgement(assessment)) {
    return { kind: 'needs_access_acknowledgement', proposed: assessment.access, suspicious: assessment.suspicious,
      evidence: assessment.evidence, suppressors: assessment.suppressors, choices: [...ACK_CHOICES] };
  }
  return { kind: 'proceed', access: assessment.access === 'public' ? 'public' : 'unknown' };
}

module.exports = { ACCESS_TYPE_VALUES, ACCESS_LABEL_HE, ACCESS_ISSUE_LABEL, ACK_CHOICES, sanitizeAccessType, assessAccessType, blocksAutoPublish, needsAccessAcknowledgement, approvalDecision, nameHead };
