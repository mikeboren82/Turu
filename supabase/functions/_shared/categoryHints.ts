// TuRu - deterministic category hint for a candidate the extractor left without a category (2026-09-19,
// Monster <- Cleaner feedback: 6 of 14 AVOIDABLE new Cleaner cases in the validation cohort were categories
// the Cleaner later derived from the very same name + source family). Same tables as the Cleaner's metadata
// resolver (tools/import-tool/cleaner/fieldEnricher.js NAME_CATEGORY / FAMILY_SUPPORTS - keep in lockstep).
// MEDIUM only: a name keyword counts when the source family supports that category or the description repeats
// it; otherwise null (the review queue / Cleaner decide). Never "אחר", never a guess from an empty name.
export const NAME_CATEGORY: [RegExp, string][] = [
  [/שעת סיפור|סיפור בספרי|הקראת ספר/, 'שעת סיפור'], [/ג['׳]ימבורי|jimbor/i, "ג'ימבורי"], [/משחקייה|משחקיה/, 'משחקייה'],
  [/הצגה|הצגת|תיאטרון|מחזמר|בובות|מופע ילדים/, 'הצגה'], [/קונצרט|מופע מוזיקלי|שירה בציבור|שרים|מוזיקה|מוסיקה/, 'מוזיקה'],
  [/סדנת בישול|סדנת אפייה|בישול|אפייה|שוקולד/, 'בישול'], [/סדנת מדע|מדע|רובוטיקה|תכנות|טכנולוגי/, 'מדע'], [/סדנת יצירה|יצירה|ציור|קרמיקה|פיסול|אמנות/, 'יצירה'],
  [/סדנה|סדנת/, 'סדנה'], [/טיול|סיור|בטבע|נחל|שמורת|צפרות|ציפורים/, 'טבע'], [/מוזיאון|תערוכה/, 'מוזיאון לילדים'], [/ריקוד|מחול|זומבה/, 'ריקוד'],
  [/סרט|הקרנה|קולנוע/, 'קולנוע לילדים'], [/בריכה|שחייה|פעילות מים|מים/, 'פעילות מים'], [/ספורט|כדורגל|כדורסל|ריצה|אתלטיקה/, 'ספורט'],
  [/פינת חי|בעלי חיים|חיות|גן חיות/, 'בעלי חיים'], [/חווה|חוות/, 'חווה'], [/טרמפולינ/, 'טרמפולינות'], [/גן שעשועים|מגרש משחקים/, 'גן שעשועים'],
  [/הפנינג|יריד|פסטיבל|חגיגה|אירוע קהילתי|קהילתי/, 'פעילות קהילתית'],
];
export const FAMILY_SUPPORTS: Record<string, string[]> = {
  library_network: ['שעת סיפור', 'ספרייה', 'יצירה', 'סדנה'],
  community_center_network: ['הצגה', 'סדנה', 'יצירה', 'פעילות קהילתית', 'מוזיקה', 'ריקוד', 'שעת סיפור'],
  venue_operator: ['הצגה', 'מוזיקה', 'מוזיאון לילדים', 'סדנה', 'קולנוע לילדים'],
  museum: ['מוזיאון לילדים', 'סדנה', 'יצירה'],
  municipality: ['פעילות קהילתית', 'פעילות עירונית', 'הצגה', 'טבע', 'מוזיקה'],
  regional_council: ['פעילות קהילתית', 'טבע', 'הצגה'],
  mall_chain: ['פעילות קהילתית', 'יצירה', 'סדנה', 'הצגה'],
  organizer: ['טבע', 'סדנה', 'הצגה'],
};

export function hintCategory(c: { name?: unknown; description?: unknown }, publisherType: string | null | undefined, allowed: string[]): { category: string; why: string } | null {
  const name = typeof c.name === 'string' ? c.name : '';
  if (!name.trim()) return null;
  const hit = NAME_CATEGORY.find(([re]) => re.test(name));
  if (!hit) return null;
  const category = hit[1];
  if (!allowed.includes(category)) return null;
  const supports = FAMILY_SUPPORTS[publisherType || ''] || [];
  const desc = typeof c.description === 'string' ? c.description : '';
  const inDesc = !!desc && NAME_CATEGORY.some(([re, cat]) => cat === category && re.test(desc));
  if (supports.includes(category)) return { category, why: `name keyword "${(name.match(hit[0]) || [''])[0]}" + source family ${publisherType} supports it` };
  if (inDesc) return { category, why: `name keyword "${(name.match(hit[0]) || [''])[0]}" repeated in the description` };
  return null;
}
