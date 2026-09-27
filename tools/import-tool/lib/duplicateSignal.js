// TuRu - Node/CommonJS mirror of coordinateDuplicateSignal in
// supabase/functions/_shared/placesDiscovery.ts (Deno). Same deliberate-duplication arrangement as
// placeholderGroup.js / categoryValidation.js: two runtimes cannot share one module, so the pair
// must change together. DRIFT PROTECTION: both implementations are run over the SAME fixture file,
// tests/fixtures/duplicateSignalCorpus.json, by tools/import-tool/tests/duplicateCandidates.test.js
// (Node) and supabase/functions/_shared/duplicateSignalCorpus.test.ts (Deno). Either side drifting
// fails its own suite against the shared expectations.
//
// TWO AXES, NOT ONE. See the Deno file for the full rationale. In short:
//   VENUE RELATEDNESS (coordinates / address / venue link / same publisher) establishes that two rows
//     belong to the same PLACE. Never identity on its own, however many of them agree.
//   ENTITY IDENTITY is either offering-name CONTAINMENT (one name's distinctive tokens inside the
//     other's) or INDEPENDENT SOURCES AGREEING (different publishers + some name overlap).
//   A PLACE and an OFFERING held at it are different kinds of record: hard gate, never duplicates.
// Nothing venue-specific: every input is a column.

// NOTE: this is placesDiscovery.ts's normalizeForMatch (Unicode letter/number classes, punctuation
// becomes a SPACE), NOT matching.ts's (which strips punctuation to nothing). The two differ on
// "מדבריום - פארק החיות": here the hyphen becomes a token boundary. Ported verbatim.
const { isGoogleMapsUrl, isGooglePlaceUrn } = require('./googlePlacesPolicy');

const COMPARISON_ONLY_STOPWORDS = new Set(['park', 'פארק', 'גן', 'ציבורי']);
function normalizeForMatch(s) {
  if (!s) return '';
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

// TOKEN QUALITY (2026-09-21). See placesDiscovery.ts for the full rationale. GENRE_WORDS is reused
// from the live scorer's Node twin (cleaner/matching.js), not hand-copied, so the two cannot drift
// silently; DOMAIN_CATEGORY_WORDS is the same small, evidence-driven, non-venue-specific addition
// as the Deno side. LOCALITY exclusion is structural (each side's own `city` field), never a
// hardcoded city list, so it generalises to any locality, seen or unseen.
const { GENRE_WORDS } = require('../cleaner/matching');
const DOMAIN_CATEGORY_WORDS = new Set(['שעשועים', 'משחקים', 'משחקייה', 'מתקני', 'חוף']);
const IDENTITY_GENERIC_WORDS = new Set([...COMPARISON_ONLY_STOPWORDS, ...GENRE_WORDS, ...DOMAIN_CATEGORY_WORDS]);
const EMPTY_SET = new Set();
function cityTokens(city) {
  return new Set(normalizeForMatch(city).split(' ').filter((w) => w.length > 1));
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371; const dLat = (lat2 - lat1) * Math.PI / 180; const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const COORDINATE_DUPLICATE_RADIUS_M = 60;
// activities.entity_type value denoting a physical place. Must equal the Deno constant; the drift
// test asserts both against extraction.ts's ENTITY_TYPE_VALUES.
const PLACE_ENTITY_TYPE = 'מקום_קבוע';

function entityKind(entityType) {
  const t = (entityType || '').trim();
  if (!t) return 'unknown';
  return t === PLACE_ENTITY_TYPE ? 'place' : 'offering';
}

function nameTokens(s, localityTokens = EMPTY_SET) {
  return new Set(normalizeForMatch(s).split(' ').filter((w) => w.length > 1 && !IDENTITY_GENERIC_WORDS.has(w) && !localityTokens.has(w)));
}

function nameContainment(a, b, localityTokens = EMPTY_SET) {
  const wa = nameTokens(a, localityTokens), wb = nameTokens(b, localityTokens);
  if (wa.size === 0 || wb.size === 0) return false;
  const [small, big] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  for (const w of small) if (!big.has(w)) return false;
  return true;
}

// A Google Maps listing / place URN is not a PUBLISHER (Google Places release policy, googlePlacesPolicy.js): two Google-origin
// rows are not "same_publisher", and a Maps row does not make an "independent source agreeing". It also keeps the signal
// the same after the Maps source_url scrub (null source_url -> no publisher).
function registrableDomain(url) {
  if (!url || isGoogleMapsUrl(url) || isGooglePlaceUrn(url)) return null;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host || null;
  } catch {
    return null;
  }
}

function nameOverlapRatio(a, b, localityTokens = EMPTY_SET) {
  const wa = nameTokens(a, localityTokens); const wb = nameTokens(b, localityTokens);
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  wa.forEach((w) => { if (wb.has(w)) common++; });
  return common / Math.min(wa.size, wb.size);
}

// a, b: { name, lat, lon, sourceUrl, address, entityType?, venueId?, city? }
function coordinateDuplicateSignal(a, b, opts = {}) {
  const radius = opts.radiusM ?? COORDINATE_DUPLICATE_RADIUS_M;
  if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) {
    return { isCandidate: false, distanceM: null, score: 0, signals: [], venueRelatedness: [], identityEvidence: [], relationship: 'UNKNOWN', reason: 'missing coordinates on one side' };
  }
  const distanceM = haversineKm(a.lat, a.lon, b.lat, b.lon) * 1000;
  if (distanceM > radius) {
    return { isCandidate: false, distanceM, score: 0, signals: [], venueRelatedness: [], identityEvidence: [], relationship: 'UNRELATED', reason: `beyond ${radius}m` };
  }

  const venueRelatedness = ['coordinates_within_radius'];
  const domA = registrableDomain(a.sourceUrl);
  const domB = registrableDomain(b.sourceUrl);
  const samePublisher = !!(domA && domB && domA === domB);
  if (samePublisher) venueRelatedness.push(`same_publisher:${domA}`);
  const addrA = normalizeForMatch(a.address); const addrB = normalizeForMatch(b.address);
  if (addrA && addrA === addrB) venueRelatedness.push('same_address');
  if (a.venueId && b.venueId && a.venueId === b.venueId) venueRelatedness.push('same_venue');

  const mk = (isCandidate, identityEvidence, relationship, reason) => ({
    isCandidate, distanceM,
    score: venueRelatedness.length + identityEvidence.length * 2,
    signals: [...venueRelatedness, ...identityEvidence],
    venueRelatedness, identityEvidence, relationship, reason,
  });

  const kindA = entityKind(a.entityType); const kindB = entityKind(b.entityType);
  if (kindA !== 'unknown' && kindB !== 'unknown' && kindA !== kindB) {
    return mk(false, [], 'SAME_PLACE_DIFFERENT_RECORD', 'one side is a place and the other is an offering held at it - co-location cannot make them the same record');
  }

  const localityTokens = new Set([...cityTokens(a.city), ...cityTokens(b.city)]);
  const identityEvidence = [];
  const overlap = nameOverlapRatio(a.name, b.name, localityTokens);
  if (nameContainment(a.name, b.name, localityTokens)) identityEvidence.push(`offering_name_identity:${overlap.toFixed(2)}`);
  if (domA && domB && domA !== domB && overlap > 0) identityEvidence.push(`independent_sources_agree:${domA}|${domB}:${overlap.toFixed(2)}`);

  if (identityEvidence.length === 0) {
    return mk(false, identityEvidence, 'SAME_PLACE_DIFFERENT_RECORD', 'co-located but nothing else corroborates it - not a duplicate candidate');
  }
  return mk(true, identityEvidence, 'POSSIBLE_DUPLICATE', 'co-located AND corroborated by an independent identity signal - review as possible duplicate');
}

module.exports = { coordinateDuplicateSignal, COORDINATE_DUPLICATE_RADIUS_M, PLACE_ENTITY_TYPE, COMPARISON_ONLY_STOPWORDS, DOMAIN_CATEGORY_WORDS, registrableDomain, haversineKm, entityKind, cityTokens };
