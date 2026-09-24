// TuRu - relay_scan_source RPC resilience: retry only transport / gateway failures, never a confirmed
// application or database error, and never re-submit a batch that already reached the database.

const TRANSIENT_HTTP = new Set([408, 425, 429, 502, 503, 504, 520, 522, 524]);
const TRANSPORT_TEXT = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|other side closed|UND_ERR/i;

// postgrest-js returns status 0 + "TypeError: fetch failed" (cause folded into `details`) for a transport failure.
function classifyRpcError(error, status) {
  const s = Number(status) || 0;
  const text = `${error?.message || ''} ${error?.details || ''}`;
  if (s === 0 && (TRANSPORT_TEXT.test(text) || !error?.code)) return { retryable: true, kind: 'transport' };
  if (TRANSIENT_HTTP.has(s)) return { retryable: true, kind: 'http_transient' };
  return { retryable: false, kind: 'application' };
}

// Wraps fetch so the raw network cause (code / errno / syscall / address) of the last failure is kept - postgrest-js
// only folds the cause message into a string. Nothing from the request (URL, headers, body) is stored.
function createFetchRecorder(baseFetch = globalThis.fetch) {
  let last = null;
  const fetch = async (...args) => {
    try { return await baseFetch(...args); } catch (e) {
      const c = e && e.cause;
      last = {
        name: e?.name, message: e?.message,
        cause: c ? { name: c.name, message: c.message, code: c.code, errno: c.errno, syscall: c.syscall, address: c.address, port: c.port } : null,
      };
      throw e;
    }
  };
  return { fetch, takeLast: () => { const l = last; last = null; return l; } };
}

// One line, no stack, no credentials: message, code, HTTP status, the "Caused by" line, and the raw cause fields.
function describeRpcFailure({ error, status, transport }) {
  const causedBy = String(error?.details || '').split('\n').find((l) => l.startsWith('Caused by:')) || null;
  const c = transport?.cause || null;
  return {
    message: error?.message || null, code: error?.code || null, status: Number(status) || 0, hint: error?.hint || null,
    causedBy, cause: c ? Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined && v !== null)) : null,
  };
}

// rpc(): Promise<{ error, status }>. landed(): Promise<boolean> - true once server-side evidence shows the
// request reached the database (a scan log started for this batch), so a lost response is never re-sent.
async function callWithRetry({ rpc, landed, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), recorder = null,
  maxAttempts = 4, baseDelayMs = 15000, factor = 3, log = () => {} }) {
  const failures = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (recorder) recorder.takeLast();
    const res = await rpc();
    if (!res.error) return { ok: true, attempts: attempt, failures };
    const detail = describeRpcFailure({ error: res.error, status: res.status, transport: recorder ? recorder.takeLast() : null });
    const cls = classifyRpcError(res.error, res.status);
    failures.push({ attempt, kind: cls.kind, ...detail });
    log(`   rpc attempt ${attempt}/${maxAttempts} failed (${cls.kind}): ${JSON.stringify(detail)}`);
    if (!cls.retryable) return { ok: false, fatal: true, attempts: attempt, failures };
    if (attempt === maxAttempts) break;
    const delay = baseDelayMs * factor ** (attempt - 1);
    await sleep(delay);
    if (landed && await landed()) return { ok: true, attempts: attempt, failures, landedDespiteError: true };
  }
  return { ok: false, fatal: false, exhausted: true, attempts: maxAttempts, failures };
}

module.exports = { classifyRpcError, createFetchRecorder, describeRpcFailure, callWithRetry, TRANSIENT_HTTP };
