// TuRu - יצירת שם-תצוגה לגני שעשועים. פונקציה מרכזית אחת - כל נקודת-כניסה שיוצרת/מעדכנת גן
// שעשועים (קליטה ידנית, OSM import, scan-source auto-approve, אישור "מקורות מידע", עדכון-מנהל)
// עוברת דרכה, כדי שלא יהיו כמה מנגנונים שנותנים שמות שונים לאותו סוג נתון (סעיף 14 בבקשה).
// Deno/scan-source לא יכול לעשות require() לקובץ CommonJS הזה - הלוגיקה מוכפלת בכוונה (לא
// ניתנת-לאיחוד בין runtimes שונים) ב-supabase/functions/_shared/playgroundNaming.ts, ושני
// הקבצים חייבים להישאר זהים בהתנהגות - test-playground-naming.js בודק רק את הצד הזה.
//
// סדר עדיפויות בפועל (מותאם לנתונים שבאמת קיימים בסכימה - locations.address/city, אין
// שדה neighborhood/area/landmark נפרד בסכימה של TuRu, אז שכבות שכונה/אזור/נקודת-ציון מהבקשה
// המקורית מתמצות כאן ל"עיר בלבד" יחיד - שכבה אמיתית אחת, לא כמה מדומות):
//   A. שם רשמי אמין קיים (לא גנרי) -> משאירים אותו כמו שהוא. tier='official'.
//   B. אין שם רשמי, יש רחוב+עיר (locations.address בפורמט "רחוב[ מספר], עיר") ->
//      "גן שעשועים – {רחוב} {מספר}, {עיר}" (עם מספר בית אם קיים באדרס, אחרת בלי). tier='street'.
//   C. אין רחוב אך יש עיר -> "גן שעשועים – {עיר}" - עדיין ספציפי משמעותית יותר מ"אזור/region".
//      tier='city'.
//   D. אין גם עיר -> לא ממציאים שם בכלל (סעיף 4/6.F בבקשה: "אל תמציא כתובת") - מחזירים
//      tier='no_data', name: null - הקוד הקורא משאיר את השם הקיים ללא שינוי ומסמן לבדיקה.
//
// name_source (activities.name_source, ראו supabase/00NN_activities_name_source.sql) נגזר
// ישירות מ-tier: official->'official', street/city->'generated_from_address', no_data->null
// (לא נוגעים). קיים גם 'admin_confirmed' שהפונקציה הזו אף פעם לא מחזירה - זה נקבע רק כשמנהל
// עורך name ידנית (server.js /api/manage/update), וברגע שנקבע הוא חוסם כל דריסה עתידית
// אוטומטית של אותה רשומה (סעיף 9 בבקשה) - הקוד הקורא אחראי לבדוק את זה *לפני* שהוא בכלל קורא
// לפונקציה הזו על רשומה קיימת.

const GENERIC_NAME_PATTERNS = [
  /^גן שעשועים\s*-\s*/, // "גן שעשועים - X" (import-playgrounds-osm.js הישן, כשיש street/city/place)
  /^גן שעשועים ציבורי\s*-\s*/, // "גן שעשועים ציבורי - X" (הישן, כשיש רק region)
  /^גן שעשועים\s*$/, // בלי שום סיומת בכלל
  /^playground\s*$/i,
];
// ערכים טכניים/שגויים שאף פעם לא אמורים להיחשב "שם אמיתי" גם אם הם לא תואמים לאף דפוס למעלה
// (סעיף 15 - "ללא undefined/null/ריק/URL/מזהה מערכת") - בדיקה נפרדת מהדפוסים הגנריים כי אלה
// לא "שם גנרי שנוצר על ידינו בעבר", אלה נתון פגום שהגיע ממקור/קלט כלשהו.
const TECHNICAL_VALUE_PATTERNS = [
  /^(null|undefined|nan|n\/a|none|-|—|\.)$/i,
  /^https?:\/\//i, // URL בטעות בשדה name
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID בטעות בשדה name
];

function isGenericPlaygroundName(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return true;
  if (TECHNICAL_VALUE_PATTERNS.some((re) => re.test(trimmed))) return true;
  return GENERIC_NAME_PATTERNS.some((re) => re.test(trimmed));
}

// "רחוב 12, עיר" -> { street: "רחוב", houseNumber: "12" } - address תמיד "רחוב[ מספר], עיר"
// בקוד הקיים (ראו enrich-playground-addresses.js/server.js queryNominatim - אותו פורמט תמיד).
// מספר-בית יכול לכלול אות עברית נספחת (למשל "12א") - נשמר כמו שהוא, לא מפוצל הלאה.
function parseStreetAddress(address) {
  if (!address) return { street: null, houseNumber: null };
  const streetPart = String(address).split(',')[0].trim();
  // a bare number is a ROAD REFERENCE ("367", "4311") that reverse geocoding returns in its `road` field for a
  // point beside a highway - never a street name (2026-09-17: 337 addresses, 284 generated playground titles)
  if (!streetPart || /^\d+$/.test(streetPart)) return { street: null, houseNumber: null };
  const match = streetPart.match(/^(.*?)\s+(\d+[א-ת]?)$/);
  if (match) return { street: match[1].trim() || null, houseNumber: match[2] };
  return { street: streetPart, houseNumber: null };
}

function generatePlaygroundDisplayName({ officialName, address, city }) {
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

module.exports = { isGenericPlaygroundName, parseStreetAddress, generatePlaygroundDisplayName };

