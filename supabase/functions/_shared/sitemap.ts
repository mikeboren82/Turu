// TuRu - THE MONSTER: SITEMAP DISCOVERY (wave 2, discovery-gap regression: cochav-hanofesh.com/parks).
// A listing page that loads its cards by script exposes a fraction of the publisher's entities to an HTML
// scan (9 of 54 parks). The publisher's own sitemap is the legitimate, machine-readable index of what exists.
// sources.adapter_config.sitemap = { url, section?, max_per_scan? }  ->  the entity pages themselves become
// the scanned pages. Bounded and incremental: a scan takes at most max_per_scan pages, NEVER-SCANNED pages
// first (coverage grows every scan), then the ones fetched longest ago (unchanged pages cost one hash compare).
// Pure functions - the fetch and the snapshot lookup stay in scan-source.
export interface SitemapConfig { url: string; section?: string; max_per_scan?: number }

const decode = (u: string) => { try { return decodeURIComponent(u); } catch { return u; } };

// <loc> URLs of a urlset, optionally only the entity pages of one section ("parks" -> .../parks/<slug>/ ;
// the section index itself and deeper paths are not entities). Order preserved, duplicates dropped.
export function parseSitemapUrls(xml: string, section?: string | null): string[] {
  const out: string[] = []; const seen = new Set<string>();
  const sec = (section || '').replace(/^\/+|\/+$/g, '');
  const re = sec ? new RegExp(`/${sec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^/]+/?$`) : null;
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const raw = m[1].replace(/&amp;/g, '&');
    if (!/^https?:\/\//i.test(raw)) continue;
    if (re && !re.test(decode(raw))) continue;
    const key = decode(raw).replace(/\/$/, '');
    if (seen.has(key)) continue; seen.add(key);
    out.push(raw);
  }
  return out;
}

// is this a sitemap INDEX (it lists other sitemaps, not pages)?
export const isSitemapIndex = (xml: string) => /<sitemapindex[\s>]/i.test(xml);

// which pages does THIS scan take? never-scanned first, then oldest fetch first; at most `max`.
export function orderForIncrementalScan(urls: string[], lastFetchedAt: Map<string, string | null>, max: number): { picked: string[]; neverScanned: number } {
  const norm = (u: string) => decode(u).replace(/\/$/, '');
  const known = new Map<string, string | null>(); for (const [u, t] of lastFetchedAt) known.set(norm(u), t);
  const fresh = urls.filter((u) => !known.has(norm(u)));
  const seenBefore = urls.filter((u) => known.has(norm(u))).sort((a, b) => String(known.get(norm(a)) || '').localeCompare(String(known.get(norm(b)) || '')));
  return { picked: [...fresh, ...seenBefore].slice(0, Math.max(1, max)), neverScanned: fresh.length };
}
