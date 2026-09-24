// TuRu - CONTINUOUS MONSTER: bounded source discovery helpers (pure, testable). Candidates come from OpenStreetMap
// venue records that carry a website (ODbL, free, provenance = the OSM element id): community centres, libraries,
// theatres, museums, zoos, farms, attractions, malls. Everything here is deterministic; the network parts live in
// discover-sources-osm.js. A candidate is never activated by code - it is registered INACTIVE for a person.
const TAG_QUERIES = [
  { family: 'community_center', publisher_type: 'community_center_network', overpass: 'node["amenity"="community_centre"]["website"]', categories: ['פעילות קהילתית', 'סדנה', 'הצגה'] },
  { family: 'library', publisher_type: 'library_network', overpass: 'node["amenity"="library"]["website"]', categories: ['ספרייה', 'שעת סיפור'] },
  { family: 'theater', publisher_type: 'venue_operator', overpass: 'node["amenity"~"^(theatre|arts_centre)$"]["website"]', categories: ['הצגה', 'מוזיקה'] },
  { family: 'museum', publisher_type: 'venue_operator', overpass: 'node["tourism"~"^(museum|gallery)$"]["website"]', categories: ['מוזיאון לילדים', 'מדע'] },
  { family: 'attraction', publisher_type: 'venue_operator', overpass: 'node["tourism"~"^(zoo|theme_park|attraction|aquarium)$"]["website"]', categories: ['אטרקציה', 'בעלי חיים', 'פארק שעשועים'] },
  { family: 'mall', publisher_type: 'mall_chain', overpass: 'node["shop"="mall"]["website"]', categories: ['פעילות קהילתית', 'יצירה'] },
  { family: 'farm', publisher_type: 'venue_operator', overpass: 'node["tourism"="farm"]["website"],node["leisure"="farm"]["website"]', categories: ['חווה', 'בעלי חיים'] },
];
// ways/relations are queried as centroids ("out center") - the same tag filters with `way` and `relation`
function overpassQuery(tagFilter, bbox, timeout = 60) {
  const [s, w, n, e] = bbox; const filters = tagFilter.split(',');
  const parts = filters.flatMap((f) => ['node', 'way', 'relation'].map((t) => f.replace(/^node/, t) + `(${s},${w},${n},${e});`));
  return `[out:json][timeout:${timeout}];(${parts.join('')});out center tags;`;
}
const hostOf = (u) => { try { return new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };
const SOCIAL_HOSTS = /facebook\.com|instagram\.com|tiktok\.com|youtube\.com|wa\.me|whatsapp\.com|twitter\.com|x\.com|linktr\.ee|waze\.com|google\.com|goo\.gl/i;

// osm element -> candidate | null. Keeps provenance (osm id), requires a non-social website, a name, coordinates.
function candidateFromElement(el, spec) {
  const t = el.tags || {}; const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
  const website = t.website || t['contact:website'] || t.url; const name = t['name:he'] || t.name;
  if (!website || !name || lat == null || lng == null) return null;
  const host = hostOf(website); if (!host || SOCIAL_HOSTS.test(host)) return null;
  return { osm: `${el.type}/${el.id}`, name, name_en: t['name:en'] || null, website: /^https?:\/\//i.test(website) ? website : 'https://' + website, host, lat: Number(lat), lng: Number(lng), city: t['addr:city'] || null, family: spec.family, publisher_type: spec.publisher_type, categories: spec.categories, tags: { amenity: t.amenity, tourism: t.tourism, shop: t.shop, leisure: t.leisure } };
}
// dedupe: same host as an existing source / venue website / another candidate -> known
function dedupeCandidates(cands, knownHosts) {
  const seen = new Set(); const out = [];
  for (const c of cands) { if (!c) continue; if (knownHosts.has(c.host) || seen.has(c.host)) { out.push({ ...c, verdict: 'known_host' }); continue; } seen.add(c.host); out.push(c); }
  return out;
}
// bounding box of a region from the settlements that belong to it (pad by ~5 km); regions without centroids -> null
function regionBbox(settlements, region, pad = 0.05) {
  const pts = settlements.filter((s) => s.region === region && s.lat != null);
  if (pts.length < 3) return null;
  // 5th-95th percentile: one settlement carrying the wrong region label must not widen the box to half the country
  const pct = (arr, q) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * q)))]; };
  const lats = pts.map((s) => s.lat), lngs = pts.map((s) => s.lng);
  return [pct(lats, 0.05) - pad, pct(lngs, 0.05) - pad, pct(lats, 0.95) + pad, pct(lngs, 0.95) + pad];
}
// registry row for an INACTIVE candidate (a person activates it in the admin) - trust below the auto-approve bar.
// Only columns that exist on public.sources (there is no notes column - the verification summary lives in disabled_reason)
function registryRow(c, batch) {
  return { name: c.name, seed_url: c.website, type: 'html', source_kind: 'website', publisher_type: c.publisher_type, publisher_name: c.name, region: c.region || null, categories: c.categories, scan_frequency_hours: 168, priority: 3, source_trust_score: 50, is_trusted: false, is_active: false, strategy: 'generic_html', health_status: 'healthy', disabled_reason: `discovery_candidate: OSM ${c.osm} (${c.family}) - activate after review | verification: ${c.verify ? c.verify.summary : 'n/a'}`, discovery_batch: batch };
}
module.exports = { TAG_QUERIES, overpassQuery, candidateFromElement, dedupeCandidates, regionBbox, registryRow, hostOf };
