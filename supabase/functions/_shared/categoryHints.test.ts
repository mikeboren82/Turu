// Category hint (Monster <- Cleaner feedback, 2026-09-19): MEDIUM, corroborated only, never a guess.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { hintCategory, NAME_CATEGORY } from "./categoryHints.ts";
import categoryValues from './categoryValues.json' with { type: 'json' };

const ALLOWED: string[] = categoryValues.categories;

Deno.test('a nature-tour name from a nature organizer / municipality is hinted; the same name from a mall is not (no family support, no description)', () => {
  assertEquals(hintCategory({ name: 'סיור בפארק הצפרות מעגן מיכאל' }, 'organizer', ALLOWED)?.category, 'טבע');
  assertEquals(hintCategory({ name: 'טיול צפרות לקראת שקיעה' }, 'regional_council', ALLOWED)?.category, 'טבע');
  assertEquals(hintCategory({ name: 'טיול צפרות לקראת שקיעה' }, 'mall_chain', ALLOWED), null);
  assertEquals(hintCategory({ name: 'טיול צפרות לקראת שקיעה', description: 'טיול משפחתי בטבע עם צפרות' }, 'mall_chain', ALLOWED)?.category, 'טבע');
});

const cases = JSON.parse(await Deno.readTextFile(new URL('./categoryHints.cases.json', import.meta.url)));

Deno.test('shared table: first NAME_CATEGORY hit (farm is a whole word; no broad בעלי חיים hint)', () => {
  for (const [name, expected] of cases.firstHit) {
    assertEquals(NAME_CATEGORY.find(([re]) => re.test(name))?.[1] ?? null, expected, name);
  }
});

Deno.test('Z-H: a tribute concert (מחווה) is never hinted חווה, even when the description repeats it; a real farm still is', () => {
  const tribute = 'להקת קרניבנד וסימפונט רעננה 26/27 - מחווה לאלטון ג׳ון';
  assertEquals(hintCategory({ name: tribute, description: tribute }, 'venue_operator', ALLOWED), null);
  assertEquals(hintCategory({ name: 'יום כיף בחווה של שלמה', description: 'ביקור בחווה עם כל המשפחה' }, 'organizer', ALLOWED)?.category, 'חווה');
  assertEquals(hintCategory({ name: 'ביקור בגן החיות', description: 'גן החיות פתוח' }, 'organizer', ALLOWED), null, 'no transitional בעלי חיים hint');
});

Deno.test('specific before generic; unknown family and empty names give nothing; the value is always an allowed category', () => {
  assertEquals(hintCategory({ name: 'שעת סיפור לקטנטנים' }, 'library_network', ALLOWED)?.category, 'שעת סיפור');
  assertEquals(hintCategory({ name: 'הצגת ילדים: הזחל הרעב' }, 'community_center_network', ALLOWED)?.category, 'הצגה');
  assertEquals(hintCategory({ name: 'מרחב ג׳ימבורי התנסותי' }, 'municipality', ALLOWED), null, 'a gymboree is not in the municipality family list and nothing corroborates it');
  assertEquals(hintCategory({ name: '' }, 'organizer', ALLOWED), null);
  assertEquals(hintCategory({ name: 'הרצאה למבוגרים' }, 'organizer', ALLOWED), null);
  assertEquals(hintCategory({ name: 'סדנת בישול לילדים' }, 'nobody', ALLOWED), null);
});
