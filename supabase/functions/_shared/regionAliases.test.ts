// TuRu - region alias fallback tests (2026-09-16). Run with
// `npx deno test --allow-read supabase/functions/_shared/` (same runner as extraction.test.ts).

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { REGION_VALUES } from "./extraction.ts";
import { REGION_ALIASES, matchRegionAlias, normalizeHebrewText } from "./regionAliases.ts";

Deno.test("every alias target is a canonical REGION_VALUES id (no drift from categoryValues.json)", () => {
  for (const a of REGION_ALIASES) assertEquals(REGION_VALUES.includes(a.region), true, `${a.key} → ${a.region}`);
});

Deno.test("normalizeHebrewText collapses gershayim/geresh/quote/hyphen variants", () => {
  assertEquals(normalizeHebrewText('יו"ש'), 'יוש');
  assertEquals(normalizeHebrewText('יו״ש'), 'יוש');
  assertEquals(normalizeHebrewText('יו\\"ש'), 'יוש');
  assertEquals(normalizeHebrewText("ג'ימבורי  בגוש-דן"), 'גימבורי בגוש דן');
  assertEquals(normalizeHebrewText('  Tel  Aviv '), 'tel aviv');
});

Deno.test("colloquial region phrases map to canonical ids", () => {
  assertEquals(matchRegionAlias('פינות חי בשרון'), 'השרון');
  assertEquals(matchRegionAlias('פינות חי באזור השרון'), 'השרון');
  assertEquals(matchRegionAlias('משהו לילדים בגוש דן'), 'גוש דן והמרכז');
  assertEquals(matchRegionAlias('גימבורי בגוש-דן'), 'גוש דן והמרכז');
  assertEquals(matchRegionAlias('פינות חי במרכז'), 'גוש דן והמרכז');
  assertEquals(matchRegionAlias('פינות חי במרכז הארץ'), 'גוש דן והמרכז');
  assertEquals(matchRegionAlias('טיול בצפון'), 'הצפון והגליל');
  assertEquals(matchRegionAlias('טיול בגליל העליון'), 'הצפון והגליל');
  assertEquals(matchRegionAlias('אטרקציות ברמת הגולן'), 'הצפון והגליל');
  assertEquals(matchRegionAlias('מוזיאון בעמק יזרעאל'), 'עמק יזרעאל והעמקים');
  assertEquals(matchRegionAlias('פארק מים בשפלה'), 'השפלה');
  assertEquals(matchRegionAlias('חוות בנגב'), 'הדרום והנגב');
  assertEquals(matchRegionAlias('פעילות בדרום'), 'הדרום והנגב');
  assertEquals(matchRegionAlias('משהו באזור חיפה'), 'חיפה והקריות');
  assertEquals(matchRegionAlias('גן שעשועים בקריות'), 'חיפה והקריות');
  assertEquals(matchRegionAlias('סדנה באזור ירושלים'), 'ירושלים והסביבה');
  assertEquals(matchRegionAlias('טיול בגוש עציון'), 'ירושלים והסביבה');
});

Deno.test("all יו\"ש spelling variants resolve to the same canonical id", () => {
  const expected = 'יו"ש והבנימין';
  assertEquals(matchRegionAlias('פעילות ביו"ש'), expected);
  assertEquals(matchRegionAlias('פעילות ביו״ש'), expected);
  assertEquals(matchRegionAlias('פעילות ביו\\"ש'), expected);
  assertEquals(matchRegionAlias('פעילות בשומרון'), expected);
  assertEquals(matchRegionAlias('פעילות בבנימין'), expected);
});

Deno.test("attached Hebrew prefix letters are tolerated", () => {
  assertEquals(matchRegionAlias('פינות חי ובשרון'), 'השרון');
  assertEquals(matchRegionAlias('חוות מהנגב'), 'הדרום והנגב');
});

Deno.test("negative: no false positives from short/ambiguous forms", () => {
  assertEquals(matchRegionAlias('מרכז קהילתי לילדים'), null);
  assertEquals(matchRegionAlias('חוג במרכז קהילתי'), null);
  assertEquals(matchRegionAlias('חוג במרכז המסחרי'), null);
  assertEquals(matchRegionAlias('גן שעשועים בצפון תל אביב'), null); // non-terminal directional
  assertEquals(matchRegionAlias('פעילות עם שרון'), null); // first name, not the region
  assertEquals(matchRegionAlias('שרונה'), null);
  assertEquals(matchRegionAlias('מרכזי מבקרים'), null);
});

Deno.test("negative: bare city names are not regions, non-region text is null", () => {
  assertEquals(matchRegionAlias('גן שעשועים בחיפה'), null);
  assertEquals(matchRegionAlias('מוזיאון בירושלים'), null);
  assertEquals(matchRegionAlias('גימבורי בנתניה'), null);
  assertEquals(matchRegionAlias('playground'), null);
  assertEquals(matchRegionAlias(''), null);
  assertEquals(matchRegionAlias('   '), null);
});

Deno.test("ambiguous: two different regions in one query → null (never guess)", () => {
  assertEquals(matchRegionAlias('פעילויות בין הצפון לדרום'), null);
  assertEquals(matchRegionAlias('בשרון או בשפלה'), null);
});
