// Source adapters that produce PAGE TEXT for the standard extraction pipeline from something that is
// not a server-rendered HTML page. Adding an adapter = configuration on `sources.adapter_config`
// (migration 0082), never a bespoke scraper: the text produced here goes through the same
// AI extraction, sanitize, child-relevance, venue resolution, dedup and provenance as any HTML page.
//
// json_api (2026-09-13, Phase 2 pass 1): municipal sites whose event listing is rendered client-side
// from a JSON service (first: Tel Aviv-Yafo SharePoint TlvListUtils.svc/getEventsList - one POST
// returns ~150 events with title/dates/location/summary/price).

export type JsonApiConfig = {
  url?: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  items_path?: string;
  fields_mode?: 'sharepoint_fields' | 'object';
  fields?: string[];
  labels?: Record<string, string>;
  item_url?: { field: string; template: string };
  max_items?: number;
  timeout_ms?: number;
};

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

// {{today}} / {{today+N}} / {{today-N}} inside string values (request bodies need a date window)
export function fillDateTemplates(value: unknown, now = new Date()): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{today([+-]\d+)?\}\}/g, (_m, off) => isoDate(new Date(now.getTime() + Number(off || 0) * 86400000)));
  }
  if (Array.isArray(value)) return value.map((v) => fillDateTemplates(v, now));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, fillDateTemplates(v, now)]));
  return value;
}

export function getPath(obj: unknown, path: string | undefined): unknown {
  if (!path) return obj;
  return path.split('.').filter(Boolean).reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), obj);
}

function itemToRecord(item: unknown, mode: JsonApiConfig['fields_mode']): Record<string, string> {
  const rec: Record<string, string> = {};
  if (mode === 'sharepoint_fields') {
    const fields = (item as { Fields?: { InternalName: string; Value: unknown }[] })?.Fields || [];
    for (const f of fields) if (f && f.InternalName && f.Value != null && f.Value !== '') rec[f.InternalName] = String(f.Value);
    return rec;
  }
  if (item && typeof item === 'object') {
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      if (v == null || v === '') continue;
      rec[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
  }
  return rec;
}

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

// Render items as labelled lines - the extraction model reads this exactly like page text.
export function renderJsonItems(items: unknown[], cfg: JsonApiConfig): string {
  const max = cfg.max_items ?? 300;
  const fields = cfg.fields && cfg.fields.length ? cfg.fields : null;
  const labels = cfg.labels || {};
  const blocks: string[] = [];
  for (const item of items.slice(0, max)) {
    const rec = itemToRecord(item, cfg.fields_mode || 'object');
    const keys = fields ? fields.filter((k) => rec[k] != null) : Object.keys(rec);
    const lines = keys.map((k) => `${labels[k] || k}: ${stripHtml(rec[k]).slice(0, 600)}`);
    if (cfg.item_url && rec[cfg.item_url.field]) lines.push(`קישור: ${cfg.item_url.template.replace('{value}', encodeURIComponent(rec[cfg.item_url.field]))}`);
    if (lines.length) blocks.push(lines.join('\n'));
  }
  return blocks.join('\n---\n');
}

export async function fetchJsonApiText(cfg: JsonApiConfig, seedUrl: string): Promise<{ ok: true; text: string; count: number } | { ok: false; error: string; status?: number }> {
  const url = cfg.url || seedUrl;
  const method = cfg.method || 'GET';
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'he-IL,he;q=0.9',
    ...(cfg.headers || {}),
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
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
