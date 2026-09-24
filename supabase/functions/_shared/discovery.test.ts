import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as cheerio from "npm:cheerio@1.0.0";
import { discoverListingLinks, canonicalPageKey } from "./discovery.ts";
import { cheapDiscoverLinks } from "./extraction.ts";

// Same cases as tools/import-tool/tests/discovery.test.js - the Node twin must agree.
const HOLON = "https://www.holon.muni.il/Havingfun/pages/allevents.aspx";
const html = (anchors: [string, string][]) => `<body>${anchors.map(([h, t]) => `<a href="${h}">${t}</a>`).join("")}</body>`;
const discover = (seed: string, anchors: [string, string][], max = 7) => discoverListingLinks(cheerio.load(html(anchors)), seed, max);

Deno.test("SharePoint /Pages/ navigation is not admitted merely because the URL contains 'page'", () => {
  assertEquals(discover(HOLON, [
    ["/Residents/Emergency/Pages/default.aspx", "חירום וביטחון"],
    ["/CityHall/Pages/ClickService.aspx", "חולון בקליק"],
    ["/Residents/TaxesWater/Pages/default.aspx", "ארנונה"],
    ["/Residents/Pages/Payments.aspx", "תשלומים"],
    ["/Residents/enforce/Pages/ParkingReports.aspx", 'דו"חות חנייה'],
    ["/_catalogs/masterpage/", ""],
    ["/Pages/Home.aspx", "עמוד הבית"],
  ]), []);
});

Deno.test("seed self-link differing only by case is one logical page", () => {
  assertEquals(discover(HOLON, [["/Havingfun/Pages/AllEvents.aspx", "אירועים בעיר"], ["https://holon.muni.il/HAVINGFUN/pages/allevents.aspx/", "לוח אירועים"]]), []);
});

Deno.test("legitimate event / pagination links are retained", () => {
  assertEquals(discover("https://city.example/events", [
    ["/events/summer", "אירועי קיץ"],
    ["/calendar?month=10", "לוח שנה"],
    ["/events?page=2", "2"],
    ["/list/p2", "עמוד 2"],
    ["/Pages/KidsActivities.aspx", "פעילויות לילדים"],
  ]), ["https://city.example/events/summer", "https://city.example/calendar?month=10", "https://city.example/events?page=2", "https://city.example/list/p2", "https://city.example/Pages/KidsActivities.aspx"]);
});

Deno.test("kids/show listings kept without 'page': show keywords and whole-anchor kids labels, but not welfare / kindergarten pages", () => {
  const found = discover("https://matnaskg.smarticket.co.il/", [
    ["/ילדים_page_17", "ילדים"],
    ["/הצגות_ילדים_page_44", "הצגות ילדים"],
    ["/show-pages", "הופעות לפי תאריך"],
    ["/סטנדאפ_page_26", "סטנדאפ"],
    ["/גני-ילדים", "רישום לגני ילדים"],
    ["/פרט-ומשפחה", "פרט ומשפחה"],
    ["/צור_קשר_page_56", "צור קשר"],
  ]);
  assertEquals(found.map((u) => decodeURIComponent(new URL(u).pathname)), ["/ילדים_page_17", "/הצגות_ילדים_page_44", "/show-pages"]);
});

Deno.test("distinct query strings stay distinct; tracking params, fragments, trailing slash and www do not", () => {
  assertEquals(discover("https://city.example/", [
    ["/event?id=1", "אירוע"], ["/event?id=2", "אירוע"], ["/event?id=1&utm_source=fb", "אירוע"],
    ["/events/", "אירועים"], ["https://www.city.example/events#top", "אירועים"],
  ]), ["https://city.example/event?id=1", "https://city.example/event?id=2", "https://city.example/events/"]);
});

Deno.test("canonicalPageKey", () => {
  assertEquals(canonicalPageKey("https://www.Holon.muni.il/Havingfun/Pages/AllEvents.aspx#x"), "holon.muni.il/havingfun/pages/allevents.aspx");
  assertEquals(canonicalPageKey("http://holon.muni.il/havingfun/pages/allevents.aspx/"), "holon.muni.il/havingfun/pages/allevents.aspx");
  assertEquals(canonicalPageKey("https://a.b/x?ID=AbC&gclid=1"), "a.b/x?ID=AbC");
  assertNotEquals(canonicalPageKey("https://a.b/x?id=1"), canonicalPageKey("https://a.b/x?id=2"));
  assertEquals(canonicalPageKey("https://a.b/"), "a.b/");
});

Deno.test("cheapDiscoverLinks (heavy pages): seed case variant is not rediscovered, a real events link is", () => {
  assertEquals(cheapDiscoverLinks(html([["/Havingfun/Pages/AllEvents.aspx", "אירועים בעיר"], ["/Events/Summer", "event"]]), HOLON, 7), ["https://www.holon.muni.il/Events/Summer"]);
});
