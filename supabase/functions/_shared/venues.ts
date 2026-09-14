// TuRu - canonical venue resolution (WHERE an activity physically happens). See migration 0076 for
// the model. Matching is deliberately conservative: an extracted location_name is linked to a
// venue only through an exact match on a curated normalized alias, and only when the city agrees
// (or one side has no city). Two venues sharing an alias in different cities with no city hint =>
// null (ambiguous, never an unsafe auto-link). The Node mirror is tools/import-tool/venueNaming.js
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

// deno-lint-ignore no-explicit-any
export async function resolveVenue(client: any, input: { locationName: string | null | undefined; city: string | null | undefined }): Promise<ResolvedVenue | null> {
  const norm = normalizeVenueAlias(input.locationName);
  if (!norm) return null;
  const city = normalizeCityName(input.city || null);
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
