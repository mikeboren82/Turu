// "✓ למה זה מתאים" - שורת-הסבר משותפת לעמוד הבית (קרוסלת ההמלצות) ולעמוד התוצאות, כדי שלא
// תהיה לוגיקה מקבילה בשני מקומות (ולא לוגיקה כפולה לזיהוי-הסבר בכלל). אך ורק תצוגה: לא נוגע
// בסינון/בדירוג (אלה ב-lib/filterActivities.js, ללא שינוי). מידע חסר = בלי טענה, לעולם לא ניחוש.
import { calculateAge } from './children';
import { getOpenNowInfo } from './filterActivities';
import { BOOKING_OPTIONS } from '../constants/filterSchema';
import { t } from './i18n';

// ערכי booking_requirement הידועים כ"לא נדרשת הרשמה" - אותו bucket 'not_required' בדיוק
// שכבר קיים לפילטר "הזמנה" (constants/filterSchema.js), לא רשימה מקבילה שעלולה לסטות ממנו.
const NOT_REQUIRED_VALUES = BOOKING_OPTIONS.find((o) => o.id === 'not_required')?.values || [];

// גיל הילדים *שנבחרו לחיפוש הנוכחי* (childAges, מערך גילאים בשנים) - לא כל הילדים בפרופיל
// (ראו קריאה ב-app/index.js/app/activities.js: מגיע מ-selectedChildIds, לא מ-children המלא).
// טוען "מתאים לכל הילדים" רק אם כל אחד מהם בפועל בטווח min_age–max_age - התאמה חלקית (חלק
// מתאימים, חלק לא) לא מנוסחת כהסבר-חיובי בכלל (בלי דוגמה כזו בבקשה, ובלי לצייר תמונה מטעה).
function ageMatchFact(activity, childAges) {
  if (!childAges || childAges.length === 0) return null;
  if (activity.min_age == null || activity.max_age == null) return null; // מידע חסר - בלי טענה
  const allFit = childAges.every((age) => activity.min_age <= age && age <= activity.max_age);
  if (!allFit) return null;
  return t('activities.card.matchReasons.ageMatchAll', { count: childAges.length });
}

// "פתוח עכשיו" / "ללא הרשמה מראש" - אותה getOpenNowInfo ואותו bucket 'not_required' שכבר
// מזינים דירוג/פילטר קיימים (lib/filterActivities.js), לא חישוב חדש. spontaneousActive===true
// מדלג לגמרי (buildSpontaneousBadge הקיים כבר מכסה את זה במצב ההוא, בניסוח שונה במכוון
// "נפתח בעוד X"/דורש הזמנה - לא כפילות/סתירה על אותה שורה).
function accessFacts(activity, { spontaneousActive } = {}) {
  if (spontaneousActive) return [];
  const facts = [];
  const openInfo = getOpenNowInfo(activity);
  if (openInfo.isOpen) facts.push(t('activities.card.matchReasons.openNow'));
  if (NOT_REQUIRED_VALUES.includes(activity.booking_requirement)) facts.push(t('activities.card.matchReasons.noRegistration'));
  return facts;
}

// עד שתי סיבות בסה"כ (בקשת המשתמש: "בלי להעמיס") - סדר-עדיפות: גיל (הכי אישי/רלוונטי-למשפחה)
// קודם, אחר-כך פתוח-עכשיו, אחר-כך ללא-הרשמה. "✓ " אחד בתחילת כל השורה (לא לכל עובדה בנפרד).
export function buildMatchReasons(activity, { childAges, spontaneousActive } = {}) {
  const facts = [ageMatchFact(activity, childAges), ...accessFacts(activity, { spontaneousActive })].filter(Boolean);
  if (facts.length === 0) return null;
  return `✓ ${facts.slice(0, 2).join(' · ')}`;
}

// גילאי-בשנים של ילדים *נבחרים* מתוך רשימת ילדים מלאה + סט-מזהים נבחרים (app/index.js) - אותה
// calculateAge בדיוק שכבר מחשבת גיל-תצוגה (formatChildAge) ו-childAgeToBand, לא נוסחה מקבילה.
// birthdate חסר/לא תקין -> מדולג (לא 0 מומצא) - שקוף גם ל-ageMatchFact למעלה (מערך קצר יותר).
export function selectedChildAges(children, selectedIds) {
  return (children || [])
    .filter((c) => selectedIds?.has?.(c.id))
    .map((c) => calculateAge(c.birthdate)?.years)
    .filter((years) => years != null);
}
