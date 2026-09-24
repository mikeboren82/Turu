// Page-scoped missing-from-source accounting + flag lifecycle (Node twin: tools/import-tool/lib/missingScope.js -
// keep identical). Only VERIFIED absence (missing_verified_streak, migration 0109) can ever produce a flag; the
// legacy consecutive_missing_scans value is informational.
import { canonicalPageKey } from './discovery.ts';

// deno-lint-ignore no-explicit-any
type Client = any;

export type PageScope = { complete: boolean; changedProcessed: boolean; text: string; tokens?: Set<string> };
export type ScopeActivity = {
  id: string; name: string | null; consecutive_missing_scans: number | null; missing_verified_streak?: number | null;
  entity_type?: string | null; activity_schedules?: { schedule_type: string | null; one_time_date: string | null }[] | null;
  rows: { page_url: string; key: string }[];
};
export type MissingAction = 'seen_matched' | 'seen_on_page' | 'present_fuzzy' | 'present_short_name' | 'absent' | 'skip';
export type MissingDecision = { id: string; action: MissingAction; reason: string; keys?: string[] };

const MIN_FRESHNESS_NAME = 4; // a shorter name proves little by substring - it only blocks an increment
export const FLAG_CLOSE = { reappeared: 'auto_resolved_reappeared', notEligible: 'auto_resolved_not_eligible', notLive: 'auto_resolved_not_live' } as const;

// relay parts (#part=N) are positional and shift daily, so the unit is the whole listing page
export const scopeKey = (url: string) => canonicalPageKey(String(url).split('#part=')[0]);
// geresh/gershayim/quotes/niqqud are intra-word (פודצ׳יק = פודצ'יק, חוה״מ); maqaf and other punctuation separate words
export const normalizeForPresence = (s: string | null | undefined) =>
  (s || '').toLowerCase()
    .replace(/[֑-ׇ]/g, (c) => (c === '־' ? ' ' : ''))
    .replace(/['"`׳״‘’“”]/g, '')
    .replace(/[^א-תa-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();

// AI-composed names ("שעת סיפור: ״X״ – תיאטרון Y", "(הופעה שנייה)", "| ת. הקיבוץ") rarely appear verbatim; most of
// their words on the page still means "listed". Blocks absence only - never claims freshness.
const FUZZY_COVERAGE = 0.6;
export function tokenCoverage(name: string, pageTokens: Set<string>): { hits: number; total: number } {
  const toks = [...new Set(name.split(' ').filter((t) => t.length >= 3))];
  return { hits: toks.filter((t) => pageTokens.has(t)).length, total: toks.length };
}
const fuzzyPresent = (name: string, pageTokens: Set<string>) => { const c = tokenCoverage(name, pageTokens); return c.hits >= 2 && c.hits / c.total >= FUZZY_COVERAGE; };

// Only a dated event with a still-future occurrence can go "missing": a place or a standing programme leaving one
// listing page is not disappearance, and a past event is the expiry job's business.
export function missingEligibility(a: Pick<ScopeActivity, 'entity_type' | 'activity_schedules'>, today: string): { eligible: boolean; shape: string; nextDate: string | null } {
  const dates = (a.activity_schedules || []).filter((s) => s.schedule_type === 'one_time' && s.one_time_date).map((s) => s.one_time_date as string).sort();
  if (a.entity_type === 'מקום_קבוע') return { eligible: false, shape: 'place', nextDate: null };
  if (a.entity_type === 'אירוע_קבוע') return { eligible: false, shape: 'standing_programme', nextDate: null };
  if (a.entity_type !== 'אירוע' || !dates.length) return { eligible: false, shape: 'undated_or_other', nextDate: null };
  const next = dates.find((d) => d >= today) || null;
  return next ? { eligible: true, shape: dates.length > 1 ? 'event_series' : 'dated_event', nextDate: next } : { eligible: false, shape: 'past_event', nextDate: null };
}

export function decideMissing(a: ScopeActivity, scopes: Map<string, PageScope>, matched: boolean): MissingDecision {
  if (matched) return { id: a.id, action: 'seen_matched', reason: 'matched in this run' };
  const keys = [...new Set(a.rows.map((r) => r.key))];
  if (!keys.length) return { id: a.id, action: 'skip', reason: 'no_listing_provenance' };
  const name = normalizeForPresence(a.name);
  const onOwn = name ? keys.filter((k) => scopes.get(k)?.text.includes(name)) : [];
  // anywhere on this run's fetched pages also counts (an event pushed from page 1 to page 2 is still listed)
  const elsewhere = !onOwn.length && name ? [...scopes.values()].some((s) => s.text.includes(name)) : false;
  if (onOwn.length || elsewhere) return name.length >= MIN_FRESHNESS_NAME ? { id: a.id, action: 'seen_on_page', reason: 'name on fetched page', keys: onOwn } : { id: a.id, action: 'present_short_name', reason: 'short name on fetched page' };
  if (name && [...scopes.values()].some((s) => fuzzyPresent(name, s.tokens || new Set(s.text.split(' '))))) return { id: a.id, action: 'present_fuzzy', reason: 'most name words on fetched page' };
  const checked = keys.map((k) => scopes.get(k));
  if (checked.some((s) => !s)) return { id: a.id, action: 'skip', reason: 'scope_not_checked' };
  if (checked.some((s) => !s!.complete)) return { id: a.id, action: 'skip', reason: 'scope_incomplete' };
  if (!checked.some((s) => s!.changedProcessed)) return { id: a.id, action: 'skip', reason: 'unchanged_no_new_evidence' };
  if (!name) return { id: a.id, action: 'skip', reason: 'no_name' };
  return { id: a.id, action: 'absent', reason: 'absent_from_fully_checked_page' };
}

// Owned (activities.source_id) approved activities + their LISTING provenance on this source's pages.
export async function loadScopeActivities(client: Client, sourceId: string): Promise<ScopeActivity[]> {
  const { data: acts, error } = await client.from('activities').select('id, name, entity_type, consecutive_missing_scans, missing_verified_streak, activity_schedules(schedule_type, one_time_date)').eq('source_id', sourceId).eq('status', 'approved');
  if (error) throw error;
  const list = (acts || []) as ScopeActivity[];
  const rows = new Map<string, { page_url: string; key: string }[]>();
  for (let i = 0; i < list.length; i += 100) {
    const { data, error: e2 } = await client.from('activity_sources').select('activity_id, page_url, url_role').eq('source_id', sourceId).in('activity_id', list.slice(i, i + 100).map((a) => a.id));
    if (e2) throw e2;
    for (const r of (data || []) as { activity_id: string; page_url: string; url_role: string | null }[]) {
      if (r.url_role && r.url_role !== 'listing') continue; // detail / booking pages are not listing scopes
      const arr = rows.get(r.activity_id) || [];
      arr.push({ page_url: r.page_url, key: scopeKey(r.page_url) });
      rows.set(r.activity_id, arr);
    }
  }
  return list.map((a) => ({ ...a, rows: rows.get(a.id) || [] }));
}

export type FlagWriteCode = 'CREATED' | 'ALREADY_OPEN' | 'ERROR';

// One open missing flag per activity (partial unique index idx_incoming_activities_missing_unique). No ON CONFLICT
// against that partial index: look first, insert, and treat a unique violation as "someone else opened it" only
// after re-reading the open row. Every other error surfaces.
export async function writeMissingFlag(client: Client, p: { sourceId: string; scanLogId?: string | null; activityId: string; pageUrl: string; evidence: Record<string, unknown> }): Promise<{ code: FlagWriteCode; id?: string; error?: string }> {
  const readOpen = () => client.from('incoming_activities').select('id').eq('existing_activity_id', p.activityId).eq('match_type', 'missing').eq('status', 'missing_flagged').maybeSingle();
  const refresh = async (id: string) => {
    const { error } = await client.from('incoming_activities').update({ extracted_data: p.evidence }).eq('id', id).eq('status', 'missing_flagged');
    return error ? { code: 'ERROR' as const, id, error: error.message } : { code: 'ALREADY_OPEN' as const, id };
  };
  const { data: open, error: rErr } = await readOpen();
  if (rErr) return { code: 'ERROR', error: rErr.message };
  if (open) return refresh((open as { id: string }).id);
  const { data: ins, error: iErr } = await client.from('incoming_activities').insert({
    source_id: p.sourceId, scan_log_id: p.scanLogId ?? null, page_url: p.pageUrl, match_type: 'missing',
    existing_activity_id: p.activityId, status: 'missing_flagged', extracted_data: p.evidence,
  }).select('id').maybeSingle();
  if (iErr) {
    if ((iErr as { code?: string }).code !== '23505') return { code: 'ERROR', error: iErr.message };
    const { data: again } = await readOpen();
    return again ? refresh((again as { id: string }).id) : { code: 'ERROR', error: 'unique violation but no open flag found' };
  }
  const { data: verify } = await readOpen();
  if (!verify) return { code: 'ERROR', error: `insert returned ${ins ? 'a row' : 'no row'} but no open flag is readable` };
  return { code: 'CREATED', id: (verify as { id: string }).id };
}

async function closeOpenFlags(client: Client, activityIds: string[], reason: string, at: string): Promise<number> {
  if (!activityIds.length) return 0;
  const { data, error } = await client.from('incoming_activities').update({
    status: 'rejected', archive_reason: reason, reject_reason: `closed automatically (${reason})`, reviewed_at: at,
  }).in('existing_activity_id', activityIds).eq('match_type', 'missing').eq('status', 'missing_flagged').select('id');
  if (error) throw error;
  return (data || []).length;
}

export type MissingSummary = {
  evaluated: number; seen_matched: number; seen_on_page: number; absent: number; verified_absent: number;
  streaks: Record<string, number>; would_flag: number; flags: Record<string, number>; flags_closed: number;
  ineligible_shapes: Record<string, number>; skipped: Record<string, number>;
};

export async function applyMissingAccounting(client: Client, p: {
  sourceId: string; sourceKind?: string | null; scanLogId?: string | null; scopes: Map<string, PageScope>; matchedIds: Set<string>;
  threshold: number; flagsEnabled: boolean; today?: string; now?: () => string;
}): Promise<{ summary: MissingSummary; decisions: MissingDecision[] }> {
  const now = p.now || (() => new Date().toISOString());
  const today = p.today || now().slice(0, 10);
  const scopes = new Map([...p.scopes].map(([k, s]) => { const text = normalizeForPresence(s.text); return [k, { ...s, text, tokens: new Set(text.split(' ')) }]; }));
  const activities = await loadScopeActivities(client, p.sourceId);
  const summary: MissingSummary = { evaluated: activities.length, seen_matched: 0, seen_on_page: 0, absent: 0, verified_absent: 0, streaks: {}, would_flag: 0, flags: {}, flags_closed: 0, ineligible_shapes: {}, skipped: {} };
  const decisions: MissingDecision[] = [];
  const seen: string[] = [];
  const notEligible: string[] = [];
  const at = now();
  for (const a of activities) {
    const d = decideMissing(a, scopes, p.matchedIds.has(a.id));
    const elig = missingEligibility(a, today);
    if (!elig.eligible) { notEligible.push(a.id); summary.ineligible_shapes[elig.shape] = (summary.ineligible_shapes[elig.shape] || 0) + 1; }
    decisions.push(d);
    if (d.action === 'seen_matched') { summary.seen_matched++; seen.push(a.id); }
    else if (d.action === 'seen_on_page') {
      const { data: w, error } = await client.from('activities').update({ consecutive_missing_scans: 0, missing_verified_streak: 0, last_seen_at: at }).eq('id', a.id).eq('status', 'approved').select('id');
      if (error) throw error;
      if (w && w.length) {
        summary.seen_on_page++; seen.push(a.id);
        const urls = a.rows.filter((r) => d.keys!.includes(r.key)).map((r) => r.page_url);
        if (urls.length) await client.from('activity_sources').update({ last_seen_at: at }).eq('activity_id', a.id).eq('source_id', p.sourceId).in('page_url', urls);
      }
    } else if (d.action === 'present_fuzzy') {
      // listed, but not verbatim: no absence evidence (streaks reset, flag closes), no freshness claim either
      const { error } = await client.from('activities').update({ consecutive_missing_scans: 0, missing_verified_streak: 0 }).eq('id', a.id).eq('status', 'approved');
      if (error) throw error;
      summary.skipped.present_fuzzy = (summary.skipped.present_fuzzy || 0) + 1; seen.push(a.id);
    } else if (d.action === 'absent') {
      const prevC = a.consecutive_missing_scans, prevV = a.missing_verified_streak || 0;
      const patch: Record<string, unknown> = { consecutive_missing_scans: (prevC || 0) + 1 };
      if (elig.eligible) Object.assign(patch, { missing_verified_streak: prevV + 1, missing_verified_last_at: at });
      let q = client.from('activities').update(patch).eq('id', a.id).eq('missing_verified_streak', prevV);
      q = prevC == null ? q.is('consecutive_missing_scans', null) : q.eq('consecutive_missing_scans', prevC);
      const { data: w, error } = await q.select('id');
      if (error) throw error;
      if (!w || !w.length) { summary.skipped.concurrent_update = (summary.skipped.concurrent_update || 0) + 1; continue; }
      summary.absent++;
      if (!elig.eligible) continue;
      summary.verified_absent++;
      const streak = prevV + 1;
      summary.streaks[String(streak)] = (summary.streaks[String(streak)] || 0) + 1;
      // aggregators relist and delist freely - their removal is not actionable
      if (streak < p.threshold || p.sourceKind === 'aggregator') continue;
      if (!p.flagsEnabled) { summary.would_flag++; continue; }
      const r = await writeMissingFlag(client, {
        sourceId: p.sourceId, scanLogId: p.scanLogId, activityId: a.id, pageUrl: a.rows[0].page_url.split('#part=')[0],
        evidence: { name: a.name, reason: 'future dated event absent from its fully checked listing page', missing_verified_streak: streak, missing_verified_last_at: at, next_occurrence: elig.nextDate, shape: elig.shape, pages: [...new Set(a.rows.map((r) => r.page_url.split('#part=')[0]))] },
      });
      summary.flags[r.code] = (summary.flags[r.code] || 0) + 1;
    } else {
      summary.skipped[d.reason] = (summary.skipped[d.reason] || 0) + 1;
    }
  }
  // lifecycle: reappearance and loss of eligibility (past / place / programme) close open flags automatically
  summary.flags_closed += await closeOpenFlags(client, seen, FLAG_CLOSE.reappeared, at);
  summary.flags_closed += await closeOpenFlags(client, notEligible.filter((id) => !seen.includes(id)), FLAG_CLOSE.notEligible, at);
  // an activity that left 'approved' (expired / archived) is not a missing-source question any more
  const { data: openFlags, error: oErr } = await client.from('incoming_activities').select('existing_activity_id').eq('source_id', p.sourceId).eq('match_type', 'missing').eq('status', 'missing_flagged');
  if (oErr) throw oErr;
  const live = new Set(activities.map((a) => a.id));
  summary.flags_closed += await closeOpenFlags(client, [...new Set(((openFlags || []) as { existing_activity_id: string }[]).map((f) => f.existing_activity_id).filter((id) => id && !live.has(id)))], FLAG_CLOSE.notLive, at);
  return { summary, decisions };
}
