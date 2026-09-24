// Node twin of supabase/functions/_shared/missingScope.ts - keep behaviourally identical.
// An owned activity advances toward "missing" only when every listing page that evidenced it was fully checked in
// this logical run, fresh content there was fully extracted, it was not matched, and its name is gone from the page.
const { canonicalPageKey } = require('./discovery');

const MIN_FRESHNESS_NAME = 4; // a shorter name proves little by substring - it only blocks an increment

// relay parts (#part=N) are positional and shift daily, so the unit is the whole listing page
const scopeKey = (url) => canonicalPageKey(String(url).split('#part=')[0]);
const normalizeForPresence = (s) => (s || '').toLowerCase().replace(/[^֐-׿a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

function decideMissing(a, scopes, matched) {
  if (matched) return { id: a.id, action: 'seen_matched', reason: 'matched in this run' };
  const keys = [...new Set(a.rows.map((r) => r.key))];
  if (!keys.length) return { id: a.id, action: 'skip', reason: 'no_listing_provenance' };
  const name = normalizeForPresence(a.name);
  const present = name ? keys.filter((k) => scopes.get(k)?.text.includes(name)) : [];
  if (present.length) return name.length >= MIN_FRESHNESS_NAME ? { id: a.id, action: 'seen_on_page', reason: 'name on fetched page', keys: present } : { id: a.id, action: 'present_short_name', reason: 'short name on fetched page' };
  const checked = keys.map((k) => scopes.get(k));
  if (checked.some((s) => !s)) return { id: a.id, action: 'skip', reason: 'scope_not_checked' };
  if (checked.some((s) => !s.complete)) return { id: a.id, action: 'skip', reason: 'scope_incomplete' };
  if (!checked.some((s) => s.changedProcessed)) return { id: a.id, action: 'skip', reason: 'unchanged_no_new_evidence' };
  if (!name) return { id: a.id, action: 'skip', reason: 'no_name' };
  return { id: a.id, action: 'absent', reason: 'absent_from_fully_checked_page' };
}

async function loadScopeActivities(client, sourceId) {
  const { data: acts } = await client.from('activities').select('id, name, consecutive_missing_scans').eq('source_id', sourceId).eq('status', 'approved');
  const list = acts || [];
  const rows = new Map();
  for (let i = 0; i < list.length; i += 100) {
    const { data } = await client.from('activity_sources').select('activity_id, page_url, url_role').eq('source_id', sourceId).in('activity_id', list.slice(i, i + 100).map((a) => a.id));
    for (const r of data || []) {
      if (r.url_role && r.url_role !== 'listing') continue; // detail / booking pages are not listing scopes
      const arr = rows.get(r.activity_id) || [];
      arr.push({ page_url: r.page_url, key: scopeKey(r.page_url) });
      rows.set(r.activity_id, arr);
    }
  }
  return list.map((a) => ({ ...a, rows: rows.get(a.id) || [] }));
}

async function applyMissingAccounting(client, { sourceId, scopes: rawScopes, matchedIds, threshold, now = () => new Date().toISOString() }) {
  const scopes = new Map([...rawScopes].map(([k, s]) => [k, { ...s, text: normalizeForPresence(s.text) }]));
  const activities = await loadScopeActivities(client, sourceId);
  const summary = { evaluated: activities.length, seen_matched: 0, seen_on_page: 0, absent: 0, over_threshold: 0, skipped: {} };
  const decisions = [];
  const at = now();
  for (const a of activities) {
    const d = decideMissing(a, scopes, matchedIds.has(a.id));
    decisions.push(d);
    if (d.action === 'seen_matched') summary.seen_matched++;
    else if (d.action === 'seen_on_page') {
      const { data: w } = await client.from('activities').update({ consecutive_missing_scans: 0, last_seen_at: at }).eq('id', a.id).eq('status', 'approved').select('id');
      if (w && w.length) {
        summary.seen_on_page++;
        const urls = a.rows.filter((r) => d.keys.includes(r.key)).map((r) => r.page_url);
        if (urls.length) await client.from('activity_sources').update({ last_seen_at: at }).eq('activity_id', a.id).eq('source_id', sourceId).in('page_url', urls);
      }
    } else if (d.action === 'absent') {
      const prev = a.consecutive_missing_scans;
      const next = (prev || 0) + 1;
      let q = client.from('activities').update({ consecutive_missing_scans: next }).eq('id', a.id);
      q = prev == null ? q.is('consecutive_missing_scans', null) : q.eq('consecutive_missing_scans', prev);
      const { data: w } = await q.select('id');
      if (w && w.length) { summary.absent++; if (next >= threshold) summary.over_threshold++; }
    } else {
      summary.skipped[d.reason] = (summary.skipped[d.reason] || 0) + 1;
    }
  }
  return { summary, decisions };
}

module.exports = { scopeKey, normalizeForPresence, decideMissing, loadScopeActivities, applyMissingAccounting };
