// TuRu - ONE rule for copying activity_images rows from one activity (a merge loser / a sibling) onto another
// (2026-09-27, "Merge Image Safety + Provider Proxy Identity Hardening").
//
// Why: a place-photo proxy URL (supabase/functions/place-photo: .../functions/v1/place-photo/<place_id>) names a
// PLACE, not a picture - the Edge Function resolves "that place's current photo" on every request. Copying the loser's
// proxy onto the keeper attaches the loser's place photo to the keeper forever (production 2026-09-14,
// reconcile-playground-twins.js: row ee34196d on גן בולטימור אשקלון embeds HaShayetet Playground's place id). A keeper
// gets its own proxy only from the places_photos job (tools/playground-discovery/enrich_images.py), for its own place
// id. The URL is not rebuilt with the keeper's place id here either - that is the job's decision, under its gate/ledger.
//
// Every source image falls in exactly one class:
//   PROVIDER        image_source_type 'PROVIDER' OR a proxy-shaped URL (legacy rows with null/wrong source type are
//                   caught by the URL) - NEVER copyable, whatever its status or the place ids involved
//   APPROVED        status 'approved', not a provider image          - the ONLY copyable class
//   REJECTED        status 'rejected'                                 - never copied (an admin said no)
//   PENDING         status 'pending'                                  - never copied (awaits review on the loser)
//   UNKNOWN_STATUS  status missing from the selected row              - never copied: the column defaults to
//                   'approved' (supabase/0012), so an insert without an explicit status would promote a
//                   rejected/pending image by omission; callers must select IMAGE_COPY_SELECT
//
// A copied row carries the source's provenance EXACTLY (COPY_COLUMNS - never a column default): url, status,
// image_source_type, image_source_url, needs_rights_review, image_kind, image_page_url, retrieved_at. A source row
// that lacks any of those keys was selected too narrowly - that is a caller bug and throws (never a silent default).
// Regenerated on purpose (not copied):
//   id           new row
//   activity_id  the keeper
//   uploaded_by  the actor performing the merge - RLS images_insert (supabase/0012) requires uploaded_by = auth.uid(),
//                so the loser's uploader cannot be carried over; the original row (on the archived loser) keeps it
//   created_at   the copy's own creation instant (column default)

const { isGoogleMapsUrl, isRawGooglePlacesPhotoUrl } = require('./googlePlacesPolicy');
const PLACE_PHOTO_PROXY_RE = /\/functions\/v1\/place-photo\/([^/?#]+)/;

const COPY_COLUMNS = ['url', 'status', 'image_source_type', 'image_source_url', 'needs_rights_review', 'image_kind', 'image_page_url', 'retrieved_at'];
// the embed column list every copy path selects on its source rows (id for reporting)
const IMAGE_COPY_SELECT = ['id', ...COPY_COLUMNS].join(', ');

const IMAGE_CLASS = Object.freeze({ PROVIDER: 'PROVIDER', APPROVED: 'APPROVED', REJECTED: 'REJECTED', PENDING: 'PENDING', UNKNOWN_STATUS: 'UNKNOWN_STATUS' });

function isPlacePhotoProxyUrl(url) {
  return typeof url === 'string' && PLACE_PHOTO_PROXY_RE.test(url);
}

// the place id a proxy URL embeds (last path segment after place-photo/), or null for a non-proxy URL
function proxyPlaceId(url) {
  if (typeof url !== 'string') return null;
  const m = PLACE_PHOTO_PROXY_RE.exec(url);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

// Google Places release policy (lib/googlePlacesPolicy.js): a row whose provenance is Google (a Maps image_source_url,
// a raw Places photo url) is provider content too - never copied, so a merge never creates a new Google-origin row
function isProviderImage(img) {
  return !!img && (img.image_source_type === 'PROVIDER' || isPlacePhotoProxyUrl(img.url)
    || isGoogleMapsUrl(img.image_source_url) || isGoogleMapsUrl(img.url) || isRawGooglePlacesPhotoUrl(img.url));
}

function classifyImage(img) {
  if (isProviderImage(img)) return IMAGE_CLASS.PROVIDER;
  switch (img && img.status) {
    case 'approved': return IMAGE_CLASS.APPROVED;
    case 'rejected': return IMAGE_CLASS.REJECTED;
    case 'pending': return IMAGE_CLASS.PENDING;
    default: return IMAGE_CLASS.UNKNOWN_STATUS;
  }
}

// may this source row be copied onto ANOTHER activity at all?
function isCopyableSourceImage(img) {
  return !!img && typeof img.url === 'string' && img.url.trim() !== '' && classifyImage(img) === IMAGE_CLASS.APPROVED;
}

function buildCopyRow(img, keeperId, uploadedBy) {
  const missing = COPY_COLUMNS.filter((c) => !(c in img));
  if (missing.length) throw new Error(`mergeImages: source image ${img.id || img.url} was selected without ${missing.join(', ')} - select IMAGE_COPY_SELECT (never rely on column defaults)`);
  const row = { activity_id: keeperId, uploaded_by: uploadedBy ?? null };
  for (const c of COPY_COLUMNS) row[c] = img[c];
  return row;
}

function emptySkipped() {
  return { provider: 0, rejected: 0, pending: 0, unknown_status: 0, duplicate_url: 0, over_limit: 0 };
}

// Pure plan: which loser images become keeper rows. Proxy/status safety is decided BEFORE the URL dedupe, so a
// provider image is reported as provider (never as a duplicate) and can never reach an insert.
//   keeperImages: the keeper's current rows (any status; only .url is read) - a URL already there is not re-added
//   max:          copy at most this many rows (the callers' historical per-merge caps)
// -> { rows, skipped: {provider, rejected, pending, unknown_status, duplicate_url, over_limit}, decisions: [{id,url,class,outcome}] }
function planImageCopy({ loserImages, keeperImages, keeperId, uploadedBy, max = Infinity }) {
  const have = new Set((keeperImages || []).map((i) => i && i.url).filter(Boolean));
  const rows = []; const skipped = emptySkipped(); const decisions = [];
  for (const img of loserImages || []) {
    if (!img) continue;
    const cls = classifyImage(img);
    let outcome;
    if (cls === IMAGE_CLASS.PROVIDER) outcome = 'provider';
    else if (cls === IMAGE_CLASS.REJECTED) outcome = 'rejected';
    else if (cls === IMAGE_CLASS.PENDING) outcome = 'pending';
    else if (cls === IMAGE_CLASS.UNKNOWN_STATUS || !isCopyableSourceImage(img)) outcome = 'unknown_status';
    else if (have.has(img.url)) outcome = 'duplicate_url';
    else if (rows.length >= max) outcome = 'over_limit';
    else { rows.push(buildCopyRow(img, keeperId, uploadedBy)); have.add(img.url); outcome = 'copy'; }
    if (outcome !== 'copy') skipped[outcome]++;
    decisions.push({ id: img.id ?? null, url: img.url, class: cls, outcome });
  }
  return { rows, skipped, decisions };
}

// Plan + insert. Never throws on an insert error (the merge scripts historically continue) - returns it.
// -> { rows (inserted, or planned when the insert failed), inserted, skipped, decisions, error }
async function copyLoserImages(client, opts) {
  const plan = planImageCopy(opts);
  if (!plan.rows.length) return { ...plan, inserted: 0, error: null };
  const { error } = await client.from('activity_images').insert(plan.rows);
  return { ...plan, inserted: error ? 0 : plan.rows.length, error: error || null };
}

// /api/merge: the requested URLs come from the client, which got them from an LLM (suggest-merge). They are never
// trusted as such:
//   - a proxy-shaped URL is refused outright, whatever else is known about it
//   - with a loser activity (duplicates page, deleteActivityId), each URL must resolve to one of the loser's ACTUAL
//     activity_images rows; an unresolved URL is refused, a resolved one goes through planImageCopy (status,
//     provider class, provenance preserved exactly)
//   - without a loser (scrape-time merge: the candidate is not stored, it has no rows to resolve against) a
//     non-proxy URL is inserted exactly as before this change (bare url, the scrape-time import convention of
//     server.js /api/import image_urls) - there is no prior row whose status could be promoted
// -> { rows, refused: [{url, why}], skipped }
function planRequestedMergeImages({ requestedUrls, loserImages, keeperImages, keeperId, uploadedBy, max = 3 }) {
  const refused = [];
  const urls = [];
  for (const u of Array.isArray(requestedUrls) ? requestedUrls : []) {
    if (typeof u !== 'string' || !u.trim()) continue;
    if (isPlacePhotoProxyUrl(u)) { refused.push({ url: u, why: 'place_photo_proxy' }); continue; }
    if (!urls.includes(u)) urls.push(u);
  }
  if (loserImages) {
    const byUrl = new Map();
    for (const img of loserImages) if (img && typeof img.url === 'string' && !byUrl.has(img.url)) byUrl.set(img.url, img);
    const resolved = [];
    for (const u of urls) {
      if (byUrl.has(u)) resolved.push(byUrl.get(u));
      else refused.push({ url: u, why: 'not_a_loser_image' });
    }
    const plan = planImageCopy({ loserImages: resolved, keeperImages, keeperId, uploadedBy, max });
    for (const d of plan.decisions) if (d.outcome !== 'copy' && d.outcome !== 'duplicate_url' && d.outcome !== 'over_limit') refused.push({ url: d.url, why: d.outcome });
    return { rows: plan.rows, refused, skipped: plan.skipped };
  }
  const have = new Set((keeperImages || []).map((i) => i && i.url).filter(Boolean));
  const rows = urls.filter((u) => !have.has(u)).slice(0, max).map((u) => ({ activity_id: keeperId, url: u, uploaded_by: uploadedBy ?? null }));
  return { rows, refused, skipped: emptySkipped() };
}

module.exports = {
  PLACE_PHOTO_PROXY_RE, COPY_COLUMNS, IMAGE_COPY_SELECT, IMAGE_CLASS,
  isPlacePhotoProxyUrl, proxyPlaceId, isProviderImage, classifyImage, isCopyableSourceImage,
  buildCopyRow, planImageCopy, copyLoserImages, planRequestedMergeImages,
};
