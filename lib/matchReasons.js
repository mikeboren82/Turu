// "✓ למה זה מתאים" - שורת-הסבר משותפת לעמוד הבית (קרוסלת ההמלצות) ולעמוד התוצאות, כדי שלא
// תהיה לוגיקה מקבילה בשני מקומות (ולא לוגיקה כפולה לזיהוי-הסבר בכלל). אך ורק תצוגה: לא נוגע
// בסינון/בדירוג (אלה ב-lib/filterActivities.js, ללא שינוי). מידע חסר = בלי טענה, לעולם לא ניחוש.
import { calculateAge } from './children';
import { getOpenNowInfo } from './filterActivities';
import { getCardPresentationKind, noRegistrationFact } from './cardMetadata';
import { t } from './i18n';

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

// "פתוח עכשיו" / "ללא הרשמה מראש" - אותה getOpenNowInfo ואותו bucket 'not_required' (lib/
// cardMetadata.js#noRegistrationFact, המקור-האמת היחיד לזה - lib/cardMetadata.js#buildCardStatFacts
// למעלה משתמש באותו bucket בדיוק בשביל registrationRequiredFact) שכבר מזינים דירוג/פילטר קיימים
// (lib/filterActivities.js), לא חישוב מקביל. spontaneousActive===true מדלג לגמרי (buildSpontaneousBadge
// הקיים כבר מכסה את זה במצב ההוא, בניסוח שונה במכוון "נפתח בעוד X"/דורש הזמנה - לא כפילות/סתירה
// על אותה שורה). "ללא הרשמה מראש" מודחק במפורש לגני-שעשועים/פארקים ציבוריים (Card Metadata Policy,
// 2026-09-25, סעיף 3) - עובדה צפויה/מובנת-מאליה שם, לא הסבר-שיווקי שימושי כמו בכל קטגוריה אחרת.
function accessFacts(activity, { spontaneousActive } = {}) {
  if (spontaneousActive) return [];
  const facts = [];
  const openInfo = getOpenNowInfo(activity);
  if (openInfo.isOpen) facts.push(t('activities.card.matchReasons.openNow'));
  if (getCardPresentationKind(activity) !== 'playground') {
    const fact = noRegistrationFact(activity);
    if (fact) facts.push(fact);
  }
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
