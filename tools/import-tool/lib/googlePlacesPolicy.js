// TuRu - GOOGLE PLACES PERSISTENCE POLICY (release safety, 2026-09-27). What TURU may STORE from Google Places:
//   allowed      google_place_id - including attaching it to an independently sourced row after a transient match
//   not allowed  any other Places-returned value as new TURU data: name (displayName), formatted address, a city
//                derived from it, Places coordinates, the googleMapsUri, primaryType / types, websiteUri, photo metadata
// NEW GOOGLE-ORIGIN CONTENT PERSISTENCE = OFF. That is NOT "google_place_id usage = off": reading a Places response
// transiently (routing, gating, matching) and storing only the id stays allowed.
// The switch is a code constant on purpose: an automation_settings row can be flipped back on, a release policy cannot.
// Existing rows are untouched here (cleanup is a separate task).
//
// Twins, pinned by one shared case table (supabase/functions/_shared/googlePlacesPolicy.cases.json):
//   Deno    supabase/functions/_shared/googlePlacesPolicy.ts   (scan-settlement-gaps, scan-source page fetch)
//   Python  tools/playground-discovery/google_policy.py         (discovery / gap fill / enrich_images)
// isGoogleMapsUrl is also the same rule as the public client's lib/googleContent.js (interim suppression).

const GOOGLE_PLACES_CONTENT_PERSISTENCE = false;
const POLICY_REASON = 'google_places_persistence_disabled';

// scheme://[user@]host[:port]path - a regex, not new URL(), so the three twins parse identically
const URL_RE = /^(?:([a-z][a-z0-9+.-]*):)?\/\/(?:[^/?#@]*@)?([^/?#:]+)(?::\d+)?([^?#]*)/i;
function parseUrl(url) {
  if (typeof url !== 'string') return null;
  const m = URL_RE.exec(url.trim());
  if (!m) return null;
  return { host: m[2].toLowerCase().replace(/\.$/, ''), path: m[3] || '/' };
}

// google.com / google.co.il / google.com.au ... (a closed TLD shape, so google.com.evil.io fails)
const GOOGLE_DOMAIN = 'google\\.(?:com|com\\.[a-z]{2}|co\\.[a-z]{2}|[a-z]{2})';
const MAPS_HOST_RE = new RegExp(`^maps\\.${GOOGLE_DOMAIN}$`);
const GOOGLE_HOST_RE = new RegExp(`^(?:www\\.)?${GOOGLE_DOMAIN}$`);

// A Google Maps WEB PAGE / place link (googleMapsUri, maps.google.com/?cid=, google.com/maps/..., maps.app.goo.gl).
// Not the Places API hosts (places.googleapis.com, maps.googleapis.com) - those are API calls, never a "page".
function isGoogleMapsUrl(url) {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  const { host, path } = parsed;
  if (MAPS_HOST_RE.test(host)) return true;
  if (GOOGLE_HOST_RE.test(host)) return path === '/maps' || path.startsWith('/maps/');
  if (host === 'maps.app.goo.gl') return true;
  if (host === 'goo.gl') return path === '/maps' || path.startsWith('/maps/');
  return false;
}

// A raw Google Places PHOTO url (host AND path prove it): lh*.googleusercontent.com/place-photos/..., the Places API
// (New) media endpoint, the legacy place/photo endpoint. The TURU proxy (/functions/v1/place-photo/<id>) is not raw.
function isRawGooglePlacesPhotoUrl(url) {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  const { host, path } = parsed;
  if (/^lh\d*\.googleusercontent\.com$/.test(host)) return path.startsWith('/place-photos/');
  if (host === 'places.googleapis.com') return /^\/v1\/places\/[^/]+\/photos\/[^/]+\/media\b/.test(path);
  if (host === 'maps.googleapis.com') return path.startsWith('/maps/api/place/photo');
  return false;
}

// PERMANENT GOOGLE-ORIGIN MARKER (supabase/0115, 2026-09-27). activities.content_origin / locations.content_origin =
// 'google_places_legacy' says "this row was CREATED from Google Places-derived catalogue facts". It is historical and
// sticky (a DB trigger refuses to clear or change it): re-sourcing, merging or scrubbing the row's fields never removes
// it, so the row stays visible to every guard after its Maps source_url is nulled. It is set only by the frozen
// backfill (google-origin-backfill.js) - no writer sets it, and it is never inferred from google_place_id, coordinates,
// title, category, proximity or the current source_url.
const GOOGLE_CONTENT_ORIGIN = 'google_places_legacy';
// Side-table replacement for a Maps page_url (activity_sources / incoming_activities, scrub phases P10/P11): the URN
// keeps the storable place id and the origin, without the Maps link.
const GOOGLE_PLACE_URN_RE = /^urn:google-place(?:-cid-removed)?:\S+$/i;
function isGooglePlaceUrn(url) {
  return typeof url === 'string' && GOOGLE_PLACE_URN_RE.test(url.trim());
}

function hasGoogleContentOrigin(row) {
  return !!row && (row.content_origin ?? row.contentOrigin ?? null) === GOOGLE_CONTENT_ORIGIN;
}

// Google-origin ACTIVITY = the permanent marker, OR (migration window, until every legacy row is marked and the scrub
// has run) a Google Maps source_url / Google place URN. Never keyed on google_place_id - 216 independent OSM/other rows
// only received a place id later. The same answer before the backfill (Maps URL), after it (both) and after the
// source_url scrub (marker).
function isGoogleOriginActivity(row) {
  if (!row) return false;
  const sourceUrl = row.source_url ?? row.sourceUrl ?? null;
  return hasGoogleContentOrigin(row) || isGoogleMapsUrl(sourceUrl) || isGooglePlaceUrn(sourceUrl);
}

// Google-origin LOCATION: its own marker, OR (before the location backfill) any embedded activity using it is
// Google-origin - `locations(..., content_origin, activities(source_url, content_origin))`. An orphan location (no
// activity) is only recognisable by its marker. Proximity or a matching name never counts.
function isGoogleOriginLocation(loc) {
  if (!loc) return false;
  if (hasGoogleContentOrigin(loc)) return true;
  return Array.isArray(loc.activities) && loc.activities.some(isGoogleOriginActivity);
}
// the select fragment a location-reuse lookup needs for isGoogleOriginLocation
const LOCATION_ORIGIN_SELECT = 'content_origin, activities(source_url, content_origin)';
// Name/venue-based location REUSE (server.js requireVerifiedLocation, scan-source, the Cleaner's locationResolver):
// the first candidate that is not Google-origin, else null (the caller creates / geocodes its own row). A Google-origin
// location - orphan or not - is never adopted by an independent activity on a name match: its coordinates / address /
// city are Places content. Its identity would have to be proven by an explicit, provenance-aware path (the OSM rescue
// ledger), never by a name or a distance.
function pickReusableLocation(rows) {
  return (Array.isArray(rows) ? rows : rows ? [rows] : []).find((l) => l && !isGoogleOriginLocation(l)) || null;
}

// Places-origin INCOMING candidate: its substantive facts are a Places response - decided by explicit provenance, never
// by a generic field. Every Places writer (scan-settlement-gaps, playground_discovery.py, the Cleaner settlement
// NEW_VALID path) stores a Google Maps page_url (defaulting to https://www.google.com/maps): that is the rule. The key
// backstop is only a Google-named key (google_maps_uri) or the Places-writer PAIR formatted_address + place_kind.
// Never on its own: lat / lon / lng / latitude / longitude / geometry (OSM, Nominatim, ArcGIS, GovMap and municipal GIS
// all emit them), a lone formatted_address or place_kind, or a google_place_id (independent rows legitimately get one).
// Production replay 2026-09-27: 694 classified rows, every one by its Maps page_url; `lon` was never the only signal.
const PLACES_EXPLICIT_KEYS = ['google_maps_uri'];
const PLACES_SIGNATURE_KEYS = ['formatted_address', 'place_kind'];
const PLACES_ORIGIN_KEYS = [...PLACES_EXPLICIT_KEYS, ...PLACES_SIGNATURE_KEYS]; // every key the rule reads
function isPlacesOriginCandidate(extractedData, pageUrl = null) {
  if (isGoogleMapsUrl(pageUrl) || isGooglePlaceUrn(pageUrl)) return true;
  const ed = extractedData;
  if (!ed || typeof ed !== 'object') return false;
  return PLACES_EXPLICIT_KEYS.some((k) => ed[k] !== undefined) || PLACES_SIGNATURE_KEYS.every((k) => ed[k] !== undefined);
}

// the publish-policy reason (lib/incomingEligibility.js): terminal and not human-overridable while the policy is OFF.
// Terminal here means "never published under this release", not "bad content" - nothing archives or rejects on it.
function placesPersistenceReason(extractedData, pageUrl = null) {
  if (GOOGLE_PLACES_CONTENT_PERSISTENCE) return null;
  if (!isPlacesOriginCandidate(extractedData, pageUrl)) return null;
  return { code: POLICY_REASON, severity: 'terminal', humanOverridable: false, detail: { rule: 'google_places_release_policy_2026_09_27' } };
}

// The Cleaner's hold rule (pure): which case subjects are Places-derived work it must not process while the policy is
// OFF. A settlement_review case is by construction a Places candidate; an incoming row by its shape; a live activity
// by isGoogleOriginActivity (marker or Maps source_url). -> null (process normally) | { reason, subject }
function cleanerPolicyHold({ subjectKind, incoming = null, activity = null } = {}) {
  if (GOOGLE_PLACES_CONTENT_PERSISTENCE) return null;
  if (subjectKind === 'settlement_review') return { reason: POLICY_REASON, subject: 'settlement_scan_candidate' };
  if (subjectKind === 'incoming' && incoming && isPlacesOriginCandidate(incoming.extracted_data, incoming.page_url)) return { reason: POLICY_REASON, subject: 'places_origin_incoming' };
  if (activity && isGoogleOriginActivity(activity)) return { reason: POLICY_REASON, subject: 'google_origin_activity' };
  return null;
}

class GooglePlacesPersistenceError extends Error {
  constructor(what) {
    super(`${POLICY_REASON}: ${what}`);
    this.code = 'GOOGLE_PLACES_PERSISTENCE_DISABLED';
  }
}

// write-boundary backstop: a Google Maps URL never becomes a stored source / provenance / image-source URL
function assertNotGoogleMapsUrl(url, where) {
  if (!GOOGLE_PLACES_CONTENT_PERSISTENCE && isGoogleMapsUrl(url)) throw new GooglePlacesPersistenceError(`${where} must not store a Google Maps URL`);
}

module.exports = {
  GOOGLE_PLACES_CONTENT_PERSISTENCE, POLICY_REASON, PLACES_ORIGIN_KEYS, GOOGLE_CONTENT_ORIGIN, LOCATION_ORIGIN_SELECT,
  isGoogleMapsUrl, isGooglePlaceUrn, isRawGooglePlacesPhotoUrl, hasGoogleContentOrigin, isGoogleOriginActivity, isGoogleOriginLocation, pickReusableLocation,
  isPlacesOriginCandidate, placesPersistenceReason, cleanerPolicyHold,
  GooglePlacesPersistenceError, assertNotGoogleMapsUrl,
};
