// CONTINUOUS MONSTER invariants: job selection / cadence / max work / overlap / scheduler command, source cadence
// policy, review-budget classification, and dry-run never mutating (orchestrator run with a recording client).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { JOBS, isDue, selectJobs, lockIsStale, schedulerCommand } = require('../lib/monsterJobs');
const { proposeCadenceHours, cadencePlan, expectedScansPerDay, classOf } = require('../lib/sourceCadence');
const { classifyIncoming, reviewBudget } = require('../lib/reviewBudget');

test('every job is bounded, placed and explained; durable jobs are never selected locally', () => {
  for (const j of JOBS) { assert.ok(j.id && j.where && j.reason && j.command, j.id); if (j.where === 'local') assert.ok(j.everyHours > 0, j.id + ' cadence'); }
  assert.ok(JOBS.filter((j) => j.where === 'local').every((j) => j.maxWork == null || j.maxWork >= 0));
  // Phase D pilot: the scheduled cadence job never applies (approval pending); the Cleaner batch stays at 40
  assert.ok(!JOBS.find((j) => j.id === 'cadence').command.includes('--apply'), 'cadence job is dry-run in the pilot');
  assert.ok(/--max=40(s|$)/.test(JOBS.find((j) => j.id === 'cleaner').command), 'Cleaner batch stays at 40');
  assert.ok(!JOBS.find((j) => j.id === 'reprobe').command.includes('--apply'), 're-probe job proposes only');
  // Phase A: the scheduled pending lifecycle touches NEW ingestion only - the historical queue needs approval
  assert.ok(/--found-since=\d{4}-\d{2}-\d{2}T/.test(JOBS.find((j) => j.id === 'pending_lifecycle').command), 'pending lifecycle never drains the historical queue unapproved');
  const sel = selectJobs({ state: {}, now: new Date('2026-09-20T10:00:00Z') });
  assert.ok(sel.every((j) => j.where === 'local')); assert.ok(sel.some((j) => j.id === 'relay') && sel.some((j) => j.id === 'cleaner'));
});

test('cadence: a job runs only when its interval elapsed; --job forces exactly one; pause selects nothing', () => {
  const now = new Date('2026-09-20T10:00:00Z');
  const state = { cleaner: { lastRunAt: '2026-09-20T09:30:00Z' }, relay: { lastRunAt: '2026-09-20T02:00:00Z' }, coverage: { lastRunAt: '2026-09-15T00:00:00Z' }, discovery: { lastRunAt: '2026-09-19T00:00:00Z' } };
  const ids = selectJobs({ state, now }).map((j) => j.id);
  assert.ok(!ids.includes('cleaner'), 'cleaner ran 30 min ago'); assert.ok(ids.includes('relay'), 'relay is 8 h old'); assert.ok(!ids.includes('coverage'), 'coverage ran 5 d ago'); assert.ok(!ids.includes('discovery'));
  assert.deepEqual(selectJobs({ state, now, only: 'cleaner' }).map((j) => j.id), ['cleaner']);
  assert.deepEqual(selectJobs({ state, now, enabled: false }), []);
  assert.equal(isDue(JOBS.find((j) => j.id === 'scan_due_sources'), {}, now), false, 'durable jobs are pg_cron, not local');
});

test('overlap: a fresh lock blocks, a stale lock (> 3 h) does not; scheduler command is a bounded Task Scheduler entry', () => {
  const now = new Date('2026-09-20T10:00:00Z');
  assert.equal(lockIsStale({ at: '2026-09-20T09:00:00Z', pid: 1 }, now), false);
  assert.equal(lockIsStale({ at: '2026-09-20T05:00:00Z', pid: 1 }, now), true);
  assert.equal(lockIsStale(null, now), true);
  const cmd = schedulerCommand({ root: 'C:\\turu\\tools\\import-tool', everyMinutes: 60 });
  assert.match(cmd, /schtasks \/Create \/TN "TuRu Monster" \/SC MINUTE \/MO 60/); assert.match(cmd, /monster\.cmd/);
});

test('source cadence: live calendars daily, productive event sources 48 h, quiet ones 72 h, venue directories weekly/fortnightly, social never, bounds 24-336 h', () => {
  const muni = { id: 'a', name: 'muni', is_active: true, source_kind: 'municipality_calendar', publisher_type: 'municipality', scan_frequency_hours: 72 };
  assert.deepEqual(proposeCadenceHours(muni, { scans: 10, pages: 10, changed: 9, new_c: 40, upd: 5 }).hours, 24);
  assert.equal(proposeCadenceHours(muni, { scans: 10, pages: 10, changed: 10, new_c: 4, upd: 0 }).hours, 48, 'a page whose hash changes on every load is not a live calendar without yield per scan');
  assert.equal(proposeCadenceHours(muni, { scans: 10, pages: 10, changed: 3, new_c: 4, upd: 0 }).hours, 48);
  assert.equal(proposeCadenceHours(muni, { scans: 10, pages: 10, changed: 3, new_c: 0, upd: 0 }).hours, 72);
  assert.equal(proposeCadenceHours(muni, { scans: 2 }).hours, 72, 'unmeasured sources keep the default');
  const venue = { id: 'b', name: 'zoo', is_active: true, source_kind: 'website', publisher_type: 'venue_operator', scan_frequency_hours: 72 };
  assert.equal(classOf(venue), 'venue');
  assert.equal(proposeCadenceHours(venue, { scans: 5, pages: 20, changed: 5, new_c: 2, upd: 1 }).hours, 168);
  assert.equal(proposeCadenceHours(venue, { scans: 5, pages: 20, changed: 0, new_c: 0, upd: 0 }).hours, 336);
  assert.equal(proposeCadenceHours({ source_kind: 'facebook' }, {}).hours, null);
  const plan = cadencePlan([muni, venue, { id: 'c', is_active: false, source_kind: 'website' }, { id: 'd', is_active: true, source_kind: 'instagram' }], { a: { scans: 10, pages: 10, changed: 9, new_c: 40 }, b: { scans: 5, pages: 20, changed: 0 } });
  assert.equal(plan.length, 2); assert.ok(plan.every((p) => p.proposed >= 24 && p.proposed <= 336)); assert.equal(plan.find((p) => p.source_id === 'a').change, true);
  assert.equal(expectedScansPerDay(plan), Math.round((24 / 24 + 24 / 336) * 10) / 10);
  // budget: the least productive daily sources are demoted until the expected scans/day fit
  const many = Array.from({ length: 10 }, (_, i) => ({ id: 'm' + i, name: 'm' + i, is_active: true, source_kind: 'municipality_calendar', scan_frequency_hours: 72 }));
  const ys = Object.fromEntries(many.map((s, i) => [s.id, { scans: 10, pages: 10, changed: 9, new_c: 10 + i, upd: 5 }]));
  const capped = cadencePlan(many, ys, { budgetScansPerDay: 6 });
  assert.ok(expectedScansPerDay(capped) <= 6, 'within budget: ' + expectedScansPerDay(capped));
  assert.equal(capped.find((p) => p.source_id === 'm9').proposed, 24, 'the most productive keeps the daily cadence');
  assert.equal(capped.find((p) => p.source_id === 'm0').proposed > 24, true, 'the least productive is demoted first');
});

test('review budget: every row lands in a reason bucket; duplicates / outside-service-area / Cleaner-resolvable are not human work; growth is a signal', () => {
  assert.equal(classifyIncoming({ status: 'approved', match_type: 'new' }), 'auto_approved');
  assert.equal(classifyIncoming({ status: 'rejected', match_type: 'new', archive_reason: 'outside_service_area' }), 'outside_service_area');
  assert.equal(classifyIncoming({ status: 'duplicate', match_type: 'duplicate' }), 'duplicate');
  assert.equal(classifyIncoming({ status: 'needs_review', match_type: 'new', validation_issues: ['עיר'] }), 'cleaner_resolvable_location');
  assert.equal(classifyIncoming({ status: 'needs_review', match_type: 'new', validation_issues: ['ימי פעילות'], city: 'x', formatted_address: null }), 'cleaner_resolvable_metadata');
  assert.equal(classifyIncoming({ status: 'needs_review', match_type: 'update' }), 'update_for_review');
  assert.equal(classifyIncoming({ status: 'new', match_type: 'new', validation_issues: [], city: 'x', location_name: 'y', source_trusted: false }), 'held_untrusted_source');
  // Phase A: confidence_score is the MATCH confidence (0 for every new row) - never an extraction-confidence bucket
  assert.equal(classifyIncoming({ status: 'needs_review', match_type: 'new', validation_issues: [], city: 'x', location_name: 'y', confidence_score: 0.4 }), 'awaiting_publish_checks');
  assert.equal(classifyIncoming({ status: 'needs_review', match_type: 'new', validation_issues: ['יחידת פעילות'], city: 'x', location_name: 'y' }), 'requires_human_judgment');
  const window = Array.from({ length: 60 }, (_, i) => ({ status: 'needs_review', match_type: 'new', validation_issues: i % 2 ? ['עיר'] : ['יחידת פעילות'], city: 'x', location_name: 'y' }));
  const b = reviewBudget({ window, openQueue: window, reviewedInWindow: 10, cleanerResolvedInWindow: 5 });
  assert.ok(b.signals.some((s) => s.code === 'review_debt_growing')); assert.equal(b.perCycle.cleaner_resolvable_location, 30); assert.equal(b.humanOnly, 30);
  const calm = reviewBudget({ window: window.slice(0, 10), openQueue: [], reviewedInWindow: 40, cleanerResolvedInWindow: 20 });
  assert.ok(!calm.signals.some((s) => s.code === 'review_debt_growing'));
});

test('discovery: a region bbox ignores a settlement carrying the wrong region label (5th-95th percentile), and a candidate is regioned by its nearest CBS settlement, not the query', () => {
  const { regionBbox } = require('../lib/sourceDiscovery');
  const pts = Array.from({ length: 40 }, (_, i) => ({ region: 'r', lat: 32.1 + (i % 10) * 0.01, lng: 34.85 + (i % 7) * 0.01 }));
  pts.push({ region: 'r', lat: 32.8, lng: 35.0 }); // mislabelled outlier 70 km north
  const b = regionBbox(pts, 'r');
  assert.ok(b[2] < 32.3, 'north edge stays with the region: ' + b[2]); assert.ok(b[0] > 32.0);
  assert.equal(regionBbox(pts.slice(0, 2), 'r'), null, 'fewer than 3 centroids -> no box');
});

test('discovery: a registry row is INACTIVE, below the trust bar, carries OSM provenance + verification in existing columns only', () => {
  const { registryRow } = require('../lib/sourceDiscovery');
  const r = registryRow({ name: 'x', website: 'https://x.example', publisher_type: 'community_center', region: 'r', categories: ['c'], osm: 'node/1', family: 'community_center', verify: { summary: 'HTTP 200, 1000 Hebrew chars' } }, 'batch-1');
  assert.equal(r.is_active, false); assert.equal(r.is_trusted, false); assert.ok(r.source_trust_score < 70);
  assert.ok(r.disabled_reason.includes('OSM node/1')); assert.ok(r.disabled_reason.includes('HTTP 200')); assert.equal(r.type, 'html', 'sources_type_check allows html | sitemap | other'); assert.equal(r.discovery_batch, 'batch-1');
  assert.ok(!('notes' in r), 'public.sources has no notes column (first pilot cycle failed all 20 inserts on it)');
});

test('code line: jobs run ONLY on branch main at main\'s commit; any other branch (even at main\'s commit) or a stale main refuses; no git -> unknown but allowed', () => {
  const { codeLineStatus } = require('../lib/codeLine');
  // A. main branch at main's commit -> accepted (a dirty tree is reported, never blocking)
  assert.deepEqual([codeLineStatus({ available: true, head: 'aaa1111', mainHead: 'aaa1111', branch: 'main', dirty: 0 }).ok, codeLineStatus({ available: true, head: 'aaa1111', mainHead: 'aaa1111', branch: 'main', dirty: 0 }).code], [true, 'main']);
  const dirty = codeLineStatus({ available: true, head: 'aaa1111', mainHead: 'aaa1111', branch: 'main', dirty: 1 });
  assert.equal(dirty.ok, true, 'a dirty main tree runs'); assert.ok(dirty.message.includes('1 modified tracked file(s)'), 'dirt still reported');
  // B. the 2026-09-27 bug: a feature branch whose HEAD IS main's commit -> refused
  const b = codeLineStatus({ available: true, head: 'aaa1111', mainHead: 'aaa1111', branch: 'feature/foo', dirty: 0 });
  assert.deepEqual([b.ok, b.code], [false, 'not_main_branch']); assert.ok(b.message.includes('feature/foo') && b.message.includes('same commit as main'));
  assert.equal(codeLineStatus({ available: true, head: 'aaa1111', mainHead: 'aaa1111', branch: 'HEAD', dirty: 0 }).ok, false, 'a detached HEAD at main\'s commit is not the main branch');
  // C. main branch but HEAD is not main's commit -> refused
  const c = codeLineStatus({ available: true, head: 'aaa1111', mainHead: 'bbb2222', branch: 'main', dirty: 0 });
  assert.deepEqual([c.ok, c.code], [false, 'stale_code_line']);
  assert.equal(codeLineStatus({ available: true, head: 'aaa1111', mainHead: null, branch: 'main', dirty: 0 }).ok, false, 'main ref unresolved -> never accepted');
  // D. feature branch at a stale commit -> refused
  const d = codeLineStatus({ available: true, head: 'aaa1111', mainHead: 'bbb2222', branch: 'feature/foo', dirty: 0 });
  assert.deepEqual([d.ok, d.code], [false, 'not_main_branch']);
  assert.equal(codeLineStatus({ available: true, head: 'aaa1111', mainHead: null, branch: 'x', dirty: 0 }).ok, false);
  // not a git checkout: unchanged (unknown, allowed, reported)
  assert.deepEqual([codeLineStatus({ available: false }).ok, codeLineStatus({ available: false }).code], [true, 'unknown']);
});

test('code line: the real git probe refuses a feature branch at main\'s commit and accepts main (temporary fixture repo)', (t) => {
  const { probeCodeLine, codeLineStatus } = require('../lib/codeLine');
  const { execFileSync } = require('child_process');
  const fs = require('fs'); const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turu-codeline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(dir, 'a.txt'), '1'); git('add', 'a.txt'); git('commit', '-q', '-m', 'one');
  const onMain = probeCodeLine(dir);
  assert.equal(onMain.branch, 'main'); assert.equal(codeLineStatus(onMain).ok, true, 'A: main at main');
  git('checkout', '-q', '-b', 'feature/foo');
  const feat = probeCodeLine(dir);
  assert.equal(feat.head, feat.mainHead, 'feature/foo sits exactly at main'); assert.equal(codeLineStatus(feat).code, 'not_main_branch', 'B: same commit, wrong branch');
  fs.writeFileSync(path.join(dir, 'a.txt'), '2'); git('commit', '-q', '-am', 'two');
  assert.equal(codeLineStatus(probeCodeLine(dir)).code, 'not_main_branch', 'D: wrong branch, other commit');
  git('checkout', '-q', 'main');
  // C: branch main, but the expected code line (here: the newer feature/foo commit) is not HEAD
  assert.equal(codeLineStatus(probeCodeLine(dir, 'feature/foo')).code, 'stale_code_line', 'C: main branch, HEAD is not the expected commit');
  assert.equal(codeLineStatus(probeCodeLine(dir)).ok, true, 'A again: main at main');
});

test('code line guard leaves the places_photos gate unchanged (E): gated off by default and for --job, on only when exactly true', () => {
  const now = new Date('2026-09-27T10:00:00Z');
  assert.ok(!selectJobs({ state: {}, now, gates: {} }).some((x) => x.id === 'places_photos'));
  assert.deepEqual(selectJobs({ state: {}, now, only: 'places_photos', gates: {} }), []);
  assert.deepEqual(selectJobs({ state: {}, now, only: 'places_photos', gates: { places_photos_enabled: true } }).map((x) => x.id), ['places_photos']);
});

// Places image automation (2026-09-26): one Python job, gated OFF until rollout, before the Cleaner
test('places_photos: python runtime, bounded, before cleaner, gated off unless places_photos_enabled is exactly true', () => {
  const { jobSpawnSpec, isGatedOff } = require('../lib/monsterJobs');
  const j = JOBS.find((x) => x.id === 'places_photos');
  assert.ok(j, 'job exists');
  assert.equal(j.runtime, 'python'); assert.equal(j.where, 'local'); assert.equal(j.everyHours, 1); assert.equal(j.maxWork, 50);
  assert.equal(j.enabledSetting, 'places_photos_enabled');
  assert.match(j.command, /^python enrich_images\.py /);
  for (const flag of ['--apply', '--limit=50', '--max-concurrency=2', '--requests-per-second=2', '--daily-max-calls=300']) assert.ok(j.command.split(' ').includes(flag), flag);
  assert.ok(!/--list-only|--dry-run/.test(j.command));
  // ordering: before the Cleaner (the Cleaner's stale sweep then closes the satisfied missing_image case)
  const ids = JOBS.map((x) => x.id); assert.ok(ids.indexOf('places_photos') < ids.indexOf('cleaner'), 'places_photos before cleaner');
  const now = new Date('2026-09-26T20:00:00Z');
  const on = selectJobs({ state: {}, now, gates: { places_photos_enabled: true } }).map((x) => x.id);
  assert.ok(on.indexOf('places_photos') >= 0 && on.indexOf('places_photos') < on.indexOf('cleaner'));
  // gate: absent / false / truthy-but-not-true = OFF, also for --job=places_photos
  for (const gates of [{}, { places_photos_enabled: false }, { places_photos_enabled: 'true' }, { places_photos_enabled: 1 }]) {
    assert.ok(!selectJobs({ state: {}, now, gates }).some((x) => x.id === 'places_photos'), JSON.stringify(gates));
    assert.deepEqual(selectJobs({ state: {}, now, only: 'places_photos', gates }), []);
    assert.equal(isGatedOff(j, gates), true);
  }
  assert.deepEqual(selectJobs({ state: {}, now, only: 'places_photos', gates: { places_photos_enabled: true } }).map((x) => x.id), ['places_photos']);
  assert.ok(!selectJobs({ state: { places_photos: { lastRunAt: '2026-09-26T19:30:00Z' } }, now, gates: { places_photos_enabled: true } }).some((x) => x.id === 'places_photos'), 'hourly');
  // spawn: py -3 on Windows in tools/playground-discovery, UTF-8 stdio, own 15-min timeout
  const root = path.join('C:', 'turu', 'tools', 'import-tool');
  const w = jobSpawnSpec(j, { root, platform: 'win32', env: { PATH: 'x' } });
  assert.equal(w.runtime, 'python'); assert.equal(w.exe, 'py'); assert.deepEqual(w.args.slice(0, 2), ['-3', 'enrich_images.py']);
  assert.ok(w.args.includes('--limit=50'));
  assert.equal(w.cwd, path.resolve(root, '..', 'playground-discovery'));
  assert.equal(w.env.PYTHONIOENCODING, 'utf-8'); assert.equal(w.env.PYTHONUTF8, '1'); assert.equal(w.env.PATH, 'x');
  assert.equal(w.timeoutMs, 15 * 60 * 1000);
  assert.equal(jobSpawnSpec(j, { root, platform: 'linux', env: {} }).exe, 'python3');
  const o = jobSpawnSpec(j, { root, platform: 'win32', env: { TURU_PYTHON: 'C:\py\python.exe' } });
  assert.equal(o.exe, 'C:\py\python.exe'); assert.equal(o.args[0], 'enrich_images.py');
  assert.throws(() => jobSpawnSpec({ ...j, runtime: 'ruby' }, { root }), /unknown runtime/);
});

test('existing Node jobs keep the Node runtime unchanged: this node binary, command minus "node", import-tool root, 45-min timeout, env untouched', () => {
  const { jobSpawnSpec } = require('../lib/monsterJobs');
  const root = path.join('C:', 'turu', 'tools', 'import-tool');
  const env = { PATH: 'p' };
  for (const j of JOBS.filter((x) => x.where === 'local' && x.id !== 'places_photos')) {
    assert.equal(j.runtime, undefined, j.id + ' has no runtime field (defaults to node)');
    assert.ok(!j.enabledSetting, j.id + ' is not gated');
    assert.match(j.command, /^node /, j.id);
    const s = jobSpawnSpec(j, { root, platform: 'win32', env, nodePath: 'C:\node\node.exe' });
    assert.equal(s.runtime, 'node'); assert.equal(s.exe, 'C:\node\node.exe'); assert.deepEqual(s.args, j.command.split(' ').slice(1));
    assert.equal(s.cwd, root); assert.equal(s.env, env, 'same env object, no UTF-8 overrides'); assert.equal(s.timeoutMs, 45 * 60 * 1000);
  }
  // the pre-existing selection is unchanged when no gate is passed
  const ids = selectJobs({ state: {}, now: new Date('2026-09-20T10:00:00Z') }).map((j) => j.id);
  assert.deepEqual(ids, ['relay', 'cleaner', 'pending_lifecycle', 'coverage', 'discovery', 'cadence', 'reprobe']);
});
