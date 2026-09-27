// TuRu - proxies a Google Places photo for a playground/park found via
// tools/playground-discovery. Google Maps Platform Terms permit storing a
// place_id indefinitely but NOT caching the photo itself or its `photos[].name`
// reference (see supabase/0055_activities_google_place_id.sql) - so
// activity_images.url points here instead of at a raw Google-hosted photo URL,
// and this function re-resolves the place's *current* photo live on every
// request rather than ever persisting one.
//
// URL shape: .../functions/v1/place-photo/<place_id>?maxwidth=1200            302 to Google's photo URI
//            .../functions/v1/place-photo/<place_id>?format=json&maxwidth=N   live photo + attribution JSON
// (place_id is the last path segment, not a query param, so the stored
// activity_images.url is a plain stable link usable directly in <img src>.)
//
// 2026-09-27 hardening - every guard runs BEFORE any Google call: strict place-id format, per-IP rate limit,
// automation_settings.place_photo_serving_enabled kill flag (explicit false = off; absent = on), and an allow-list of
// place ids on APPROVED activities. The handler and its contract live in ../_shared/placePhoto.ts (tested offline).

import { createClient } from 'npm:@supabase/supabase-js@2';
import { createPlacePhotoHandler, supabaseDbGuards, type SelectOnlyClient } from '../_shared/placePhoto.ts';

let client: SelectOnlyClient | null = null;
function getClient(): SelectOnlyClient | null {
  if (client) return client;
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return null; // guards then fail closed (503), Google is never reached
  client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

Deno.serve(createPlacePhotoHandler({
  fetch: (input, init) => fetch(input, init),
  getApiKey: () => Deno.env.get('GOOGLE_MAPS_API_KEY'),
  db: supabaseDbGuards(getClient),
}));
