// TuRu - עותק Deno/TypeScript מדויק של tools/import-tool/playgroundNaming.js (Node). Deno לא
// יכול לעשות require() לקובץ CommonJS הזה - הלוגיקה מוכפלת בכוונה, לא ניתנת-לאיחוד בין
// runtimes שונים (אותו עיקרון בדיוק כמו matching.ts מול server.js findSimilarActivities).
// שני הקבצים חייבים להישאר זהים בהתנהגות - כל שינוי כאן דורש שינוי מקביל שם, ולהפך.
// ראו את הקובץ המקורי להסבר-סדר-העדיפויות המלא (tier A/B/C/D).

const GENERIC_NAME_PATTERNS = [
  /^גן שעשועים\s*-\s*/,
  /^גן שעשועים ציבורי\s*-\s*/,
  /^גן שעשועים\s*$/,
  /^playground\s*$/i,
];
const TECHNICAL_VALUE_PATTERNS = [
  /^(null|undefined|nan|n\/a|none|-|—|\.)$/i,
  /^https?:\/\//i,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
];

export function isGenericPlaygroundName(name: string | null | undefined): boolean {
  const trimmed = (name || '').trim();
  if (!trimmed) return true;
  if (TECHNICAL_VALUE_PATTERNS.some((re) => re.test(trimmed))) return true;
  return GENERIC_NAME_PATTERNS.some((re) => re.test(trimmed));
}

export function parseStreetAddress(address: string | null | undefined): { street: string | null; houseNumber: string | null } {
  if (!address) return { street: null, houseNumber: null };
  const streetPart = String(address).split(',')[0].trim();
  if (!streetPart) return { street: null, houseNumber: null };
  const match = streetPart.match(/^(.*?)\s+(\d+[א-ת]?)$/);
  if (match) return { street: match[1].trim() || null, houseNumber: match[2] };
  return { street: streetPart, houseNumber: null };
}

export type PlaygroundNameTier = 'official' | 'street' | 'city' | 'no_data';
export type PlaygroundNameSource = 'official' | 'generated_from_address' | null;

export function generatePlaygroundDisplayName(
  { officialName, address, city }: { officialName: string | null | undefined; address: string | null | undefined; city: string | null | undefined },
): { name: string | null; tier: PlaygroundNameTier; nameSource: PlaygroundNameSource } {
  const trimmedOfficial = (officialName || '').trim();
  if (trimmedOfficial && !isGenericPlaygroundName(trimmedOfficial)) {
    return { name: trimmedOfficial, tier: 'official', nameSource: 'official' };
  }
  const { street, houseNumber } = parseStreetAddress(address);
  if (street && city) {
    const streetLabel = houseNumber ? `${street} ${houseNumber}` : street;
    return { name: `גן שעשועים – ${streetLabel}, ${city}`, tier: 'street', nameSource: 'generated_from_address' };
  }
  if (city) {
    return { name: `גן שעשועים – ${city}`, tier: 'city', nameSource: 'generated_from_address' };
  }
  return { name: null, tier: 'no_data', nameSource: null };
}
