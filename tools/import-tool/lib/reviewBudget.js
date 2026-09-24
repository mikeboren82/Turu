// TuRu - CONTINUOUS MONSTER: the human-review budget (pure, testable). Human judgment is reserved for genuinely
// ambiguous cases; everything else must be counted under its real reason so that a growing queue is a SIGNAL,
// never a landfill. Inputs are plain rows (incoming_activities over a window, open queue, Cleaner cases).
//
// Human Queue Policy Phase A (2026-09-24):
// - 'מחיר' (unknown price) is completeness metadata, never a substantive issue - also on legacy rows that still
//   carry the flag (lib/intakePolicy.js substantiveIssues).
// - the former 'low_confidence_extraction' bucket read incoming_activities.confidence_score, which is the MATCH
//   confidence (0 for every match_type=new row by construction) - there is no extraction-confidence value in the
//   data, so the bucket is gone. A clean new row with no substantive issue is 'awaiting_publish_checks' (it waits
//   on trust / location verification / the date window - system work, not a person).
// - pending lifecycle buckets: 'expired_pending' (every known date passed) and 'deferred_far_future'.
const { substantiveIssues, pendingLifecycle, classifyUpdateDiff } = require('./intakePolicy');

const RESOLVABLE_ISSUES = new Set(['missing_location', 'incomplete_address', 'missing_venue', 'missing_image', 'missing_region', 'missing_city', 'city_not_canonical', 'missing_required_metadata', 'missing_schedule', 'unverified_location']);
const METADATA_ISSUES = ['קטגוריה', 'תאריך', 'סוג ישות', 'קהל יעד לא ברור', 'ימי פעילות'];
// buckets that are human work
const HUMAN_BUCKETS = ['requires_human_judgment', 'update_for_review', 'possible_duplicate_review'];

// the dated fields pendingLifecycle needs, from a full row (extracted_data) or a flat select
function lifecycleView(row) {
  const ed = row.extracted_data || { schedule_type: row.schedule_type, entity_type: row.entity_type, one_time_date: row.one_time_date, occurrences: row.occurrences };
  return { match_type: row.match_type, status: row.status, extracted_data: ed, validation_issues: row.validation_issues, deferred_until: row.deferred_until ?? null };
}

// one incoming row -> its bucket. opts.today (YYYY-MM-DD) enables the lifecycle buckets.
function classifyIncoming(row, { today = null, maxDaysAhead = 180 } = {}) {
  const st = row.status, mt = row.match_type, reason = row.archive_reason || '';
  if (st === 'approved') return 'auto_approved';
  if (mt === 'duplicate' && ['new', 'needs_review'].includes(st)) return 'possible_duplicate_review';
  if (mt === 'duplicate' || reason === 'duplicate_of_existing_activity' || reason === 'duplicate_of_pending_candidate') return 'duplicate';
  if (reason === 'outside_service_area') return 'outside_service_area';
  if (st === 'rejected' && reason === 'activity_expired_before_resolution') return 'expired_before_resolution';
  if (st === 'rejected' && reason === 'invalid_event') return 'rejected_not_for_children';
  if (st === 'rejected' && /missing_address|city_unresolved|ambiguous_location|venue_not_found/.test(reason)) return 'unresolved_location';
  if (st === 'rejected') return 'rejected_other';
  if (st === 'missing_flagged') return 'missing_from_source';
  if (mt === 'update') return row.diff !== undefined && classifyUpdateDiff(row.diff).kind !== 'material' ? 'update_no_material_change' : 'update_for_review';
  if (today) {
    const lc = pendingLifecycle(lifecycleView(row), today, maxDaysAhead);
    if (lc.action === 'expire') return 'expired_pending';
    if (lc.action === 'defer' || (lc.action === 'keep' && lc.reason === 'deferred')) return 'deferred_far_future';
  }
  const issues = substantiveIssues(row.validation_issues);
  if (issues.includes('עיר') || (!row.city && !row.formatted_address)) return 'cleaner_resolvable_location';
  if (issues.some((i) => METADATA_ISSUES.includes(i))) return 'cleaner_resolvable_metadata';
  if (row.source_trusted === false) return 'held_untrusted_source';
  if (issues.length) return 'requires_human_judgment';
  return 'awaiting_publish_checks';
}

function tally(rows, fn) { const m = {}; for (const r of rows) { const k = fn(r); m[k] = (m[k] || 0) + 1; } return m; }

// window = rows found in the window; openQueue = rows currently open (new / needs_review)
// -> { perCycle: {...buckets}, open: {...buckets}, signals: [{level, code, message}] }
function reviewBudget({ window = [], openQueue = [], reviewedInWindow = 0, cleanerResolvedInWindow = 0, windowDays = 7, today = null, maxDaysAhead = 180 }) {
  const opts = { today, maxDaysAhead };
  const perCycle = tally(window, (r) => classifyIncoming(r, opts));
  const open = tally(openQueue, (r) => classifyIncoming(r, opts));
  const inflow = window.filter((r) => ['needs_review', 'new'].includes(r.status) && r.match_type !== 'duplicate').length;
  const outflow = reviewedInWindow + cleanerResolvedInWindow;
  const humanOnly = HUMAN_BUCKETS.reduce((n, b) => n + (open[b] || 0), 0);
  const signals = [];
  if (inflow > outflow * 1.5 && inflow >= 20) signals.push({ level: 'warn', code: 'review_debt_growing', message: `review inflow ${inflow} > outflow ${outflow} over ${windowDays} d` });
  if (openQueue.length > 1500) signals.push({ level: 'warn', code: 'review_queue_large', message: `${openQueue.length} open review rows` });
  const cleanerShare = ((open.cleaner_resolvable_location || 0) + (open.cleaner_resolvable_metadata || 0)) / Math.max(1, openQueue.length);
  if (cleanerShare > 0.5 && openQueue.length >= 100) signals.push({ level: 'info', code: 'queue_mostly_cleaner_resolvable', message: `${Math.round(cleanerShare * 100)} % of the open queue is Cleaner-resolvable (location / metadata) - not human work yet` });
  if ((open.expired_pending || 0) > 0) signals.push({ level: 'info', code: 'expired_pending_in_queue', message: `${open.expired_pending} pending one-time candidates whose last date passed - pending lifecycle work, not human work` });
  if ((perCycle.outside_service_area || 0) > 0) signals.push({ level: 'info', code: 'outside_service_area_blocked', message: `${perCycle.outside_service_area} candidates stopped by the service-area rule` });
  return { perCycle, open, inflow, outflow, humanOnly, signals };
}

module.exports = { classifyIncoming, reviewBudget, RESOLVABLE_ISSUES, HUMAN_BUCKETS };
