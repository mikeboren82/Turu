// TuRu - JSON-LD Event reader for THE MONSTER (scan-source). Deno twin of the Event/Place subset of
// tools/import-tool/lib/pageExtract.js extractJsonLd (the Cleaner's shared page-evidence module) -
// keep the two in lockstep. Pure: no network, no DB.
//
// Why: 624 of 757 live activities had no street address (audit 2026-09-14). Ticketing/municipal
// pages often carry schema.org Event blocks with PostalAddress / GeoCoordinates / startDate that the
// AI extraction never sees. Filling those deterministically at ingestion prevents Cleaner debt.
// Fill-null only: nothing the extractor already found is overwritten.

export interface JsonLdEvent {
  name: string | null;
  startDate: string | null;
  location: { name: string | null; street: string | null; city: string | null; addressText: string | null; lat: number | null; lng: number | null } | null;
}

// deno-lint-ignore no-explicit-any
function flatten(node: any, out: any[] = []): any[] {
  if (!node) return out;
  if (Array.isArray(node)) { node.forEach((n) => flatten(n, out)); return out; }
  if (typeof node !== 'object') return out;
  out.push(node);
  if (node['@graph']) flatten(node['@graph'], out);
  return out;
}
// deno-lint-ignore no-explicit-any
const typesOf = (n: any): string[] => (Array.isArray(n?.['@type']) ? n['@type'] : [n?.['@type']]).filter(Boolean).map(String);
// deno-lint-ignore no-explicit-any
const str = (v: any): string | null => (typeof v === 'string' ? v.trim() : (v && typeof v === 'object' && typeof v.name === 'string') ? v.name.trim() : null);

// deno-lint-ignore no-explicit-any
export function parseJsonLdEvents(blocks: string[]): JsonLdEvent[] {
  const nodes: any[] = [];
  for (const b of blocks) { try { flatten(JSON.parse(b), nodes); } catch { /* malformed block - ignore */ } }
  const events: JsonLdEvent[] = [];
  for (const n of nodes) {
    if (!typesOf(n).some((t) => /Event$/.test(t))) continue;
    const loc = n.location && typeof n.location === 'object' ? (Array.isArray(n.location) ? n.location[0] : n.location) : null;
    let location: JsonLdEvent['location'] = null;
    if (loc) {
      const a = loc.address;
      const street = a && typeof a === 'object' ? str(a.streetAddress) : null;
      const city = a && typeof a === 'object' ? str(a.addressLocality) : null;
      const addressText = typeof a === 'string' ? a.trim() : [street, city].filter(Boolean).join(', ') || null;
      const lat = Number(loc.geo?.latitude), lng = Number(loc.geo?.longitude);
      const geoOk = Number.isFinite(lat) && Number.isFinite(lng) && lat >= 29.3 && lat <= 33.4 && lng >= 34.2 && lng <= 35.95;
      location = { name: str(loc.name), street, city, addressText, lat: geoOk ? lat : null, lng: geoOk ? lng : null };
    }
    events.push({ name: str(n.name), startDate: typeof n.startDate === 'string' ? n.startDate : null, location });
  }
  return events;
}

// cheerio document -> events (scan-source already has the DOM loaded)
// deno-lint-ignore no-explicit-any
export function extractJsonLdEvents($: any): JsonLdEvent[] {
  const blocks: string[] = [];
  $('script[type="application/ld+json"]').each((_: number, el: unknown) => { const t = $(el).text(); if (t) blocks.push(t); });
  return parseJsonLdEvents(blocks);
}

function overlap(a: string | null, b: string | null): number {
  const norm = (s: string | null) => new Set((s || '').toLowerCase().replace(/[^֐-׿a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 1));
  const wa = norm(a), wb = norm(b);
  if (!wa.size || !wb.size) return 0;
  let c = 0; wa.forEach((w) => { if (wb.has(w)) c++; });
  return c / Math.max(wa.size, wb.size);
}

// A single place, not a touring list: aggregators (Ticketsi, 2026-09-14) put "חולון, רמלה, טבריה, ..."
// (22 cities) into streetAddress/addressLocality of one Event. Such values are not a location.
export function isSinglePlace(s: string | null | undefined): boolean {
  if (!s) return false;
  const t = s.trim();
  return t.length <= 60 && (t.match(/,/g) || []).length <= 1;
}
export function isMultiVenueListing(ev: JsonLdEvent): boolean {
  const l = ev.location;
  return !!l && [l.name, l.city, l.street].some((s) => s && (s.match(/,/g) || []).length >= 3);
}

// Fill-null: address (street + number only), lat/lng (geo), one_time_date/start_time (startDate),
// location_name/city when the extractor left them empty - and only single-place values.
// Returns the field names filled.
// deno-lint-ignore no-explicit-any
export function applyJsonLdToCandidate(candidate: Record<string, any>, events: JsonLdEvent[]): string[] {
  if (!events.length || !candidate.name) return [];
  const ev = events.find((e) => overlap(e.name, candidate.name) >= 0.5) || (events.length === 1 ? events[0] : null);
  if (!ev) return [];
  const filled: string[] = [];
  const l = ev.location;
  if (l && isMultiVenueListing(ev)) { candidate.jsonld_multi_venue = true; }
  else if (l) {
    if (!candidate.address && l.street && /\d/.test(l.street) && isSinglePlace(l.street)) { candidate.address = l.street; filled.push('address'); }
    if (!candidate.location_name && isSinglePlace(l.name)) { candidate.location_name = l.name; filled.push('location_name'); }
    if (!candidate.city && isSinglePlace(l.city) && !/\d/.test(l.city || '')) { candidate.city = l.city; filled.push('city'); }
    if (candidate.lat == null && l.lat != null) { candidate.lat = l.lat; candidate.lng = l.lng; filled.push('geo'); }
  }
  if (ev.startDate && /^\d{4}-\d{2}-\d{2}/.test(ev.startDate)) {
    if (candidate.schedule_type === 'one_time' && !candidate.one_time_date) { candidate.one_time_date = ev.startDate.slice(0, 10); filled.push('one_time_date'); }
    const t = /T(\d{2}:\d{2})/.exec(ev.startDate);
    if (t && !candidate.start_time && candidate.schedule_type === 'one_time') { candidate.start_time = t[1]; filled.push('start_time'); }
  }
  return filled;
}
