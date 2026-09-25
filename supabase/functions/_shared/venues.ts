// TuRu - canonical venue resolution (WHERE an activity physically happens). See migration 0076 for
// the model. Matching is deliberately conservative: an extracted location_name is linked to a
// venue only through an exact match on a curated normalized alias, and only when the city agrees
// (or one side has no city). Two venues sharing an alias in different cities with no city hint =>
// null (ambiguous, never an unsafe auto-link). A generic label ("ספרייה") never links through an alias:
// no city => null, with a city => the city's only venue of that type (R2/R3 below). The Node mirror
// is tools/import-tool/venueNaming.js
// - keep both normalizers identical (same two-runtime copy pattern as cityNaming/playgroundNaming).

import { normalizeCityName } from './cityNaming.ts';

// Common generic prefixes that vary between how a venue writes its own name and how a
// municipality/aggregator refers to it ("קניון רננים" / "רננים"). Stripped ONLY from the very start.
const GENERIC_PREFIXES = [
  'המרכז המסחרי', 'מרכז מסחרי', 'מרכז הקניות', 'מרכז קניות', 'קניון', 'מתחם', 'מול', 'פארק המסחר', 'מרכז',
];

export function normalizeVenueAlias(name: string | null | undefined): string {
  let s = (name || '').toLowerCase().trim();
  if (!s) return '';
  s = s.replace(/[׳״"'`’‘“”]/g, ''); // gershayim/geresh/quotes
  s = s.replace(/[-–—_/\\|.,:;!?()\[\]{}]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  for (const p of GENERIC_PREFIXES) {
    if (s.startsWith(p + ' ') && s.length > p.length + 2) { s = s.slice(p.length + 1).trim(); break; }
  }
  // leading definite article on the remaining first word ("הספרייה" -> "ספרייה")
  s = s.replace(/^ה(?=[א-ת]{3,})/, '');
  return s;
}

// GENERIC VENUE LABELS (R2/R3, Phase 1 libraries golden cases L-A..L-C, 2026-09-25). A label that names
// only a KIND of place ("ספרייה", "הספרייה העירונית") identifies no venue by itself: it must never link
// through a globally-unique alias, and with a city it links only to the city's single venue of that
// type. Keys are normalizeVenueAlias output (leading ה already stripped); both spellings are listed
// explicitly instead of folded, so normalizeVenueAlias - and every stored alias_normalized - is unchanged.
// Phase 1 is libraries only: do not add a word here without its own golden cases (venues.cases.json).
export const GENERIC_VENUE_LABEL_TYPES: ReadonlyMap<string, string> = new Map([
  ['ספרייה', 'library'], ['ספריה', 'library'],
  ['ספרייה עירונית', 'library'], ['ספריה עירונית', 'library'],
  ['ספרייה העירונית', 'library'], ['ספריה העירונית', 'library'],
]);

// The venue_type a generic label stands for, or null for a specific (or empty) label.
export function genericVenueType(name: string | null | undefined): string | null {
  const norm = normalizeVenueAlias(name);
  return (norm && GENERIC_VENUE_LABEL_TYPES.get(norm)) || null;
}

export interface ResolvedVenue { id: string; name_he: string; city: string | null; venue_type: string; lat: number | null; lng: number | null; address?: string | null }

// "תל אביב" vs "תל אביב יפו", "מודיעין" vs "מודיעין מכבים רעות": the shorter canonical form is a
// prefix/substring of the longer one. Exact after normalizeCityName, else containment (>= 3 chars).
export function cityMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeCityName(a || null) || '';
  const nb = normalizeCityName(b || null) || '';
  if (!na || !nb) return true; // one side unknown - don't block on it
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  return short.length >= 3 && (long === short || long.startsWith(short + ' ') || long.endsWith(' ' + short) || long.includes(' ' + short + ' '));
}

// Strict city identity for the generic-label rule: both sides known and equal after normalizeCityName
// (which already folds the canonical short forms תל אביב/מודיעין/קדימה). cityMatches' "one side unknown"
// pass and word containment ("יבנה" ~ "גן יבנה", "נצרת" ~ "נצרת עילית") are safe for a curated
// specific alias, not for a label that names only a kind of place.
export function sameCityStrict(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeCityName(a || null) || '';
  const nb = normalizeCityName(b || null) || '';
  return !!na && na === nb;
}

// R3: the city's single active, non-merged venue of the type - 0 or several => null (never first, never
// nearest, never the source's venue).
// deno-lint-ignore no-explicit-any
async function resolveGenericInCity(client: any, venueType: string, city: string): Promise<ResolvedVenue | null> {
  const { data, error } = await client
    .from('venues')
    .select('id, name_he, city, venue_type, lat, lng, address, is_active, merged_into')
    .eq('venue_type', venueType)
    .eq('is_active', true)
    .is('merged_into', null);
  if (error || !data) return null;
  // deno-lint-ignore no-explicit-any
  const inCity: ResolvedVenue[] = (data as any[])
    .filter((v) => v && v.is_active && !v.merged_into && v.venue_type === venueType && sameCityStrict(v.city, city));
  return inCity.length === 1 ? inCity[0] : null;
}

// deno-lint-ignore no-explicit-any
export async function resolveVenue(client: any, input: { locationName: string | null | undefined; city: string | null | undefined }): Promise<ResolvedVenue | null> {
  const norm = normalizeVenueAlias(input.locationName);
  if (!norm) return null;
  const city = normalizeCityName(input.city || null);
  // Generic label: R2 no city => null before any alias lookup (a globally-unique generic alias is a trap,
  // not evidence); R3 with a city => by type only - a generic alias row never decides.
  const genericType = genericVenueType(input.locationName);
  if (genericType) return city ? resolveGenericInCity(client, genericType, city) : null;
  const { data, error } = await client
    .from('venue_aliases')
    .select('venue:venues!inner(id, name_he, city, venue_type, lat, lng, address, is_active)')
    .eq('alias_normalized', norm);
  if (error || !data) return null;
  // deno-lint-ignore no-explicit-any
  const venues: ResolvedVenue[] = (data as any[])
    .map((r) => r.venue)
    .filter((v) => v && v.is_active);
  if (venues.length === 0) return null;
  if (city) {
    const sameCity = venues.filter((v) => cityMatches(v.city, city));
    if (sameCity.length === 1) return sameCity[0];
    return null; // none (alias belongs to another city) or several (ambiguous) - never guess
  }
  return venues.length === 1 ? venues[0] : null; // no city hint: only an unambiguous alias links
}
