// TuRu - child relevance evidence hierarchy (2026-09-24): the SAME case table as the Node twin
// (tools/import-tool/tests/childRelevance.test.js) + item-local source context binding (listingCards.ts).
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { childRelevanceEvidence, sourceContextAudience } from "./extraction.ts";
import { itemSourceContext, type ListingCard } from "./listingCards.ts";

const table = JSON.parse(await Deno.readTextFile(new URL("./childRelevance.cases.json", import.meta.url)));
// deno-lint-ignore no-explicit-any
for (const k of table.cases as any[]) {
  Deno.test(`child relevance: ${k.id}`, () => {
    const r = childRelevanceEvidence(k.c);
    assertEquals([r.verdict, r.reason], k.expect);
  });
}

// cards as enumerateListingCards produces them for the Karmiel culture hall (www.htk.co.il, 2026-09-24)
const card = (title: string, lines: string[]): ListingCard => ({ title, text: [title, ...lines].join("\n"), url: null, image: null, signature: "div|show_cube" });
const SHALOM_16 = card("שלום בית", ["קומדיה משפחתית חדשה מאת גלעד שמואלי", "פרטים נוספים", "שלום בית", "עונת תיאטרון 26/27 תיאטרון מופעי בחירה", "היכל התרבות כרמיאל", "ביום שלישי, 16 במרץ 2027", "20:30 - 22:00", "ההצגה היא חלק מעונת התיאטרון 26/27"]);
const SHALOM_17 = card("שלום בית", ["קומדיה משפחתית חדשה מאת גלעד שמואלי", "פרטים נוספים", "שלום בית", "עונת תיאטרון 26/27 תיאטרון מופעי בחירה", "היכל התרבות כרמיאל", "ביום רביעי, 17 במרץ 2027", "20:30 - 22:00"]);
const SMURFS = card("הדרדסים ההצגה - LIVE על הבמה!", ["ניתן לקחת הצגה זאת במסגרת המנוי", "פרטים נוספים", "הצגות ילדים", "היכל התרבות כרמיאל", "ביום חמישי, 29 באוקטובר 2026", "17:30 - 19:00"]);
const CARDS = [SMURFS, SHALOM_16, SHALOM_17];
const shalom = { name: "שלום בית", description: "קומדיה משפחתית חדשה מאת גלעד שמואלי", location_name: "היכל התרבות כרמיאל" };

Deno.test("item-local context: the item's own card labels, never a neighbour's (a kids card sits right before it)", () => {
  const sc = itemSourceContext(CARDS, { ...shalom, one_time_date: "2027-03-16" }, sourceContextAudience);
  assertEquals(sc?.labels, ["עונת תיאטרון 26/27 תיאטרון מופעי בחירה", "ההצגה היא חלק מעונת התיאטרון 26/27"]);
  assertEquals(sourceContextAudience(sc), "adult");
  assertEquals(sourceContextAudience(itemSourceContext(CARDS, { name: "הדרדסים ההצגה - LIVE על הבמה!", one_time_date: "2026-10-29", location_name: "היכל התרבות כרמיאל" }, sourceContextAudience)), "child");
});

Deno.test("item-local context: several nights of one title bind by the item's own date; a season label is not a date", () => {
  const sc17 = itemSourceContext(CARDS, { ...shalom, one_time_date: "2027-03-17" }, sourceContextAudience);
  assertEquals(sc17?.labels, ["עונת תיאטרון 26/27 תיאטרון מופעי בחירה"]);
  // no date on the candidate: usable because every matching card says the same thing
  assertEquals(sourceContextAudience(itemSourceContext(CARDS, shalom, sourceContextAudience)), "adult");
});

Deno.test("item-local context: cards of one title that disagree, and titles not on the page, bind nothing", () => {
  const kidsVersion = card("שלום בית", ["הצגות ילדים", "ביום שישי, 19 במרץ 2027"]);
  assertEquals(itemSourceContext([SHALOM_16, kidsVersion], shalom, sourceContextAudience), null);
  assertEquals(itemSourceContext(CARDS, { name: "מופע שלא קיים בעמוד" }, sourceContextAudience), null);
});

Deno.test("scan-source binds the item context BEFORE its relevance gate", async () => {
  const src = await Deno.readTextFile(new URL("../scan-source/index.ts", import.meta.url));
  const bind = src.indexOf("candidate.source_context = sc;"), gate = src.indexOf("const relevance = assessChildRelevance(candidate);");
  assertEquals(bind > 0 && bind < gate, true);
});
