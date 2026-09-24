// TuRu - HEBREW-AWARE MARKER MATCHING (2026-09-24). Node twin of supabase/functions/_shared/markerMatch.ts (identical
// rules; _shared/markerMatch.cases.json runs against both). Pure, no I/O.
//
// WHY. Relevance markers were matched with String.includes, so a marker matched INSIDE another word: "פורים" (Purim)
// inside "סיפורים" (stories), "ציפורים" (birds) and "הכיפורים" (Yom Kippur) - 54 rows in 60 days were child-relevant
// only because of that, 8 of them published by the bot (a Selichot ceremony, an Arabic-course open day, a lecture on Yom Kippur War
// songs, "שבת נקבלה" at a senior citizens' centre); and the ADULT marker "מנוי" (subscription) inside "אמנויות" (arts).
//
// RULE. A marker matches only as a whole word (or a whole phrase), measured on Unicode letters - never JavaScript \b,
// which does not know Hebrew letters:
//   - not preceded by a letter/digit (nor by letter + geresh/gershayim, i.e. inside "צ'יקונג" / "מתנ"ס"), not followed
//     by one
//   - a Hebrew marker may carry the attached clitic prefixes ו, ש, then ב/ל/מ (optionally + ה, the informal
//     "להילדים") or ה, in that order ("ובפורים", "שבסוכות", "לילדים", "הילדים"). כ is NOT a prefix here: "כפורים" is
//     the defective spelling of Yom Kippur.
//   - NO suffix stripping: plural / construct / feminine forms are explicit aliases in the marker lists ("פעוטות",
//     "תינוקות", "ילדי", "קורסי") - generic morphology is how "פורים" became "סיפורים" in the first place
//   - text is normalized first: niqqud / cantillation removed, maqaf -> space, geresh / gershayim variants -> ' and ",
//     lower case; phrase markers match across spaces, hyphens and maqaf.
const LETTERS = 'א-תa-z0-9';
const PREFIX = '(?:ו?ש?(?:[בלמ]ה?|ה)?)';
function normalizeText(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[֑-ׇֽֿׁׂׅׄ]/g, '') // niqqud + cantillation
    .replace(/[־׀׃]/g, ' ') // maqaf, paseq, sof pasuq
    .replace(/[׳‘’`]/g, "'") // geresh variants
    .replace(/[״“”]/g, '"'); // gershayim variants
}
const cache = new Map();
function markerRegex(marker) {
  const m = normalizeText(marker).trim();
  let re = cache.get(m);
  if (!re) {
    const body = m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s\\-–—]+');
    const prefix = /^[א-ת]/.test(m) ? PREFIX : '';
    re = new RegExp(`(?<![${LETTERS}])(?<![${LETTERS}]['"])${prefix}${body}(?![${LETTERS}])(?!['"][${LETTERS}])`);
    cache.set(m, re);
  }
  return re;
}
// the markers of `list` that occur in `text` as whole words / phrases
function markersIn(text, list) {
  const t = normalizeText(text);
  return list.filter((m) => markerRegex(m).test(t));
}
const hasMarker = (text, list) => markersIn(text, list).length > 0;

module.exports = { normalizeText, markerRegex, markersIn, hasMarker, PREFIX, LETTERS };
