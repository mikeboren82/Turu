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

// PERMANENT GOOGLE-ORIGIN MARKER (supabase/0115): activities/locations.content_origin = 'google_places_legacy' -
// historical, sticky (DB trigger), set only by the frozen backfill; never inferred from google_place_id, coordinates,
// title, category, proximity or the current source_url. Rule + rationale: the Node twin.
export const GOOGLE_CONTENT_ORIGIN = 'google_places_legacy';
const GOOGLE_PLACE_URN_RE = /^urn:google-place(?:-cid-removed)?:\S+$/i;
// side-table replacement for a Maps page_url (scrub phases P10/P11)
export function isGooglePlaceUrn(url: unknown): boolean {
  return typeof url === 'string' && GOOGLE_PLACE_URN_RE.test(url.trim());
}

type OriginRow = Record<string, unknown> | null | undefined;
export function hasGoogleContentOrigin(row: OriginRow): boolean {
  return !!row && (row.content_origin ?? row.contentOrigin ?? null) === GOOGLE_CONTENT_ORIGIN;
}

// marker OR (migration window) a Maps source_url / place URN - never google_place_id
export function isGoogleOriginActivity(row: OriginRow): boolean {
  if (!row) return false;
  const sourceUrl = row.source_url ?? row.sourceUrl ?? null;
  return hasGoogleContentOrigin(row) || isGoogleMapsUrl(sourceUrl) || isGooglePlaceUrn(sourceUrl);
}

// its own marker, OR (before the location backfill) an embedded Google-origin activity; an orphan only by its marker
export function isGoogleOriginLocation(loc: OriginRow): boolean {
  if (!loc) return false;
  if (hasGoogleContentOrigin(loc)) return true;
  return Array.isArray(loc.activities) && (loc.activities as OriginRow[]).some(isGoogleOriginActivity);
}
export const LOCATION_ORIGIN_SELECT = 'content_origin, activities(source_url, content_origin)';
// name/venue-based location reuse: the first non-Google-origin candidate, else null (Node twin has the rationale)
export function pickReusableLocation<T extends OriginRow>(rows: T[] | T | null | undefined): T | null {
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  return list.find((l) => !!l && !isGoogleOriginLocation(l)) ?? null;
}

// Places-origin incoming by explicit provenance: a Maps page_url (or its place URN), a google_maps_uri, or the
// Places-writer PAIR formatted_address + place_kind. A generic key alone (lat/lon/lng, a lone formatted_address or
// place_kind, google_place_id) never counts - independent OSM / GIS / municipal rows carry those.
export const PLACES_EXPLICIT_KEYS = ['google_maps_uri'];
export const PLACES_SIGNATURE_KEYS = ['formatted_address', 'place_kind'];
export function isPlacesOriginCandidate(extractedData: unknown, pageUrl: unknown = null): boolean {
  if (isGoogleMapsUrl(pageUrl) || isGooglePlaceUrn(pageUrl)) return true;
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
