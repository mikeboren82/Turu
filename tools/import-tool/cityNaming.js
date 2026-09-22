// TuRu - נרמול שם עיר/יישוב לצורה קנונית אחת, כדי שאותו יישוב לא יתפצל לכמה ערכים שונים
// ב-locations.city (נמצא בפועל 2026-09-11: "תל אביב" בנפרד מ-"תל־אביב–יפו", "ירושלים" בנפרד
// מ-"ירושלים | القدس", "קרית מוצקין" בנפרד מ-"קריית מוצקין" וכו' - כל אחד מהם "עיר" נפרדת
// לצורך סינון/קיבוץ, מה שגרם גם לבאג-קטן בפילטור וגם לתוצאות שגויות ב-gap-analysis
// (settlement_gap_check.py חישב "תל אביב = 0 גנים" כי כל 231 הגנים היו רשומים תחת השם השני).
//
// הצורה הקנונית נגזרת מ-constants/israeliCities.js הקיים (רשימת ההשלמה-האוטומטית של האפליקציה,
// מקור-האמת היחיד שכבר קיים לאיות "רשמי") - לא המצאה: "תל אביב יפו" (רווחים, לא מקפים),
// "מודיעין מכבים רעות", "קריית מוצקין" (לא "קרית") - כל אלה כבר מופיעים שם בדיוק בצורה הזו.

const NIQQUD_RE = /[֑-ׇ]/g; // Hebrew combining marks (teamim, niqqud points, dagesh, sin/shin dots) - diacritics only, never base letters
const QUOTE_RE = /[׳״'"]/g; // Hebrew geresh/gershayim + their ASCII equivalents - folded to nothing, same style as matching.ts's placeLabelsDisagree fold
const HYPHEN_LIKE_RE = /[-־–—]/g; // מקף רגיל, מקף עברי (maqaf), en-dash, em-dash
const KRIAT_RE = /(^|\s)קרית(\s|$)/g;
const WHITESPACE_RE = /\s+/g;

function normalizeCityName(city) {
  if (!city) return city;
  let s = String(city).trim();
  if (!s) return s;
  // שם דו-לשוני ("ירושלים | القدس") - השם הראשי (עברית) הוא הקנוני; לא נוגעים בתצוגה
  // הדו-לשונית בכל מקום אחר באפליקציה, רק במקור-האמת של city לצורך קיבוץ/סינון.
  s = s.split('|')[0].trim();
  // מקף/מקף-עברי (maqaf, U+05BE) קודם - הוא גם בטווח ה"ניקוד" של יוניקוד, וחייב להיהפך לרווח
  // (לא להימחק) לפני הסרת שאר סימני הניקוד, אחרת "באר־שבע" יתמזג ל"בארשבע" במקום "באר שבע".
  s = s.replace(HYPHEN_LIKE_RE, ' ');
  // ניקוד/טעמים ("בְּאֵר שֶׁבַע") וגרשיים/גרש (עברי או ASCII, "כפר ביל״ו" / "כפר ביל\"ו") לא
  // משנים את הזהות של היישוב - רק את הכתיב. מוסרים אותם לפני כל השוואה/fingerprint.
  s = s.replace(NIQQUD_RE, '');
  s = s.replace(QUOTE_RE, '');
  s = s.replace(KRIAT_RE, '$1קריית$2');
  s = s.replace(WHITESPACE_RE, ' ').trim();
  return s;
}

module.exports = { normalizeCityName };
