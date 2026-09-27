// TuRu - the place-photo Edge Function's request handler (supabase/functions/place-photo), kept free of npm/Deno.serve
// imports so every guard is unit-testable offline with the Google fetch and the database mocked.
//
// Google Maps Platform terms allow storing a place_id indefinitely but NOT a photo, its `photos[].name`, its photo
// URI or its author attributions. So nothing Google returns is persisted here: every request re-resolves the place's
// *current* first photo live, and the only cached state (in this isolate's memory, bounded, short-lived) is TURU's
// own data - "is this place_id on an approved activity?" and the serving kill flag - plus per-IP request counters.
//
// Request pipeline - Google is contacted only after EVERY guard passes (2026-09-27 hardening):
//   1. method       GET (OPTIONS = CORS preflight)                                        else 405
//   2. place id     last path segment matches PLACE_ID_RE                                 else 400 invalid_place_id
//   3. format       absent (302 redirect, the historical contract) or `format=json`       else 400 unsupported_format
//   4. rate limit   best-effort per-IP token bucket, in-isolate                           else 429 rate_limited
//   5. kill flag    automation_settings.place_photo_serving_enabled - explicit false      => 503 service_disabled
//                   (absent / true / anything else => serve, so a missing row never bricks deployed clients)
//   6. allow-list   the place_id is on at least one activities row with status='approved' else 404 place_not_listed
//                   (archived / rejected / pending activities, incoming rows, scan candidates and image rows never
//                   count - the allow-list is the approved catalogue only)
//   7. Google       Place Details (field mask `photos`) -> first photo -> media with skipHttpRedirect=true
//
// Modes:
//   GET .../place-photo/<place_id>[?maxwidth=N]              302 to Google's photo URI (existing <img src> clients)
//   GET .../place-photo/<place_id>?format=json[&maxwidth=N]  live JSON for a future attributed-image client:
//     { photoUri, widthPx, heightPx, authorAttributions: [{ displayName, uri, photoUri }], photoGoogleMapsUri,
//       placeGoogleMapsUrl }
//     widthPx/heightPx are the source photo's dimensions (aspect ratio); placeGoogleMapsUrl is derived locally from the
//     place_id, never taken from Google; a photo without authorAttributions yields [] (attribution is never invented).
//
// Rate-limit limitation: the buckets live in ONE isolate's memory. Supabase runs several isolates and recycles them,
// so the effective ceiling is (limit x live isolates) and it resets on cold start. It deters trivial hammering only;
// the hard spend limit is the Google Cloud quota on the key (see the owner checklist in the 2026-09-27 report).

export const PLACE_ID_RE = /^[A-Za-z0-9_-]{20,300}$/;
export const PLACES_BASE_URL = 'https://places.googleapis.com/v1';
export const SERVING_FLAG_KEY = 'place_photo_serving_enabled';
const DEFAULT_MAX_WIDTH_PX = 1200;
const UPSTREAM_TIMEOUT_MS = 8000;

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Max-Age': '86400',
};
// Every response - redirect, JSON or error - is no-store: a Google photo URI / attribution must not be cached by us,
// by a shared proxy, or by the browser beyond the single page view.
const BASE_HEADERS: Record<string, string> = { ...CORS_HEADERS, 'Cache-Control': 'no-store' };

export type ErrorCode =
  | 'method_not_allowed' | 'invalid_place_id' | 'unsupported_format' | 'rate_limited' | 'service_disabled'
  | 'service_unavailable' | 'place_not_listed' | 'no_photo' | 'upstream_error' | 'upstream_quota' | 'misconfigured';

// The client-visible error contract: fixed codes, no upstream bodies, no secrets.
function errorResponse(status: number, error: ErrorCode, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

// ---------------------------------------------------------------- place id

// The place id is the single path segment after `place-photo` (a trailing slash is tolerated, as before). The raw,
// still percent-encoded segment is validated, so a space / slash / control character / query delimiter arrives as
// `%..` or splits the path and is rejected - never decoded into something that reaches Google.
export function extractPlaceId(pathname: string): string | null {
  const segs = pathname.split('/');
  const at = segs.lastIndexOf('place-photo');
  const rest = (at >= 0 ? segs.slice(at + 1) : segs.slice(-1)).filter((s) => s !== '');
  return rest.length === 1 ? rest[0] : null;
}

export function isValidPlaceId(id: unknown): id is string {
  return typeof id === 'string' && PLACE_ID_RE.test(id);
}

// Derived locally from the (validated, URL-safe) place id - never a Google-returned value.
export function placeGoogleMapsUrl(placeId: string): string {
  return `https://www.google.com/maps/place/?q=place_id:${placeId}`;
}

// ---------------------------------------------------------------- bounded TTL memo (allow-list, kill flag)

export class BoundedTtlCache<V> {
  #map = new Map<string, { value: V; expiresAt: number }>();
  constructor(readonly maxEntries: number) {}
  get(key: string, now: number): V | undefined {
    const hit = this.#map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= now) { this.#map.delete(key); return undefined; }
    return hit.value;
  }
  set(key: string, value: V, ttlMs: number, now: number): void {
    this.#map.delete(key);
    if (this.#map.size >= this.maxEntries) {
      // drop expired entries first, then the oldest insertion (Map keeps insertion order)
      for (const [k, v] of this.#map) if (v.expiresAt <= now) this.#map.delete(k);
      while (this.#map.size >= this.maxEntries) this.#map.delete(this.#map.keys().next().value as string);
    }
    this.#map.set(key, { value, expiresAt: now + ttlMs });
  }
  get size(): number { return this.#map.size; }
}

// ---------------------------------------------------------------- rate limit

export interface RateLimitOptions { capacity: number; refillPerSec: number; maxKeys: number }
// A page of activity cards loads a burst of images at once; 60 then 1/s is far above one person scrolling and far
// below scripted hammering. Overridable for tests.
export const DEFAULT_RATE_LIMIT: RateLimitOptions = { capacity: 60, refillPerSec: 1, maxKeys: 5000 };

// Classic token bucket per key. A bucket idle long enough to be full again is indistinguishable from a new one, so
// it expires then (capacity / refill seconds); the map is capped at maxKeys (expired first, then oldest).
export class TokenBucketLimiter {
  #buckets = new Map<string, { tokens: number; at: number }>();
  constructor(readonly opts: RateLimitOptions) {}
  take(key: string, now: number): { ok: boolean; retryAfterSec: number } {
    const { capacity, refillPerSec, maxKeys } = this.opts;
    const idleMs = (capacity / refillPerSec) * 1000;
    let b = this.#buckets.get(key);
    if (b) {
      this.#buckets.delete(key); // re-inserted below = most recently used
      b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSec);
      b.at = now;
    } else {
      if (this.#buckets.size >= maxKeys) {
        for (const [k, v] of this.#buckets) if (now - v.at >= idleMs) this.#buckets.delete(k);
        while (this.#buckets.size >= maxKeys) this.#buckets.delete(this.#buckets.keys().next().value as string);
      }
      b = { tokens: capacity, at: now };
    }
    this.#buckets.set(key, b);
    if (b.tokens >= 1) { b.tokens -= 1; return { ok: true, retryAfterSec: 0 }; }
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / refillPerSec)) };
  }
  get size(): number { return this.#buckets.size; }
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^[0-9a-f:.]{2,45}$/i;
function isPrivateOrReserved(ip: string): boolean {
  const m = IPV4_RE.exec(ip);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}
function isIp(s: string): boolean {
  const m = IPV4_RE.exec(s);
  if (m) return m.slice(1).every((o) => Number(o) <= 255);
  return s.includes(':') && IPV6_RE.test(s);
}

// The rate-limit key. X-Forwarded-For is a comma list the CLIENT can pre-seed: each proxy APPENDS the address it
// received the connection from, so everything left of the last trusted hop is attacker-controlled. We therefore walk
// the list from the RIGHT and take the first syntactically valid public address (internal hops are private/reserved
// and skipped); anything unparsable ends the walk. X-Real-IP (single value, set by the gateway) is the fallback, and
// with neither, all such requests share one 'unknown' bucket - which fails toward limiting, not toward bypass.
export function clientIpKey(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean).slice(-8);
    for (let i = parts.length - 1; i >= 0; i--) {
      if (!isIp(parts[i])) break;
      if (!isPrivateOrReserved(parts[i])) return parts[i];
    }
  }
  const real = headers.get('x-real-ip')?.trim();
  if (real && isIp(real)) return real;
  return 'unknown';
}

// ---------------------------------------------------------------- TURU database guards (read-only)

// Minimal duck type of the supabase-js query builder this module uses - SELECT only. The function holds no insert /
// update / upsert / delete / rpc path at all (tests run it against a recording client that would expose one).
// deno-lint-ignore no-explicit-any
export type SelectOnlyClient = { from(table: string): any };

export type Lookup<T> = { ok: true; value: T } | { ok: false };

export interface DbGuards {
  isApprovedPlaceId(placeId: string): Promise<Lookup<boolean>>;
  // null = no row (absent); otherwise the stored jsonb value
  readServingFlag(): Promise<Lookup<unknown>>;
}

export function supabaseDbGuards(getClient: () => SelectOnlyClient | null): DbGuards {
  return {
    async isApprovedPlaceId(placeId) {
      try {
        const client = getClient();
        if (!client) return { ok: false };
        const { data, error } = await client.from('activities').select('id')
          .eq('google_place_id', placeId).eq('status', 'approved').limit(1);
        if (error || !Array.isArray(data)) return { ok: false };
        return { ok: true, value: data.length > 0 };
      } catch {
        return { ok: false };
      }
    },
    async readServingFlag() {
      try {
        const client = getClient();
        if (!client) return { ok: false };
        const { data, error } = await client.from('automation_settings').select('value').eq('key', SERVING_FLAG_KEY).limit(1);
        if (error || !Array.isArray(data)) return { ok: false };
        return { ok: true, value: data.length ? data[0].value : null };
      } catch {
        return { ok: false };
      }
    },
  };
}

// Safe semantics: only an EXPLICIT false (jsonb false, or the string "false") stops serving. An absent row, true, or
// any other value serves - the flag is an emergency brake, and a missing/garbled row must not brick deployed clients.
export function servingDisabled(flagValue: unknown): boolean {
  return flagValue === false || (typeof flagValue === 'string' && flagValue.trim().toLowerCase() === 'false');
}

// ---------------------------------------------------------------- Google response shaping (live, never stored)

function httpsUrlOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  try { return new URL(v).protocol === 'https:' ? v : null; } catch { return null; }
}
function intOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}
export interface AuthorAttribution { displayName: string; uri: string | null; photoUri: string | null }
// Only entries Google actually returned with a display name; links only if https. Missing/garbled => [].
export function shapeAuthorAttributions(raw: unknown): AuthorAttribution[] {
  if (!Array.isArray(raw)) return [];
  const out: AuthorAttribution[] = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const name = (a as Record<string, unknown>).displayName;
    if (typeof name !== 'string' || !name.trim()) continue;
    out.push({ displayName: name, uri: httpsUrlOrNull((a as Record<string, unknown>).uri), photoUri: httpsUrlOrNull((a as Record<string, unknown>).photoUri) });
  }
  return out;
}

// ---------------------------------------------------------------- handler

export interface HandlerDeps {
  fetch: typeof fetch;                // Google only
  getApiKey: () => string | undefined;
  db: DbGuards;
  now?: () => number;
  log?: (msg: string) => void;        // fixed strings + status codes only - never a Google body, URL, error object or key
  rateLimit?: RateLimitOptions;
  allowTtlMs?: { positive: number; negative: number; maxEntries: number };
  flagTtlMs?: number;
}

export function createPlacePhotoHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((m: string) => console.error(m));
  const limiter = new TokenBucketLimiter(deps.rateLimit ?? DEFAULT_RATE_LIMIT);
  const allowTtl = deps.allowTtlMs ?? { positive: 5 * 60_000, negative: 60_000, maxEntries: 2000 };
  const allowMemo = new BoundedTtlCache<boolean>(allowTtl.maxEntries);
  const flagMemo = new BoundedTtlCache<boolean>(1);
  const flagTtl = deps.flagTtlMs ?? 30_000;

  async function isDisabled(): Promise<boolean | null> {
    const cached = flagMemo.get('flag', now());
    if (cached !== undefined) return cached;
    const r = await deps.db.readServingFlag();
    if (!r.ok) return null;
    const disabled = servingDisabled(r.value);
    flagMemo.set('flag', disabled, flagTtl, now());
    return disabled;
  }

  async function isListed(placeId: string): Promise<boolean | null> {
    const cached = allowMemo.get(placeId, now());
    if (cached !== undefined) return cached;
    const r = await deps.db.isApprovedPlaceId(placeId);
    if (!r.ok) return null;
    allowMemo.set(placeId, r.value, r.value ? allowTtl.positive : allowTtl.negative, now());
    return r.value;
  }

  // One Google GET. The key travels ONLY in the X-Goog-Api-Key request header - never in a URL - so it cannot surface
  // in a Location header, a fetch error message, or a log line.
  async function google(url: string, apiKey: string, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: unknown } | null> {
    try {
      const resp = await deps.fetch(url, {
        method: 'GET',
        headers: { 'X-Goog-Api-Key': apiKey, ...extraHeaders },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!resp.ok) { await resp.body?.cancel(); return { status: resp.status, body: null }; }
      return { status: resp.status, body: await resp.json() };
    } catch {
      return null; // network error / timeout / bad JSON - the error object is deliberately not logged (may carry the URL)
    }
  }
  const upstreamFail = (stage: string, r: { status: number } | null): Response => {
    log(`place-photo: upstream ${stage} failed (${r ? r.status : 'network'})`);
    return r && r.status === 429 ? errorResponse(503, 'upstream_quota', { 'Retry-After': '60' }) : errorResponse(502, 'upstream_error');
  };

  return async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: BASE_HEADERS });
    if (req.method !== 'GET') return errorResponse(405, 'method_not_allowed', { Allow: 'GET, OPTIONS' });

    const url = new URL(req.url);
    const placeId = extractPlaceId(url.pathname);
    if (!isValidPlaceId(placeId)) return errorResponse(400, 'invalid_place_id');
    const format = url.searchParams.get('format');
    if (format !== null && format !== 'json') return errorResponse(400, 'unsupported_format');
    const maxWidthPx = Math.min(1600, Math.max(100, Number(url.searchParams.get('maxwidth')) || DEFAULT_MAX_WIDTH_PX));

    const rl = limiter.take(clientIpKey(req.headers), now());
    if (!rl.ok) return errorResponse(429, 'rate_limited', { 'Retry-After': String(rl.retryAfterSec) });

    const disabled = await isDisabled();
    if (disabled === null) { log('place-photo: serving flag unreadable'); return errorResponse(503, 'service_unavailable'); }
    if (disabled) return errorResponse(503, 'service_disabled');

    const listed = await isListed(placeId);
    if (listed === null) { log('place-photo: allow-list lookup failed'); return errorResponse(503, 'service_unavailable'); }
    if (!listed) return errorResponse(404, 'place_not_listed');

    const apiKey = deps.getApiKey();
    if (!apiKey) { log('place-photo: GOOGLE_MAPS_API_KEY is not configured'); return errorResponse(500, 'misconfigured'); }

    // Step 1: the place's current photos - resolved fresh, never stored.
    const details = await google(`${PLACES_BASE_URL}/places/${placeId}`, apiKey, { 'X-Goog-FieldMask': 'photos' });
    if (!details || details.status >= 400 || !details.body || typeof details.body !== 'object') return upstreamFail('details', details);
    const photo = (details.body as { photos?: unknown }).photos;
    const first = Array.isArray(photo) && photo[0] && typeof photo[0] === 'object' ? photo[0] as Record<string, unknown> : null;
    const photoName = first?.name;
    if (typeof photoName !== 'string' || !/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(photoName)) {
      return errorResponse(404, 'no_photo');
    }

    // Step 2: Google's own CDN URI for that photo - we never fetch or store the bytes.
    const media = await google(`${PLACES_BASE_URL}/${photoName}/media?maxWidthPx=${maxWidthPx}&skipHttpRedirect=true`, apiKey);
    if (!media || media.status >= 400 || !media.body || typeof media.body !== 'object') return upstreamFail('media', media);
    const photoUri = httpsUrlOrNull((media.body as { photoUri?: unknown }).photoUri);
    // Defense in depth: never hand out a URI that embeds our own key.
    if (!photoUri || photoUri.includes(apiKey)) return upstreamFail('media-uri', { status: 502 });

    if (format === 'json') {
      const body = {
        photoUri,
        widthPx: intOrNull(first!.widthPx),
        heightPx: intOrNull(first!.heightPx),
        authorAttributions: shapeAuthorAttributions(first!.authorAttributions),
        photoGoogleMapsUri: httpsUrlOrNull(first!.googleMapsUri),
        placeGoogleMapsUrl: placeGoogleMapsUrl(placeId),
      };
      const text = JSON.stringify(body);
      if (text.includes(apiKey)) return upstreamFail('json-shape', { status: 502 });
      return new Response(text, { status: 200, headers: { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } });
    }
    return new Response(null, { status: 302, headers: { ...BASE_HEADERS, Location: photoUri } });
  };
}
