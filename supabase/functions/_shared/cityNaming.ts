// TuRu - עותק Deno/TypeScript מדויק של tools/import-tool/cityNaming.js (Node). Deno לא יכול
// לעשות require() לקובץ CommonJS הזה - הלוגיקה מוכפלת בכוונה, אותו עיקרון כמו playgroundNaming.ts/
// matching.ts. שני הקבצים חייבים להישאר זהים בהתנהגות.

const HYPHEN_LIKE_RE = /[-־–—]/g;
const KRIAT_RE = /(^|\s)קרית(\s|$)/g;
const WHITESPACE_RE = /\s+/g;

export function normalizeCityName(city: string | null | undefined): string | null {
  if (!city) return city ?? null;
  let s = String(city).trim();
  if (!s) return s;
  s = s.split('|')[0].trim();
  s = s.replace(HYPHEN_LIKE_RE, ' ');
  s = s.replace(KRIAT_RE, '$1קריית$2');
  s = s.replace(WHITESPACE_RE, ' ').trim();
  return s;
}
