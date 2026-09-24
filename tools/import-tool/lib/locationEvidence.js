// TuRu - LOCATION EVIDENCE for incoming candidates (verify_location Phase 2, 2026-09-24). Pure rules, no I/O:
//   labelKind            what the location LABEL is: VENUE | STREET | SETTLEMENT | ADMIN_AREA | MULTI | GENERIC | TITLE | CONTAINER
//   verifyLocationShape  may this row be routed to automated location resolution at all (wrong-shape exclusions)
//   classifyResolution   the evidence ladder over one resolver result: HIGH | MEDIUM | VERIFY_MORE | CONFLICT | NO_EVIDENCE
//   storedLocationHolds  canonical-evaluator holds for a row that already carries coordinates (lib/incomingEligibility.js)
// A street, road, neighbourhood or administrative area may give COORDINATES; it never becomes the venue identity.
// Nothing here invents a city, an address or a venue.
const { normalizeCityName } = require('../cityNaming');
const { compoundPlace } = require('./placeSafety');
const LABEL_DERIVED = new Set(['existing_venue', 'existing_source_venue', 'prior_activity', 'existing_location', 'place_lookup', 'place_lookup_inferred']);

const norm = (s) => String(s || '').toLowerCase().replace(/["'`״׳’]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const STREET_PREFIX = /^(רחוב|רח[׳']?|שדרות|שדרת|שד[׳']|דרך|סמטת|סמ[׳'])\s+\S/;
const STREET_WITH_NUMBER = /^[א-ת"'׳״\s-]{2,30}\s\d{1,4}[א-ת]?$/;
// a venue named with a number ("תיאטרון בית 9", "אולם 2", "סטודיו 5") is not a street: venue nouns never open a street label
const VENUE_NOUN = /^(ה?תיאטרון|בית|אולם|מרכז|מתנ|ה?ספרי|ה?מוזיאון|היכל|קולנוע|סטודיו|גלריה|מועדון|גן|פארק|קניון|מתחם|אודיטוריום|סינמה|לונה|חוות|סינמטק|אמפי|ה?קאנטרי|ה?בריכה)/;
const ADMIN_LABEL = /^(מועצה\s+(אזורית|מקומית|איזורית)|מ\.?\s?א\.?\s|נפת\s|מחוז\s)/;
// a label that spreads the activity over several places (pilot 2026-09-24: "רחבי העיר" geocoded to the city hall and
// was published there) - no single place exists to resolve; coordinates would be invented
const MULTI_LOCATION = /(^|\s)(ב?רחבי(?=\s|$)|בכל\s+(ה?עיר|רחבי|ה?שכונות|ה?גינות|ה?מתנסים|ה?סניפים)|מיקומים\s+שונים|מקומות\s+שונים|מוקדים\s+שונים|ב?(מספר|כמה|מגוון)\s+(מוקדים|מיקומים|מקומות|אתרים|נקודות)|בשכונות|פרטים(\s+מדויקים)?\s+ב(מודעה|הרשמה|אתר)|יימסר|ימסר|ישלח|יישלח)/;
const CONTAINER_LABEL =/^(קניון|קניוני|מתחם|קאנטרי|פאוור סנטר|מרכז מסחרי|אאוטלט)/;
// labels that name a KIND of place, not one place (several per city): no identity without an address / venue
const GENERIC_LABELS = new Set(['ספרייה', 'ספריה', 'הספרייה', 'הספריה', 'ספרייה עירונית', 'מתנס', 'המתנס', 'פארק', 'הפארק', 'גן', 'גינה', 'גן ציבורי', 'מרכז', 'מרכז קהילתי', 'אולם', 'מועדון', 'חוף', 'החוף', 'מגרש', 'בית ספר', 'בית הספר', 'קניון', 'הקניון', 'עירייה', 'העירייה', 'מרכז העיר', 'כיכר העיר', 'אונליין', 'online', 'זום', 'zoom', 'יפורסם בהמשך', 'ייקבע', 'מקום יפורסם']);
// OSM object types that are roads / administrative units - coordinates only, never a venue
const HIGHWAY_TYPES = new Set(['residential', 'primary', 'secondary', 'tertiary', 'trunk', 'motorway', 'road', 'street', 'pedestrian', 'living_street', 'unclassified', 'service', 'footway', 'path', 'track', 'cycleway', 'steps']);
const ADMIN_TYPES = new Set(['city', 'town', 'village', 'suburb', 'administrative', 'municipality', 'county', 'state', 'neighbourhood', 'quarter', 'hamlet', 'locality', 'district']);
const VENUE_TYPES = new Set(['theatre', 'museum', 'library', 'community_centre', 'arts_centre', 'cinema', 'zoo', 'attraction', 'park', 'mall', 'sports_centre', 'stadium', 'university', 'school', 'kindergarten', 'place_of_worship', 'playground', 'garden', 'nature_reserve', 'aquarium', 'theme_park', 'water_park', 'swimming_pool', 'events_venue', 'social_centre', 'centre', 'farm']);

// the street part of an address ("שאול המלך 25" -> "שאול המלך"; "רחוב הרצל 5, חולון" -> "הרצל")
function streetOf(address) {
  if (!address) return null;
  let a = String(address).split(',')[0].trim().replace(STREET_PREFIX, (m) => m.replace(/^(רחוב|רח[׳']?|שדרות|שדרת|שד[׳']|דרך|סמטת|סמ[׳'])\s+/, ''));
  a = a.replace(/\s\d{1,4}[א-ת]?$/, '').trim();
  return a || null;
}

// c: { name, location_name, city, address, formatted_address, entity_type, venue_id, cleaner_location }
function labelKind(c) {
  const label = String(c.location_name || '').trim();
  if (!label) return { kind: 'NONE' };
  const n = norm(label), name = norm(c.name);
  if (ADMIN_LABEL.test(label)) return { kind: 'ADMIN_AREA', why: 'administrative area label' };
  if (MULTI_LOCATION.test(label)) return { kind: 'MULTI', why: 'label names several places / an undisclosed place' };
  if (c.city && normalizeCityName(label) === normalizeCityName(c.city)) return { kind: 'SETTLEMENT', why: 'label is the city itself' };
  if (STREET_PREFIX.test(label) || (STREET_WITH_NUMBER.test(label) && !VENUE_NOUN.test(label))) return { kind: 'STREET', why: 'street-shaped label' };
  const st = streetOf(c.address || c.formatted_address);
  if (st && norm(st) === n && !c.venue_id) return { kind: 'STREET', why: `label equals the address street ("${st}")` };
  const evType = c.cleaner_location?.evidence?.type;
  if (evType && HIGHWAY_TYPES.has(evType) && !c.venue_id) return { kind: 'STREET', why: `resolver object type ${evType}` };
  if (evType && ADMIN_TYPES.has(evType) && !c.venue_id) return { kind: 'ADMIN_AREA', why: `resolver object type ${evType}` };
  if (CONTAINER_LABEL.test(label) && c.entity_type === 'מקום_קבוע' && name && (name.includes(n) || n.includes(name))) return { kind: 'CONTAINER', why: 'the container itself is the listed activity' };
  if (n && name && (n === name || ((name.includes(n) || n.includes(name)) && Math.min(n.length, name.length) / Math.max(n.length, name.length) >= 0.7))) return { kind: 'TITLE', why: 'location label is the activity title' };
  if (GENERIC_LABELS.has(n) && !c.venue_id && !(c.address || c.formatted_address)) return { kind: 'GENERIC', why: 'generic place label without address or venue' };
  return { kind: 'VENUE' };
}

const hasCoords = (c) => c.lat != null && c.lng != null && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng));
const isPublishable = (cl) => !!cl && ['HIGH', 'MEDIUM'].includes(cl.verification?.class || null);

// May this row enter verify_location? (the policy side - "location is the only blocker" - is the canonical evaluator's
// job; this is the SHAPE side). settlementOf(city) -> a canonical settlement or null (lib/canonicalSettlement).
function verifyLocationShape(c, { settlementOf = null } = {}) {
  if (hasCoords(c)) return { ok: false, exclusion: 'already_has_coordinates' };
  if (c.cleaner_location && ['HIGH', 'MEDIUM'].includes(c.cleaner_location.confidence)) return { ok: false, exclusion: 'already_resolved' };
  if (!c.city || !String(c.location_name || '').trim()) return { ok: false, exclusion: 'no_city_or_label' };
  if (settlementOf && !settlementOf(c.city)) return { ok: false, exclusion: 'city_not_settlement' };
  const k = labelKind(c);
  if (k.kind !== 'VENUE') return { ok: false, exclusion: 'label_' + k.kind.toLowerCase(), why: k.why };
  return { ok: true };
}

// the row's label and a venue name name the same place (containment or >= half the words shared; no label = no conflict)
function labelNamesVenue(label, venueName) {
  const fold = (t) => norm(t).replace(/יי/g, 'י').replace(/וו/g, 'ו');
  const a = fold(label), b = fold(venueName);
  if (!a) return true;
  if (!b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const wa = new Set(a.split(' ').filter((w) => w.length > 1)), wb = new Set(b.split(' ').filter((w) => w.length > 1));
  let common = 0; wa.forEach((w) => { if (wb.has(w)) common++; });
  return common / Math.max(wa.size, wb.size, 1) >= 0.5;
}

// The evidence ladder over one resolveLocation result for a subject with a KNOWN city.
//   HIGH   canonical venue (+ matching city + coordinates), prior approved activity of the same source/label, an existing
//          verified location row, page/detail-page geo with city agreement
//   MEDIUM a street-level address geocoded in the canonical city, a venue-name + city lookup with a venue object type
//   VERIFY_MORE  label-only / inferred-city lookups, non-venue object types, LOW, anything without coordinates
//   CONFLICT     the resolver found several credible places, or a credible place in ANOTHER canonical city
//   NO_EVIDENCE  nothing
function classifyResolution(result, subject = {}) {
  if (!result) return { class: 'NO_EVIDENCE', rule: 'no_result' };
  if (result.ambiguous) return { class: 'CONFLICT', rule: 'several_candidates' };
  if (result.lat == null || result.lng == null) return { class: result.confidence === 'LOW' ? 'VERIFY_MORE' : 'NO_EVIDENCE', rule: 'no_coordinates' };
  const want = normalizeCityName(subject.city || null), got = normalizeCityName(result.city || null);
  if (want && got && want !== got && !(want.includes(got) || got.includes(want))) return { class: 'CONFLICT', rule: `city_disagreement(${want}|${got})` };
  const ev = result.evidence || {};
  if (ev.city_inferred) return { class: 'VERIFY_MORE', rule: 'inferred_city' };
  if (result.confidence === 'LOW') return { class: 'VERIFY_MORE', rule: 'low_confidence' };
  // COMPOUND PLACE LABEL (pilot #5, "גן החיות ואקווריום ישראל" for "אקווריום ישראל"): a point derived from the LABEL
  // (a canonical venue, a prior activity, an existing location, a name lookup) is the complex's / another component's,
  // not the sub-place the title names - unless the resolved place names exactly that component. Page evidence (a map
  // pin, JSON-LD, a bound address on the item's own page) is event-local and passes.
  const cp = compoundPlace(subject.location_name, subject.name);
  if (cp.compound && cp.titleComponent !== null && LABEL_DERIVED.has(result.method)) {
    const resolved = norm(ev.venue || ev.source_venue || result.location_name || '');
    const mine = cp.components[cp.titleComponent];
    const others = cp.components.filter((_, i) => i !== cp.titleComponent).map(norm);
    if (!(labelNamesVenue(mine, resolved) && !others.some((o) => o && resolved.includes(o)))) return { class: 'VERIFY_MORE', rule: 'compound_place_label' };
  }
  switch (result.method) {
    case 'existing_venue': case 'existing_source_venue':
      if (!result.venue_id) return { class: 'VERIFY_MORE', rule: 'venue_without_id' };
      // the venue must be the place the row itself names (a network source's venue is not every branch's venue)
      if (!labelNamesVenue(subject.location_name, ev.venue || ev.source_venue || result.location_name)) return { class: 'VERIFY_MORE', rule: 'venue_label_mismatch' };
      return /venue_name_geocoded/.test(String(ev.coords || '')) ? { class: 'MEDIUM', rule: 'canonical_venue_name_geocoded' } : { class: 'HIGH', rule: 'canonical_venue' };
    case 'prior_activity': return { class: result.confidence, rule: 'prior_activity_same_source_label' };
    case 'existing_location': return { class: result.confidence, rule: 'existing_verified_location' };
    case 'source_page': case 'detail_page': case 'venue_site': {
      if (result.confidence === 'HIGH') return { class: 'HIGH', rule: 'first_party_page_geo' };
      const addr = String(result.address || '');
      return /\d/.test(addr) || ev.jsonld_address || ev.jsonld_place ? { class: 'MEDIUM', rule: 'street_address_city_geocode' } : { class: 'VERIFY_MORE', rule: 'page_label_without_street_number' };
    }
    case 'place_lookup':
      if (ev.type && VENUE_TYPES.has(ev.type)) return { class: 'MEDIUM', rule: 'venue_name_city_lookup' };
      if (ev.type && HIGHWAY_TYPES.has(ev.type)) return { class: 'VERIFY_MORE', rule: 'label_resolved_to_street' };
      return { class: 'VERIFY_MORE', rule: `non_venue_object_type(${ev.type || '?'})` };
    case 'place_lookup_inferred': return { class: 'VERIFY_MORE', rule: 'label_only_or_inferred_city' };
    default: return { class: 'VERIFY_MORE', rule: 'unknown_method' };
  }
}

// For the canonical evaluator: a row WITH coordinates is publishable automatically only when its location label names a
// place (not a street / admin area / the city) and, when the Cleaner supplied the coordinates, that evidence is HIGH/MEDIUM
// under the ladder. Legacy cleaner_location objects (before verify_location) are graded by method + stored evidence.
function storedLocationHolds(c) {
  if (!hasCoords(c)) return [];
  const holds = [];
  const k = labelKind(c);
  if (['STREET', 'ADMIN_AREA', 'SETTLEMENT', 'MULTI'].includes(k.kind)) holds.push({ code: 'location_label_not_venue', severity: 'hold', humanOverridable: true, detail: k.kind + ': ' + k.why });
  const cl = c.cleaner_location;
  if (cl) {
    const v = cl.verification || classifyResolution({ ...cl, lat: c.lat, lng: c.lng, city: cl.city ?? null, address: cl.address ?? c.address ?? null, venue_id: cl.venue_id ?? c.venue_id ?? null, evidence: cl.evidence || {} }, {});
    if (!['HIGH', 'MEDIUM'].includes(v.class)) holds.push({ code: 'location_evidence_insufficient', severity: 'hold', humanOverridable: true, detail: v.class + ': ' + v.rule });
  }
  return holds;
}

module.exports = { labelKind, verifyLocationShape, classifyResolution, storedLocationHolds, streetOf, isPublishable, GENERIC_LABELS, HIGHWAY_TYPES, VENUE_TYPES };
