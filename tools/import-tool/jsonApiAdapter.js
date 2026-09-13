// TuRu - Node mirror of supabase/functions/_shared/adapters.ts (api_json adapter). Used by
// relay-scan.js when a JSON-service source is blocked for the edge runtime's cloud IPs: the request
// runs on the admin machine and the rendered TEXT is relayed to scan-source, which then runs the
// normal extraction/dedup/provenance pipeline. Keep the rendering identical to the Deno copy
// (tests/jsonApiAdapter.test.js asserts the mirror on fixed input).
const isoDate = (d) => d.toISOString().slice(0, 10);

function fillDateTemplates(value, now = new Date()) {
  if (typeof value === 'string') return value.replace(/\{\{today([+-]\d+)?\}\}/g, (_m, off) => isoDate(new Date(now.getTime() + Number(off || 0) * 86400000)));
  if (Array.isArray(value)) return value.map((v) => fillDateTemplates(v, now));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDateTemplates(v, now)]));
  return value;
}

function getPath(obj, path) {
  if (!path) return obj;
  return path.split('.').filter(Boolean).reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), obj);
}

function itemToRecord(item, mode) {
  const rec = {};
  if (mode === 'sharepoint_fields') {
    for (const f of (item && item.Fields) || []) if (f && f.InternalName && f.Value != null && f.Value !== '') rec[f.InternalName] = String(f.Value);
    return rec;
  }
  if (item && typeof item === 'object') for (const [k, v] of Object.entries(item)) { if (v == null || v === '') continue; rec[k] = typeof v === 'object' ? JSON.stringify(v) : String(v); }
  return rec;
}

const stripHtml = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

function renderJsonItems(items, cfg) {
  const max = cfg.max_items ?? 300;
  const fields = cfg.fields && cfg.fields.length ? cfg.fields : null;
  const labels = cfg.labels || {};
  const blocks = [];
  for (const item of items.slice(0, max)) {
    const rec = itemToRecord(item, cfg.fields_mode || 'object');
    const keys = fields ? fields.filter((k) => rec[k] != null) : Object.keys(rec);
    const lines = keys.map((k) => `${labels[k] || k}: ${stripHtml(rec[k]).slice(0, 600)}`);
    if (cfg.item_url && rec[cfg.item_url.field]) lines.push(`קישור: ${cfg.item_url.template.replace('{value}', encodeURIComponent(rec[cfg.item_url.field]))}`);
    if (lines.length) blocks.push(lines.join('\n'));
  }
  return blocks.join('\n---\n');
}

async function fetchJsonApiText(cfg, seedUrl) {
  const url = cfg.url || seedUrl;
  const method = cfg.method || 'GET';
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'he-IL,he;q=0.9', ...(cfg.headers || {}),
  };
  const body = method === 'POST' ? JSON.stringify(fillDateTemplates(cfg.body ?? {})) : undefined;
  if (method === 'POST' && !headers['Content-Type']) headers['Content-Type'] = 'application/json; charset=utf-8';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeout_ms ?? 30000);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    const json = await res.json();
    const items = getPath(json, cfg.items_path);
    if (!Array.isArray(items)) return { ok: false, error: `items_path "${cfg.items_path || ''}" did not resolve to an array` };
    return { ok: true, text: renderJsonItems(items, cfg), count: items.length };
  } catch (e) { return { ok: false, error: e.message || String(e) }; } finally { clearTimeout(timer); }
}

module.exports = { fillDateTemplates, getPath, renderJsonItems, fetchJsonApiText };
