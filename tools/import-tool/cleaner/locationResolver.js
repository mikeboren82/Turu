// TuRu Cleaner - address resolution pipeline (THE-CLEANER.md §4-7). Evidence stages, in order:
//   existing        Turu's own data (canonical venues/aliases, the source's venue, prior activities of
//                   the same source with the same label, existing location rows) - always cheap
//   source_page     the record's own page (JSON-LD Event/Place, Google-Maps links, Hebrew street text)
//   detail_page     the event's detail page reached from the listing card ("פרטים נוספים"/title link)
//   venue_site      the canonical venue's official site / contact page (needs a venue)
//   place_lookup    Nominatim "<label>, <city>" without the city-centroid fallback (needs label + city)
//   place_lookup_inferred  the same lookup with a city inferred from the source's other activities, or a
//                   label that is unique in Israel and is itself a venue-type hit (needs a label)
// An attempt is INFORMATION GAIN, never "ask the same resolver again": resolveLocation reports which
// stages it actually ran (`tried`), which were configured but unavailable for this subject and why
// (`skipped`), and errors. lifecycle.js archives only when nothing available remains untried.
// Every result: { location_name, address, city, lat, lng, venue_id, method, confidence, evidence }.
// HIGH/MEDIUM are publishable, LOW is evidence only. Nothing is fabricated: no result => null.
const { normalizeCityName } = require('../cityNaming');
const { resolveVenue } = require('../venueNaming');
const { fetchHtml } = require('../lib/fetchPage');
const { extractJsonLd, extractMapLinks, extractAddressTexts, pageText, inIsrael, findEventCard } = require('../lib/pageExtract');
const { wordOverlapScore, haversineKm } = require('./matching');
const { nominatim } = require('./nominatimClient');
const { reverseAddress } = require('./reverse');

const STAGES = ['existing', 'source_page', 'detail_page', 'venue_site', 'place_lookup', 'place_lookup_inferred'];
const EVIDENCE_STAGES = STAGES.filter((s) => s !== 'existing');
const ADMIN_TYPES = new Set(['city', 'town', 'village', 'suburb', 'administrative', 'municipality', 'county', 'state', 'neighbourhood', 'quarter', 'hamlet', 'locality']);
const VENUE_TYPES = new Set(['theatre', 'museum', 'library', 'community_centre', 'arts_centre', 'cinema', 'zoo', 'attraction', 'park', 'mall', 'sports_centre', 'stadium', 'university', 'school', 'kindergarten', 'place_of_worship', 'playground', 'garden', 'nature_reserve', 'aquarium', 'theme_park']);
// no external place API is configured (Google Places exists only inside scan-settlement-gaps); recorded on archives
const EXTERNAL_LIMIT = 'google_places_lookup_unavailable: no resolve-place function / key configured for the Cleaner';

async function geocodeText(text) {
  const rows = await nominatim(`/search?format=jsonv2&limit=3&countrycodes=il&addressdetails=1&q=${encodeURIComponent(text + ', ישראל')}`);
  return (rows || []).map((r) => ({ lat: Number(r.lat), lng: Number(r.lon), displayName: r.display_name, type: r.type, category: r.category, city: r.address?.city || r.address?.town || r.address?.village || r.address?.municipality || null, road: r.address?.road || null, houseNumber: r.address?.house_number || null, importance: r.importance }));
}
async function reverseCity(lat, lng) {
  const r = await nominatim(`/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1`);
  return r?.address ? (r.address.city || r.address.town || r.address.village || r.address.municipality || null) : null;
}
const cityAgrees = (a, b) => { const x = normalizeCityName(a || null), y = normalizeCityName(b || null); if (!x || !y) return false; return x === y || x.includes(y) || y.includes(x); };

// A canonical venue without coordinates/address: derive them once from Turu's own linked verified
// locations (HIGH, median), the venue's address (HIGH) or its name in its city (MEDIUM) - and keep
// the HIGH result on the venue so the next hundred items resolve from stage 1 (compounding
// knowledge). Writes are fill-null only (a venue that already has coords is never touched).
async function coordsForVenue(client, venue, cityHint, counters) {
  const bump = (k) => { if (counters) counters[k] = (counters[k] || 0) + 1; };
  if (venue.lat != null && venue.lng != null) {
    if (!venue.address) {
      // coordinates known, street missing: one reverse geocode gives every linked activity its street
      const rev = await reverseAddress(venue.lat, venue.lng);
      if (rev && rev.street) {
        const address = `${rev.street}${rev.houseNumber ? ' ' + rev.houseNumber : ''}`;
        const { data } = await client.from('venues').update({ address, updated_at: new Date().toISOString() }).eq('id', venue.id).is('address', null).select('id');
        if (data && data.length) { bump('venueRowsEnriched'); venue.address = address; }
      }
    }
    return { lat: venue.lat, lng: venue.lng, address: venue.address || null, confidence: 'HIGH', how: 'venue' };
  }
  const city = venue.city || cityHint;
  const { data: linked } = await client.from('locations').select('lat, lng, address').eq('venue_id', venue.id).not('lat', 'is', null).limit(50);
  if (linked && linked.length) {
    const lats = linked.map((l) => Number(l.lat)).sort((a, b) => a - b), lngs = linked.map((l) => Number(l.lng)).sort((a, b) => a - b);
    const lat = lats[Math.floor(lats.length / 2)], lng = lngs[Math.floor(lngs.length / 2)];
    const spreadOk = haversineKm(lats[0], lngs[0], lats[lats.length - 1], lngs[lngs.length - 1]) < 1.5;
    if (spreadOk) {
      const address = venue.address || (linked.find((l) => l.address)?.address ?? null);
      const { data } = await client.from('venues').update({ lat, lng, address, updated_at: new Date().toISOString() }).eq('id', venue.id).is('lat', null).select('id');
      if (data && data.length) bump('venueRowsEnriched');
      return { lat, lng, address, confidence: 'HIGH', how: `linked_locations(${linked.length})` };
    }
  }
  if (venue.address) {
    const g = await geocodeAddress(venue.address, city);
    if (g && g.city_ok) { const { data } = await client.from('venues').update({ lat: g.lat, lng: g.lng, updated_at: new Date().toISOString() }).eq('id', venue.id).is('lat', null).select('id'); if (data && data.length) bump('venueRowsEnriched'); return { lat: g.lat, lng: g.lng, address: venue.address, confidence: 'HIGH', how: 'venue_address_geocoded' }; }
  }
  if (city) {
    const rows = await geocodeText(`${venue.name_he}, ${city}`);
    const good = rows.filter((r) => !ADMIN_TYPES.has(r.type) && inIsrael(r) && cityAgrees(r.city, city));
    if (good.length === 1 || (good.length > 1 && haversineKm(good[0].lat, good[0].lng, good[1].lat, good[1].lng) < 0.3)) {
      const h = good[0];
      return { lat: h.lat, lng: h.lng, address: h.road ? `${h.road}${h.houseNumber ? ' ' + h.houseNumber : ''}` : null, confidence: 'MEDIUM', how: 'venue_name_geocoded', geocode: h.displayName };
    }
  }
  return null;
}

// city missing on the candidate: the source's other published activities usually say where it is
async function inferCityFromSource(client, sourceId) {
  if (!sourceId) return null;
  const { data } = await client.from('activities').select('locations(city)').eq('source_id', sourceId).eq('status', 'approved').limit(300);
  const t = {}; (data || []).forEach((a) => { const c = normalizeCityName(a.locations?.city || null); if (c) t[c] = (t[c] || 0) + 1; });
  const sorted = Object.entries(t).sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((n, [, v]) => n + v, 0);
  if (sorted.length && sorted[0][1] >= 3 && sorted[0][1] / total >= 0.8) return { city: sorted[0][0], share: sorted[0][1] / total, n: total };
  return null;
}

// ---- stage: existing data ----
async function stageExisting(client, s, counters) {
  const out = [];
  for (const [label, kind] of [[s.location_name, 'existing_venue'], [s.organizer_name, 'existing_venue'], [s.name, 'existing_venue']]) {
    if (!label) continue;
    const v = await resolveVenue(client, { locationName: label, city: s.city });
    if (v) {
      const full = await client.from('venues').select('id, name_he, city, address, lat, lng, website_url, events_url, updated_at').eq('id', v.id).maybeSingle();
      const venue = full.data || v;
      const co = await coordsForVenue(client, venue, s.city, counters);
      out.push({ location_name: venue.name_he, address: co?.address || venue.address || null, city: normalizeCityName(venue.city || s.city), lat: co?.lat ?? null, lng: co?.lng ?? null, venue_id: venue.id, method: kind, confidence: co ? co.confidence : 'LOW', evidence: { alias_of: label, venue: venue.name_he, coords: co?.how || 'none', geocode: co?.geocode, city_inferred: s.city_inferred }, venue });
      break;
    }
  }
  if (!out.length && s.source_venue_id) {
    const { data: venue } = await client.from('venues').select('id, name_he, city, address, lat, lng, website_url, events_url, updated_at').eq('id', s.source_venue_id).maybeSingle();
    if (venue) { const co = await coordsForVenue(client, venue, s.city, counters); out.push({ location_name: s.location_name || venue.name_he, address: co?.address || venue.address || null, city: normalizeCityName(venue.city || s.city), lat: co?.lat ?? null, lng: co?.lng ?? null, venue_id: venue.id, method: 'existing_source_venue', confidence: co ? co.confidence : 'LOW', evidence: { source_venue: venue.name_he, coords: co?.how || 'none', geocode: co?.geocode }, venue }); }
  }
  if (!out.length && s.location_name && s.source_id) {
    const { data } = await client.from('activities').select('id, name, venue_id, locations!inner(name, address, city, lat, lng, address_confidence)').eq('source_id', s.source_id).eq('status', 'approved').ilike('locations.name', s.location_name).not('locations.lat', 'is', null).limit(3);
    const prior = (data || []).find((a) => a.locations.address_confidence !== 'LOW' && (!s.city || cityAgrees(a.locations.city, s.city)));
    if (prior) out.push({ location_name: prior.locations.name, address: prior.locations.address || null, city: normalizeCityName(prior.locations.city), lat: prior.locations.lat, lng: prior.locations.lng, venue_id: prior.venue_id || null, method: 'prior_activity', confidence: prior.locations.address ? 'HIGH' : 'MEDIUM', evidence: { prior_activity_id: prior.id, prior_name: prior.name } });
  }
  if (!out.length && s.location_name) {
    const { data } = await client.from('locations').select('id, name, address, city, lat, lng, venue_id, address_confidence').ilike('name', s.location_name).not('lat', 'is', null).limit(5);
    const loc = (data || []).find((l) => l.address_confidence !== 'LOW' && (!s.city || cityAgrees(l.city, s.city)));
    if (loc) out.push({ location_name: loc.name, address: loc.address || null, city: normalizeCityName(loc.city || s.city), lat: loc.lat, lng: loc.lng, venue_id: loc.venue_id || null, method: 'existing_location', confidence: loc.address ? 'HIGH' : 'MEDIUM', evidence: { location_id: loc.id } });
  }
  return out[0] || null;
}

// ---- evidence from one HTML page (source_page / detail_page / venue_site share it) ----
async function evidenceFromPage(html, pageUrl, s, official, stage) {
  const method = stage || (official ? 'venue_site' : 'source_page');
  const ld = extractJsonLd(html);
  const evs = ld.events.filter((e) => e.location && (e.location.geo || e.location.address));
  const ev = evs.find((e) => wordOverlapScore(e.name, s.name) >= 0.5) || (evs.length === 1 ? evs[0] : null);
  if (ev && isMultiVenueListing(ev.location)) {
    // a touring show: the listing names many cities/venues as ONE address (Ticketsi et al.) - there is
    // no single place to resolve; LOW + ambiguous so the case archives as ambiguous_location with the reason
    const venues = (ev.location.name || ev.location.address?.text || '').split(',').map((x) => x.trim()).filter(Boolean);
    return { location_name: null, address: null, city: null, lat: null, lng: null, venue_id: null, method, confidence: 'LOW', ambiguous: true, evidence: { multi_venue: true, venues: venues.slice(0, 25), page: pageUrl } };
  }
  if (ev) {
    const addr = ev.location.address; const geo = ev.location.geo;
    const city = normalizeCityName(addr?.city || s.city || null);
    if (geo && inIsrael(geo)) return { location_name: ev.location.name || s.location_name, address: addr?.text || null, city, lat: geo.lat, lng: geo.lng, venue_id: null, method, confidence: 'HIGH', evidence: { jsonld_event: ev.name, page: pageUrl } };
    if (addr?.text) { const g = await geocodeAddress(addr.text, city); if (g) return { ...g, location_name: ev.location.name || s.location_name, method, confidence: g.city_ok ? 'HIGH' : 'MEDIUM', evidence: { jsonld_address: addr.text, page: pageUrl } }; }
  }
  const place = ld.places.find((p) => p.geo || p.address?.text);
  if (place) {
    const city = normalizeCityName(place.address?.city || s.city || null);
    if (place.geo && inIsrael(place.geo)) return { location_name: place.name || s.location_name, address: place.address?.text || null, city, lat: place.geo.lat, lng: place.geo.lng, venue_id: null, method, confidence: official ? 'HIGH' : 'MEDIUM', evidence: { jsonld_place: place.name, page: pageUrl } };
    if (place.address?.text) { const g = await geocodeAddress(place.address.text, city); if (g) return { ...g, location_name: place.name || s.location_name, method, confidence: g.city_ok ? (official ? 'HIGH' : 'MEDIUM') : 'LOW', evidence: { jsonld_place_address: place.address.text, page: pageUrl } }; }
  }
  const maps = extractMapLinks(html);
  for (const m of maps) {
    if (m.coords) {
      const rc = await reverseCity(m.coords.lat, m.coords.lng);
      const ok = !s.city || cityAgrees(rc, s.city);
      return { location_name: s.location_name || m.query || null, address: m.query && !/^-?\d/.test(m.query) ? m.query : null, city: normalizeCityName(s.city || rc), lat: m.coords.lat, lng: m.coords.lng, venue_id: null, method, confidence: ok ? 'HIGH' : 'LOW', evidence: { map_link: m.url, reverse_city: rc, page: pageUrl } };
    }
    if (m.query && !/^-?\d/.test(m.query)) { const g = await geocodeAddress(m.query, s.city); if (g) return { ...g, location_name: s.location_name || m.query, method, confidence: g.city_ok ? 'MEDIUM' : 'LOW', evidence: { map_query: m.query, page: pageUrl } }; }
  }
  const text = pageText(html);
  for (const a of extractAddressTexts(text, { city: s.city })) {
    if (s.city && a.city && !cityAgrees(a.city, s.city)) continue;
    const g = await geocodeAddress(a.text, s.city || a.city);
    if (g) return { ...g, location_name: s.location_name || null, address: g.address || a.text, method, confidence: g.city_ok ? (official ? 'HIGH' : 'MEDIUM') : 'LOW', evidence: { address_text: a.text, page: pageUrl } };
  }
  return null;
}

// several venues/cities packed into one "address" (touring shows) - not a single place
function isMultiVenueListing(loc) {
  if (!loc) return false;
  return [loc.name, loc.address?.text, loc.address?.city].some((x) => x && (x.match(/,/g) || []).length >= 3);
}

// geocode a street address; the result must be a street-level hit in the expected city (no centroid fallback)
async function geocodeAddress(text, city) {
  if (!text || text.length > 80 || (text.match(/,/g) || []).length > 2) return null; // not an address
  const q = city && !text.includes(city) ? `${text}, ${city}` : text;
  const rows = await geocodeText(q);
  const hit = rows.find((r) => !ADMIN_TYPES.has(r.type) && inIsrael(r));
  if (!hit) return null;
  const city_ok = !city || cityAgrees(hit.city, city);
  return { address: hit.road ? `${hit.road}${hit.houseNumber ? ' ' + hit.houseNumber : ''}` : text, city: normalizeCityName(city || hit.city), lat: hit.lat, lng: hit.lng, venue_id: null, city_ok, evidence_geocode: hit.displayName };
}

async function fetchPage(url, budget, cache) {
  if (budget.pages <= 0) return { _error: 'page budget exhausted' };
  budget.pages--;
  if (cache && cache.has('page:' + url)) return cache.get('page:' + url);
  const r = await fetchHtml(url);
  if (cache) cache.set('page:' + url, r);
  return r;
}

async function stageSourcePage(s, budget, cache) {
  const r = await fetchPage(s.page_url, budget, cache);
  if (r._error) return r;
  if (!r.ok || !r.html) return { _error: `page ${r.status || r.error}` };
  return evidenceFromPage(r.html, s.page_url, s, false, 'source_page');
}

// the listing card that names this event links to its detail page - that is where the address is
async function stageDetailPage(s, budget, cache) {
  const r = await fetchPage(s.page_url, budget, cache);
  if (r._error) return r;
  if (!r.ok || !r.html) return { _error: `page ${r.status || r.error}` };
  const card = findEventCard(r.html, s.page_url, s.name);
  if (!card.detailUrl) return { _skipped: 'no event card / detail link on the listing page' };
  const r2 = await fetchPage(card.detailUrl, budget, cache);
  if (r2._error) return r2;
  if (!r2.ok || !r2.html) return { _error: `detail page ${r2.status || r2.error}` };
  const found = await evidenceFromPage(r2.html, card.detailUrl, s, false, 'detail_page');
  if (found) found.evidence = { ...(found.evidence || {}), detail_url: card.detailUrl, card_score: card.score };
  return found;
}

async function stageVenueSite(client, s, venue, budget, cache) {
  const site = venue?.website_url || venue?.events_url;
  if (!site) return { _skipped: 'venue has no website_url/events_url' };
  const r = await fetchPage(site, budget, cache);
  if (r._error) return r;
  if (!r.ok || !r.html) return { _error: `venue site ${r.status || r.error}` };
  let found = await evidenceFromPage(r.html, site, { ...s, location_name: venue.name_he, city: venue.city || s.city }, true, 'venue_site');
  if (!found && budget.pages > 0) {
    const m = /href=["']([^"']*(?:contact|about|צור-קשר|צור_קשר|אודות|הגעה|directions|location)[^"']*)["']/i.exec(r.html);
    if (m) { let u; try { u = new URL(m[1], site).toString(); } catch { u = null; } if (u) { const r2 = await fetchPage(u, budget, cache); if (!r2._error && r2.ok && r2.html) found = await evidenceFromPage(r2.html, u, { ...s, location_name: venue.name_he, city: venue.city || s.city }, true, 'venue_site'); } }
  }
  if (found && found.confidence === 'HIGH' && venue.lat == null) {
    // reusable knowledge: the venue now has an official address (only from its own site, only HIGH, fill-null)
    await client.from('venues').update({ lat: found.lat, lng: found.lng, address: venue.address || found.address, updated_at: new Date().toISOString() }).eq('id', venue.id).is('lat', null);
    found.venue_id = venue.id;
  }
  return found;
}

async function placeLookup(label, city, method) {
  const rows = await geocodeText(`${label}, ${city}`);
  const hits = rows.filter((r) => !ADMIN_TYPES.has(r.type) && inIsrael(r));
  if (!hits.length) return null;
  const good = hits.filter((r) => cityAgrees(r.city, city));
  if (good.length === 1 || (good.length > 1 && haversineKm(good[0].lat, good[0].lng, good[1].lat, good[1].lng) < 0.3)) {
    const h = good[0];
    return { location_name: label, address: h.road ? `${h.road}${h.houseNumber ? ' ' + h.houseNumber : ''}` : null, city: normalizeCityName(city), lat: h.lat, lng: h.lng, venue_id: null, method, confidence: 'MEDIUM', evidence: { nominatim: h.displayName, type: h.type } };
  }
  if (good.length > 1) return { location_name: label, address: null, city: normalizeCityName(city), lat: null, lng: null, venue_id: null, method, confidence: 'LOW', evidence: { ambiguous: good.slice(0, 3).map((g) => g.displayName) }, ambiguous: true };
  return null;
}

async function stagePlaceLookup(s) {
  if (!s.location_name) return { _skipped: 'no location label' };
  if (!s.city) return { _skipped: 'no city (place lookup needs label + city)' };
  return placeLookup(s.location_name, s.city, 'place_lookup');
}

// no city: (a) the source's other activities are 80%+ in one city, (b) the label alone is a unique
// venue-type hit in Israel (a named theatre/museum/library) - MEDIUM at best, never a city centroid
async function stagePlaceLookupInferred(client, s) {
  if (!s.location_name) return { _skipped: 'no location label' };
  if (s.city) return { _skipped: 'city known - covered by place_lookup' };
  const inf = await inferCityFromSource(client, s.source_id);
  if (inf) {
    const r = await placeLookup(s.location_name, inf.city, 'place_lookup_inferred');
    if (r) { r.evidence = { ...(r.evidence || {}), city_inferred: inf }; return r; }
  }
  const rows = await geocodeText(s.location_name);
  const hits = rows.filter((r) => !ADMIN_TYPES.has(r.type) && inIsrael(r) && VENUE_TYPES.has(r.type));
  if (hits.length === 1) {
    const h = hits[0];
    return { location_name: s.location_name, address: h.road ? `${h.road}${h.houseNumber ? ' ' + h.houseNumber : ''}` : null, city: normalizeCityName(h.city), lat: h.lat, lng: h.lng, venue_id: null, method: 'place_lookup_inferred', confidence: 'MEDIUM', evidence: { nominatim: h.displayName, type: h.type, unique_label: true } };
  }
  if (hits.length > 1) return { location_name: s.location_name, address: null, city: null, lat: null, lng: null, venue_id: null, method: 'place_lookup_inferred', confidence: 'LOW', evidence: { ambiguous: hits.slice(0, 3).map((g) => g.displayName) }, ambiguous: true };
  return null;
}

// Which evidence stages can run for this subject right now (before fetching anything). `venueKnown`
// is only known after `existing` ran, so venue_site is decided inside resolveLocation.
function stageAvailability(subject) {
  const why = {};
  if (!subject.page_url) { why.source_page = 'no page_url'; why.detail_page = 'no page_url'; }
  if (!subject.location_name) { why.place_lookup = 'no location label'; why.place_lookup_inferred = 'no location label'; }
  else if (!subject.city) why.place_lookup = 'no city (place lookup needs label + city)';
  else why.place_lookup_inferred = 'city known - covered by place_lookup';
  return why;
}

// subject: { name, location_name, city, organizer_name, page_url, source_id, source_venue_id }
// opts.stages: ordered subset of STAGES to consider (lifecycle picks the untried ones per attempt)
// opts.maxEvidenceStages: how many evidence stages may actually run this attempt (default 2)
// -> { result, tried: [stage], skipped: [{stage, why}], errors: [], venue }
async function resolveLocation(client, subject, opts = {}) {
  const s = { ...subject, city: normalizeCityName(subject.city || null) };
  const stages = opts.stages || STAGES;
  // coordinates known to be weak (a city centroid): evidence that merely repeats them is no evidence -
  // another activity of the same source sitting on the same centroid must not "verify" this one
  const avoid = opts.avoidCoords && opts.avoidCoords.lat != null ? opts.avoidCoords : null;
  const repeatsWeak = (r) => avoid && r && r.lat != null && haversineKm(Number(r.lat), Number(r.lng), Number(avoid.lat), Number(avoid.lng)) < 0.02;
  const budget = { pages: opts.maxPages ?? 4 };
  const cache = opts.cache || new Map();
  const counters = opts.counters || null;
  const tried = []; const skipped = []; const errors = [];
  let venue = null; let best = null; let ran = 0;
  const maxRun = opts.maxEvidenceStages ?? 2;
  const rank = (c) => ({ HIGH: 3, MEDIUM: 2, LOW: 1 })[c] || 0;
  // a missing_venue case is only done when the result carries a venue - a HIGH address without one
  // must not stop the search (it did: source_page never ran for missing_venue, batch 2 2026-09-14)
  const done = () => best && best.confidence === 'HIGH' && (!opts.needVenue || best.venue_id);
  const consider = (stage, r) => {
    if (!r) return;
    if (r._error) { errors.push(`${stage}: ${r._error}`); return; }
    if (r._skipped) { skipped.push({ stage, why: r._skipped }); tried.splice(tried.lastIndexOf(stage), 1); ran--; return; }
    if (repeatsWeak(r)) { errors.push(`${stage}: evidence repeats the known-weak coordinates (${r.method})`); return; }
    if (!best || rank(r.confidence) > rank(best.confidence) || (opts.needVenue && r.venue_id && !best.venue_id)) best = r;
  };
  const pre = stageAvailability(s);

  if (stages.includes('existing')) {
    if (!s.city) { const inf = await inferCityFromSource(client, s.source_id); if (inf) { s.city = inf.city; s.city_inferred = inf; } }
    tried.push('existing');
    const r = await stageExisting(client, s, counters);
    if (r) { venue = r.venue || null; consider('existing', r); }
    if (done()) return finish(best, tried, skipped, errors, venue);
  }
  for (const stage of stages) {
    if (stage === 'existing') continue;
    if (done()) break;
    if (ran >= maxRun) break;
    if (pre[stage]) { skipped.push({ stage, why: pre[stage] }); continue; }
    if (stage === 'venue_site' && !venue) { skipped.push({ stage, why: 'no canonical venue for this label yet' }); continue; }
    tried.push(stage); ran++;
    if (stage === 'source_page') consider(stage, await stageSourcePage(s, budget, cache));
    else if (stage === 'detail_page') consider(stage, await stageDetailPage(s, budget, cache));
    else if (stage === 'venue_site') consider(stage, await stageVenueSite(client, s, venue, budget, cache));
    else if (stage === 'place_lookup') consider(stage, await stagePlaceLookup(s));
    else if (stage === 'place_lookup_inferred') consider(stage, await stagePlaceLookupInferred(client, s));
  }
  return finish(best, tried, skipped, errors, venue);
}
function finish(best, tried, skipped, errors, venue) { return { result: best && best.lat != null ? strip(best) : (best ? { ...strip(best), lat: null, lng: null } : null), tried, skipped, errors, venue: venue ? { id: venue.id, name_he: venue.name_he } : null }; }
function strip(r) { const { venue, city_ok, evidence_geocode, ...rest } = r; if (evidence_geocode) rest.evidence = { ...(rest.evidence || {}), geocode: evidence_geocode }; return rest; }

module.exports = { resolveLocation, STAGES, EVIDENCE_STAGES, EXTERNAL_LIMIT, geocodeAddress, geocodeText, cityAgrees, coordsForVenue, inferCityFromSource, stageAvailability, placeLookup, ADMIN_TYPES };
