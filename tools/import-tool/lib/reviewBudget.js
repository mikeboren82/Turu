// TuRu - CONTINUOUS MONSTER: the human-review budget (pure, testable). Human judgment is reserved for genuinely
// ambiguous cases; everything else must be counted under its real reason so that a growing queue is a SIGNAL,
// never a landfill. Inputs are plain rows (incoming_activities over a window, open queue, Cleaner cases).
const RESOLVABLE_ISSUES = new Set(['missing_location', 'incomplete_address', 'missing_venue', 'missing_image', 'missing_region', 'missing_city', 'city_not_canonical', 'missing_required_metadata', 'missing_schedule', 'unverified_location']);

// one incoming row -> its bucket
function classifyIncoming(row) {
  const st = row.status, mt = row.match_type, reason = row.archive_reason || '';
  if (st === 'approved') return 'auto_approved';
  if (mt === 'duplicate' || reason === 'duplicate_of_existing_activity' || reason === 'duplicate_of_pending_candidate') return 'duplicate';
  if (reason === 'outside_service_area') return 'outside_service_area';
  if (st === 'rejected' && reason === 'invalid_event') return 'rejected_not_for_children';
  if (st === 'rejected' && /missing_address|city_unresolved|ambiguous_location|venue_not_found/.test(reason)) return 'unresolved_location';
  if (st === 'rejected') return 'rejected_other';
  if (st === 'missing_flagged') return 'missing_from_source';
  if (mt === 'update') return 'update_for_review';
  const issues = row.validation_issues || [];
  if (issues.includes('עיר') || (!row.city && !row.formatted_address)) return 'cleaner_resolvable_location';
  if (issues.some((i) => ['קטגוריה', 'תאריך', 'סוג ישות', 'קהל יעד לא ברור', 'ימי פעילות'].includes(i))) return 'cleaner_resolvable_metadata';
  if (row.source_trusted === false) return 'held_untrusted_source';
  if (row.confidence_score != null && row.confidence_score < 0.6 && mt === 'new') return 'low_confidence_extraction';
  return 'requires_human_judgment';
}

function tally(rows, fn) { const m = {}; for (const r of rows) { const k = fn(r); m[k] = (m[k] || 0) + 1; } return m; }

// window = rows found in the window; openQueue = rows currently open (new / needs_review)
// -> { perCycle: {...buckets}, open: {...buckets}, signals: [{level, code, message}] }
function reviewBudget({ window = [], openQueue = [], reviewedInWindow = 0, cleanerResolvedInWindow = 0, windowDays = 7 }) {
  const perCycle = tally(window, classifyIncoming);
  const open = tally(openQueue, classifyIncoming);
  const inflow = window.filter((r) => ['needs_review', 'new'].includes(r.status) && r.match_type !== 'duplicate').length;
  const outflow = reviewedInWindow + cleanerResolvedInWindow;
  const humanOnly = (open.requires_human_judgment || 0) + (open.update_for_review || 0) + (open.low_confidence_extraction || 0);
  const signals = [];
  if (inflow > outflow * 1.5 && inflow >= 20) signals.push({ level: 'warn', code: 'review_debt_growing', message: `review inflow ${inflow} > outflow ${outflow} over ${windowDays} d` });
  if (openQueue.length > 1500) signals.push({ level: 'warn', code: 'review_queue_large', message: `${openQueue.length} open review rows` });
  const cleanerShare = ((open.cleaner_resolvable_location || 0) + (open.cleaner_resolvable_metadata || 0)) / Math.max(1, openQueue.length);
  if (cleanerShare > 0.5 && openQueue.length >= 100) signals.push({ level: 'info', code: 'queue_mostly_cleaner_resolvable', message: `${Math.round(cleanerShare * 100)} % of the open queue is Cleaner-resolvable (location / metadata) - not human work yet` });
  if ((perCycle.outside_service_area || 0) > 0) signals.push({ level: 'info', code: 'outside_service_area_blocked', message: `${perCycle.outside_service_area} candidates stopped by the service-area rule` });
  return { perCycle, open, inflow, outflow, humanOnly, signals };
}

module.exports = { classifyIncoming, reviewBudget, RESOLVABLE_ISSUES };
