// Interim Google Places content suppression (2026-09-27). This is a release-safety gate until live
// Places attribution exists. It is pure: no imports and no network. It is also reversible, because
// nothing in the DB changes; the public client just treats these URLs and rows as unavailable.
//
//   1. Google Places photos (the TURU place-photo proxy, or a raw Places photo URL) are treated as
//      "no image" on every public surface. A Places photo cannot be shown without live attribution.
//   2. Google-origin activities get no pin on our non-Google maps (web = Leaflet/OSM,
//      iOS = Apple MapKit). Places content must not be displayed on a non-Google map.
//
// "Google-origin" is keyed on the stored source_url being a Google Maps URL. It is NOT keyed on
// google_place_id: 215 approved OSM/other rows only received a place_id later from a backfill, and
// their data is independent (see the 2026-09-27 compliance inventory).
//
// URLs are parsed with a regex rather than `new URL()`. React Native's URL polyfill does not
// implement hostname/pathname on every runtime this app ships to.

const URL_RE = /^(?:([a-z][a-z0-9+.-]*):)?\/\/(?:[^/?#@]*@)?([^/?#:]+)(?::\d+)?([^?#]*)/i;

function parseUrl(url) {
  if (typeof url !== 'string') return null;
  const m = URL_RE.exec(url.trim());
  if (!m) return null;
  return { host: m[2].toLowerCase().replace(/\.$/, ''), path: m[3] || '/' };
}

function pathOf(url) {
  if (typeof url !== 'string') return null;
  const parsed = parseUrl(url);
  if (parsed) return parsed.path;
  // Host-less relative form ("/functions/v1/place-photo/<id>").
  const trimmed = url.trim();
  return trimmed.startsWith('/') ? trimmed.split(/[?#]/)[0] : null;
}

// The sanctioned TURU proxy (supabase/functions/place-photo): /functions/v1/place-photo/<id>.
const PROXY_PATH_RE = /\/functions\/v1\/place-photo\/[^/]+\/?$/;

export function isPlacesPhotoProxyUrl(url) {
  const path = pathOf(url);
  return !!path && PROXY_PATH_RE.test(path);
}

// Raw Google Places photo URLs, matched only where the host AND path prove it is a Places photo.
// A bare googleusercontent.com or googleapis.com host is not enough (for example,
// storage.googleapis.com/<bucket>/... is ordinary hosting).
//   - lh3.googleusercontent.com/place-photos/...   Places API (New) photo media redirect target
//   - places.googleapis.com/v1/places/<id>/photos/<ref>/media   Places API (New) media endpoint
//   - maps.googleapis.com/maps/api/place/photo     legacy Places photo endpoint
export function isRawGooglePlacesPhotoUrl(url) {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  const { host, path } = parsed;
  if (/^lh\d*\.googleusercontent\.com$/.test(host)) return path.startsWith('/place-photos/');
  if (host === 'places.googleapis.com') return /^\/v1\/places\/[^/]+\/photos\/[^/]+\/media\b/.test(path);
  if (host === 'maps.googleapis.com') return path.startsWith('/maps/api/place/photo');
  return false;
}

export function isGooglePlacesPhotoUrl(url) {
  return isPlacesPhotoProxyUrl(url) || isRawGooglePlacesPhotoUrl(url);
}

// The URL itself, or null when it is empty or a Google Places photo.
export function publicImageUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  return isGooglePlacesPhotoUrl(url) ? null : url;
}

// Public image list from activity_images-shaped input ([{url}] rows or plain strings). Keeps the
// original order and drops empty entries and Google Places photos. A new array is returned; the
// input is never mutated.
export function publicImageUrls(images) {
  if (!Array.isArray(images)) return [];
  const out = [];
  for (const img of images) {
    const url = publicImageUrl(typeof img === 'string' ? img : img?.url);
    if (url) out.push(url);
  }
  return out;
}

export function firstPublicImageUrl(images) {
  return publicImageUrls(images)[0] || null;
}

// google.com / google.co.il / google.com.au ... (a closed TLD shape, so google.com.evil.io fails).
const GOOGLE_DOMAIN = 'google\\.(?:com|com\\.[a-z]{2}|co\\.[a-z]{2}|[a-z]{2})';
const MAPS_HOST_RE = new RegExp(`^maps\\.${GOOGLE_DOMAIN}$`);
const GOOGLE_HOST_RE = new RegExp(`^(?:www\\.)?${GOOGLE_DOMAIN}$`);

export function isGoogleMapsUrl(url) {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  const { host, path } = parsed;
  if (MAPS_HOST_RE.test(host)) return true;
  if (GOOGLE_HOST_RE.test(host)) return path === '/maps' || path.startsWith('/maps/');
  if (host === 'maps.app.goo.gl') return true;
  if (host === 'goo.gl') return path === '/maps' || path.startsWith('/maps/');
  return false;
}

// Google-origin marker for the interim gate. It accepts a mapped activity (sourceUrl) or a raw
// row (source_url), and it deliberately ignores google_place_id.
export function isGoogleOriginActivity(activity) {
  if (!activity) return false;
  return isGoogleMapsUrl(activity.sourceUrl ?? activity.source_url ?? null);
}

// Pins for our non-Google maps (components/ActivitiesMap*.js): rows that have coordinates and are
// not Google-origin. Independent rows that merely carry a google_place_id stay.
export function activitiesForNonGoogleMap(activities) {
  if (!Array.isArray(activities)) return [];
  return activities.filter((a) => a && a.lat != null && a.lng != null && !isGoogleOriginActivity(a));
}
