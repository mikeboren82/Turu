// Node twin of supabase/functions/_shared/missingScope.ts - keep behaviourally identical.
// Page-scoped missing-from-source accounting + flag lifecycle. Only VERIFIED absence (missing_verified_streak,
// migration 0109) can ever produce a flag; the legacy consecutive_missing_scans value is informational.
const { canonicalPageKey } = require('./discovery');

const MIN_FRESHNESS_NAME = 4; // a shorter name proves little by substring - it only blocks an increment
const FLAG_CLOSE = { reappeared: 'auto_resolved_reappeared', notEligible: 'auto_resolved_not_eligible', notLive: 'auto_resolved_not_live' };

// relay parts (#part=N) are positional and shift daily, so the unit is the whole listing page
const scopeKey = (url) => canonicalPageKey(String(url).split('#part=')[0]);
// geresh/gershayim/quotes/niqqud are intra-word (פודצ׳יק = פודצ'יק, חוה״מ); maqaf and other punctuation separate words
const normalizeForPresence = (s) => (s || '').toLowerCase()
  .replace(/[֑-ׇ]/g, (c) => (c === '־' ? ' ' : ''))
  .replace(/['"`׳״‘’“”]/g, '')
  .replace(/[^א-תa-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ').trim();

// AI-composed names ("שעת סיפור: ״X״ – תיאטרון Y", "(הופעה שנייה)", "| ת. הקיבוץ") rarely appear verbatim; most of
// their words on the page still means "listed". Blocks absence only - never claims freshness.
const FUZZY_COVERAGE = 0.6;
function tokenCoverage(name, pageTokens) {
  const toks = [...new Set(name.split(' ').filter((t) => t.length >= 3))];
  return { hits: toks.filter((t) => pageTokens.has(t)).length, total: toks.length };
}
const fuzzyPresent = (name, pageTokens) => { const c = tokenCoverage(name, pageTokens); return c.hits >= 2 && c.hits / c.total >= FUZZY_COVERAGE; };

// Only a dated event with a still-future occurrence can go "missing": a place or a standing programme leaving one
// listing page is not disappearance, and a past event is the expiry job's business.
function missingEligibility(a, today) {
  const dates = (a.activity_schedules || []).filter((s) => s.schedule_type === 'one_time' && s.one_time_date).map((s) => s.one_time_date).sort();
  if (a.entity_type === 'מקום_קבוע') return { eligible: false, shape: 'place', nextDate: null };
  if (a.entity_type === 'אירוע_קבוע') return { eligible: false, shape: 'standing_programme', nextDate: null };
  if (a.entity_type !== 'אירוע' || !dates.length) return { eligible: false, shape: 'undated_or_other', nextDate: null };
  const next = dates.find((d) => d >= today) || null;
  return next ? { eligible: true, shape: dates.length > 1 ? 'event_series' : 'dated_event', nextDate: next } : { eligible: false, shape: 'past_event', nextDate: null };
}

function decideMissing(a, scopes, matched) {
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
  if (checked.some((s) => !s.complete)) return { id: a.id, action: 'skip', reason: 'scope_incomplete' };
  if (!checked.some((s) => s.changedProcessed)) return { id: a.id, action: 'skip', reason: 'unchanged_no_new_evidence' };
  if (!name) return { id: a.id, action: 'skip', reason: 'no_name' };
  return { id: a.id, action: 'absent', reason: 'absent_from_fully_checked_page' };
}

async function loadScopeActivities(client, sourceId) {
  const { data: acts, error } = await client.from('activities').select('id, name, entity_type, consecutive_missing_scans, missing_verified_streak, activity_schedules(schedule_type, one_time_date)').eq('source_id', sourceId).eq('status', 'approved');
  if (error) throw error;
  const list = acts || [];
  const rows = new Map();
  for (let i = 0; i < list.length; i += 100) {
    const { data, error: e2 } = await client.from('activity_sources').select('activity_id, page_url, url_role').eq('source_id', sourceId).in('activity_id', list.slice(i, i + 100).map((a) => a.id));
    if (e2) throw e2;
    for (const r of data || []) {
      if (r.url_role && r.url_role !== 'listing') continue; // detail / booking pages are not listing scopes
      const arr = rows.get(r.activity_id) || [];
      arr.push({ page_url: r.page_url, key: scopeKey(r.page_url) });
      rows.set(r.activity_id, arr);
    }
  }
  return list.map((a) => ({ ...a, rows: rows.get(a.id) || [] }));
}

// One open missing flag per activity (partial unique index idx_incoming_activities_missing_unique). No ON CONFLICT
// against that partial index: look first, insert, and treat a unique violation as "someone else opened it" only
// after re-reading the open row. Every other error surfaces.
async function writeMissingFlag(client, p) {
  const readOpen = () => client.from('incoming_activities').select('id').eq('existing_activity_id', p.activityId).eq('match_type', 'missing').eq('status', 'missing_flagged').maybeSingle();
  const refresh = async (id) => {
    const { error } = await client.from('incoming_activities').update({ extracted_data: p.evidence }).eq('id', id).eq('status', 'missing_flagged');
    return error ? { code: 'ERROR', id, error: error.message } : { code: 'ALREADY_OPEN', id };
  };
  const { data: open, error: rErr } = await readOpen();
  if (rErr) return { code: 'ERROR', error: rErr.message };
  if (open) return refresh(open.id);
  const { data: ins, error: iErr } = await client.from('incoming_activities').insert({
    source_id: p.sourceId, scan_log_id: p.scanLogId ?? null, page_url: p.pageUrl, match_type: 'missing',
    existing_activity_id: p.activityId, status: 'missing_flagged', extracted_data: p.evidence,
  }).select('id').maybeSingle();
  if (iErr) {
    if (iErr.code !== '23505') return { code: 'ERROR', error: iErr.message };
    const { data: again } = await readOpen();
    return again ? refresh(again.id) : { code: 'ERROR', error: 'unique violation but no open flag found' };
  }
  const { data: verify } = await readOpen();
  if (!verify) return { code: 'ERROR', error: `insert returned ${ins ? 'a row' : 'no row'} but no open flag is readable` };
  return { code: 'CREATED', id: verify.id };
}

async function closeOpenFlags(client, activityIds, reason, at) {
  if (!activityIds.length) return 0;
  const { data, error } = await client.from('incoming_activities').update({
    status: 'rejected', archive_reason: reason, reject_reason: `closed automatically (${reason})`, reviewed_at: at,
  }).in('existing_activity_id', activityIds).eq('match_type', 'missing').eq('status', 'missing_flagged').select('id');
  if (error) throw error;
  return (data || []).length;
}

async function applyMissingAccounting(client, p) {
  const now = p.now || (() => new Date().toISOString());
  const today = p.today || now().slice(0, 10);
  const scopes = new Map([...p.scopes].map(([k, s]) => { const text = normalizeForPresence(s.text); return [k, { ...s, text, tokens: new Set(text.split(' ')) }]; }));
  const activities = await loadScopeActivities(client, p.sourceId);
  const summary = { evaluated: activities.length, seen_matched: 0, seen_on_page: 0, absent: 0, verified_absent: 0, streaks: {}, would_flag: 0, flags: {}, flags_closed: 0, ineligible_shapes: {}, skipped: {} };
  const decisions = [];
  const seen = [];
  const notEligible = [];
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
        const urls = a.rows.filter((r) => d.keys.includes(r.key)).map((r) => r.page_url);
        if (urls.length) await client.from('activity_sources').update({ last_seen_at: at }).eq('activity_id', a.id).eq('source_id', p.sourceId).in('page_url', urls);
      }
    } else if (d.action === 'present_fuzzy') {
      // listed, but not verbatim: no absence evidence (streaks reset, flag closes), no freshness claim either
      const { error } = await client.from('activities').update({ consecutive_missing_scans: 0, missing_verified_streak: 0 }).eq('id', a.id).eq('status', 'approved');
      if (error) throw error;
      summary.skipped.present_fuzzy = (summary.skipped.present_fuzzy || 0) + 1; seen.push(a.id);
    } else if (d.action === 'absent') {
      const prevC = a.consecutive_missing_scans, prevV = a.missing_verified_streak || 0;
      const patch = { consecutive_missing_scans: (prevC || 0) + 1 };
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
  summary.flags_closed += await closeOpenFlags(client, [...new Set((openFlags || []).map((f) => f.existing_activity_id).filter((id) => id && !live.has(id)))], FLAG_CLOSE.notLive, at);
  return { summary, decisions };
}

module.exports = { FLAG_CLOSE, scopeKey, normalizeForPresence, tokenCoverage, missingEligibility, decideMissing, loadScopeActivities, writeMissingFlag, applyMissingAccounting };
