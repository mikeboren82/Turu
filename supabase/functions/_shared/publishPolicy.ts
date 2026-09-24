// TuRu - CANONICAL PUBLISH POLICY (2026-09-24). The ONE answer to "may this candidate be published
// automatically NOW?", evaluated from the candidate's CURRENT data and the CURRENT policy - never from a
// verdict stored when a scan ran or a Cleaner case opened. Every automated path uses it: scan-source intake
// (autoApproveEligible), and through the Node twin tools/import-tool/lib/publishPolicy.js the admin approve
// route (at the write boundary), the evaluate route, the Cleaner hand-back and reprocess-review-queue.js.
// Parity: _shared/publishPolicy.cases.json runs against both twins.
//
// Pure: no I/O. Row-level facts that need the database (coordinates verified, service area, exact duplicate)
// are added by the Node row evaluator (lib/incomingEligibility.js); at intake scan-source verifies the location
// inside autoApproveNewActivity and dedups before this runs.
//
// Each reason: { code, severity: 'hold' | 'terminal', humanOverridable, detail? }
//   decision   ELIGIBLE (no reason) | HELD (holds only) | INELIGIBLE (a terminal reason) - for AUTOMATED publication
//   humanApprovable  no terminal reason a person may not override. A reviewer's Approve IS the decision on
//              trust / relevance / content / metadata holds; access and granularity keep their own
//              acknowledgement flow in the approve route; an expired event can be approved by nobody.
import { missingTemporalEvidence, childRelevanceEvidence, isPlausibleEventDate, looksLikeStaleRepost } from './extraction.ts';
import { assessAccessType, blocksAutoPublish as accessBlocks } from './accessType.ts';
import { assessGranularity, blocksAutoPublish as granularityBlocks } from './granularity.ts';
import { assessAutoPublishSafety } from './autoPublishSafety.ts';
import { substantiveIssues, pendingLifecycle } from './intakePolicy.ts';
import { assessTemporalShape } from './temporalShape.ts';
import { compoundLocationHold } from './placeSafety.ts';

export type Severity = 'hold' | 'terminal';
export interface PolicyReason { code: string; severity: Severity; humanOverridable: boolean; detail?: unknown }
export type Decision = 'ELIGIBLE' | 'HELD' | 'INELIGIBLE';
export interface PolicySource { is_trusted?: boolean | null; source_trust_score?: number | null; name?: string | null; seed_url?: string | null }
export interface PolicyRow { status?: string | null; match_type?: string | null; deferred_until?: string | null }
export interface PolicyContext {
  source: PolicySource | null;
  issues?: unknown;                 // the row's CURRENT validation_issues (or the candidate's labels at intake)
  today: string;                    // YYYY-MM-DD
  minTrust: number;                 // automation_settings.auto_approve_min_trust_score
  maxDaysAhead: number;             // automation_settings.event_max_days_ahead
  row?: PolicyRow | null;           // an existing incoming row (absent at intake)
  trustOverride?: string | null;    // a named, audited reason the SOURCE-trust gate is satisfied (never relevance)
}
// deno-lint-ignore no-explicit-any
type Candidate = Record<string, any>;

// Ages / audience written by the Cleaner's metadata enricher (extracted_data.cleaner_fields.audience) are first-party
// child evidence only with an event-local provenance (cleaner/fieldEnricher.js, 2026-09-24). Before that the enricher
// read whole pages, and a bare "גיל הרך" / "תינוקות" in a menu, a department name or a footer was stored as HIGH
// "explicit ages" 0-5 (verify_location pilot #7: an evening concert published as a toddler event). Such a legacy
// record - or one a reviewer invalidated - is set aside for the relevance and content-safety judgments: the ages it
// wrote are not evidence. Records with provenance, and ages from the extraction itself,
// are untouched.
// The same legacy parser also read clock times as ages ("10:00-22:00" -> "explicit ages: 00 - 22" -> 0-22): a bare
// range with a leading zero, or one that is not lo < hi <= 18, is not an age either.
// Only the ages the record wrote are removed; the audience LABEL stays - a label alone never publishes (and clearing it
// would skip the label's own adult-marker check).
const LEGACY_BARE_AGE_WORD = /^explicit ages:\s*(?:גיל הרך|לפעוטות|פעוטות|קטנטנים|תינוקות)\s*$/;
const LEGACY_BARE_RANGE = /^explicit ages:\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\s*$/;
function untrustedEnrichmentAges(a: Candidate | null | undefined): [number | null, number | null] | null {
  if (!a || typeof a !== 'object') return null;
  const ev = String(a.evidence || '');
  if (a.invalidated === true) return a.previous ? [a.previous.min_age ?? null, a.previous.max_age ?? null] : [0, 5];
  if (a.provenance) return null;
  if (LEGACY_BARE_AGE_WORD.test(ev)) return [0, 5];
  const m = LEGACY_BARE_RANGE.exec(ev);
  if (m) { const lo = Number(m[1]), hi = Number(m[2]); if (/^0\d/.test(m[1]) || /^0\d/.test(m[2]) || !(lo < hi && hi <= 18)) return [lo, hi]; }
  return null;
}
export function withoutUntrustedEnrichment(c: Candidate): Candidate {
  const wrote = untrustedEnrichmentAges(c && c.cleaner_fields && c.cleaner_fields.audience);
  if (!wrote) return c;
  if (c.min_age == null && c.max_age == null) return c;
  if (c.min_age !== wrote[0] || (c.max_age ?? null) !== wrote[1]) return c; // not the ages that record wrote
  return { ...c, min_age: null, max_age: null };
}

const hold = (code: string, detail?: unknown): PolicyReason => ({ code, severity: 'hold', humanOverridable: true, ...(detail !== undefined ? { detail } : {}) });
const terminal = (code: string, humanOverridable: boolean, detail?: unknown): PolicyReason => ({ code, severity: 'terminal', humanOverridable, ...(detail !== undefined ? { detail } : {}) });

export function decide(reasons: PolicyReason[]): { decision: Decision; humanApprovable: boolean } {
  const decision: Decision = reasons.some((r) => r.severity === 'terminal') ? 'INELIGIBLE' : reasons.length ? 'HELD' : 'ELIGIBLE';
  return { decision, humanApprovable: !reasons.some((r) => r.severity === 'terminal' && !r.humanOverridable) };
}

export function evaluatePublishPolicy(c: Candidate, ctx: PolicyContext): { decision: Decision; humanApprovable: boolean; reasons: PolicyReason[] } {
  const reasons: PolicyReason[] = [];
  const row = ctx.row || null;
  // lifecycle of an existing row
  if (row) {
    if (!['new', 'needs_review'].includes(String(row.status))) reasons.push(terminal('not_pending', false, row.status));
    if (row.match_type !== 'new') reasons.push(hold('not_a_new_candidate', row.match_type));
  }
  const lc = pendingLifecycle({ match_type: row ? row.match_type : 'new', status: row ? row.status : 'new', extracted_data: c, validation_issues: [], deferred_until: row?.deferred_until ?? null }, ctx.today, ctx.maxDaysAhead);
  if (lc.action === 'expire') reasons.push(terminal('expired', false, lc.lastDate));
  else if (row?.deferred_until && row.deferred_until > ctx.today) reasons.push(hold('deferred', row.deferred_until));
  // publisher trust (a property of the SOURCE; it answers nothing about the content)
  const s = ctx.source || {};
  const trusted = !!ctx.trustOverride || !!s.is_trusted || (s.source_trust_score != null && Number(s.source_trust_score) >= ctx.minTrust);
  if (!trusted) reasons.push(hold('untrusted_source', s.source_trust_score ?? null));
  // open review / Cleaner items still attached to the row
  const open = substantiveIssues(ctx.issues);
  if (open.length) reasons.push(hold('open_issues', open));
  // a place to put it
  if (!c.city || !(c.location_name || c.formatted_address)) reasons.push(hold('no_place'));
  // a compound label ("גן החיות ואקווריום ישראל") never lends one component's point to the sub-place the title names
  const compound = compoundLocationHold(c);
  if (compound) reasons.push(hold('location_compound_label', compound));
  // temporal evidence the entity type requires, and the auto-publish date window
  const temporal = missingTemporalEvidence(c);
  if (temporal) reasons.push(hold('missing_temporal_evidence', temporal));
  if (c.schedule_type === 'one_time' && lc.action !== 'expire' && !isPlausibleEventDate(c.one_time_date ?? null, ctx.today, ctx.maxDaysAhead)) reasons.push(hold('date_outside_window', c.one_time_date ?? null));
  if (looksLikeStaleRepost(c as { schedule_type?: string | null; one_time_date?: string | null; source_published_date?: string | null }, ctx.today)) reasons.push(hold('stale_repost', c.source_published_date ?? null));
  // is ONE occurrence really one occurrence - not a programme / run / series collapsed to a single date (temporalShape.ts)
  const shape = assessTemporalShape(c);
  if (shape.collapsed) reasons.push(hold('temporal_shape_ambiguous', { signals: shape.signals, evidence: shape.evidence ?? null, span: shape.span ?? null }));
  // who it is for: children's relevance, then positive child evidence for commercial / אחר content
  // (evidence hierarchy: item-local publisher context > item text / ages > the model's audience label)
  const evidence = withoutUntrustedEnrichment(c);
  const relevance = childRelevanceEvidence(evidence);
  if (relevance.verdict === 'reject') reasons.push(terminal('relevance_reject', true, relevance.reason));
  else if (relevance.verdict === 'review') reasons.push(hold('relevance_review', relevance.reason));
  const safety = assessAutoPublishSafety(evidence, { name: s.name ?? null, url: s.seed_url ?? null });
  if (!safety.allow) reasons.push(hold('content_safety', { code: safety.code, evidence: safety.evidence }));
  // who may attend, and is it one actionable thing (re-assessed now; a stored verdict can only add a hold)
  const access = assessAccessType(c);
  if (accessBlocks(access)) reasons.push(hold('access', access.access + (access.suspicious ? ':suspicious' : '')));
  const storedGranularity = c.granularity_evidence?.verdict;
  if ((storedGranularity && storedGranularity !== 'independent') || granularityBlocks(assessGranularity(c))) reasons.push(hold('granularity', storedGranularity || assessGranularity(c).verdict));
  return { ...decide(reasons), reasons };
}
