// TuRu - CONTINUOUS MONSTER: the job model (pure, testable). Durable jobs run inside Supabase (pg_cron); LOCAL jobs
// run through `monster.js cycle` on the admin machine (pilot). Every job is bounded (max work per run), idempotent
// (safe to repeat), isolated (one job's failure never stops the cycle) and has an explicit cadence with a reason.
// rows found before this instant are the historical queue (Phase A cleanup waits for approval)
const PHASE_A_CUTOFF = '2026-09-24T07:00:00Z';
const JOBS = [
  { id: 'scan_due_sources', where: 'supabase', cadence: 'every 15 min (pg_cron scan-due-sources)', maxWork: 20, reason: 'dated events have a median lead time of 14 d (p25 5 d): a healthy event source must be revisited every 1-2 days; the dispatcher takes at most 20 due sources per tick so the edge function never sees a thundering herd', command: 'select public._scan_due_sources_cron()' },
  { id: 'cleanup_expired', where: 'supabase', cadence: 'daily 03:00 (pg_cron cleanup-expired-activities-daily)', maxWork: null, reason: 'a one-time event whose last date passed must leave Results the next morning', command: 'select public._cleanup_expired_activities_cron()' },
  { id: 'relay', where: 'local', everyHours: 6, maxWork: 6, reason: 'WAF-blocked sources (Holon, Tel Aviv, Lod...) are only reachable from a local IP; 10 sources with 72-168 h frequencies need ~2 relays per cycle - 6 per cycle absorbs a backlog after downtime', command: 'node relay-scan.js --max=6' },
  // Places image automation (2026-09-26): the ONE Python job - the existing Places photo enrichment
  // (tools/playground-discovery/enrich_images.py), scoped server-side to approved imageless Places activities
  // (oldest first, 10-min grace so the scan-settlement-gaps inline insert wins), with its own no-photo / error /
  // invalid ledger (automation_settings.places_photo_checks) and a daily Places call cap. BEFORE the Cleaner so the
  // Cleaner's stale sweep closes the missing_image case the photo just satisfied. Gated OFF until rollout:
  // automation_settings.places_photos_enabled must be exactly true.
  { id: 'places_photos', where: 'local', runtime: 'python', cwd: '../playground-discovery', enabledSetting: 'places_photos_enabled', everyHours: 1, maxWork: 50, timeoutMinutes: 15, reason: 'new Places activities (queue approval, coverage plans) arrive without an image; one bounded hourly pass (50 oldest approved imageless rows, <= 2 Places calls/s, 300 calls/day) adds the sanctioned place-photo proxy image, and a place Google has no photo for is re-checked only every 30 days', command: 'python enrich_images.py --apply --limit=50 --max-concurrency=2 --requests-per-second=2 --daily-max-calls=300' },
  { id: 'cleaner', where: 'local', everyHours: 1, maxWork: 40, reason: 'resolvable debt follows ingestion asynchronously; one bounded batch per hour (40 cases, leases + run guard) clears ~1,000 cases/day when due', command: 'node cleaner.js --max=40' },
  // Human Queue Policy Phase A (2026-09-24): expired pending candidates leave the inbox, far-future ones are
  // deferred. --found-since = the Phase A deploy: NEW ingestion only. The historical queue is drained only by an
  // explicitly approved run without it (tests assert the cutoff stays on the scheduled command).
  { id: 'pending_lifecycle', where: 'local', everyHours: 24, maxWork: 200, reason: 'a one-time candidate whose last date passed can no longer be decided and a valid event > 180 d ahead cannot publish yet - neither is human work; one bounded daily pass (200 rows) keeps both out of the inbox', command: `node pending-lifecycle.js --apply --max=200 --found-since=${PHASE_A_CUTOFF}` },
  { id: 'coverage', where: 'local', everyHours: 24 * 7, maxWork: null, reason: 'coverage gaps move slowly; a weekly read-only report feeds the next discovery targets', command: 'node report-coverage.js --json-only' },
  { id: 'discovery', where: 'local', everyHours: 24 * 7, maxWork: 20, reason: 'new sources are found from OpenStreetMap venue records with a website (free, provenance-aware) inside the service area, verified by a fetch, deduplicated against the registry, and registered INACTIVE for a person to activate - at most 20 candidates per week so review stays bounded', command: 'node discover-sources-osm.js --max=20 --register' },
  { id: 'cadence', where: 'local', everyHours: 24 * 7, maxWork: 0, reason: 'scan frequencies follow 30-day yield (live calendars daily, quiet venue sites fortnightly). PILOT (Phase D, 2026-09-19): the weekly job only writes the plan (dry run, source-cadence-<date>-dryrun.json) - applying it (38 -> 60 scans/day, +55 % AI calls) is NOT approved; a person runs `tune-source-cadence.js --apply --max=40 --budget=60` after approval', command: 'node tune-source-cadence.js --budget=60' },
  { id: 'reprobe', where: 'local', everyHours: 24 * 30, maxWork: 30, reason: 'paused / 403-blocked sources are re-probed from the local IP once a month; those that answer become relay candidates (proposal, not activation)', command: 'node reprobe-sources.js --max=30' },
];

const nowMs = (now) => (now instanceof Date ? now.getTime() : Number(now));
// state: { [jobId]: { lastRunAt: ISO, lastStatus, lastError } }
function isDue(job, state, now = new Date()) {
  if (job.where !== 'local') return false;
  const last = state && state[job.id] && state[job.id].lastRunAt ? Date.parse(state[job.id].lastRunAt) : 0;
  return nowMs(now) - last >= job.everyHours * 3600 * 1000;
}
// a job with `enabledSetting` runs only when that automation_settings key is exactly true (absent = OFF, also
// for --job=<id>): new jobs land dark and a person switches them on after review
function isGatedOff(job, gates = {}) { return !!job.enabledSetting && gates[job.enabledSetting] !== true; }
// jobs due now, in priority order (relay before places_photos before cleaner: fresh candidates first), honouring `only`
function selectJobs({ state = {}, now = new Date(), only = null, enabled = true, gates = {} } = {}) {
  if (!enabled) return [];
  return JOBS.filter((j) => j.where === 'local' && !isGatedOff(j, gates) && (!only || only === j.id) && (only ? true : isDue(j, state, now)));
}
// how one local job is launched. runtime 'node' (default, unchanged): this process's node binary, the command minus
// its leading "node", in the import-tool root. runtime 'python': the Windows py launcher (`py -3`, the interpreter
// tools/playground-discovery already runs on) or python3 elsewhere, overridable with TURU_PYTHON; cwd = the job's
// own directory; UTF-8 stdio so Hebrew names in logs never crash the child on a cp1252 pipe.
function jobSpawnSpec(job, { root, platform = process.platform, env = process.env, nodePath = process.execPath } = {}) {
  const parts = job.command.split(' ').slice(1); // drop the leading "node" / "python"
  const timeoutMs = (job.timeoutMinutes || 45) * 60 * 1000;
  if ((job.runtime || 'node') === 'node') return { runtime: 'node', exe: nodePath, args: parts, cwd: root, env, timeoutMs };
  if (job.runtime !== 'python') throw new Error(`job ${job.id}: unknown runtime ${job.runtime}`);
  const override = env.TURU_PYTHON && String(env.TURU_PYTHON).trim();
  const [exe, pre] = override ? [override, []] : platform === 'win32' ? ['py', ['-3']] : ['python3', []];
  const cwd = job.cwd ? require('path').resolve(root, job.cwd) : root;
  return { runtime: 'python', exe, args: [...pre, ...parts], cwd, env: { ...env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }, timeoutMs };
}
// a cycle never overlaps another: the lock is a file with the owner pid + timestamp; stale after 3 h
function lockIsStale(lock, now = new Date(), staleMs = 3 * 3600 * 1000) { return !lock || !lock.at || nowMs(now) - Date.parse(lock.at) > staleMs; }
// scheduler command for the pilot machine (printed, never executed by monster.js itself)
function schedulerCommand({ root, everyMinutes = 60, taskName = 'TuRu Monster' }) {
  return `schtasks /Create /TN "${taskName}" /SC MINUTE /MO ${everyMinutes} /TR "cmd.exe /c ${root}\\monster.cmd" /F`;
}
function pauseCommand(root) { return `node ${root}\\monster.js pause   (sets automation_settings.monster_enabled=false; pg_cron scanning: automation_settings.scanning_enabled=false)`; }

module.exports = { JOBS, PHASE_A_CUTOFF, isDue, isGatedOff, selectJobs, jobSpawnSpec, lockIsStale, schedulerCommand, pauseCommand };
