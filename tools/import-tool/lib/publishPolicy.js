// TuRu - CANONICAL PUBLISH POLICY, Node twin of supabase/functions/_shared/publishPolicy.ts (identical rules;
// the shared case table _shared/publishPolicy.cases.json runs against both). Pure, no I/O. The row evaluator
// lib/incomingEligibility.js adds the database facts (coordinates, service area, exact duplicate).
const { missingTemporalEvidence } = require('./temporalEvidence');
const { childRelevanceEvidence } = require('../childRelevance');
const { assessAccessType, blocksAutoPublish: accessBlocks } = require('./accessType');
const { assessGranularity, blocksAutoPublish: granularityBlocks } = require('./granularity');
const { assessAutoPublishSafety } = require('./autoPublishSafety');
const { substantiveIssues, pendingLifecycle } = require('./intakePolicy');
const { assessTemporalShape } = require('./temporalShape');

// same rules as extraction.ts isPlausibleEventDate / looksLikeStaleRepost
function isPlausibleEventDate(dateStr, todayStr, maxDaysAhead) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(dateStr + 'T00:00:00Z').getTime();
  const t = new Date(todayStr + 'T00:00:00Z').getTime();
  if (Number.isNaN(d) || Number.isNaN(t)) return false;
  const days = (d - t) / 86400000;
  return days >= 0 && days <= maxDaysAhead;
}
function looksLikeStaleRepost(candidate, todayStr, maxAgeDays = 365) {
  const pub = candidate.source_published_date;
  if (!pub || !/^\d{4}-\d{2}-\d{2}$/.test(pub)) return false;
  const ageDays = (new Date(todayStr + 'T00:00:00Z').getTime() - new Date(pub + 'T00:00:00Z').getTime()) / 86400000;
  if (ageDays <= maxAgeDays) return false;
  return candidate.schedule_type === 'one_time' || !candidate.schedule_type;
}

const hold = (code, detail) => ({ code, severity: 'hold', humanOverridable: true, ...(detail !== undefined ? { detail } : {}) });
const terminal = (code, humanOverridable, detail) => ({ code, severity: 'terminal', humanOverridable, ...(detail !== undefined ? { detail } : {}) });

function decide(reasons) {
  const decision = reasons.some((r) => r.severity === 'terminal') ? 'INELIGIBLE' : reasons.length ? 'HELD' : 'ELIGIBLE';
  return { decision, humanApprovable: !reasons.some((r) => r.severity === 'terminal' && !r.humanOverridable) };
}

function evaluatePublishPolicy(c, ctx) {
  const reasons = [];
  const row = ctx.row || null;
  if (row) {
    if (!['new', 'needs_review'].includes(String(row.status))) reasons.push(terminal('not_pending', false, row.status));
    if (row.match_type !== 'new') reasons.push(hold('not_a_new_candidate', row.match_type));
  }
  const lc = pendingLifecycle({ match_type: row ? row.match_type : 'new', status: row ? row.status : 'new', extracted_data: c, validation_issues: [], deferred_until: row?.deferred_until ?? null }, ctx.today, ctx.maxDaysAhead);
  if (lc.action === 'expire') reasons.push(terminal('expired', false, lc.lastDate));
  else if (row?.deferred_until && row.deferred_until > ctx.today) reasons.push(hold('deferred', row.deferred_until));
  const s = ctx.source || {};
  const trusted = !!ctx.trustOverride || !!s.is_trusted || (s.source_trust_score != null && Number(s.source_trust_score) >= ctx.minTrust);
  if (!trusted) reasons.push(hold('untrusted_source', s.source_trust_score ?? null));
  const open = substantiveIssues(ctx.issues);
  if (open.length) reasons.push(hold('open_issues', open));
  if (!c.city || !(c.location_name || c.formatted_address)) reasons.push(hold('no_place'));
  const temporal = missingTemporalEvidence(c);
  if (temporal) reasons.push(hold('missing_temporal_evidence', temporal));
  if (c.schedule_type === 'one_time' && lc.action !== 'expire' && !isPlausibleEventDate(c.one_time_date ?? null, ctx.today, ctx.maxDaysAhead)) reasons.push(hold('date_outside_window', c.one_time_date ?? null));
  if (looksLikeStaleRepost(c, ctx.today)) reasons.push(hold('stale_repost', c.source_published_date ?? null));
  const shape = assessTemporalShape(c);
  if (shape.collapsed) reasons.push(hold('temporal_shape_ambiguous', { signals: shape.signals, evidence: shape.evidence ?? null, span: shape.span ?? null }));
  const relevance = childRelevanceEvidence(c);
  if (relevance.verdict === 'reject') reasons.push(terminal('relevance_reject', true, relevance.reason));
  else if (relevance.verdict === 'review') reasons.push(hold('relevance_review', relevance.reason));
  const safety = assessAutoPublishSafety(c, { name: s.name ?? null, url: s.seed_url ?? null });
  if (!safety.allow) reasons.push(hold('content_safety', { code: safety.code, evidence: safety.evidence }));
  const access = assessAccessType(c);
  if (accessBlocks(access)) reasons.push(hold('access', access.access + (access.suspicious ? ':suspicious' : '')));
  const storedGranularity = c.granularity_evidence?.verdict;
  if ((storedGranularity && storedGranularity !== 'independent') || granularityBlocks(assessGranularity(c))) reasons.push(hold('granularity', storedGranularity || assessGranularity(c).verdict));
  return { ...decide(reasons), reasons };
}

module.exports = { evaluatePublishPolicy, decide, isPlausibleEventDate, looksLikeStaleRepost };
