// Sitemap discovery (THE MONSTER wave 2) - fixture shaped like cochav-hanofesh.com/parks-sitemap.xml.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseSitemapUrls, orderForIncrementalScan, isSitemapIndex } from "./sitemap.ts";

const XML = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://site.example/parks/</loc></url>
<url><loc>https://site.example/parks/%D7%92%D7%9F-%D7%94%D7%95%D7%95%D7%A8%D7%93%D7%99%D7%9D/</loc></url>
<url><loc>https://site.example/parks/park-b/</loc></url>
<url><loc>https://site.example/parks/park-b</loc></url>
<url><loc>https://site.example/parks/park-c/gallery/</loc></url>
<url><loc>https://site.example/tracks/track-1/</loc></url>
<url><loc>javascript:alert(1)</loc></url>
</urlset>`;

Deno.test("a section's ENTITY pages only: not the section index, not deeper paths, not other sections, no duplicates", () => {
  assertEquals(parseSitemapUrls(XML, "parks"), ["https://site.example/parks/%D7%92%D7%9F-%D7%94%D7%95%D7%95%D7%A8%D7%93%D7%99%D7%9D/", "https://site.example/parks/park-b/"]);
  assertEquals(parseSitemapUrls(XML, "/parks/").length, 2, "slashes around the section name are tolerated");
  assertEquals(parseSitemapUrls(XML).length, 5, "without a section every http(s) page is returned once");
  assertEquals(isSitemapIndex("<sitemapindex><sitemap><loc>x</loc></sitemap></sitemapindex>"), true);
  assertEquals(isSitemapIndex(XML), false);
});

Deno.test("incremental and bounded: never-scanned pages first, then the oldest fetch; at most max per scan", () => {
  const urls = ["https://s/parks/a/", "https://s/parks/b/", "https://s/parks/c/", "https://s/parks/d/"];
  const seen = new Map<string, string | null>([["https://s/parks/a", "2026-09-10T00:00:00Z"], ["https://s/parks/c/", "2026-09-01T00:00:00Z"]]);
  const first = orderForIncrementalScan(urls, seen, 3);
  assertEquals(first.neverScanned, 2);
  assertEquals(first.picked, ["https://s/parks/b/", "https://s/parks/d/", "https://s/parks/c/"], "b, d never scanned; then c (older than a)");
  assertEquals(orderForIncrementalScan(urls, new Map(), 2).picked.length, 2);
  assertEquals(orderForIncrementalScan(urls, new Map(), 0).picked.length, 1, "a scan always advances by at least one page");
});
