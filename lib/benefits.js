// "הטבות והנחות" - לוגיקה משותפת לכרטיס פעילות, לעמוד פעילות ולמנוע הדירוג (lib/filterActivities.js),
// כדי שניסוח/תוקף לא ישוכפלו בכמה מקומות. ראו constants/filterSchema.js ל-BENEFIT_PROVIDER_OPTIONS.
import { supabase } from './supabase';
import { t, formatDate } from './i18n';
import { BENEFIT_PROVIDER_OPTIONS, BENEFIT_PROVIDER_EDIT_OPTIONS } from '../constants/filterSchema';

// הוספת הטבה ישירות מעמוד הפעילות (app/activity/[id].js, אדמין בלבד) - מסתמכת על RLS
// (activity_benefits_insert: is_admin() OR is_trusted_uploader()) בדיוק כמו updateActivityAsAdmin/
// deleteActivityAsAdmin ב-lib/activities.js - אין קריאה לשרת הנפרד (tools/import-tool), אותו
// דפוס בדיוק. כלי הניהול נשאר האמצעי המלא לעריכה/מחיקה של הטבות קיימות.
export async function addActivityBenefit(activityId, fields) {
  const { data, error } = await supabase
    .from('activity_benefits')
    .insert({ activity_id: activityId, ...fields })
    .select('id, provider, benefit_type, value, special_price, valid_from, valid_until, redemption_method, redemption_url, coupon_code, terms, status, last_verified_at')
    .single();
  if (error) throw error;
  return data;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// dd.mm.yyyy in Hebrew (he-IL with 2-digit day/month), locale-appropriate otherwise.
function formatBenefitDate(iso) {
  return formatDate(iso, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Provider is a canonical/brand value - localized label when it matches a known option id, else as-is.
function providerLabel(provider) {
  const opt = BENEFIT_PROVIDER_OPTIONS.find((o) => o.id === provider)
    || BENEFIT_PROVIDER_EDIT_OPTIONS.find((o) => o.id === provider);
  return opt ? opt.label : provider;
}

// תוקף ההטבה נבדק בכל קריאה (לא מאוחסן) - בדיוק כמו requiresTicket ב-lib/activities.js.
// status ב-DB הוא דגל-איכות ידני של המנהל בלבד, לא נראה למשתמשי הקצה.
export function isBenefitActive(benefit) {
  if (!benefit) return false;
  if (benefit.status === 'expired') return false;
  if (benefit.valid_until && benefit.valid_until < todayIso()) return false;
  return true;
}

export function getActiveBenefits(rawBenefits) {
  return (rawBenefits || []).filter(isBenefitActive);
}

// "מה שיודעים על ההטבה" בלי תלות במשתמש - "20% הנחה" / "1+1" / "מחיר מיוחד: 59 ₪" / null אם
// אין ערך ספציפי ידוע (למשל type='other' בלי value).
function benefitHeadline(benefit) {
  if (benefit.value) return benefit.value;
  if (benefit.benefit_type === 'one_plus_one') return '1+1';
  if (benefit.benefit_type === 'special_price' && benefit.special_price != null) return t('activity.benefits.specialPrice', { price: benefit.special_price });
  return null;
}

// תג קומפקטי אחד לכרטיס הפעילות, גם כשיש כמה הטבות (סעיף 12 בבקשה - לא להעמיס). בוחר הטבה
// שמתאימה למועדון שהמשתמש הגדיר (אם יש), אחרת את הראשונה הזמינה. מחזיר מחרוזת בלי אמוג'י
// (הרכיב הקורא מוסיף את האייקון) או null אם אין הטבות בכלל.
export function formatBenefitCardTag(benefits, benefitClubs) {
  const active = getActiveBenefits(benefits);
  if (active.length === 0) return null;
  const clubs = benefitClubs || [];
  const personal = active.find((b) => clubs.includes(b.provider));
  const chosen = personal || active[0];
  const isPersonalized = !!personal;
  const headline = benefitHeadline(chosen);
  const provider = providerLabel(chosen.provider);
  if (isPersonalized) {
    return headline
      ? t('activity.benefits.tagPersonal', { headline, provider })
      : t('activity.benefits.tagPersonalNoHeadline', { provider });
  }
  return headline
    ? t('activity.benefits.tagMembers', { headline, provider })
    : t('activity.benefits.tagMembersNoHeadline', { provider });
}

// Keys resolved at call time (render), so the text follows the active locale.
const REDEMPTION_TEXT_KEYS = {
  link: 'activity.benefits.redemption.link',
  show_card: 'activity.benefits.redemption.showCard',
  automatic: 'activity.benefits.redemption.automatic',
  other: null,
};

// פרטים מובנים להצגה בעמוד הפעילות המלא - כרטיס נפרד לכל הטבה, כולל ניסוח מותאם-אישית אם
// המשתמש הגדיר את המועדון הזה בפרופיל (סעיף 6 בבקשה).
export function formatBenefitDetailLines(benefit, benefitClubs) {
  const isPersonalized = (benefitClubs || []).includes(benefit.provider);
  const headline = benefitHeadline(benefit);
  return {
    provider: providerLabel(benefit.provider),
    isPersonalized,
    headline: headline || t('activity.benefits.defaultHeadline'),
    validityText: benefit.valid_until ? t('activity.benefits.validUntil', { date: formatBenefitDate(benefit.valid_until) }) : null,
    redemptionText: benefit.redemption_method === 'coupon_code'
      ? t('activity.benefits.couponRedemption', { code: benefit.coupon_code || '' }).trim()
      : (REDEMPTION_TEXT_KEYS[benefit.redemption_method] ? t(REDEMPTION_TEXT_KEYS[benefit.redemption_method]) : null),
    redemptionUrl: benefit.redemption_url || null,
    couponCode: benefit.redemption_method === 'coupon_code' ? (benefit.coupon_code || null) : null,
    terms: benefit.terms || null,
  };
}
