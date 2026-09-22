// TuRu - עותק Deno/TypeScript מדויק של tools/import-tool/cityNaming.js (Node). Deno לא יכול
// לעשות require() לקובץ CommonJS הזה - הלוגיקה מוכפלת בכוונה, אותו עיקרון כמו playgroundNaming.ts/
// matching.ts. שני הקבצים חייבים להישאר זהים בהתנהגות.

const NIQQUD_RE = /[֑-ׇ]/g; // Hebrew combining marks (teamim, niqqud points, dagesh, sin/shin dots) - diacritics only, never base letters
const QUOTE_RE = /[׳״'"]/g; // Hebrew geresh/gershayim + their ASCII equivalents - folded to nothing, same style as matching.ts's placeLabelsDisagree fold
const HYPHEN_LIKE_RE = /[-־–—]/g;
const KRIAT_RE = /(^|\s)קרית(\s|$)/g;
const WHITESPACE_RE = /\s+/g;

export function normalizeCityName(city: string | null | undefined): string | null {
  if (!city) return city ?? null;
  let s = String(city).trim();
  if (!s) return s;
  s = s.split('|')[0].trim();
  // מקף/מקף-עברי (maqaf, U+05BE) קודם - הוא גם בטווח ה"ניקוד" של יוניקוד, וחייב להיהפך לרווח
  // (לא להימחק) לפני הסרת שאר סימני הניקוד, אחרת "באר־שבע" יתמזג ל"בארשבע" במקום "באר שבע".
  s = s.replace(HYPHEN_LIKE_RE, ' ');
  s = s.replace(NIQQUD_RE, '');
  s = s.replace(QUOTE_RE, '');
  s = s.replace(KRIAT_RE, '$1קריית$2');
  s = s.replace(WHITESPACE_RE, ' ').trim();
  return s;
}
