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

// Google-origin ACTIVITY: its stored source_url is a Google Maps URL (the 2026-09-27 inventory marker). Never keyed on
// google_place_id - 215 independent OSM/other rows only received a place id later.
function isGoogleOriginActivity(row) {
  return !!row && isGoogleMapsUrl(row.source_url ?? row.sourceUrl ?? null);
}

// Places-origin INCOMING candidate: its substantive facts are a Places response. Every Places writer (scan-settlement-
// gaps, playground_discovery.py, the Cleaner settlement NEW_VALID path) stores formatted_address / lon / place_kind /
// google_maps_uri and a Maps page_url; the page-extraction shape never uses these keys. A google_place_id alone never
// makes a row Places-origin.
const PLACES_ORIGIN_KEYS = ['formatted_address', 'lon', 'place_kind', 'google_maps_uri'];
function isPlacesOriginCandidate(extractedData, pageUrl = null) {
  if (isGoogleMapsUrl(pageUrl)) return true;
  const ed = extractedData;
  if (!ed || typeof ed !== 'object') return false;
  return PLACES_ORIGIN_KEYS.some((k) => ed[k] !== undefined);
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
// by its Maps source_url. -> null (process normally) | { reason, subject }
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
  GOOGLE_PLACES_CONTENT_PERSISTENCE, POLICY_REASON, PLACES_ORIGIN_KEYS,
  isGoogleMapsUrl, isRawGooglePlacesPhotoUrl, isGoogleOriginActivity, isPlacesOriginCandidate, placesPersistenceReason, cleanerPolicyHold,
  GooglePlacesPersistenceError, assertNotGoogleMapsUrl,
};
