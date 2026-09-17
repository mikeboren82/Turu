// Dense-listing recall (THE MONSTER wave 2): deterministic card enumeration, funnel accounting and the
// bounded recovery window. Run with `deno test --allow-read supabase/functions/_shared/`.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as cheerio from "npm:cheerio@1.0.0";
import { enumerateListingCards, cardAccounting, cardWindows, cardsLookLikeEvents } from "./listingCards.ts";

const card = (i: number, title: string, extra = "") => `<a href="/event/${i}" class="col-xs-12 show wow pulse default"><div class="pic"><img src="/img/${i}.jpg"><span class="date">${10 + i}<span>אוקטובר</span></span></div><div class="details-container"><h2>${title}</h2><div class="category">ילדים ומשפחה</div><div class="details">מרכז קהילתי ${i}, שעה 17:00 ${extra}</div></div></a>`;
const TITLES = ["הצגת ילדים - פיטר פן", "סדנת יצירה בחימר", "שעת סיפור עם דנה", "מופע קסמים לכל המשפחה", "קונצרט לקטנטנים", "סיור לילה במוזיאון", "ג'ימבורי פתוח", "תיאטרון בובות - הזחל הרעב"];
const page = (cards: string) => `<html><body><nav><a class="m" href="/a">ראשי</a><a class="m" href="/b">אודות</a><a class="m" href="/c">צור קשר</a><a class="m" href="/d">נגישות</a><a class="m" href="/e">מכרזים</a></nav><div class="content">${cards}</div><footer><a href="/x">תקנון</a></footer></body></html>`;

Deno.test("repeated cards are enumerated from the DOM with title, text, url and image; navigation is never a card", () => {
  const $ = cheerio.load(page(TITLES.map((t, i) => card(i, t)).join("\n")));
  const cards = enumerateListingCards($, "https://tickets.example.muni.il/kids");
  assertEquals(cards.length, 8);
  assertEquals(cards[0].title, "הצגת ילדים - פיטר פן");
  assertEquals(cards[0].url, "https://tickets.example.muni.il/event/0");
  assertEquals(cards[0].image, "https://tickets.example.muni.il/img/0.jpg");
  assert(cards[0].text.includes("מרכז קהילתי 0"));
  assert(!cards.some((c) => c.title === "אודות"));
  assert(cardsLookLikeEvents(cards));
});

Deno.test("the real Ra'anana listing fixture yields its cards (heading wins over the date badge)", async () => {
  const html = await Deno.readTextFile(new URL("./fixtures/raanana-listing.html", import.meta.url));
  // the trimmed fixture keeps 4 of the page's cards
  const cards = enumerateListingCards(cheerio.load(html), "https://tickets.raanana.muni.il/ילדים_ומשפחה", { minGroup: 3 });
  assert(cards.length >= 3, `cards: ${cards.length}`);
  assert(cards.some((c) => c.title.includes("גולי והגיטרה")), cards.map((c) => c.title).join(" | "));
  assert(cards.every((c) => !/^\d/.test(c.title)), "a date badge is never the title");
});

Deno.test("a page without a repeated structure yields no cards (the text-window path stays as it was)", () => {
  const $ = cheerio.load(`<html><body><div class="content"><h1>חוות הסוסים</h1><p>פתוח כל יום. <a href="/contact">צור קשר</a></p><a class="btn" href="/tickets">כרטיסים</a></div></body></html>`);
  assertEquals(enumerateListingCards($, "https://farm.example.co.il/").length, 0);
});

Deno.test("a venue label repeated on every card is not the title; glued inline spans are separated", () => {
  const cards = [0, 1, 2, 3, 4, 5].map((i) => `<div class="show_cube col-sm-4"><div class="date">1${i} אוקטובר</div><a href="/show/${i}"><span>מופע מספר ${["אחת", "שתיים", "שלוש", "ארבע", "חמש", "שש"][i]}</span><span>אורח מיוחד</span></a><div class="venue">היכל התרבות</div></div>`).join("");
  const out = enumerateListingCards(cheerio.load(page(cards)), "https://hall.example.co.il/");
  assertEquals(out.length, 6);
  assert(out[0].title.startsWith("מופע מספר אחת"), out[0].title);
  assert(out[0].title.includes("אחת אורח") || out[0].title === "מופע מספר אחת", "inline spans are separated by a space: " + out[0].title);
  assert(!out.some((c) => c.title === "היכל התרבות"));
});

Deno.test("accounting: extracted names account for their cards; the rest is listed for ONE bounded recovery window", () => {
  const cards = enumerateListingCards(cheerio.load(page(TITLES.map((t, i) => card(i, t)).join("\n"))), "https://x.example/");
  const acc = cardAccounting(cards, ["פיטר פן - הצגת ילדים", "סדנת יצירה בחימר", "שעת סיפור עם דנה", "מופע קסמים לכל המשפחה", "קונצרט לקטנטנים", "ג'ימבורי פתוח"]);
  assertEquals(acc.matched, 6);
  assertEquals(acc.unaccounted, ["סיור לילה במוזיאון", "תיאטרון בובות - הזחל הרעב"]);
  const w = cardWindows(acc.unaccountedCards, 18000, 12);
  assertEquals(w.length, 1);
  assert(w[0].includes("בקטע זה 2 כרטיסי") && w[0].includes("### כרטיס 1") && w[0].includes("קישור: https://x.example/event/5"));
});

Deno.test("card windows never split a card and respect the per-window and size limits", () => {
  const many = enumerateListingCards(cheerio.load(page(Array.from({ length: 30 }, (_, i) => card(i, `אירוע ייחודי מספר ${i} לילדים`, "תיאור ".repeat(40))).join(""))), "https://x.example/");
  assertEquals(many.length, 30);
  const w = cardWindows(many, 18000, 12);
  assertEquals(w.length, 3);
  for (const win of w) assert(win.length <= 18000);
  assertEquals(w.join("\n").match(/### כרטיס \d+/g)!.length, 30);
});

Deno.test("service tiles (no dates) are measured but never worth a recovery call", () => {
  const tiles = ["תשלום ארנונה", "רישום לגנים", "דיווח על מפגע", "טפסים מקוונים", "מכרזים פעילים", "דרושים בעירייה"].map((t, i) => `<div class="tile box"><a href="/s/${i}">${t}</a><p>שירות מקוון לתושבי העיר ולבעלי עסקים</p></div>`).join("");
  const cards = enumerateListingCards(cheerio.load(page(tiles)), "https://muni.example/");
  assertEquals(cardsLookLikeEvents(cards), false);
});

Deno.test("event-like detection works on NUMERIC dates and times alone (17.09.2026 | 09:00), not only month names", () => {
  const cards = [0, 1, 2, 3, 4, 5].map((i) => `<a class="event" href="/e/${i}"><span>מופע ייחודי ${["אלף", "בית", "גימל", "דלת", "הא", "וו"][i]}</span><span>1${i}.09.2026 | 0${i}:30 | מרכז קהילתי</span></a>`).join("");
  const out = enumerateListingCards(cheerio.load(page(cards)), "https://city.example/calendar");
  assertEquals(out.length, 6);
  assert(cardsLookLikeEvents(out), "numeric dates must count as event-like");
});
