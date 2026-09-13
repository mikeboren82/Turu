// TuRu Cleaner - address resolution pipeline (THE-CLEANER.md §4-7). Stages, in order:
//   1 existing Turu data  (canonical venues/aliases, the source's own venue, prior activities of the
//                          same source with the same location label, existing location rows)
//   2 source page         (JSON-LD Event/Place, Google-Maps links, Hebrew street text, og)
//   3 official venue site (venue.website_url / contact page)
//   4 place lookup        (Nominatim "<name>, <city>" WITHOUT the city-centroid fallback; a result
//                          that is itself a city/administrative area is rejected)
// Every result: { location_name, address, city, lat, lng, venue_id, method, confidence, evidence }.
// HIGH/MEDIUM are publishable, LOW is evidence only. Nothing is fabricated: no result => null.
// Reuses the ingestion normalization (cityNaming, venueNaming) - no second normalizer.
const { normalizeCityName } = require('../cityNaming');
const { resolveVenue } = require('../venueNaming');
const { fetchHtml } = require('../lib/fetchPage');
const { extractJsonLd, extractMapLinks, extractAddressTexts, pageText, inIsrael } = require('./pageEvidence');
const { wordOverlapScore, haversineKm } = require('./matching');

const STAGES = ['existing_venue', 'existing_source_venue', 'prior_activity', 'existing_location', 'source_page', 'venue_site', 'place_lookup'];

// ---- Nominatim (same public endpoint/UA as server.js geocodeLocation; throttled) ----
let lastNominatim = 0;
async function nominatim(pathAndQuery) {
  const wait = 1100 - (Date.now() - lastNominatim);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();
  const res = await fetch(`https://nominatim.openstreetmap.org${pathAndQuery}`, { headers: { 'User-Agent': 'TuRu-KidsApp/1.0 (contact: mborenmusic@gmail.com)', 'Accept-Language': 'he' }, signal: AbortSignal.timeout(12000) });
  if (!res.ok) return null;
  return res.json();
}
const ADMIN_TYPES = new Set(['city', 'town', 'village', 'suburb', 'administrative', 'municipality', 'county', 'state', 'neighbourhood', 'quarter', 'hamlet', 'locality']);
async function geocodeText(text) {
  const rows = await nominatim(`/search?format=jsonv2&limit=3&countrycodes=il&addressdetails=1&q=${encodeURIComponent(text + ', ישראל')}`);
  return (rows || []).map((r) => ({ lat: Number(r.lat), lng: Number(r.lon), displayName: r.display_name, type: r.type, category: r.category, city: r.address?.city || r.address?.town || r.address?.village || r.address?.municipality || null, road: r.address?.road || null, houseNumber: r.address?.house_number || null, importance: r.importance }));
}
async function reverseCity(lat, lng) {
  const r = await nominatim(`/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1`);
  return r?.address ? (r.address.city || r.address.town || r.address.village || r.address.municipality || null) : null;
}
const cityAgrees = (a, b) => { const x = normalizeCityName(a || null), y = normalizeCityName(b || null); if (!x || !y) return false; return x === y || x.includes(y) || y.includes(x); };

// A canonical venue without coordinates: geocode its own address (HIGH) or its name in its city
// (MEDIUM) right now instead of leaving every event at that venue waiting - and keep the HIGH
// result on the venue so the next hundred items resolve from stage 1 (source-aware learning).
async function coordsForVenue(client, venue, cityHint) {
  if (venue.lat != null && venue.lng != null) return { lat: venue.lat, lng: venue.lng, address: venue.address || null, confidence: 'HIGH', how: 'venue' };
  const city = venue.city || cityHint;
  // Turu's own verified locations already linked to this venue (each was geocoded/approved on its
  // own): their median is the venue's position - no external call, and it is written back to the venue
  const { data: linked } = await client.from('locations').select('lat, lng, address').eq('venue_id', venue.id).not('lat', 'is', null).limit(50);
  if (linked && linked.length) {
    const lats = linked.map((l) => Number(l.lat)).sort((a, b) => a - b), lngs = linked.map((l) => Number(l.lng)).sort((a, b) => a - b);
    const lat = lats[Math.floor(lats.length / 2)], lng = lngs[Math.floor(lngs.length / 2)];
    const spreadOk = haversineKm(lats[0], lngs[0], lats[lats.length - 1], lngs[lngs.length - 1]) < 1.5;
    if (spreadOk) {
      const address = venue.address || (linked.find((l) => l.address)?.address ?? null);
      await client.from('venues').update({ lat, lng, address, updated_at: new Date().toISOString() }).eq('id', venue.id);
      return { lat, lng, address, confidence: 'HIGH', how: `linked_locations(${linked.length})` };
    }
  }
  if (venue.address) {
    const g = await geocodeAddress(venue.address, city);
    if (g && g.city_ok) { await client.from('venues').update({ lat: g.lat, lng: g.lng, updated_at: new Date().toISOString() }).eq('id', venue.id); return { lat: g.lat, lng: g.lng, address: venue.address, confidence: 'HIGH', how: 'venue_address_geocoded' }; }
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

// ---- stage 1: existing data ----
async function stageExisting(client, s) {
  const out = [];
  if (!s.city) { const inf = await inferCityFromSource(client, s.source_id); if (inf) { s.city = inf.city; s.city_inferred = inf; } }
  for (const [label, kind] of [[s.location_name, 'existing_venue'], [s.organizer_name, 'existing_venue'], [s.name, 'existing_venue']]) {
    if (!label) continue;
    const v = await resolveVenue(client, { locationName: label, city: s.city });
    if (v) {
      const full = await client.from('venues').select('id, name_he, city, address, lat, lng, website_url, events_url').eq('id', v.id).maybeSingle();
      const venue = full.data || v;
      const co = await coordsForVenue(client, venue, s.city);
      out.push({ location_name: venue.name_he, address: co?.address || venue.address || null, city: normalizeCityName(venue.city || s.city), lat: co?.lat ?? null, lng: co?.lng ?? null, venue_id: venue.id, method: kind, confidence: co ? co.confidence : 'LOW', evidence: { alias_of: label, venue: venue.name_he, coords: co?.how || 'none', geocode: co?.geocode, city_inferred: s.city_inferred }, venue });
      break;
    }
  }
  if (!out.length && s.source_venue_id) {
    const { data: venue } = await client.from('venues').select('id, name_he, city, address, lat, lng, website_url, events_url').eq('id', s.source_venue_id).maybeSingle();
    if (venue) { const co = await coordsForVenue(client, venue, s.city); out.push({ location_name: s.location_name || venue.name_he, address: co?.address || venue.address || null, city: normalizeCityName(venue.city || s.city), lat: co?.lat ?? null, lng: co?.lng ?? null, venue_id: venue.id, method: 'existing_source_venue', confidence: co ? co.confidence : 'LOW', evidence: { source_venue: venue.name_he, coords: co?.how || 'none', geocode: co?.geocode }, venue }); }
  }
  if (!out.length && s.location_name && s.source_id) {
    // the same source published this label before and it was resolved then
    const { data } = await client.from('activities').select('id, name, venue_id, locations!inner(name, address, city, lat, lng)').eq('source_id', s.source_id).eq('status', 'approved').ilike('locations.name', s.location_name).not('locations.lat', 'is', null).limit(3);
    const prior = (data || []).find((a) => !s.city || cityAgrees(a.locations.city, s.city));
    if (prior) out.push({ location_name: prior.locations.name, address: prior.locations.address || null, city: normalizeCityName(prior.locations.city), lat: prior.locations.lat, lng: prior.locations.lng, venue_id: prior.venue_id || null, method: 'prior_activity', confidence: prior.locations.address ? 'HIGH' : 'MEDIUM', evidence: { prior_activity_id: prior.id, prior_name: prior.name } });
  }
  if (!out.length && s.location_name) {
    const { data } = await client.from('locations').select('id, name, address, city, lat, lng, venue_id').ilike('name', s.location_name).not('lat', 'is', null).limit(5);
    const loc = (data || []).find((l) => !s.city || cityAgrees(l.city, s.city));
    if (loc) out.push({ location_name: loc.name, address: loc.address || null, city: normalizeCityName(loc.city || s.city), lat: loc.lat, lng: loc.lng, venue_id: loc.venue_id || null, method: 'existing_location', confidence: loc.address ? 'HIGH' : 'MEDIUM', evidence: { location_id: loc.id } });
  }
  return out[0] || null;
}

// ---- evidence from one HTML page (stage 2 and 3 share it) ----
async function evidenceFromPage(html, pageUrl, s, official) {
  const ld = extractJsonLd(html);
  // JSON-LD event whose name matches, else a single event on the page
  const evs = ld.events.filter((e) => e.location && (e.location.geo || e.location.address));
  let ev = evs.find((e) => wordOverlapScore(e.name, s.name) >= 0.5) || (evs.length === 1 ? evs[0] : null);
  if (ev) {
    const addr = ev.location.address; const geo = ev.location.geo;
    const city = normalizeCityName(addr?.city || s.city || null);
    if (geo && inIsrael(geo)) return { location_name: ev.location.name || s.location_name, address: addr?.text || null, city, lat: geo.lat, lng: geo.lng, venue_id: null, method: official ? 'venue_site' : 'source_page', confidence: 'HIGH', evidence: { jsonld_event: ev.name, page: pageUrl } };
    if (addr?.text) { const g = await geocodeAddress(addr.text, city); if (g) return { ...g, location_name: ev.location.name || s.location_name, method: official ? 'venue_site' : 'source_page', confidence: g.city_ok ? 'HIGH' : 'MEDIUM', evidence: { jsonld_address: addr.text, page: pageUrl } }; }
  }
  const place = ld.places.find((p) => p.geo || p.address?.text);
  if (place) {
    const city = normalizeCityName(place.address?.city || s.city || null);
    if (place.geo && inIsrael(place.geo)) return { location_name: place.name || s.location_name, address: place.address?.text || null, city, lat: place.geo.lat, lng: place.geo.lng, venue_id: null, method: official ? 'venue_site' : 'source_page', confidence: official ? 'HIGH' : 'MEDIUM', evidence: { jsonld_place: place.name, page: pageUrl } };
    if (place.address?.text) { const g = await geocodeAddress(place.address.text, city); if (g) return { ...g, location_name: place.name || s.location_name, method: official ? 'venue_site' : 'source_page', confidence: g.city_ok ? (official ? 'HIGH' : 'MEDIUM') : 'LOW', evidence: { jsonld_place_address: place.address.text, page: pageUrl } }; }
  }
  const maps = extractMapLinks(html);
  for (const m of maps) {
    if (m.coords) {
      const rc = await reverseCity(m.coords.lat, m.coords.lng);
      const ok = !s.city || cityAgrees(rc, s.city);
      return { location_name: s.location_name || m.query || null, address: m.query && !/^-?\d/.test(m.query) ? m.query : null, city: normalizeCityName(s.city || rc), lat: m.coords.lat, lng: m.coords.lng, venue_id: null, method: official ? 'venue_site' : 'source_page', confidence: ok ? 'HIGH' : 'LOW', evidence: { map_link: m.url, reverse_city: rc, page: pageUrl } };
    }
    if (m.query && !/^-?\d/.test(m.query)) { const g = await geocodeAddress(m.query, s.city); if (g) return { ...g, location_name: s.location_name || m.query, method: official ? 'venue_site' : 'source_page', confidence: g.city_ok ? 'MEDIUM' : 'LOW', evidence: { map_query: m.query, page: pageUrl } }; }
  }
  const text = pageText(html);
  for (const a of extractAddressTexts(text, { city: s.city })) {
    if (s.city && a.city && !cityAgrees(a.city, s.city)) continue;
    const g = await geocodeAddress(a.text, s.city || a.city);
    if (g) return { ...g, location_name: s.location_name || null, address: g.address || a.text, method: official ? 'venue_site' : 'source_page', confidence: g.city_ok ? (official ? 'HIGH' : 'MEDIUM') : 'LOW', evidence: { address_text: a.text, page: pageUrl } };
  }
  return null;
}

// geocode a street address; the result must be a street-level hit in the expected city (no centroid fallback)
async function geocodeAddress(text, city) {
  const q = city && !text.includes(city) ? `${text}, ${city}` : text;
  const rows = await geocodeText(q);
  const hit = rows.find((r) => !ADMIN_TYPES.has(r.type) && inIsrael(r));
  if (!hit) return null;
  const city_ok = !city || cityAgrees(hit.city, city);
  return { address: hit.road ? `${hit.road}${hit.houseNumber ? ' ' + hit.houseNumber : ''}` : text, city: normalizeCityName(city || hit.city), lat: hit.lat, lng: hit.lng, venue_id: null, city_ok, evidence_geocode: hit.displayName };
}

async function stageSourcePage(s, budget) {
  if (!s.page_url || budget.pages <= 0) return null;
  budget.pages--;
  const r = await fetchHtml(s.page_url);
  if (!r.ok || !r.html) return { _error: `page ${r.status || r.error}` };
  return evidenceFromPage(r.html, s.page_url, s, false);
}

async function stageVenueSite(client, s, venue, budget) {
  const site = venue?.website_url || venue?.events_url;
  if (!site || budget.pages <= 0) return null;
  budget.pages--;
  const r = await fetchHtml(site);
  if (!r.ok || !r.html) return { _error: `venue site ${r.status || r.error}` };
  let found = await evidenceFromPage(r.html, site, { ...s, location_name: venue.name_he, city: venue.city || s.city }, true);
  if (!found && budget.pages > 0) {
    const m = /href=["']([^"']*(?:contact|about|צור-קשר|צור_קשר|אודות|הגעה|directions|location)[^"']*)["']/i.exec(r.html);
    if (m) { let u; try { u = new URL(m[1], site).toString(); } catch { u = null; } if (u) { budget.pages--; const r2 = await fetchHtml(u); if (r2.ok && r2.html) found = await evidenceFromPage(r2.html, u, { ...s, location_name: venue.name_he, city: venue.city || s.city }, true); } }
  }
  if (found && found.confidence === 'HIGH' && venue.lat == null) {
    // reusable knowledge: the venue now has an official address (only from its own site, only HIGH)
    await client.from('venues').update({ lat: found.lat, lng: found.lng, address: venue.address || found.address, updated_at: new Date().toISOString() }).eq('id', venue.id);
    found.venue_id = venue.id;
  }
  return found;
}

async function stagePlaceLookup(s) {
  if (!s.location_name || !s.city) return null;
  const rows = await geocodeText(`${s.location_name}, ${s.city}`);
  const hits = rows.filter((r) => !ADMIN_TYPES.has(r.type) && inIsrael(r));
  if (!hits.length) return null;
  const good = hits.filter((r) => cityAgrees(r.city, s.city));
  if (good.length === 1 || (good.length > 1 && haversineKm(good[0].lat, good[0].lng, good[1].lat, good[1].lng) < 0.3)) {
    const h = good[0];
    return { location_name: s.location_name, address: h.road ? `${h.road}${h.houseNumber ? ' ' + h.houseNumber : ''}` : null, city: normalizeCityName(s.city), lat: h.lat, lng: h.lng, venue_id: null, method: 'place_lookup', confidence: 'MEDIUM', evidence: { nominatim: h.displayName, type: h.type } };
  }
  if (good.length > 1) return { location_name: s.location_name, address: null, city: normalizeCityName(s.city), lat: null, lng: null, venue_id: null, method: 'place_lookup', confidence: 'LOW', evidence: { ambiguous: good.slice(0, 3).map((g) => g.displayName) }, ambiguous: true };
  return null;
}

// subject: { name, location_name, city, organizer_name, page_url, source_id, source_venue_id }
// opts.stages: subset of STAGES to run (retry policy picks different stages per attempt)
async function resolveLocation(client, subject, opts = {}) {
  const s = { ...subject, city: normalizeCityName(subject.city || null) };
  const stages = opts.stages || STAGES;
  const budget = { pages: opts.maxPages ?? 3 };
  const tried = []; const errors = [];
  let venue = null; let best = null;
  const consider = (r) => { if (!r) return; if (r._error) { errors.push(r._error); return; } if (!best || rank(r.confidence) > rank(best.confidence)) best = r; };
  const rank = (c) => ({ HIGH: 3, MEDIUM: 2, LOW: 1 })[c] || 0;

  if (stages.some((x) => x.startsWith('existing') || x === 'prior_activity')) { tried.push('existing'); const r = await stageExisting(client, s); if (r) { venue = r.venue || null; consider(r); } }
  if (best?.confidence === 'HIGH') return finish(best, tried, errors);
  if (stages.includes('source_page')) { tried.push('source_page'); consider(await stageSourcePage(s, budget)); }
  if (best?.confidence === 'HIGH') return finish(best, tried, errors);
  if (stages.includes('venue_site') && venue) { tried.push('venue_site'); consider(await stageVenueSite(client, s, venue, budget)); }
  if (best?.confidence === 'HIGH') return finish(best, tried, errors);
  if (stages.includes('place_lookup') && (!best || best.confidence === 'LOW')) { tried.push('place_lookup'); consider(await stagePlaceLookup(s)); }
  return finish(best, tried, errors);
}
function finish(best, tried, errors) { return { result: best && best.lat != null ? strip(best) : (best ? { ...strip(best), lat: null, lng: null } : null), tried, errors }; }
function strip(r) { const { venue, city_ok, evidence_geocode, ...rest } = r; if (evidence_geocode) rest.evidence = { ...(rest.evidence || {}), geocode: evidence_geocode }; return rest; }

module.exports = { resolveLocation, STAGES, geocodeAddress, cityAgrees };
