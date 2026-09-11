// TuRu - proxies a Google Places photo for a playground/park found via
// tools/playground-discovery. Google Maps Platform Terms permit storing a
// place_id indefinitely but NOT caching the photo itself or its `photos[].name`
// reference (see supabase/0055_activities_google_place_id.sql) - so
// activity_images.url points here instead of at a raw Google-hosted photo URL,
// and this function re-resolves the place's *current* photo live on every
// request rather than ever persisting one.
//
// URL shape: .../functions/v1/place-photo/<place_id>?maxwidth=1200
// (place_id is the last path segment, not a query param, so the stored
// activity_images.url is a plain stable link usable directly in <img src>.)

const PLACES_BASE_URL = 'https://places.googleapis.com/v1';
const DEFAULT_MAX_WIDTH_PX = 1200;

Deno.serve(async (req: Request) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const placeId = url.pathname.split('/').filter(Boolean).pop();
  if (!placeId) {
    return new Response('Missing place_id', { status: 400 });
  }
  const maxWidthPx = Math.min(1600, Math.max(100, Number(url.searchParams.get('maxwidth')) || DEFAULT_MAX_WIDTH_PX));

  const apiKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
  if (!apiKey) {
    console.error('GOOGLE_MAPS_API_KEY is not configured for place-photo');
    return new Response('Photo service misconfigured', { status: 500 });
  }

  try {
    // Step 1: look up the place's current photos - never stored, resolved fresh each call.
    const detailsResp = await fetch(`${PLACES_BASE_URL}/places/${encodeURIComponent(placeId)}`, {
      headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'photos' },
    });
    if (!detailsResp.ok) {
      return new Response('Place lookup failed', { status: 502 });
    }
    const details = await detailsResp.json();
    const photoName = details.photos?.[0]?.name;
    if (!photoName) {
      return new Response('No photo available', { status: 404 });
    }

    // Step 2: resolve that photo to Google's own CDN URL and redirect there -
    // we hand the browser/app straight to Google, we never fetch/store the bytes.
    const mediaResp = await fetch(
      `${PLACES_BASE_URL}/${photoName}/media?maxWidthPx=${maxWidthPx}&skipHttpRedirect=true&key=${apiKey}`,
    );
    if (!mediaResp.ok) {
      return new Response('Photo media lookup failed', { status: 502 });
    }
    const media = await mediaResp.json();
    if (!media.photoUri) {
      return new Response('No photo URI returned', { status: 502 });
    }

    return Response.redirect(media.photoUri, 302);
  } catch (err) {
    console.error('place-photo error', err);
    return new Response('Photo service error', { status: 500 });
  }
});
