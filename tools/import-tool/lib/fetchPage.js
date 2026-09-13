// TuRu - one local page fetcher for every Node job that runs on the admin machine (relay-scan.js,
// the Cleaner). Browser UA + he-IL, charset sniffing (iso-8859-8 municipal pages), curl fallback for
// the Israeli hosts whose TLS handshake Node/undici cannot negotiate. Returns {ok, status, html,
// finalUrl, contentType}; never throws on HTTP errors (only on unexpected runtime failures).
const { execFileSync } = require('child_process');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function decodeBuf(buf, contentType) {
  const head = buf.slice(0, 4096).toString('latin1');
  const charset = ((/charset=([\w-]+)/i.exec(contentType || '') || /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1] || 'utf-8').toLowerCase();
  try { return new TextDecoder(charset === 'iso-8859-8-i' ? 'iso-8859-8' : charset).decode(buf); } catch { return buf.toString('utf8'); }
}

function curlFetch(url, { timeoutSec = 90 } = {}) {
  const out = execFileSync('curl', ['-sL', '-A', 'Mozilla/5.0 (compatible; TuruBot/1.0)', '--max-time', String(timeoutSec), '-H', 'Accept-Language: he-IL,he;q=0.9', '-w', '\n__STATUS__%{http_code}', url], { maxBuffer: 30 * 1024 * 1024 });
  const s = out.toString('latin1');
  const m = /__STATUS__(\d+)\s*$/.exec(s);
  const status = m ? Number(m[1]) : 0;
  const body = out.slice(0, out.length - (m ? m[0].length + 1 : 0));
  return { ok: status >= 200 && status < 400, status, html: decodeBuf(body, null), finalUrl: url, contentType: null, via: 'curl' };
}

async function fetchHtml(url, { timeoutMs = 45000 } = {}) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'he-IL,he;q=0.9,en;q=0.5' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type');
    return { ok: res.ok, status: res.status, html: decodeBuf(buf, contentType), finalUrl: res.url || url, contentType, via: 'fetch' };
  } catch (e) {
    if (!/fetch failed|ECONNRESET|certificate|TLS|socket/i.test(e.message || '')) return { ok: false, status: 0, html: '', finalUrl: url, contentType: null, error: e.message, via: 'fetch' };
    try { return curlFetch(url); } catch (e2) { return { ok: false, status: 0, html: '', finalUrl: url, contentType: null, error: e2.message, via: 'curl' }; }
  }
}

// Headers + first bytes only (image probing). Follows redirects; returns {ok,status,contentType,length,bytes,finalUrl}.
async function fetchHead(url, { timeoutMs = 20000, maxBytes = 256 * 1024 } = {}) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'image/*,*/*;q=0.8', 'Range': `bytes=0-${maxBytes - 1}` }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    const contentType = res.headers.get('content-type') || '';
    const lengthHeader = res.headers.get('content-range') ? Number((res.headers.get('content-range') || '').split('/')[1]) : Number(res.headers.get('content-length') || 0);
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: res.ok, status: res.status, contentType, length: lengthHeader || buf.length, bytes: buf.slice(0, maxBytes), finalUrl: res.url || url };
  } catch (e) {
    return { ok: false, status: 0, contentType: '', length: 0, bytes: Buffer.alloc(0), finalUrl: url, error: e.message };
  }
}

module.exports = { UA, decodeBuf, curlFetch, fetchHtml, fetchHead };
