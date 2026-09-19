// Category hint (Monster <- Cleaner feedback, 2026-09-19): MEDIUM, corroborated only, never a guess.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { hintCategory } from "./categoryHints.ts";
import categoryValues from './categoryValues.json' with { type: 'json' };

const ALLOWED: string[] = categoryValues.categories;

Deno.test('a nature-tour name from a nature organizer / municipality is hinted; the same name from a mall is not (no family support, no description)', () => {
  assertEquals(hintCategory({ name: 'סיור בפארק הצפרות מעגן מיכאל' }, 'organizer', ALLOWED)?.category, 'טבע');
  assertEquals(hintCategory({ name: 'טיול צפרות לקראת שקיעה' }, 'regional_council', ALLOWED)?.category, 'טבע');
  assertEquals(hintCategory({ name: 'טיול צפרות לקראת שקיעה' }, 'mall_chain', ALLOWED), null);
  assertEquals(hintCategory({ name: 'טיול צפרות לקראת שקיעה', description: 'טיול משפחתי בטבע עם צפרות' }, 'mall_chain', ALLOWED)?.category, 'טבע');
});

Deno.test('specific before generic; unknown family and empty names give nothing; the value is always an allowed category', () => {
  assertEquals(hintCategory({ name: 'שעת סיפור לקטנטנים' }, 'library_network', ALLOWED)?.category, 'שעת סיפור');
  assertEquals(hintCategory({ name: 'הצגת ילדים: הזחל הרעב' }, 'community_center_network', ALLOWED)?.category, 'הצגה');
  assertEquals(hintCategory({ name: 'מרחב ג׳ימבורי התנסותי' }, 'municipality', ALLOWED), null, 'a gymboree is not in the municipality family list and nothing corroborates it');
  assertEquals(hintCategory({ name: '' }, 'organizer', ALLOWED), null);
  assertEquals(hintCategory({ name: 'הרצאה למבוגרים' }, 'organizer', ALLOWED), null);
  assertEquals(hintCategory({ name: 'סדנת בישול לילדים' }, 'nobody', ALLOWED), null);
});
