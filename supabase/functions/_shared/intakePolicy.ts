// TuRu - Human Review Queue intake policy, Phase A (2026-09-24). Pure rules that keep ROUTINE noise out of
// human review before it is created: an unknown price is completeness metadata (never an issue), a diff that
// only restates what the record already says (format, a less specific value, an empty diff) is no update, a
// diff made only of enrichment (description / image / event identity) is not a human decision, a pending
// one-time candidate whose LAST date passed is expired, and a valid event beyond the auto-publish horizon is
// deferred instead of waiting in the inbox. Node twin: tools/import-tool/lib/intakePolicy.js (parity tests).
// Deliberately NOT here: source trust, first-party auto-updates, Cleaner routes (later phases).

// ---- price: completeness, not a review issue ----
// Legacy rows still carry 'מחיר' in validation_issues; every consumer treats it as non-substantive.
export const SOFT_ISSUES = new Set(['מחיר']);
export function substantiveIssues(issues: unknown): string[] {
  return Array.isArray(issues) ? issues.filter((i): i is string => typeof i === 'string' && !SOFT_ISSUES.has(i)) : [];
}
// 'unknown' = the page did not state a price (price_type null). A stated free event is price_type 'free',
// so the catalogue can always tell "free" from "price not listed".
export function priceCompleteness(c: { price_type?: unknown } | null | undefined): 'known' | 'unknown' {
  return c && typeof c.price_type === 'string' && c.price_type ? 'known' : 'unknown';
}

// ---- representation-only differences ----
// "17:00:00" (database) and "17:00" (extractor) are the same time
export const hhmm = (t: unknown): string | null => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t ?? '').trim()); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null; };
// booking labels the product already treats as one meaning (constants/filterSchema.js BOOKING_OPTIONS):
// a change inside a bucket is a wording change, a change across buckets is real
export const BOOKING_BUCKET: Record<string, string> = { none: 'not_required', walk_in: 'not_required', available_now: 'not_required', registration_required: 'required', advance_booking: 'required' };
export function sameBookingMeaning(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && !!BOOKING_BUCKET[a] && BOOKING_BUCKET[a] === BOOKING_BUCKET[b];
}
// SPECIFICITY GUARD: `after` states strictly less than `before` ("2026-09-29" for a known "2026-09-29 20:00",
// "הרצל 5" for a known "הרצל 5, חולון"). Such a value is never an update proposal - it is the same fact, less
// precisely. A DIFFERENT value (another date, another hour) is never "less specific".
export function isLessSpecific(before: unknown, after: unknown): boolean {
  if (typeof before !== 'string' || typeof after !== 'string') return false;
  const b = before.trim(), a = after.trim();
  if (!a || a.length >= b.length || !b.startsWith(a)) return false;
  return /[\s,|T]/.test(b.charAt(a.length));
}
export interface Occ { date: string; start_time?: string | null }
// an occurrence the record already has: same date, and the same hour when the candidate states one (a
// candidate occurrence WITHOUT an hour on a date the record knows with an hour is less specific, not new)
export function occurrenceKnown(o: Occ, existing: Occ[]): boolean {
  const t = hhmm(o.start_time);
  return existing.some((e) => e.date === o.date && (t == null || hhmm(e.start_time) === t));
}
// "2026-09-29 20:00" / "2026-09-29" (the stored diff label form) -> Occ
export function parseOccLabel(s: unknown): Occ | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?/.exec(String(s ?? '').trim());
  return m ? { date: m[1], start_time: m[2] || null } : null;
}

// ---- which updates are human decisions ----
// enrichment a person cannot meaningfully judge: the extractor's own summary, an image, identity bookkeeping
export const NON_HUMAN_DIFF_FIELDS = new Set(['description', 'has_image', 'event_key']);
export type DiffKind = 'empty' | 'representation_only' | 'less_specific' | 'non_human' | 'material';
export interface DiffClass { kind: DiffKind; material: string[]; nonHuman: string[]; dropped: Record<string, 'format' | 'less_specific'> }
interface DiffEntryLike { before?: unknown; after?: unknown }
// Classifies a computeFieldDiff result (also a legacy stored diff, which may predate the format fixes).
// kind: 'empty' (no keys) | 'representation_only' / 'less_specific' (every key restates the record) |
// 'non_human' (only description / image / identity remain) | 'material' (at least one real change).
export function classifyUpdateDiff(diff: Record<string, DiffEntryLike> | null | undefined): DiffClass {
  const keys = Object.keys(diff || {});
  const out: DiffClass = { kind: 'empty', material: [], nonHuman: [], dropped: {} };
  if (!keys.length) return out;
  for (const k of keys) {
    const { before, after } = (diff as Record<string, DiffEntryLike>)[k] || {};
    if (k === 'start_time' || k === 'end_time') { if (before != null && hhmm(before) != null && hhmm(before) === hhmm(after)) { out.dropped[k] = 'format'; continue; } }
    else if (k === 'one_time_date') { if (before != null && String(before).slice(0, 10) === String(after ?? '').slice(0, 10)) { out.dropped[k] = 'format'; continue; } }
    else if (k === 'price_amount') { if (before != null && after != null && Number(before) === Number(after)) { out.dropped[k] = 'format'; continue; } }
    else if (k === 'booking_requirement') { if (sameBookingMeaning(before, after)) { out.dropped[k] = 'format'; continue; } }
    else if (k === 'occurrences') {
      const have = (Array.isArray(before) ? before : []).map(parseOccLabel).filter((o): o is Occ => !!o);
      const added = (Array.isArray(after) ? after : []).map(parseOccLabel).filter((o): o is Occ => !!o);
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
// civil-date arithmetic on the Y-M-D itself (never a local-midnight Date -> toISOString, see the holiday lesson)
export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
interface DatedCandidate { schedule_type?: unknown; entity_type?: unknown; one_time_date?: unknown; occurrences?: unknown }
// every known performance date of a candidate (its occurrences and its one_time_date), sorted
export function knownDates(c: DatedCandidate | null | undefined): string[] {
  const occ = Array.isArray(c?.occurrences) ? (c!.occurrences as { date?: unknown }[]) : [];
  const set = new Set<string>();
  for (const o of occ) if (o && typeof o.date === 'string' && ISO.test(o.date)) set.add(o.date);
  if (typeof c?.one_time_date === 'string' && ISO.test(c.one_time_date)) set.add(c.one_time_date);
  return [...set].sort();
}
// standing identities never expire or defer on a date: a programme (אירוע_קבוע) or a place (מקום_קבוע) lives
// beyond any one performance; only a dated one-time candidate has a lifecycle here
export function isDatedOneTime(c: DatedCandidate | null | undefined): boolean {
  if (!c || c.entity_type === 'אירוע_קבוע' || c.entity_type === 'מקום_קבוע') return false;
  return c.schedule_type === 'one_time' && knownDates(c).length > 0;
}
// scan time: a candidate whose (first) date is beyond the auto-publish horizon waits, without a person, until
// the date enters the window -> the day it does; null when the candidate is not far-future
export function farFutureDeferUntil(c: DatedCandidate | null | undefined, today: string, maxDaysAhead: number): string | null {
  if (!isDatedOneTime(c)) return null;
  const first = knownDates(c).find((d) => d >= today);
  if (!first || first <= addDays(today, maxDaysAhead)) return null;
  return addDays(first, -maxDaysAhead);
}
export interface PendingRow { match_type?: string | null; status?: string | null; extracted_data?: DatedCandidate | null; validation_issues?: unknown; deferred_until?: string | null }
export type PendingAction = 'expire' | 'defer' | 'release' | 'keep';
// expire: every known date is past (the LAST occurrence decides, never the first) -> reject with the existing
//         lifecycle reason activity_expired_before_resolution
// defer:  a clean 'new' candidate (no substantive issue) beyond the horizon -> deferred_until
// release: a deferred row whose day came -> back into the normal flow
export function pendingLifecycle(row: PendingRow, today: string, maxDaysAhead: number): { action: PendingAction; reason: string; lastDate?: string; deferUntil?: string } {
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
