// TuRu - EVENT identity for THE MONSTER (scan-source). Node twin: tools/import-tool/lib/eventIdentity.js
// - keep in lockstep (tests/eventIdentity.test.js pins the shared cases).
//
// IDENTITY MODEL (binding, 2026-09-14):
//   event_key         = EVENT identity. Stable across occurrences - it does not change when the earliest
//                       performance passes, expires or disappears, or when a new date is added.
//   event_fingerprint = LEGACY occurrence-level / first-occurrence fingerprint (matching.ts
//                       computeEventFingerprint: name|venue-or-city|date-or-days|HH:MM). Kept for the
//                       exact pre-checks. NEVER use it as the canonical multi-occurrence event identity.
//   occurrence        = activity_schedules row (activity, one_time_date, start_time [+ external_id]).
//
// Key kinds, strongest first - a weaker kind never outranks a stronger one:
//   1. ext:<source_id>:<provider event id>      authoritative external event ID
//   2. url:<normalized detail URL>              a VERIFIED event-specific detail page (card/title
//                                               evidence, claimed by one candidate, page names the event)
//   3. pk:<source_id>:<provider key>            a stable provider/adapter key
//   4. tvs:<normalized title>|v:<venue>|s:<src> conservative fallback: EXACT normalized title + canonical
//                                               venue + source, only for non-generic titles. It is a
//                                               fallback: a candidate carrying a kind-1/2/3 key that
//                                               differs from an existing tvs match is NOT the same event.
// A shared listing/calendar page URL is never an identity signal (it holds many events).

import { normalizeForMatch } from './matching.ts';

export type EventKeyKind = 'external_id' | 'detail_url' | 'provider_key' | 'title_venue_source';
export interface EventKey { key: string; kind: EventKeyKind }

// words that carry no event identity on their own ("שעת סיפור", "הצגה לגיל הרך", "סדנת יצירה")
export const GENERIC_TITLE_STOPWORDS = new Set([
  'שעת', 'סיפור', 'הצגה', 'הצגת', 'ילדים', 'לילדים', 'מופע', 'סדנה', 'סדנת', 'פעילות', 'לגיל', 'לגילאי', 'גילאי', 'גיל', 'בני',
  'הרך', 'לכל', 'המשפחה', 'משפחתי', 'משפחה', 'לפעוטות', 'פעוטות', 'קטנטנים', 'יצירה', 'ספרייה', 'בספרייה', 'ההצגה', 'המופע',
]);

export function contentWords(title: string | null | undefined): string[] {
  return normalizeForMatch(title).split(' ').filter((w) => w.length > 1 && !/^\d+$/.test(w) && !GENERIC_TITLE_STOPWORDS.has(w));
}
export function isGenericTitle(title: string | null | undefined): boolean {
  return contentWords(title).length < 3;
}

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|_ga$)/i;
export function normalizeDetailUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL; try { u = new URL(url); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  u.hash = '';
  for (const k of Array.from(u.searchParams.keys())) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  let path = u.pathname; try { path = decodeURIComponent(path); } catch { /* keep encoded */ }
  path = path.replace(/\/+$/, '') || '/';
  const q = u.searchParams.toString();
  return `${u.protocol}//${u.hostname}${path}${q ? '?' + q : ''}`;
}

// A listing/category/search/paginated page is never an event's own page.
const LISTING_PATH = /(^|\/)(page_\d+|page\/\d+|category|categories|search|calendar|events?|all|list|tag|tags)\/?$|_page_\d+$|(^|[/_])season_\d+/i;
const LISTING_QUERY = /(^|[?&])(page|p|pg|category|cat|q|search|date|month|year)=/i;
export function isListingShapedUrl(url: string, opts: { seedUrl?: string | null; listingUrls?: Iterable<string> } = {}): boolean {
  let u: URL; try { u = new URL(url); } catch { return true; }
  const norm = normalizeDetailUrl(url);
  const known = new Set<string>();
  if (opts.seedUrl) { const s = normalizeDetailUrl(opts.seedUrl); if (s) known.add(s); }
  for (const l of opts.listingUrls || []) { const s = normalizeDetailUrl(l); if (s) known.add(s); }
  if (norm && known.has(norm)) return true;
  const path = (() => { try { return decodeURIComponent(u.pathname); } catch { return u.pathname; } })().replace(/\/+$/, '');
  if (!path || path === '/') return true; // host root
  if (LISTING_PATH.test(path)) return true;
  if (LISTING_QUERY.test(u.search)) return true;
  return false;
}

export interface EventKeyInput {
  sourceId: string | null | undefined;
  title: string | null | undefined;
  venueId?: string | null;
  externalEventId?: string | null;
  providerKey?: string | null;
  detailUrl?: string | null;
  detailVerified?: boolean; // card/title evidence + one claimant + page names the event (detailLinks/detailEvidence)
}

export function computeEventKey(input: EventKeyInput): EventKey | null {
  const src = (input.sourceId || '').trim();
  const ext = (input.externalEventId || '').toString().trim();
  if (src && ext) return { key: `ext:${src}:${ext}`, kind: 'external_id' };
  if (input.detailVerified && input.detailUrl) {
    const n = normalizeDetailUrl(input.detailUrl);
    if (n && !isListingShapedUrl(n)) return { key: `url:${n}`, kind: 'detail_url' };
  }
  const pk = (input.providerKey || '').toString().trim();
  if (src && pk) return { key: `pk:${src}:${pk}`, kind: 'provider_key' };
  const title = normalizeForMatch(input.title);
  if (src && input.venueId && title && !isGenericTitle(input.title)) return { key: `tvs:${title}|v:${input.venueId}|s:${src}`, kind: 'title_venue_source' };
  return null;
}

const KIND_RANK: Record<EventKeyKind, number> = { external_id: 4, detail_url: 3, provider_key: 2, title_venue_source: 1 };
export function eventKeyRank(kind: EventKeyKind | null | undefined): number { return kind ? KIND_RANK[kind] || 0 : 0; }

// ---------------------------------------------------------------------------------------------
// EVENT MATCH LADDER (scan-source): is this candidate the same EVENT as an existing activity?
//   E1  same event_key (kinds external_id / detail_url / provider_key / title_venue_source).
//       A detail_url key additionally needs compatibility (title overlap >= 0.5 OR same venue) and the
//       same source; a kind-1/2/3 candidate key that DIFFERS from an existing tvs key wins -> not the same.
//   E2  fallback for rows created before detail traversal: >= 2 explicit occurrences from a detail page,
//       same canonical venue (required), same source, EXACT normalized title (non-generic), and one
//       occurrence time equal to the existing time. Nothing weaker - "שעת סיפור" at the same venue and
//       hour stays a separate activity (today's similarity path decides).
//   Never matches an existing whose dated occurrences are all in the past.
import { wordOverlapScore, candidateDates, existingDates, type ExistingActivity } from './matching.ts';

export interface EventMatch { activity: ExistingActivity; reason: 'event_key' | 'occurrence_series'; breakdown: Record<string, number | string> }

// deno-lint-ignore no-explicit-any
export function findEventMatch(candidate: Record<string, any>, existing: ExistingActivity[], sourceId: string | null, today: string): EventMatch | null {
  const cKey = candidate.event_key as string | null | undefined;
  const cKind = candidate.event_key_kind as EventKeyKind | null | undefined;
  const cTitle = normalizeForMatch(candidate.name);
  const cOcc: { date: string; start_time: string | null }[] = Array.isArray(candidate.occurrences) ? candidate.occurrences : [];
  const cTimes = new Set([...cOcc.map((o) => (o.start_time || '').slice(0, 5)), String(candidate.start_time || '').slice(0, 5)].filter(Boolean));
  const allPast = (e: ExistingActivity) => { const ds = existingDates(e); return ds.length > 0 && ds.every((d) => d < today); };

  // E1 - event key
  if (cKey) {
    for (const e of existing) {
      if (!e.event_key || e.event_key !== cKey) continue;
      if (allPast(e)) continue;
      if (e.event_key_kind === 'detail_url') {
        const compatible = wordOverlapScore(candidate.name, e.name) >= 0.5 || (candidate.venue_id && e.venue_id === candidate.venue_id);
        if (!compatible || (sourceId && e.source_id && e.source_id !== sourceId)) continue;
      }
      return { activity: e, reason: 'event_key', breakdown: { event_key_match: 1, kind: e.event_key_kind || '' } };
    }
  }
  // E2 - occurrence series (exact title + venue + source + time, >= 2 explicit performances)
  if (cOcc.length >= 2 && candidate.detail_url && candidate.venue_id && sourceId && cTitle && !isGenericTitle(candidate.name)) {
    for (const e of existing) {
      if (e.venue_id !== candidate.venue_id || e.source_id !== sourceId) continue;
      if (normalizeForMatch(e.name) !== cTitle) continue;
      if (allPast(e)) continue;
      // a stronger key on either side that disagrees means a different event (season / edition)
      if (cKey && e.event_key && e.event_key !== cKey && eventKeyRank(cKind) >= 2 && eventKeyRank(e.event_key_kind as EventKeyKind) >= 2) continue;
      const eTime = String(e.start_time || '').slice(0, 5);
      if (!eTime || !cTimes.has(eTime)) continue;
      return { activity: e, reason: 'occurrence_series', breakdown: { exact_title: 1, venue_match: 1, same_source: 1, time_match: 1, occurrences: cOcc.length, shared_dates: candidateDates(candidate).filter((d) => existingDates(e).includes(d)).length } };
    }
  }
  return null;
}
