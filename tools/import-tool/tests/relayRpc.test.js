const test = require('node:test');
const assert = require('node:assert/strict');
const { callWithRetry, classifyRpcError, createFetchRecorder, describeRpcFailure } = require('../lib/relayRpc');

// postgrest-js shape of a transport failure (see node_modules/@supabase/postgrest-js: status 0, cause folded into details)
const TRANSPORT = { error: { message: 'TypeError: fetch failed', details: 'TypeError: fetch failed\n\nCaused by: Error: read ECONNRESET (ECONNRESET)\n    at TLSWrap.onStreamRead', hint: '', code: '' }, status: 0 };
const APP = { error: { message: 'permission denied: admin or trusted uploader only', details: null, hint: null, code: 'P0001' }, status: 400 };
const OK = { error: null, status: 204 };

function scripted(responses) { let i = 0; const calls = { n: 0 }; return { calls, rpc: async () => { calls.n++; return responses[Math.min(i++, responses.length - 1)]; } }; }
const recordSleep = () => { const s = []; return { s, sleep: async (ms) => { s.push(ms); } }; };

test('transient transport failure is retried with exponential backoff, then succeeds', async () => {
  const { rpc, calls } = scripted([TRANSPORT, TRANSPORT, OK]);
  const { s, sleep } = recordSleep();
  const r = await callWithRetry({ rpc, sleep, landed: async () => false });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
  assert.equal(calls.n, 3);
  assert.deepEqual(s, [15000, 45000]);
  assert.equal(r.failures[0].kind, 'transport');
  assert.equal(r.failures[0].causedBy, 'Caused by: Error: read ECONNRESET (ECONNRESET)');
});

test('application / database error is NOT retried', async () => {
  const { rpc, calls } = scripted([APP, OK]);
  const r = await callWithRetry({ rpc, sleep: async () => {}, landed: async () => false });
  assert.equal(r.ok, false);
  assert.equal(r.fatal, true);
  assert.equal(calls.n, 1);
  assert.equal(r.failures[0].kind, 'application');
  assert.equal(r.failures[0].code, 'P0001');
});

test('gateway 503 is retried; generic 500 with a database code is not', () => {
  assert.equal(classifyRpcError({ message: 'Service Unavailable' }, 503).retryable, true);
  assert.equal(classifyRpcError({ message: 'x', code: 'XX000' }, 500).retryable, false);
  assert.equal(classifyRpcError({ message: 'x', code: '42501' }, 403).retryable, false);
});

test('a batch that actually reached the database is never re-submitted (lost response)', async () => {
  const { rpc, calls } = scripted([TRANSPORT, OK]);
  const r = await callWithRetry({ rpc, sleep: async () => {}, landed: async () => true });
  assert.equal(r.ok, true);
  assert.equal(r.landedDespiteError, true);
  assert.equal(calls.n, 1);
});

test('retries are bounded: exhausted after maxAttempts', async () => {
  const { rpc, calls } = scripted([TRANSPORT]);
  const r = await callWithRetry({ rpc, sleep: async () => {}, landed: async () => false, maxAttempts: 4 });
  assert.equal(r.ok, false);
  assert.equal(r.exhausted, true);
  assert.equal(calls.n, 4);
});

test('fetch recorder keeps the raw network cause (code/errno/syscall) and nothing from the request', async () => {
  const err = new TypeError('fetch failed');
  err.cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', errno: -4077, syscall: 'read' });
  const rec = createFetchRecorder(async () => { throw err; });
  await assert.rejects(rec.fetch('https://x.supabase.co/rest/v1/rpc/relay_scan_source', { headers: { Authorization: 'Bearer SECRET' }, body: 'payload' }));
  const last = rec.takeLast();
  assert.deepEqual(last.cause, { name: 'Error', message: 'read ECONNRESET', code: 'ECONNRESET', errno: -4077, syscall: 'read', address: undefined, port: undefined });
  assert.equal(JSON.stringify(last).includes('SECRET'), false);
  assert.equal(JSON.stringify(last).includes('payload'), false);
  assert.equal(rec.takeLast(), null);
  const d = describeRpcFailure({ ...TRANSPORT, transport: last });
  assert.deepEqual(d.cause, { name: 'Error', message: 'read ECONNRESET', code: 'ECONNRESET', errno: -4077, syscall: 'read' });
  assert.equal(JSON.stringify(d).includes('TLSWrap'), false); // no stack
});
