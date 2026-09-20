// שיתוף פעילות (למשל דרך WhatsApp) - בניית הקישור וטקסט ההודעה כפונקציות טהורות, כדי שיהיה
// אפשר לבדוק אותן בלי React/רשת/Share API, ולהשתמש בהן גם ממקומות נוספים בעתיד (ראו tests/shareActivity.test.js).
import { placeName } from './i18n/format';

// דומיין הייצור הציבורי (למשל https://wabbit.expo.app) - EXPO_PUBLIC_* מוטמע בזמן build ע"י Expo,
// חייב configuration מפורשת (ראו .env.example) ולעולם לא ניחוש. בלי זה אין דרך אמינה לפתוח את עמוד
// הפעילות בדפדפן כשהאפליקציה לא מותקנת - זה חסר-production ידוע, ראו README/סיכום המשימה.
function productionBaseUrl() {
  return (process.env.EXPO_PUBLIC_SITE_URL || '').trim().replace(/\/+$/, '');
}

// scheme קבוע מ-app.json ("wabbit") - fallback לפיתוח/כשאין עדיין דומיין ייצור מוגדר. זה deep link
// לאפליקציה בלבד (לא כתובת-device/לוקאלהוסט), אבל לא ייפתח כדף אינטרנט תקין כשהאפליקציה לא מותקנת -
// לכן זה מסומן כ"פיתוח בלבד" ולא מוצג כפתרון-שיתוף שלם לייצור.
const DEV_FALLBACK_SCHEME = 'wabbit';

// מזהה הפעילות (id יציב) הוא כל מה שנכנס לקישור - בלי טוקן/פרמטר אישי.
export function buildActivityShareUrl(activityId) {
  const base = productionBaseUrl();
  if (base) return `${base}/activity/${activityId}`;
  return `${DEV_FALLBACK_SCHEME}://activity/${activityId}`;
}

// true כשהקישור שנבנה הוא כתובת-אינטרנט אמיתית (EXPO_PUBLIC_SITE_URL מוגדר) ולא ה-fallback לפיתוח.
export function isProductionShareUrl(url) {
  return /^https?:\/\//.test(url || '');
}

function ageDetail(activity, t) {
  const { min_age, max_age } = activity;
  if (min_age == null && max_age == null) return null;
  if (min_age != null && max_age != null && min_age !== max_age) return t('activity.share.ageRange', { min: min_age, max: max_age });
  if (min_age != null && max_age != null) return t('activity.share.ageExact', { min: min_age });
  if (min_age != null) return t('activity.share.ageFrom', { min: min_age });
  return t('activity.share.ageUpTo', { max: max_age });
}

// מחיר רק כשידוע בוודאות (חינם, או קבוע עם סכום) - 'range'/לא-ידוע לא מוצג, כדי לא להטעות.
function priceDetail(activity, t) {
  if (activity.price_type === 'free') return t('domain.activityMeta.priceFree');
  if (activity.price_type === 'fixed' && activity.price_amount != null) return `₪${activity.price_amount}`;
  return null;
}

// שעות/מועד קרוב - רק אם הלוגיקה הקיימת (summarizeSchedules) בפועל מספקת openHours/nextDate;
// אחרת מדלגים (לא כותבים "שעות לא צוינו" בהודעת שיתוף, ובטח שלא טוענים שהפעילות פתוחה עכשיו).
function hoursDetail(activity, formatDate) {
  if (activity.openHours?.start && activity.openHours?.end) return `${activity.openHours.start}–${activity.openHours.end}`;
  if (activity.nextDate) return formatDate(activity.nextDate, { weekday: 'short', day: 'numeric', month: 'numeric' });
  return null;
}

function bookingDetail(activity, t) {
  if (activity.booking_requirement === 'registration_required' || activity.booking_requirement === 'advance_booking') {
    return t('activity.detail.fallbackRegistration');
  }
  return null;
}

// פונקציה טהורה: activity (מ-mapActivityRow), url (מ-buildActivityShareUrl), t/formatDate (מ-useI18n).
// עד 2 פרטים שימושיים (גיל, מחיר, שעות/מועד, צורך בהרשמה) - רק כשהמידע קיים ואמין; שם/עיר/קישור תמיד.
export function buildActivityShareMessage(activity, { url, t, formatDate }) {
  const placeLabel = [activity.locationName, placeName(activity.city)].filter(Boolean).join(' · ');
  const details = [
    ageDetail(activity, t),
    priceDetail(activity, t),
    hoursDetail(activity, formatDate),
    bookingDetail(activity, t),
  ].filter(Boolean).slice(0, 2);

  const lines = [t('activity.share.intro'), '', activity.title];
  if (placeLabel) lines.push(placeLabel);
  if (details.length > 0) lines.push(details.join(' · '));
  lines.push('', url, '', t('activity.share.closing'));
  return lines.join('\n');
}
