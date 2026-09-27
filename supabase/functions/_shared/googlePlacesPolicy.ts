// TuRu - GOOGLE PLACES PERSISTENCE POLICY, Deno twin (release safety, 2026-09-27). Rule, rationale and the other twins:
// tools/import-tool/lib/googlePlacesPolicy.js (Node) and tools/playground-discovery/google_policy.py (Python), all
// pinned by googlePlacesPolicy.cases.json.
//
// TURU may store a google_place_id. It must not create new persistent Places-returned content (name, formatted
// address, derived city, Places coordinates, googleMapsUri, primaryType/types, websiteUri, photo metadata).
// The switch is a CODE constant, deliberately separate from the operational automation_settings toggles
// (settlement_scan_enabled): a settings row can be re-enabled by accident, this cannot without a code change + deploy.

export const GOOGLE_PLACES_CONTENT_PERSISTENCE = false;
export const POLICY_REASON = 'google_places_persistence_disabled';

const URL_RE = /^(?:([a-z][a-z0-9+.-]*):)?\/\/(?:[^/?#@]*@)?([^/?#:]+)(?::\d+)?([^?#]*)/i;
function parseUrl(url: unknown): { host: string; path: string } | null {
  if (typeof url !== 'string') return null;
  const m = URL_RE.exec(url.trim());
  if (!m) return null;
  return { host: m[2].toLowerCase().replace(/\.$/, ''), path: m[3] || '/' };
}

const GOOGLE_DOMAIN = 'google\\.(?:com|com\\.[a-z]{2}|co\\.[a-z]{2}|[a-z]{2})';
const MAPS_HOST_RE = new RegExp(`^maps\\.${GOOGLE_DOMAIN}$`);
const GOOGLE_HOST_RE = new RegExp(`^(?:www\\.)?${GOOGLE_DOMAIN}$`);

// A Google Maps web page / place link - never the Places API hosts
export function isGoogleMapsUrl(url: unknown): boolean {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  const { host, path } = parsed;
  if (MAPS_HOST_RE.test(host)) return true;
  if (GOOGLE_HOST_RE.test(host)) return path === '/maps' || path.startsWith('/maps/');
  if (host === 'maps.app.goo.gl') return true;
  if (host === 'goo.gl') return path === '/maps' || path.startsWith('/maps/');
  return false;
}

// Places-origin incoming by explicit provenance: a Maps page_url, a google_maps_uri, or the Places-writer PAIR
// formatted_address + place_kind. A generic key alone (lat/lon/lng, a lone formatted_address or place_kind,
// google_place_id) never counts - independent OSM / GIS / municipal rows carry those.
export const PLACES_EXPLICIT_KEYS = ['google_maps_uri'];
export const PLACES_SIGNATURE_KEYS = ['formatted_address', 'place_kind'];
export function isPlacesOriginCandidate(extractedData: unknown, pageUrl: unknown = null): boolean {
  if (isGoogleMapsUrl(pageUrl)) return true;
  if (!extractedData || typeof extractedData !== 'object') return false;
  const ed = extractedData as Record<string, unknown>;
  return PLACES_EXPLICIT_KEYS.some((k) => ed[k] !== undefined) || PLACES_SIGNATURE_KEYS.every((k) => ed[k] !== undefined);
}

// scan-settlement-gaps' single run decision. The release policy is checked FIRST and independently of the operational
// settlement_scan_enabled flag: operational ON + policy OFF -> no Places call and no write of any kind.
export type SettlementScanGate = { run: true } | { run: false; skipped: string };
export function settlementScanGate(settings: Record<string, unknown>, persistence: boolean = GOOGLE_PLACES_CONTENT_PERSISTENCE): SettlementScanGate {
  if (!persistence) return { run: false, skipped: POLICY_REASON };
  if (settings.settlement_scan_enabled === false) return { run: false, skipped: 'disabled' };
  return { run: true };
}
