// TuRu - granularity: IS THIS ONE INDEPENDENTLY ACTIONABLE THING? (Phase 1, 2026-09-22). Deno/
// TypeScript twin of tools/import-tool/lib/granularity.js (Node) - same deliberate-duplication
// arrangement as accessType.ts/cityNaming.ts. Read that file's header for the full rationale; kept
// here only where the two runtimes differ (types, and the DB-aware helper's client type).

export const GRANULARITY_VALUES = ['independent', 'not_independent', 'uncertain'] as const;
export type GranularityVerdict = typeof GRANULARITY_VALUES[number];
export const GRANULARITY_LABEL_HE: Record<GranularityVerdict, string> = { independent: 'עצמאית', not_independent: 'לא עצמאית (עטיפה / תת-אזור)', uncertain: 'לא ברור' };
// the review-queue GATING issue label - never soft, same vocabulary as ACCESS_ISSUE_LABEL/TEMPORAL_ISSUE_LABEL
export const GRANULARITY_ISSUE_LABEL = 'יחידת פעילות';
// the Cleaner case issue type (supabase/0107, prepared but NOT applied - see that file's header)
export const CLEANER_ISSUE = 'not_independently_actionable';
// the reviewer's four explicit outcomes (Section 12): 'independent' proceeds, 'wrapper'/'sub_area'
// mean the row is never published as its own activity, 'uncertain' holds it in review
export const ACK_CHOICES = ['independent', 'wrapper', 'sub_area', 'uncertain'] as const;
export type AckChoice = typeof ACK_CHOICES[number];

const WRAPPER_TITLE = /(פעילויות\s+ב|פעילויות\s+ל|אירועים\s+ב|מה\s+עושים|אטרקציות\s+ב|חוגים\s+ב|מגוון\s+פעילויות|לוח\s+אירועים|רפרטואר|כרטיס\s+משולב)/;
const WRAPPER_DESC = /(מגוון\s+פעילויות|מגוון\s+אירועים|מגוון\s+סדנאות|כל\s+הפעילויות|לוח\s+האירועים|תוכניה|רפרטואר|מגוון\s+אטרקציות|פעילויות\s+שונות|אטרקציות\s+שונות|מגוון\s+חוגים)/;
const ZONE_TITLE = /(?:^|\s)(אזור|מתחם|פינת|אגף|ביתן|תחנת|עמדת)\s/;
const ZONE_DESC = /^(אזור|מתחם|פינה|אגף|ביתן)\s|אזור\s+ב(פארק|מתחם|גן|מוזיאון)|(?:חלק|אזור)\s+מ(תוך)?\s*(ה)?(פארק|מתחם|אתר|יעד)/;

function nDays(recurringDays: unknown): number {
  return Array.isArray(recurringDays) ? new Set(recurringDays.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)).size : 0;
}

export interface GranularityCandidate {
  name?: string | null; description?: string | null; schedule_type?: string | null; recurring_days?: unknown;
  one_time_date?: string | null; price_type?: string | null; registration_url?: string | null; booking_requirement?: string | null;
}
export interface GranularityEvidence { code: string; label: string }
export interface GranularityAssessment { verdict: GranularityVerdict; reason: 'wrapper' | 'sub_entity' | null; evidence: GranularityEvidence[]; suppressors: GranularityEvidence[] }

// Deterministic, structural-only assessment (Section 3) - a pure function of the candidate's own
// extracted fields. `siblingPlaceAtVenue` is an OPTIONAL boolean the caller supplies after a
// venue-aware DB lookup (Section 7); omit/null when unavailable, never guess. `hasVenue` is
// OPTIONAL too (true/false once venue resolution has run, null before it has) - a "sub_entity"
// verdict claims the row is PART OF a larger destination, so once a venue lookup has run and found
// NONE, a confident NOT_INDEPENDENT from title+description text alone downgrades to UNCERTAIN:
// there is no parent to point to (Section 7). See the Node twin's comment for the production
// dry-run false positive this fixes ("מתחם" = zone-inside-a-place OR self-contained facility).
export function assessGranularity(c: GranularityCandidate = {}, opts: { siblingPlaceAtVenue?: boolean | null; hasVenue?: boolean | null } = {}): GranularityAssessment {
  const siblingPlaceAtVenue = opts.siblingPlaceAtVenue ?? null;
  const hasVenue = opts.hasVenue ?? null;
  const name = String(c.name || '');
  const description = String(c.description || '');

  const evidence: GranularityEvidence[] = [];
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

  const suppressors: GranularityEvidence[] = [];
  const hasOwnPrice = c.price_type === 'fixed' || c.price_type === 'range';
  if (hasOwnPrice) suppressors.push({ code: 'has_own_price', label: 'יש לשורה מחיר/כרטיס משלה' });
  // a concrete registration LINK proves one specific booking action; booking_requirement alone is a
  // generic categorical tag that a wrapper describing several sub-offerings can carry too (real
  // false negative caught in the production dry-run, 2026-09-22: see the Node twin's comment).
  const hasBooking = typeof c.registration_url === 'string' && /^https?:\/\//i.test(c.registration_url);
  if (hasBooking) suppressors.push({ code: 'has_booking_action', label: 'יש קישור הרשמה/פעולת הזמנה עצמאית' });
  const hasOwnDate = c.schedule_type === 'one_time' && !!c.one_time_date;
  if (hasOwnDate) suppressors.push({ code: 'has_one_time_date', label: 'אירוע עם תאריך משלו - החלטת השתתפות עצמאית מטבעה' });

  const wrapperScore = [wrapperTitle, wrapperDesc, weekdaySaturation].filter(Boolean).length;
  const subEntityScore = [zoneTitle, zoneDesc, siblingPlaceAtVenue === true].filter(Boolean).length;
  const hasSuppressor = suppressors.length > 0;

  let verdict: GranularityVerdict; let reason: 'wrapper' | 'sub_entity' | null = null;
  if (hasSuppressor) { verdict = 'independent'; }
  else if (wrapperScore >= 2) { verdict = 'not_independent'; reason = 'wrapper'; }
  else if (subEntityScore >= 2 && hasVenue !== false) { verdict = 'not_independent'; reason = 'sub_entity'; }
  else if (subEntityScore >= 2) { verdict = 'uncertain'; reason = 'sub_entity'; }
  else if (wrapperScore === 1) { verdict = 'uncertain'; reason = 'wrapper'; }
  else if (subEntityScore === 1) { verdict = 'uncertain'; reason = 'sub_entity'; }
  else { verdict = 'independent'; }

  return { verdict, reason, evidence, suppressors };
}

// AUTO-PUBLISH: only 'independent' may pass; 'not_independent' AND 'uncertain' both hold for review.
export function blocksAutoPublish(assessment: GranularityAssessment): boolean {
  return assessment.verdict !== 'independent';
}
export function needsGranularityAcknowledgement(assessment: GranularityAssessment): boolean { return blocksAutoPublish(assessment); }

export type GranularityDecision =
  | { kind: 'proceed'; granularity: 'independent' }
  | { kind: 'needs_granularity_acknowledgement'; proposedVerdict: GranularityVerdict; proposedReason: string | null; evidence: GranularityEvidence[]; suppressors: GranularityEvidence[]; choices: AckChoice[] }
  | { kind: 'ineligible'; granularity: AckChoice }
  | { kind: 'hold_uncertain'; granularity: 'uncertain' }
  | { kind: 'invalid_acknowledgement'; error: string };

export function granularityDecision({ assessment, acknowledgedGranularity = null }: { assessment: GranularityAssessment; acknowledgedGranularity?: string | null }): GranularityDecision {
  if (acknowledgedGranularity != null) {
    const v = String(acknowledgedGranularity).trim().toLowerCase();
    if (!(ACK_CHOICES as readonly string[]).includes(v)) return { kind: 'invalid_acknowledgement', error: `acknowledged_granularity must be one of ${ACK_CHOICES.join('/')}` };
    if (v === 'independent') return { kind: 'proceed', granularity: 'independent' };
    if (v === 'uncertain') return { kind: 'hold_uncertain', granularity: 'uncertain' };
    return { kind: 'ineligible', granularity: v as AckChoice };
  }
  if (needsGranularityAcknowledgement(assessment)) {
    return { kind: 'needs_granularity_acknowledgement', proposedVerdict: assessment.verdict, proposedReason: assessment.reason,
      evidence: assessment.evidence, suppressors: assessment.suppressors, choices: [...ACK_CHOICES] };
  }
  return { kind: 'proceed', granularity: 'independent' };
}

// deno-lint-ignore no-explicit-any
type Client = any;
// VENUE-AWARE REFINEMENT (Section 7) - see the Node twin's header comment for the full rationale.
export async function hasPlaceSiblingAtVenue(client: Client, venueId: string | null, excludeActivityId: string | null = null): Promise<boolean | null> {
  if (!venueId) return null;
  let q = client.from('activities').select('id', { count: 'exact', head: true }).eq('venue_id', venueId).eq('entity_type', 'מקום_קבוע').eq('status', 'approved');
  if (excludeActivityId) q = q.neq('id', excludeActivityId);
  const { count, error } = await q;
  if (error) return null;
  return (count || 0) > 0;
}
