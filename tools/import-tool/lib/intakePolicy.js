// TuRu - Human Review Queue intake policy, Phase A (2026-09-24). Node twin of
// supabase/functions/_shared/intakePolicy.ts - identical rules, parity asserted by tests/intakePolicy.test.js.
// Pure rules that keep ROUTINE noise out of human review: an unknown price is completeness metadata, a diff that
// only restates the record (format, a less specific value, an empty diff) is no update, a diff made only of
// enrichment (description / image / event identity) is not a human decision, a pending one-time candidate
// whose LAST date passed is expired, and a valid event beyond the auto-publish horizon is deferred.

// ---- price: completeness, not a review issue ----
const SOFT_ISSUES = new Set(['מחיר']);
function substantiveIssues(issues) {
  return Array.isArray(issues) ? issues.filter((i) => typeof i === 'string' && !SOFT_ISSUES.has(i)) : [];
}
function priceCompleteness(c) {
  return c && typeof c.price_type === 'string' && c.price_type ? 'known' : 'unknown';
}

// ---- representation-only differences ----
const hhmm = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t ?? '').trim()); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null; };
const BOOKING_BUCKET = { none: 'not_required', walk_in: 'not_required', available_now: 'not_required', registration_required: 'required', advance_booking: 'required' };
function sameBookingMeaning(a, b) {
  return typeof a === 'string' && typeof b === 'string' && !!BOOKING_BUCKET[a] && BOOKING_BUCKET[a] === BOOKING_BUCKET[b];
}
function isLessSpecific(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string') return false;
  const b = before.trim(), a = after.trim();
  if (!a || a.length >= b.length || !b.startsWith(a)) return false;
  return /[\s,|T]/.test(b.charAt(a.length));
}
function occurrenceKnown(o, existing) {
  const t = hhmm(o.start_time);
  return existing.some((e) => e.date === o.date && (t == null || hhmm(e.start_time) === t));
}
function parseOccLabel(s) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?/.exec(String(s ?? '').trim());
  return m ? { date: m[1], start_time: m[2] || null } : null;
}

// ---- which updates are human decisions ----
const NON_HUMAN_DIFF_FIELDS = new Set(['description', 'has_image', 'event_key']);
function classifyUpdateDiff(diff) {
  const keys = Object.keys(diff || {});
  const out = { kind: 'empty', material: [], nonHuman: [], dropped: {} };
  if (!keys.length) return out;
  for (const k of keys) {
    const { before, after } = diff[k] || {};
    if (k === 'start_time' || k === 'end_time') { if (before != null && hhmm(before) != null && hhmm(before) === hhmm(after)) { out.dropped[k] = 'format'; continue; } }
    else if (k === 'one_time_date') { if (before != null && String(before).slice(0, 10) === String(after ?? '').slice(0, 10)) { out.dropped[k] = 'format'; continue; } }
    else if (k === 'price_amount') { if (before != null && after != null && Number(before) === Number(after)) { out.dropped[k] = 'format'; continue; } }
    else if (k === 'booking_requirement') { if (sameBookingMeaning(before, after)) { out.dropped[k] = 'format'; continue; } }
    else if (k === 'occurrences') {
      const have = (Array.isArray(before) ? before : []).map(parseOccLabel).filter(Boolean);
      const added = (Array.isArray(after) ? after : []).map(parseOccLabel).filter(Boolean);
      const fresh = added.filter((o) => !occurrenceKnown(o, have));
      if (added.length && !fresh.length) { out.dropped[k] = added.every((o) => have.some((e) => e.date === o.date && hhmm(e.start_time) === hhmm(o.start_time))) ? 'format' : 'less_specific'; continue; }
    }
    if (isLessSpecific(before, after)) { out.dropped[k] = 'less_specific'; continue; }
    (NON_HUMAN_DIFF_FIELDS.has(k) ? out.nonHuman : out.material).push(k);
  }
  if (out.material.length) out.kind = 'material';
  else if (out.nonHuman.length) out.kind = 'non_human';
  else out.kind = Object.values(out.dropped).includes('less_specific') ? 'less_specific' : 'representation_only';
  return out;
}

// ---- pending lifecycle: expiry and far-future deferral ----
const ISO = /^\d{4}-\d{2}-\d{2}$/;
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function knownDates(c) {
  const occ = Array.isArray(c?.occurrences) ? c.occurrences : [];
  const set = new Set();
  for (const o of occ) if (o && typeof o.date === 'string' && ISO.test(o.date)) set.add(o.date);
  if (typeof c?.one_time_date === 'string' && ISO.test(c.one_time_date)) set.add(c.one_time_date);
  return [...set].sort();
}
function isDatedOneTime(c) {
  if (!c || c.entity_type === 'אירוע_קבוע' || c.entity_type === 'מקום_קבוע') return false;
  return c.schedule_type === 'one_time' && knownDates(c).length > 0;
}
function farFutureDeferUntil(c, today, maxDaysAhead) {
  if (!isDatedOneTime(c)) return null;
  const first = knownDates(c).find((d) => d >= today);
  if (!first || first <= addDays(today, maxDaysAhead)) return null;
  return addDays(first, -maxDaysAhead);
}
function pendingLifecycle(row, today, maxDaysAhead) {
  if (!['new', 'needs_review'].includes(String(row.status))) return { action: 'keep', reason: 'not_pending' };
  if (!['new', 'duplicate'].includes(String(row.match_type))) return { action: 'keep', reason: 'not_a_candidate' };
  const c = row.extracted_data || {};
  if (!isDatedOneTime(c)) return { action: 'keep', reason: c.entity_type === 'אירוע_קבוע' || c.entity_type === 'מקום_קבוע' ? 'standing_identity' : 'undated' };
  const dates = knownDates(c), lastDate = dates[dates.length - 1];
  if (lastDate < today) return { action: 'expire', reason: 'activity_expired_before_resolution', lastDate };
  if (row.deferred_until) return row.deferred_until <= today ? { action: 'release', reason: 'deferral_due', lastDate } : { action: 'keep', reason: 'deferred', lastDate };
  if (row.match_type === 'new' && row.status === 'new' && substantiveIssues(row.validation_issues).length === 0) {
    const deferUntil = farFutureDeferUntil(c, today, maxDaysAhead);
    if (deferUntil) return { action: 'defer', reason: 'beyond_auto_publish_horizon', lastDate, deferUntil };
  }
  return { action: 'keep', reason: 'live', lastDate };
}

// Israel civil date (the catalogue's day), independent of the machine's timezone
function israelToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

module.exports = {
  SOFT_ISSUES, substantiveIssues, priceCompleteness, hhmm, BOOKING_BUCKET, sameBookingMeaning, isLessSpecific,
  occurrenceKnown, parseOccLabel, NON_HUMAN_DIFF_FIELDS, classifyUpdateDiff, addDays, knownDates, isDatedOneTime,
  farFutureDeferUntil, pendingLifecycle, israelToday,
};
