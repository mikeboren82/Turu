// TuRu - offering access type: WHO MAY ATTEND a row (Phase 1, 2026-09-21). Deno twin of
// tools/import-tool/lib/accessType.js - same deliberate-duplication arrangement as extraction.ts's
// sanitizeCategory: the pair must be changed together (accessType.test.ts / tests/accessType.test.js).
//
// Nothing here archives. The assessment blocks AUTO-publish, explains itself to the reviewer, and
// records the reviewer's explicit verdict. See the Node twin's header for the full rationale.
import categoryValues from './categoryValues.json' with { type: 'json' };

export type AccessType = 'public' | 'private_group' | 'mixed' | 'unknown';
export const ACCESS_TYPE_VALUES: string[] = categoryValues.accessTypes;
const ACCESS_TYPE_SET = new Set(ACCESS_TYPE_VALUES);
export const ACCESS_LABEL_HE: Record<AccessType, string> = { public: 'ציבורי', private_group: 'פרטי / לקבוצה', mixed: 'מעורב', unknown: 'לא ברור' };
export const ACCESS_ISSUE_LABEL = 'גישה';
export const ACK_CHOICES = ['public', 'private_group', 'mixed'] as const;

export interface AccessVerdict { access: AccessType; rejected: boolean; reason: string | null }
export function sanitizeAccessType(raw: unknown): AccessVerdict {
  if (raw === null || raw === undefined || raw === '') return { access: 'unknown', rejected: false, reason: null };
  if (typeof raw !== 'string') return { access: 'unknown', rejected: true, reason: 'access_type_not_a_string' };
  const v = raw.trim().toLowerCase();
  if (!v) return { access: 'unknown', rejected: false, reason: null };
  if (ACCESS_TYPE_SET.has(v)) return { access: v as AccessType, rejected: false, reason: null };
  return { access: 'unknown', rejected: true, reason: `non_canonical_access_type:${v}` };
}

const PRIVATE_HEAD = /^(?:חגיגת\s+)?(?:יום|ימי)\s*הולדת|^יומולדת|^(?:יום|ימי)\s*גיבוש|^גיבוש\b|^אירועי?\s+(?:חברה|חברות)|^השכר(?:ה|ת)\b|^חבילת\b|^חבילה\b|^בר\s*מצווה|^בת\s*מצווה|^אירוע\s+פרטי|^אירועים\s+פרטיים|^מסיב(?:ה|ת|ות)\b/;
const PRIVATE_LEXICON = /(?:יום|ימי)\s*הולדת|יומולדת|גיבוש|השכר(?:ה|ת)|אירועי?\s+חברה|בר\s*מצווה|בת\s*מצווה|אירועים?\s+פרטיים?/;
const PUBLIC_HEAD = /^(?:הצג(?:ה|ת|ות)|סיור(?:ים|י)?|סדנ(?:ה|ת|אות)|מופע|פסטיבל|תערוכ(?:ה|ת)|הקרנ(?:ה|ות)|קונצרט|שעת\s+סיפור|חוג|קייטנ(?:ה|ת)|מחנ(?:ה|ות)|יריד|טיול|מרוץ|הרצא(?:ה|ת)|משחקיי(?:ה|ת)|תיאטרון|פעילות)\b/;
const GROUP_PRICING = /מחיר\s+לקבוצה|לקבוצה\s+של\s+\d+|מינימום\s+\d+\s*(?:משתתפים|ילדים|אנשים|איש)|החל\s+מ-?\s*\d+\s*(?:משתתפים|ילדים|אנשים|איש)|עד\s+\d+\s+(?:משתתפים|ילדים)\s+ב-?\s*\d/;
const QUOTE_COMMERCE = /הצעת\s+מחיר|בהתאמה\s+אישית|לפי\s+דרישה/;
const BY_REQUEST_ONLY = /(?:רק|אך\s+ורק)\s+בתיאום\s+מראש|בתיאום\s+מראש\s+בלבד|לפי\s+בקשה|במועד\s+שתבחרו|בתאריך\s+שתבחרו|בהזמנה\s+מראש\s+בלבד/;
const INSTITUTIONAL = /לגני\s+ילדים\s+ובתי\s+ספר|לבתי\s+ספר\s+וגנים|למוסדות|לחברות\s+וארגונים|לארגונים|קבוצות\s+(?:חינוכיות|ארגוניות)|לקבוצות\s+מאורגנות\s+בלבד|לקבוצות\s+בלבד/;
const SERVICE_TAGS = new Set(['מתאים ליום הולדת', 'מתאים לקבוצות']);

export function nameHead(name: unknown): string {
  const n = String(name ?? '').trim();
  const parts = n.split(/\s*[-–:]\s+/);
  return (parts.length > 1 ? parts[parts.length - 1] : n).trim();
}

export interface Reason { code: string; label: string }
export interface AccessAssessment { access: AccessType; modelAccess: AccessType; evidence: Reason[]; suppressors: Reason[]; privateSignals: number; strong: boolean; suspicious: boolean }

// deno-lint-ignore no-explicit-any
export function assessAccessType(c: Record<string, any> = {}): AccessAssessment {
  const name = String(c.name ?? '');
  const description = String(c.description ?? '');
  const head = nameHead(name);
  const text = `${name} ${description}`;
  const ff: unknown[] = Array.isArray(c.family_fit) ? c.family_fit : [];
  const modelAccess = sanitizeAccessType(c.offering_access_type).access;

  const evidence: Reason[] = [];
  const subject = PRIVATE_HEAD.test(head);
  if (subject) evidence.push({ code: 'subject_private_service', label: `נושא השורה הוא שירות פרטי/קבוצתי ("${head}")` });
  if (GROUP_PRICING.test(text)) evidence.push({ code: 'group_pricing', label: 'תמחור לקבוצה / מינימום משתתפים' });
  if (QUOTE_COMMERCE.test(text)) evidence.push({ code: 'quote_commerce', label: 'הצעת מחיר / התאמה אישית' });
  const byRequest = BY_REQUEST_ONLY.test(text);
  if (byRequest) evidence.push({ code: 'occurrence_by_request', label: 'מתקיים רק בתיאום/לפי בקשה' });
  if (INSTITUTIONAL.test(text)) evidence.push({ code: 'institutional_target', label: 'מיועד למוסדות / קבוצות מאורגנות' });
  if (ff.length && ff.every((t) => SERVICE_TAGS.has(t as string))) evidence.push({ code: 'family_fit_service_only', label: 'family_fit מכיל רק תגי יום הולדת/קבוצות' });

  const suppressors: Reason[] = [];
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

  let access: AccessType;
  let suspicious = false;
  if (modelAccess === 'private_group') access = privateSignals >= 1 && !hasSuppressor ? 'private_group' : 'mixed';
  else if (modelAccess === 'mixed') access = 'mixed';
  else if (modelAccess === 'public') access = strong && privateSignals >= 2 && !hasSuppressor ? 'mixed' : 'public';
  else { access = 'unknown'; suspicious = strong && privateSignals >= 2 && !hasSuppressor; }

  return { access, modelAccess, evidence, suppressors, privateSignals, strong, suspicious };
}

export function blocksAutoPublish(a: AccessAssessment): boolean {
  return a.access === 'private_group' || a.access === 'mixed' || a.suspicious === true;
}

// Model-facing guidance appended to the extraction prompt. Written around the two tests, never
// around keywords, and explicit that "the venue also hosts birthdays" is NOT private_group.
export function accessGuidanceBlock(): string {
  return [
    '- offering_access_type: מי יכול להגיע לפריט הזה - בדיוק אחד מ- "public" | "private_group" | "mixed" | "unknown".',
    '  שני מבחנים, שניהם על נושא הפריט עצמו (לא על מה שהמקום מציע בנוסף):',
    '  (1) כניסה אישית - האם משפחה אחת רגילה יכולה להגיע / להזמין / לקנות כרטיס לעצמה?',
    '  (2) קיום עצמאי - האם הפעילות מתקיימת גם בלי שאותה משפחה הזמינה אותה?',
    '  "public" = שני המבחנים מתקיימים (גם אם צריך להירשם או לקנות כרטיס מראש).',
    '  "private_group" = נושא הפריט הוא חבילת שירות שהלקוח מביא אליה קבוצה משלו ובעצם מזמין את המועד:',
    '     חבילת יום הולדת, יום גיבוש/אירוע חברה, השכרת אולם/מתחם, חוויה סגורה לקבוצה בהזמנה.',
    '  "mixed" = הדף עצמו מערבב כניסה ציבורית ושירות פרטי כך שהכרעה אחת לא בטוחה.',
    '  "unknown" = אין מספיק ראיות.',
    '  קריטי: "המקום גם מארח ימי הולדת" אינו הופך מקום ל-private_group - זה עדיין "public".',
    '  רק פריט שהנושא שלו הוא החבילה עצמה ("יום הולדת ב-X", "ימי גיבוש ב-X") עשוי להיות private_group.',
    '  אל תסיק private_group מהיעדר לוח זמנים או ממילה אחת. סיור/סדנה/הצגה/אירוע ציבורי הדורשים הרשמה הם "public".',
  ].join('\n');
}
