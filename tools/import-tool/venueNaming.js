// TuRu - Node/CommonJS mirror of supabase/functions/_shared/venues.ts normalizeVenueAlias (same
// intentional two-runtime copy as cityNaming.js/playgroundNaming.js - Deno can't require() this
// file). Both MUST stay identical in behaviour; tests/venueNaming.test.js pins the shared cases.

const GENERIC_PREFIXES = [
  'המרכז המסחרי', 'מרכז מסחרי', 'מרכז הקניות', 'מרכז קניות', 'קניון', 'מתחם', 'מול', 'פארק המסחר', 'מרכז',
];

function normalizeVenueAlias(name) {
  let s = (name || '').toLowerCase().trim();
  if (!s) return '';
  s = s.replace(/[׳״"'`’‘“”]/g, '');
  s = s.replace(/[-–—_/\\|.,:;!?()\[\]{}]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  for (const p of GENERIC_PREFIXES) {
    if (s.startsWith(p + ' ') && s.length > p.length + 2) { s = s.slice(p.length + 1).trim(); break; }
  }
  s = s.replace(/^ה(?=[א-ת]{3,})/, '');
  return s;
}

// Same rule as _shared/extraction.ts repairHebrewGershayim: a raw ASCII quote with a Hebrew letter
// on both sides can only be an abbreviation (התנ"כי / ע"ש / מתנ"ס), never a JSON delimiter.
function repairHebrewGershayim(raw) {
  return raw.replace(/(?<=[א-ת])"(?=[א-ת])/g, '״');
}

// Mirror of _shared/extraction.ts repairUnescapedQuotes (structural pass for quoted words inside strings).
function repairUnescapedQuotes(raw) {
  let out = '';
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (!inString) { if (ch === '"') inString = true; out += ch; continue; }
    if (ch === '\\') { out += ch + (raw[i + 1] ?? ''); i++; continue; }
    if (ch !== '"') { out += ch; continue; }
    let j = i + 1;
    while (j < raw.length && /\s/.test(raw[j])) j++;
    const next = raw[j];
    if (next === undefined || next === ',' || next === ':' || next === ']' || next === '}') { inString = false; out += ch; }
    else out += '\\"';
  }
  return out;
}

function repairModelJson(raw) {
  return repairUnescapedQuotes(repairHebrewGershayim(raw));
}

// Node mirror of _shared/venues.ts resolveVenue - conservative: exact normalized alias + city
// agreement (or one side without a city); ambiguity => null, never an unsafe auto-link.
async function resolveVenue(client, { locationName, city }) {
  const { normalizeCityName } = require('./cityNaming');
  const norm = normalizeVenueAlias(locationName);
  if (!norm) return null;
  const cityNorm = normalizeCityName(city || null);
  const { data, error } = await client
    .from('venue_aliases')
    .select('venue:venues!inner(id, name_he, city, venue_type, lat, lng, is_active)')
    .eq('alias_normalized', norm);
  if (error || !data) return null;
  const venues = data.map((r) => r.venue).filter((v) => v && v.is_active);
  if (venues.length === 0) return null;
  if (cityNorm) {
    const same = venues.filter((v) => cityMatches(v.city, cityNorm));
    return same.length === 1 ? same[0] : null;
  }
  return venues.length === 1 ? venues[0] : null;
}

// Mirror of _shared/venues.ts cityMatches ("תל אביב" ~ "תל אביב יפו").
function cityMatches(a, b) {
  const { normalizeCityName } = require('./cityNaming');
  const na = normalizeCityName(a || null) || '';
  const nb = normalizeCityName(b || null) || '';
  if (!na || !nb) return true;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  return short.length >= 3 && (long === short || long.startsWith(short + ' ') || long.endsWith(' ' + short) || long.includes(' ' + short + ' '));
}

module.exports = { normalizeVenueAlias, repairHebrewGershayim, repairUnescapedQuotes, repairModelJson, resolveVenue };
