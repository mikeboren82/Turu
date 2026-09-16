// TuRu - region alias fallback for the smart-search intent parser (2026-09-16).
//
// The model (smart-search/index.ts) is asked to map a broad-area phrase in the query to one of the
// canonical REGION_VALUES strings exactly; sanitizeIntent then drops anything that is not an exact
// match, silently. Colloquial phrasing ("בשרון", "גוש דן", "ביו״ש", "בצפון") therefore sometimes
// produced a query with no location at all. This module is the deterministic, code-level safety net:
// a single centralized alias table (colloquial → canonical id, validated at load time against
// REGION_VALUES so it cannot drift from categoryValues.json), matched only as a FALLBACK when the
// model returned neither a city nor a region.
//
// Matching is deliberately conservative - wrong-region is worse than no-region:
// - keys are matched as whole tokens (optional 1-2 attached Hebrew prefix letters ובלמכש), never as
//   arbitrary substrings, so "מרכזי"/"שרונה" cannot match;
// - directional/short forms ("במרכז", "בצפון", "הדרום"...) are `terminal` - they only count as a
//   region when they are the LAST word of the query. "פינות חי במרכז" → region; "במרכז קהילתי" or
//   "בצפון תל אביב" → no match (the latter normally carries a city the model already extracted);
// - bare city names (ירושלים, חיפה) are NOT aliases - "אזור ירושלים"/"אזור חיפה" are;
// - if two different regions match the same query the result is null (ambiguous).
//
// Text is normalized before matching so gershayim/geresh variants collapse: יו"ש / יו״ש / יו\"ש → יוש.

import { REGION_VALUES } from './extraction.ts';

interface RegionAlias { key: string; region: string; terminal?: boolean }

const GUSH_DAN = 'גוש דן והמרכז';
const SHARON = 'השרון';
const JERUSALEM = 'ירושלים והסביבה';
const HAIFA = 'חיפה והקריות';
const NORTH = 'הצפון והגליל';
const VALLEYS = 'עמק יזרעאל והעמקים';
const SHFELA = 'השפלה';
const SOUTH = 'הדרום והנגב';
const YOSH = 'יו"ש והבנימין';

export const REGION_ALIASES: readonly RegionAlias[] = [
  // גוש דן והמרכז
  { key: 'גוש דן', region: GUSH_DAN },
  { key: 'מרכז הארץ', region: GUSH_DAN },
  { key: 'אזור המרכז', region: GUSH_DAN },
  { key: 'במרכז', region: GUSH_DAN, terminal: true },
  { key: 'המרכז', region: GUSH_DAN, terminal: true },
  // השרון - never bare "שרון" (also a first name: "פעילות עם שרון")
  { key: 'אזור השרון', region: SHARON },
  { key: 'השרון', region: SHARON },
  { key: 'בשרון', region: SHARON },
  // ירושלים והסביבה - bare "ירושלים" is a city, handled by the model as location.city
  { key: 'ירושלים והסביבה', region: JERUSALEM },
  { key: 'אזור ירושלים', region: JERUSALEM },
  { key: 'סביבת ירושלים', region: JERUSALEM },
  { key: 'סביבות ירושלים', region: JERUSALEM },
  { key: 'הרי ירושלים', region: JERUSALEM },
  { key: 'גוש עציון', region: JERUSALEM }, // per the extraction cheat-sheet (extraction.ts)
  // חיפה והקריות - bare "חיפה" is a city
  { key: 'חיפה והקריות', region: HAIFA },
  { key: 'אזור חיפה', region: HAIFA },
  { key: 'מפרץ חיפה', region: HAIFA },
  { key: 'הקריות', region: HAIFA },
  { key: 'בקריות', region: HAIFA },
  // הצפון והגליל
  { key: 'הצפון והגליל', region: NORTH },
  { key: 'אזור הצפון', region: NORTH },
  { key: 'צפון הארץ', region: NORTH },
  { key: 'גליל עליון', region: NORTH },
  { key: 'גליל תחתון', region: NORTH },
  { key: 'גליל מערבי', region: NORTH },
  { key: 'רמת הגולן', region: NORTH },
  { key: 'הגליל', region: NORTH },
  { key: 'בגליל', region: NORTH },
  { key: 'הגולן', region: NORTH },
  { key: 'בגולן', region: NORTH },
  { key: 'הצפון', region: NORTH, terminal: true },
  { key: 'בצפון', region: NORTH, terminal: true },
  // עמק יזרעאל והעמקים
  { key: 'עמק יזרעאל והעמקים', region: VALLEYS },
  { key: 'עמק יזרעאל', region: VALLEYS },
  { key: 'עמק הירדן', region: VALLEYS },
  { key: 'סביבות הכנרת', region: VALLEYS },
  { key: 'אזור הכנרת', region: VALLEYS },
  { key: 'העמקים', region: VALLEYS },
  { key: 'בעמקים', region: VALLEYS },
  { key: 'יזרעאל', region: VALLEYS },
  { key: 'הכנרת', region: VALLEYS },
  { key: 'בכנרת', region: VALLEYS },
  // השפלה
  { key: 'אזור השפלה', region: SHFELA },
  { key: 'השפלה', region: SHFELA },
  { key: 'בשפלה', region: SHFELA },
  // הדרום והנגב
  { key: 'הדרום והנגב', region: SOUTH },
  { key: 'אזור הדרום', region: SOUTH },
  { key: 'דרום הארץ', region: SOUTH },
  { key: 'עוטף עזה', region: SOUTH },
  { key: 'הנגב', region: SOUTH },
  { key: 'בנגב', region: SOUTH },
  { key: 'הערבה', region: SOUTH },
  { key: 'בערבה', region: SOUTH },
  { key: 'הדרום', region: SOUTH, terminal: true },
  { key: 'בדרום', region: SOUTH, terminal: true },
  // יו"ש והבנימין - keys are written already-normalized (no quotes), see normalizeHebrewText
  { key: 'יוש והבנימין', region: YOSH },
  { key: 'יהודה ושומרון', region: YOSH },
  { key: 'יוש', region: YOSH },
  { key: 'ביוש', region: YOSH },
  { key: 'השומרון', region: YOSH },
  { key: 'בשומרון', region: YOSH },
  { key: 'שומרון', region: YOSH },
  { key: 'הבנימין', region: YOSH },
  { key: 'בנימין', region: YOSH },
];

// Load-time guard: an alias pointing at a region id that no longer exists in categoryValues.json is
// a deploy-time error, not a silent runtime miss.
for (const a of REGION_ALIASES) {
  if (!REGION_VALUES.includes(a.region)) {
    throw new Error(`regionAliases: "${a.key}" points at unknown region "${a.region}" - update categoryValues.json mirror`);
  }
}

// Collapses the spellings that differ only in punctuation: ASCII quote, gershayim ״ (U+05F4), a
// JSON-escaped \" that survived a round-trip, curly quotes, geresh ׳ / apostrophe, and hyphen/maqaf
// (גוש-דן → גוש דן). Whitespace is collapsed; case-folding only affects Latin text.
export function normalizeHebrewText(text: string): string {
  return String(text ?? '')
    .replace(/\\/g, '')
    .replace(/["״“”'׳’`]/g, '')
    .replace(/[-–—־]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const PUNCT = '\\s,.;:!?()\\[\\]{}';
const BOUNDARY_BEFORE = `(?:^|[${PUNCT}])`;
const PREFIX = '[ובלמכש]{0,2}';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const COMPILED = [...REGION_ALIASES]
  // longest keys first so "אזור השרון" is tried before "השרון" (same region either way, but keeps
  // the ambiguity check meaningful for multi-word keys of different regions)
  .sort((a, b) => b.key.length - a.key.length)
  .map((a) => {
    const after = a.terminal ? `(?=[${PUNCT}]*$)` : `(?=$|[${PUNCT}])`;
    return { ...a, re: new RegExp(`${BOUNDARY_BEFORE}${PREFIX}${escapeRegExp(normalizeHebrewText(a.key))}${after}`, 'u') };
  });

// Returns the canonical REGION_VALUES id the query refers to, or null when no alias matches or when
// aliases of two different regions both match (ambiguous - never guess).
export function matchRegionAlias(query: string): string | null {
  const text = normalizeHebrewText(query);
  if (!text) return null;
  let found: string | null = null;
  for (const a of COMPILED) {
    if (!a.re.test(text)) continue;
    if (found && found !== a.region) return null;
    found = a.region;
  }
  return found;
}
