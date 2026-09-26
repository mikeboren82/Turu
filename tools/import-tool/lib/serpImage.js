// TuRu - SerpAPI (Google Images) image search: the only web-image-search path, and its limits (2026-09-26).
//
//  - A Places-linked activity (activities.google_place_id set) NEVER gets an automatic SerpAPI image: its automatic
//    image is the sanctioned place-photo proxy (Monster job places_photos, tools/playground-discovery/enrich_images.py);
//    when Google has no photo the placeholder stays. There is no SerpAPI fallback for it, now or later.
//  - Every row inserted from a search result is EXTERNAL_SOURCE + needs_rights_review=true (supabase/0047): a web
//    search hit is never rights-cleared. image_source_url = the page SerpAPI says the image was found on, and only
//    when it names one - never the image URL itself, never a guess.
//  - Callers: saveNewActivity (autoImageFallback - approved default, unchanged) and the admin button
//    POST /api/manage/search-photo (status 'pending', unchanged).

// { url, sourcePageUrl } for the first usable result, or null (no key, no result, any failure - never throws).
async function searchGoogleImage(query, { apiKey = process.env.SERPAPI_KEY, fetchImpl = fetch } = {}) {
  if (!apiKey || !query) return null;
  try {
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'google_images');
    url.searchParams.set('q', query);
    url.searchParams.set('api_key', apiKey);
    const res = await fetchImpl(url.toString());
    if (!res.ok) return null;
    const data = await res.json();
    const results = Array.isArray(data.images_results) ? data.images_results : [];
    const first = results.find((r) => r && typeof r.original === 'string' && r.original.trim());
    if (!first) return null;
    // `link` = the result's originating page (SerpAPI google_images); absent or not http(s) => no provenance URL
    const sourcePageUrl = typeof first.link === 'string' && /^https?:\/\//i.test(first.link.trim()) ? first.link.trim() : null;
    return { url: first.original.trim(), sourcePageUrl };
  } catch (err) {
    console.error('חיפוש תמונה אוטומטי בגוגל נכשל:', err);
    return null;
  }
}

// The activity_images row for a search result. `status` omitted = the column default (approved).
function serpImageRow({ activityId, userId, found, status }) {
  return {
    activity_id: activityId,
    url: found.url,
    uploaded_by: userId,
    image_source_type: 'EXTERNAL_SOURCE',
    image_source_url: found.sourcePageUrl || null,
    needs_rights_review: true,
    ...(status ? { status } : {}),
  };
}

// Automatic search only for a published-bound row that got no image from its source AND is not a Places activity.
function mayAutoSearchImage({ imageAdded, archived, googlePlaceId }) {
  return !imageAdded && !archived && !googlePlaceId;
}

// saveNewActivity's fallback: search (only when allowed), insert with provenance, drop the pre-set placeholder.
async function autoImageFallback(client, { activity, activityId, userId, archived, imageAdded, placeholderGroup, search = searchGoogleImage }) {
  if (!mayAutoSearchImage({ imageAdded, archived, googlePlaceId: activity.google_place_id })) return { searched: false, inserted: false };
  const query = [activity.name, activity.city].filter(Boolean).join(' ');
  const found = await search(query);
  if (!found) return { searched: true, inserted: false };
  const { error } = await client.from('activity_images').insert(serpImageRow({ activityId, userId, found }));
  if (error) {
    console.error('שמירת תמונה שנמצאה אוטומטית נכשלה:', error);
    return { searched: true, inserted: false };
  }
  if (placeholderGroup) {
    // תמונה אמיתית בכל זאת נמצאה - אין עוד צורך ב-placeholder שנקבע מראש.
    await client.from('activities').update({ placeholder_group: null }).eq('id', activityId);
  }
  return { searched: true, inserted: true };
}

module.exports = { searchGoogleImage, serpImageRow, mayAutoSearchImage, autoImageFallback };
