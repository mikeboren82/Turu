const test = require('node:test');
const assert = require('node:assert/strict');
const { relaySource } = require('../lib/relayRun');

const APP = { error: { message: 'permission denied', details: null, hint: null, code: 'P0001' }, status: 400 };
const SEED = 'https://www.holon.muni.il/Havingfun/pages/allevents.aspx';

// Fake Supabase for a LOGICAL relay run. relay_scan_source behaves like scan-source: page budget per invocation,
// hash-skip of unchanged parts, snapshot saved only after a complete extraction, and - like the real match path -
// an extracted part marks every approved activity it names (or aliases) as seen. It never counts missing itself.
function world({ budget = 3, rpcScript = [], snapshots = [], activities = [], sources = [], aiErrorUrls = [], aliases = {} } = {}) {
  let clock = Date.parse('2026-09-24T08:00:00Z');
  const now = () => clock;
  const iso = () => new Date(clock).toISOString();
  const t = {
    source_scan_logs: [], source_page_snapshots: snapshots.map((s) => ({ source_id: 'S', ...s })),
    sources: [{ id: 'S', last_scan_at: '2026-09-21T03:00:00.000Z', next_scan_at: '2026-09-24T00:00:00.000Z', scan_frequency_hours: 72, last_scan_status: 'success' }],
    activities: activities.map((a) => ({ source_id: 'S', status: 'approved', ...a })),
    activity_sources: sources.map((r) => ({ source_id: 'S', url_role: null, relation: 'seen', ...r })),
  };
  const rpcCalls = []; let logSeq = 0;
  const scan = (pages) => {
    clock += 60_000;
    const log = { id: `log${++logSeq}`, source_id: 'S', started_at: iso(), status: 'running' };
    t.source_scan_logs.push(log);
    let extracted = 0;
    for (const p of pages) {
      const snap = t.source_page_snapshots.find((s) => s.url === p.url);
      if (snap && snap.content_hash === p.hash) { snap.last_fetched_at = iso(); continue; }
      if (extracted >= budget) break;
      extracted++;
      if (aiErrorUrls.includes(p.url)) continue; // extraction failed: no snapshot
      for (const a of t.activities) if (p.text.includes(a.name) || (aliases[a.id] && p.text.includes(aliases[a.id]))) Object.assign(a, { last_seen_at: iso(), consecutive_missing_scans: 0 });
      if (snap) Object.assign(snap, { content_hash: p.hash, last_fetched_at: iso() }); else t.source_page_snapshots.push({ source_id: 'S', url: p.url, content_hash: p.hash, last_fetched_at: iso() });
    }
    clock += 30_000; log.status = 'success'; clock += 1000;
    Object.assign(t.sources[0], { last_scan_at: iso(), next_scan_at: new Date(clock + 72 * 3600e3).toISOString() });
  };
  const from = (table) => {
    const q = { op: 'select', patch: null, f: [], ord: null, lim: null, ret: false };
    const match = (r) => q.f.every(([k, v, kind]) => kind === 'eq' ? r[k] === v : kind === 'gte' ? r[k] >= v : kind === 'in' ? v.includes(r[k]) : (r[k] ?? null) === v);
    const run = () => {
      let rows = (t[table] ||= []).filter(match);
      if (q.op === 'update') { for (const r of rows) Object.assign(r, q.patch); return { data: q.ret ? rows.map((r) => ({ ...r })) : null, error: null }; }
      if (q.ord) rows = [...rows].sort((a, b) => (a[q.ord.k] < b[q.ord.k] ? -1 : 1) * (q.ord.asc ? 1 : -1));
      if (q.lim != null) rows = rows.slice(0, q.lim);
      return { data: rows.map((r) => ({ ...r })), error: null };
    };
    const b = {
      select() { if (q.op !== 'select') q.ret = true; return b; }, update(p) { q.op = 'update'; q.patch = p; return b; },
      eq(k, v) { q.f.push([k, v, 'eq']); return b; }, gte(k, v) { q.f.push([k, v, 'gte']); return b; },
      in(k, v) { q.f.push([k, v, 'in']); return b; }, is(k, v) { q.f.push([k, v, 'is']); return b; },
      order(k, o) { q.ord = { k, asc: o?.ascending !== false }; return b; }, limit(n) { q.lim = n; return b; },
      maybeSingle() { const r = run(); return Promise.resolve({ data: r.data[0] ?? null, error: null }); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  };
  const client = { from, rpc: async (name, args) => { const s = rpcScript[rpcCalls.length]; rpcCalls.push(args.p_pages.map((p) => p.url)); if (s && s.error) return s; scan(args.p_pages); return { error: null, status: 204 }; } };
  const act = (id) => t.activities.find((a) => a.id === id);
  return { client, t, now, act, rpcCalls };
}

// a 5-part calendar; `names[i]` are the cards printed in part i
const calendar = (names, tag) => names.map((cards, i) => ({ url: i ? `${SEED}#part=${i + 1}` : SEED, text: `part ${i + 1}\n---\n${cards.join('\n---\n')}`, hash: `h${i + 1}-${tag}` }));
const ctxFor = (w, pages, extra = {}) => ({ client: w.client, now: w.now, sleep: async () => {}, pollMs: 0, maxPolls: 3, log: () => {}, relayPages: async () => ({ stats: [], pages }), ...extra });
const S = { id: 'S', name: 'Holon' };
const LIVE = [['גוליבר'], ['ילדי בית העץ'], ['בת הים הקטנה'], ['הבלונים הצבעוניים'], ['הרצאה']];
const unchangedSnapshots = (pages) => pages.map((p) => ({ url: p.url, content_hash: p.hash, last_fetched_at: '2026-09-24T04:13:12.000Z' }));

test('a08ab845 REGRESSION: every part unchanged, 2 batches - the counter does not grow; the activity is seen on its page', async () => {
  const pages = calendar(LIVE, 'v1');
  const w = world({
    snapshots: unchangedSnapshots(pages),
    activities: [{ id: 'a08', name: 'ילדי בית העץ', consecutive_missing_scans: 19, last_seen_at: '2026-09-13T18:25:09.000Z' }],
    sources: [{ activity_id: 'a08', page_url: `${SEED}#part=4`, relation: 'created' }, { activity_id: 'a08', page_url: 'https://www.holon.muni.il/Havingfun/Pages/AllEvents.aspx#part=4', relation: 'updated' }],
  });
  const run = await relaySource(ctxFor(w, pages), S);
  assert.equal(run.outcome, 'COMPLETE');
  assert.equal(w.t.source_scan_logs.length, 2); // two invocations, as on 2026-09-24
  assert.equal(w.act('a08').consecutive_missing_scans, 0);
  assert.ok(w.act('a08').last_seen_at > '2026-09-24');
  assert.deepEqual(w.t.activity_sources.map((r) => r.relation), ['created', 'updated']);
  assert.equal(run.missing.seen_on_page, 1);
});

test('TRUE REMOVAL: run N present; run N+1 page changed + fully processed without it -> exactly ONE increment across batches and pages', async () => {
  const w = world({
    activities: [{ id: 'gul', name: 'גוליבר', consecutive_missing_scans: 0, last_seen_at: '2026-09-23T00:00:00.000Z' }],
    sources: [{ activity_id: 'gul', page_url: `${SEED}#part=1`, relation: 'created' }],
    budget: 10,
  });
  await relaySource(ctxFor(w, calendar(LIVE, 'N')), S); // run N: present
  assert.equal(w.act('gul').consecutive_missing_scans, 0);
  const next = [...calendar([['חדש 1'], ['ילדי בית העץ'], ['בת הים הקטנה'], ['הבלונים הצבעוניים'], ['הרצאה']], 'N1'), { url: 'https://www.holon.muni.il/Havingfun/other', text: 'עמוד אחר\n---\nאירוע אחר', hash: 'o1' }];
  const run = await relaySource(ctxFor(w, next), S); // run N+1: 6 parts -> 2 batches, plus an unrelated page
  assert.equal(run.outcome, 'COMPLETE');
  assert.ok(w.t.source_scan_logs.length >= 4);
  assert.equal(w.act('gul').consecutive_missing_scans, 1);
  assert.equal(run.missing.absent, 1);
});

test('FALSE-MISSING: a PARTIAL run with deferred parts never increments', async () => {
  const w = world({ budget: 1, activities: [{ id: 'gul', name: 'גוליבר', consecutive_missing_scans: 0 }], sources: [{ activity_id: 'gul', page_url: SEED, relation: 'created' }] });
  const run = await relaySource(ctxFor(w, calendar([['א'], ['ב'], ['ג'], ['ד'], ['ה']], 'x')), S);
  assert.equal(run.outcome, 'PARTIAL');
  assert.equal(w.act('gul').consecutive_missing_scans, 0);
  assert.equal(run.missing.skipped.scope_incomplete, 1);
});

test('FALSE-MISSING: parts dropped by the ceiling, a FAILED run, and an extraction error never increment', async () => {
  const setup = (extra) => world({ activities: [{ id: 'gul', name: 'גוליבר', consecutive_missing_scans: 2 }], sources: [{ activity_id: 'gul', page_url: SEED, relation: 'created' }], budget: 10, ...extra });
  const pages = calendar([['א'], ['ב'], ['ג'], ['ד'], ['ה']], 'y');
  const w1 = setup(); await relaySource(ctxFor(w1, pages, { maxParts: 3 }), S);
  const w2 = setup({ rpcScript: [APP] }); const r2 = await relaySource(ctxFor(w2, pages), S);
  const w3 = setup({ aiErrorUrls: [`${SEED}#part=3`] }); await relaySource(ctxFor(w3, pages), S);
  assert.equal(r2.outcome, 'FAILED');
  for (const w of [w1, w2, w3]) assert.equal(w.act('gul').consecutive_missing_scans, 2);
});

test('FALSE-MISSING: an activity whose page is not part of this run (another batch / source page) is untouched', async () => {
  const w = world({ activities: [{ id: 'far', name: 'אירוע בעמוד אחר', consecutive_missing_scans: 1 }], sources: [{ activity_id: 'far', page_url: 'https://www.holon.muni.il/Havingfun/kids', relation: 'created' }], budget: 10 });
  const run = await relaySource(ctxFor(w, calendar(LIVE, 'z')), S);
  assert.equal(w.act('far').consecutive_missing_scans, 1);
  assert.equal(run.missing.skipped.scope_not_checked, 1);
});

test('FALSE-MISSING: renamed activity matched by extraction (or reconfirmed from a pending review) is not counted absent', async () => {
  const w = world({ activities: [{ id: 'ren', name: 'שם שהמנהל שינה', consecutive_missing_scans: 3 }], sources: [{ activity_id: 'ren', page_url: SEED, relation: 'created' }], aliases: { ren: 'גוליבר' }, budget: 10 });
  const run = await relaySource(ctxFor(w, calendar(LIVE, 'r')), S);
  assert.equal(w.act('ren').consecutive_missing_scans, 0);
  assert.equal(run.missing.seen_matched, 1);
});
