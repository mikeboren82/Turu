// TuRu - the ONE canonical locality resolution layer (Node side). Raw locality text (geocoder output,
// a Google formatted-address token, a venue city, an extracted city) -> a real settlement from
// public.settlements (CBS list, 0063) through explicit knowledge only:
//   exact normalized Hebrew name  >  public.settlement_aliases (0072, curated in the DB)
//   >  merged-authority aliases (the legacy knowledge of import-playgrounds-osm.js /
//      lib/filterActivities.js CITY_ALIAS_GROUPS)  >  exact CBS English name.
// Never fuzzy: an unknown locality resolves to null and the caller must not write it.
// An administrative area ("מועצה אזורית X") is NOT a settlement - flagged, never returned as a city.
// The Deno twin of the same idea is the injected SettlementResolver of _shared/placesDiscovery.ts.
// Pure index (testable without a DB) + a loader.
const { normalizeCityName } = require('../cityNaming');

// CBS "לשכה" (settlements.region) -> TuRu region; same table the frozen OSM importer and the
// extraction prompt use.
const LISHKA_TO_TURU_REGION = {
  'אילת': 'הדרום והנגב', 'אריאל': 'יו"ש והבנימין', 'אשדוד': 'השפלה',
  'אשקלון': 'הדרום והנגב', 'באר שבע': 'הדרום והנגב', 'בית שמש': 'ירושלים והסביבה',
  'בני ברק': 'גוש דן והמרכז', 'הרצליה': 'גוש דן והמרכז', 'חדרה': 'השרון',
  'חולון': 'גוש דן והמרכז', 'חיפה': 'חיפה והקריות', 'טבריה': 'עמק יזרעאל והעמקים',
  'ירושלים': 'ירושלים והסביבה', 'כפר סבא': 'השרון', 'כרמיאל': 'הצפון והגליל',
  'נוף הגליל': 'הצפון והגליל', 'נתניה': 'השרון', 'עכו': 'הצפון והגליל',
  'עפולה': 'עמק יזרעאל והעמקים', 'פתח תקוה': 'גוש דן והמרכז', 'צפת': 'הצפון והגליל',
  'קריות': 'חיפה והקריות', 'ראש העין': 'גוש דן והמרכז', 'ראשון לציון': 'גוש דן והמרכז',
  'רחובות': 'השפלה', 'רמלה': 'השפלה', 'רמת גן': 'גוש דן והמרכז',
  'ת"א - מרכז': 'גוש דן והמרכז',
};

// merged authorities: half of the official name is what OSM / Google / sources usually carry
const MERGED_AUTHORITY_ALIASES = {
  'קדימה': 'קדימה-צורן', 'צורן': 'קדימה-צורן',
  'תל אביב': 'תל אביב - יפו', 'יפו': 'תל אביב - יפו',
  'בנימינה': 'בנימינה-גבעת עדה', 'גבעת עדה': 'בנימינה-גבעת עדה',
  'פרדס חנה': 'פרדס חנה-כרכור', 'כרכור': 'פרדס חנה-כרכור',
  'מכבים רעות': 'מודיעין-מכבים-רעות', 'רעות': 'מודיעין-מכבים-רעות', 'מכבים': 'מודיעין-מכבים-רעות', 'מודיעין': 'מודיעין-מכבים-רעות',
  'יהוד': 'יהוד-מונוסון', 'מונוסון': 'יהוד-מונוסון', 'נווה מונוסון': 'יהוד-מונוסון',
  'כוכב יאיר': 'כוכב יאיר', 'צור יגאל': 'כוכב יאיר',
  'עופרים': 'בית אריה', 'בית אריה עופרים': 'בית אריה',
  'מעלות': 'מעלות-תרשיחא', 'תרשיחא': 'מעלות-תרשיחא',
  'נצרת עילית': 'נוף הגליל',
};

const PLACEHOLDER_CITIES = new Set(['-', '--', '?', 'null', 'undefined', 'n/a', 'na', 'none', 'unknown', 'לא ידוע', 'לא צוין', 'ישראל', 'israel', 'ארץ ישראל']);
const ADMIN_AREA_RE = /^(מועצה\s+(אזורית|מקומית|איזורית)|מ\.?\s?א\.?\s|נפת\s|מחוז\s)|regional council|sub-?district|district$/i;

// NULL / '' / whitespace / a known placeholder. A legitimate unusual locality is NOT missing.
function isMissingCity(city) {
  if (city == null) return true;
  const s = String(city).trim();
  if (!s) return true;
  return PLACEHOLDER_CITIES.has(s.toLowerCase());
}

const isAdministrativeArea = (raw) => !!raw && ADMIN_AREA_RE.test(String(raw).trim());
const adminAreaName = (raw) => { const m = /^מועצה\s+(?:אזורית|איזורית|מקומית)\s+(.+)$/.exec(String(raw || '').trim()); return m ? m[1].trim() : null; };

// CITY_NOT_CANONICAL: why a stored locations.city is not the canonical settlement value; null when it is.
//   administrative_area  "מועצה אזורית X" (a council is not a city; `council` = X)
//   variant              resolves to a settlement under another spelling / alias (`canonical` = the value to store)
//   unresolved           no settlement knows this string (script noted: Arabic-script OSM values, Latin, typos)
function classifyCityValue(index, city) {
  if (!index || !index.size || isMissingCity(city)) return null;
  const raw = String(city).trim();
  if (isAdministrativeArea(raw)) return { kind: 'administrative_area', council: adminAreaName(raw) };
  const s = resolveSettlement(index, raw);
  if (s) return s.city === raw ? null : { kind: 'variant', canonical: s.city, settlement_id: s.settlement_id, how: s.how };
  const script = /[؀-ۿ]/.test(raw) ? 'arabic' : /[֐-׿]/.test(raw) ? 'hebrew' : /[a-zA-Z]/.test(raw) ? 'latin' : 'other';
  return { kind: 'unresolved', script };
}

// comparison key: canonical city normalization + quote/geresh/parenthesis noise removed
function heKey(s) {
  let v = normalizeCityName(String(s || '')) || '';
  v = v.replace(/\([^)]*\)/g, ' ').replace(/["'`״׳’]/g, '').replace(/\s+/g, ' ').trim();
  return v;
}
const enKey = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

// rows: settlements (settlement_id, name_he, name_en, council, region, population, lat, lng); aliasRows: settlement_aliases
function buildSettlementIndex(rows, aliasRows = []) {
  const byId = new Map(), byHe = new Map(), byEn = new Map(), byAlias = new Map();
  const ambiguousEn = new Set();
  for (const r of rows || []) {
    const s = { settlement_id: String(r.settlement_id), name_he: r.name_he, city: normalizeCityName(r.name_he), name_en: r.name_en || null, council: r.council || null, region: LISHKA_TO_TURU_REGION[r.region] || null, population: r.population ?? null, lat: r.lat ?? null, lng: r.lng ?? null };
    byId.set(s.settlement_id, s);
    const k = heKey(r.name_he); if (k && !byHe.has(k)) byHe.set(k, s);
    const e = enKey(r.name_en); if (e.length >= 3) { if (byEn.has(e) && byEn.get(e) !== s) ambiguousEn.add(e); else byEn.set(e, s); }
  }
  for (const e of ambiguousEn) byEn.delete(e);
  for (const [alias, official] of Object.entries(MERGED_AUTHORITY_ALIASES)) { const s = byHe.get(heKey(official)); if (s) byAlias.set(heKey(alias), { s, how: 'merged_authority_alias' }); }
  // the curated DB table wins over the built-in list
  for (const a of aliasRows || []) { const s = byId.get(String(a.settlement_id)); if (!s) continue; byAlias.set(heKey(a.alias_name), { s, how: 'settlement_alias' }); const e = enKey(a.alias_name); if (e.length >= 3 && !/[֐-׿]/.test(a.alias_name)) byAlias.set('en:' + e, { s, how: 'settlement_alias' }); }
  return { byId, byHe, byEn, byAlias, size: byId.size };
}

// -> { settlement_id, city (canonical value for locations.city), name_he, region, lat, lng, population, how, raw, normalized } | null
function resolveSettlement(index, raw) {
  if (!index || isMissingCity(raw) || isAdministrativeArea(raw)) return null;
  const normalized = heKey(raw);
  const out = (s, how) => ({ ...s, how, raw: String(raw), normalized });
  if (/[֐-׿]/.test(normalized)) {
    const alias = byAliasGet(index, normalized); if (alias && alias.how === 'settlement_alias') return out(alias.s, alias.how);
    const exact = index.byHe.get(normalized); if (exact) return out(exact, 'exact');
    if (alias) return out(alias.s, alias.how);
    return null;
  }
  const e = enKey(raw); if (e.length < 3) return null;
  const a = index.byAlias.get('en:' + e); if (a) return out(a.s, a.how);
  const en = index.byEn.get(e); if (en) return out(en, 'english_exact');
  return null;
}
const byAliasGet = (index, k) => index.byAlias.get(k) || null;

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// how far from its CBS centroid a point may be and still plausibly belong to the settlement.
// public.settlements.population is not populated (2026-09-17), so the size proxy is the KIND of
// locality the evidence named: a geocoder 'city' boundary (Jerusalem spans ~20 km) / 'town' / anything smaller.
const RADIUS_KM = { city: 15, town: 9, text: 9, small: 3.5 };
function plausibleRadiusKm(kind) { return RADIUS_KM[kind] || RADIUS_KM.small; }
// -> { km, withinKm, plausible } | null when the settlement has no centroid
function centroidCheck(s, lat, lng, kind = 'small') {
  if (!s || s.lat == null || s.lng == null || lat == null || lng == null) return null;
  const km = haversineKm(Number(s.lat), Number(s.lng), Number(lat), Number(lng));
  const withinKm = plausibleRadiusKm(kind);
  return { km: Math.round(km * 100) / 100, withinKm, plausible: km <= withinKm };
}
function nearestSettlements(index, lat, lng, n = 3) {
  const out = [];
  for (const s of index.byId.values()) { if (s.lat == null) continue; out.push({ settlement_id: s.settlement_id, city: s.city, council: s.council, region: s.region, km: Math.round(haversineKm(s.lat, s.lng, lat, lng) * 100) / 100 }); }
  return out.sort((a, b) => a.km - b.km).slice(0, n);
}

const ADDRESS_NOISE = /^(ישראל|israel|\d{5,7}|[A-Z0-9]{4}\+[A-Z0-9]{2,3}.*)$/i; // country, postal code, plus code
// last resolvable comma token of the address whose centroid is plausible for these coordinates.
// A street that merely shares a settlement's name ("נגה", "רחובות") fails the centroid check.
function settlementFromAddress(index, address, lat, lng) {
  if (!address) return null;
  const tokens = String(address).split(',').map((t) => t.trim()).filter((t) => t && !ADDRESS_NOISE.test(t));
  const rejected = [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    const s = resolveSettlement(index, tokens[i]); if (!s) continue;
    const c = centroidCheck(s, lat, lng, 'city'); // coarse gate only; the final limit depends on the evidence kind
    if (c && !c.plausible) { rejected.push({ token: tokens[i], city: s.city, km: c.km }); continue; }
    // a single-token address is usually a bare street name from reverse geocoding - only a token that
    // follows a street part ("X, City") or a plausible centroid counts as locality evidence
    if (tokens.length === 1 && !c) continue;
    return { settlement: s, token: tokens[i], centroid: c, rejected, single: tokens.length === 1 };
  }
  return rejected.length ? { settlement: null, rejected } : null;
}


async function pageAll(client, table, select) {
  let from = 0, rows = [];
  while (true) { const { data, error } = await client.from(table).select(select).range(from, from + 999); if (error) throw new Error(table + ': ' + error.message); rows = rows.concat(data || []); if (!data || data.length < 1000) return rows; from += 1000; }
}
let cached = null;
async function loadSettlementIndex(client, { fresh = false } = {}) {
  if (cached && !fresh) return cached;
  const [rows, aliases] = await Promise.all([pageAll(client, 'settlements', 'settlement_id, name_he, name_en, council, region, population, lat, lng'), pageAll(client, 'settlement_aliases', 'alias_name, settlement_id')]);
  cached = buildSettlementIndex(rows, aliases);
  return cached;
}

// The SHARED resolver learns a locality string from a HIGH Cleaner repair ONLY when every published
// location carrying that exact string lies within the settlement's widest plausible radius (one string
// = one place). Never an administrative area, never a string with digits/commas, never from a value the
// index already resolves. The alias makes the Monster and the Cleaner agree next time (0072 table).
// generic geographic words are never an alias of one settlement ("גולן" is a region, "צפון" a direction)
const GENERIC_GEO = new Set(['צפון', 'דרום', 'מרכז', 'מזרח', 'מערב', 'גולן', 'גליל', 'נגב', 'שרון', 'שפלה', 'ערבה', 'יהודה', 'שומרון', 'בקעה', 'כרמל', 'עמק', 'הר', 'חוף', 'ים המלח', 'ישראל', 'israel', 'north', 'south', 'center', 'galilee', 'negev', 'golan']);
const tokens = (s) => heKey(s).split(' ').filter((t) => t.length >= 2);
function aliasRelatesToSettlement(raw, S) {
  const hebrew = /[֐-׿]/.test(raw);
  if (!hebrew) return true; // Arabic / Latin / Cyrillic spellings of the same place carry no shared Hebrew token by nature
  const a = tokens(raw), b = new Set([...tokens(S.name_he), ...tokens(S.city)]);
  return a.some((t) => b.has(t)) || a.some((t) => [...b].some((x) => x.length >= 4 && t.length >= 4 && (x.startsWith(t) || t.startsWith(x)))); // "טירת הכרמל"/"טירת כרמל", "יוקנעם"/"יקנעם" (no) -> shared "עילית"
}
async function learnSettlementAlias(client, index, alias, settlementId, { notes } = {}) {
  const raw = String(alias || '').trim();
  if (!raw || raw.length < 2 || isAdministrativeArea(raw) || /[\d,]/.test(raw)) return { learned: false, why: 'not_a_locality_string' };
  if (GENERIC_GEO.has(heKey(raw)) || GENERIC_GEO.has(raw.toLowerCase())) return { learned: false, why: 'generic_geographic_word' };
  if (resolveSettlement(index, raw)) return { learned: false, why: 'already_resolves' };
  const S = index.byId.get(String(settlementId));
  if (!S || S.lat == null) return { learned: false, why: 'settlement_without_centroid' };
  // a string that is part of ANOTHER settlement's name ("שער חפר" in "בית יצחק-שער חפר") is that settlement's, not this one's
  const k = heKey(raw);
  for (const other of index.byId.values()) { if (other.settlement_id !== S.settlement_id && k.length >= 4 && heKey(other.name_he).includes(k)) return { learned: false, why: `substring of another settlement name (${other.city})` }; }
  if (!aliasRelatesToSettlement(raw, S)) return { learned: false, why: 'hebrew string shares no token with the settlement name (historical / neighbourhood names need a person)' };
  const { data: rows, error } = await client.from('locations').select('lat, lng, activities!inner(status)').eq('city', raw).eq('activities.status', 'approved').limit(500);
  if (error) throw error;
  const far = (rows || []).filter((r) => r.lat != null && haversineKm(S.lat, S.lng, Number(r.lat), Number(r.lng)) > RADIUS_KM.city);
  if (far.length) return { learned: false, why: `${far.length} of ${rows.length} published locations with this value lie > ${RADIUS_KM.city} km from ${S.city}`, checked: rows.length };
  const { error: e2 } = await client.from('settlement_aliases').upsert({ alias_name: raw, settlement_id: S.settlement_id, notes: notes || 'learned by THE CLEANER (city_not_canonical)' }, { onConflict: 'alias_name' });
  if (e2) throw e2;
  cached = null; // the shared index must see the new alias on its next load
  return { learned: true, checked: (rows || []).length, city: S.city };
}

// Prevention for the create path (THE MONSTER, Node approve): a location about to be stored with
// coordinates but no city gets the canonical city from knowledge already in hand - the canonical
// venue's city, else the "street, city" tail of its address validated against the CBS centroid.
// No geocoder call here (publishing never waits on an external service); whatever stays empty is
// picked up by the Cleaner's missing_city case.
async function canonicalCityFallback(client, { venueId = null, address = null, lat = null, lng = null } = {}) {
  try {
    const index = await loadSettlementIndex(client);
    if (venueId) { const { data: venue } = await client.from('venues').select('city').eq('id', venueId).maybeSingle(); const s = resolveSettlement(index, venue?.city); if (s) return { city: s.city, region: s.region, how: 'venue' }; }
    const a = settlementFromAddress(index, address, lat, lng);
    if (a && a.settlement && !a.single && a.centroid && a.centroid.km <= RADIUS_KM.text) return { city: a.settlement.city, region: a.settlement.region, how: 'address' };
  } catch { /* prevention is best effort - never blocks a publish */ }
  return null;
}

module.exports = { settlementFromAddress, canonicalCityFallback, buildSettlementIndex, resolveSettlement, loadSettlementIndex, isMissingCity, isAdministrativeArea, adminAreaName, classifyCityValue, learnSettlementAlias, centroidCheck, nearestSettlements, plausibleRadiusKm, haversineKm, heKey, RADIUS_KM, LISHKA_TO_TURU_REGION, MERGED_AUTHORITY_ALIASES };
