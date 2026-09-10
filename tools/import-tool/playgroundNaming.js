// TuRu - יצירת שם-תצוגה לגני שעשועים. פונקציה מרכזית אחת, בשימוש גם ע"י ייבוא-OSM
// (import-playgrounds-osm.js) וגם ע"י המיגרציה החד-פעמית (migrate-playground-names.js) - כדי
// שלא יהיו שני מנגנונים שנותנים שמות שונים (סעיף 14 בבקשה).
//
// סדר עדיפויות בפועל (מותאם לנתונים שבאמת קיימים בסכימה - locations.address/city/region,
// אין שדה neighborhood/area/landmark נפרד בסכימה של TuRu, אז שכבות C/D/E מהבקשה המקורית
// (שכונה/אזור/נקודת ציון) מתמצות לכאן ל-"עיר בלבד" יחיד - שכבה אמיתית אחת, לא שלוש מדומות):
//   A. שם רשמי אמין קיים (לא גנרי) -> משאירים אותו כמו שהוא.
//   B. אין שם רשמי, יש רחוב+עיר (locations.address בפורמט "רחוב[ מספר], עיר") ->
//      "גן שעשועים ברחוב {רחוב}, {עיר}" (בלי מספר בית - ברירת המחדל המבוקשת).
//   C. אין רחוב אך יש עיר -> "גן שעשועים ב{עיר}" (עדיין ספציפי משמעותית יותר מ"אזור/region" -
//      פותר את התלונה המקורית "ירושלים והסביבה" גם בלי מידע-שכונה שאין לנו בפועל).
//   D. אין גם עיר -> לא ממציאים שם בכלל (בדיוק כמו שסעיף 6.F בבקשה דורש) - מחזירים tier
//      'no_data', name: null - הקוד הקורא משאיר את השם הקיים ללא שינוי ומסמן לבדיקה.

const GENERIC_NAME_PATTERNS = [
  /^גן שעשועים\s*-\s*/, // "גן שעשועים - X" (import-playgrounds-osm.js הישן, כשיש street/city/place)
  /^גן שעשועים ציבורי\s*-\s*/, // "גן שעשועים ציבורי - X" (הישן, כשיש רק region)
  /^גן שעשועים$/, // בלי שום סיומת בכלל
  /^playground$/i,
];

function isGenericPlaygroundName(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return true;
  return GENERIC_NAME_PATTERNS.some((re) => re.test(trimmed));
}

// "רחוב 12, עיר" -> "רחוב" (בלי העיר, בלי מספר הבית) - address תמיד "רחוב[ מספר], עיר" בקוד
// הקיים (ראו enrich-playground-addresses.js/server.js queryNominatim - אותו פורמט תמיד).
function extractStreetOnly(address) {
  if (!address) return null;
  const streetPart = String(address).split(',')[0].trim();
  if (!streetPart) return null;
  const withoutHouseNumber = streetPart.replace(/\s+\d+[א-ת]?$/, '').trim();
  return withoutHouseNumber || null;
}

function generatePlaygroundDisplayName({ officialName, address, city }) {
  const trimmedOfficial = (officialName || '').trim();
  if (trimmedOfficial && !isGenericPlaygroundName(trimmedOfficial)) {
    return { name: trimmedOfficial, tier: 'official' };
  }
  const street = extractStreetOnly(address);
  if (street && city) {
    return { name: `גן שעשועים ברחוב ${street}, ${city}`, tier: 'street' };
  }
  if (city) {
    return { name: `גן שעשועים ב${city}`, tier: 'city' };
  }
  return { name: null, tier: 'no_data' };
}

module.exports = { isGenericPlaygroundName, extractStreetOnly, generatePlaygroundDisplayName };
