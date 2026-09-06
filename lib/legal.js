import { supabase } from './supabase';
import { TERMS_VERSION, PRIVACY_VERSION, LEGAL_CONTACT_EMAIL } from '../constants/legal';

// נקרא אחרי כל התחברות/הרשמה מוצלחת (טלפון, אימייל, Google, Apple - ראו נקודות הקריאה
// ב-verify-code.js/login.js/_layout.js). upsert זול ואידמפוטנטי - אם המשתמש כבר אישר את
// הגרסה הנוכחית לא נכתב כלום. כשל בכתיבה לא אמור לחסום התחברות - נרשם ל-console בלבד,
// באותו דפוס בדיוק כמו שמירת profiles.email ב-verify-code.js.
export async function recordLegalConsentIfNeeded(userId) {
  if (!userId) return;
  try {
    const { data } = await supabase
      .from('legal_consents')
      .select('terms_version, privacy_version')
      .eq('user_id', userId)
      .maybeSingle();
    if (data?.terms_version === TERMS_VERSION && data?.privacy_version === PRIVACY_VERSION) return;
    const { error } = await supabase.from('legal_consents').upsert({
      user_id: userId,
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
      accepted_at: new Date().toISOString(),
    });
    if (error) console.warn('לא ניתן היה לתעד הסכמה לתנאים (ייתכן שהמיגרציה 0040 עוד לא רצה):', error.message);
  } catch (err) {
    console.warn('שגיאה בתיעוד הסכמה לתנאים:', err?.message || err);
  }
}

// TODO(backend): אין היום מנגנון מחיקת-חשבון אוטומטי בשרת. עד שייבנה, בקשת מחיקה נשלחת
// כהודעה אמיתית לצוות (דרך אותה Edge Function ששולחת פניות "צור קשר") לטיפול ידני.
// אין כאן שום מחיקה בפועל ואסור להציג למשתמש הודעה כאילו החשבון נמחק.
export async function requestAccountDeletion({ userId, contactEmail, nickname, phone }) {
  const message = [
    'בקשת מחיקת חשבון (נשלח אוטומטית ממסך הפרופיל)',
    `User ID: ${userId}`,
    nickname ? `כינוי: ${nickname}` : null,
    phone ? `טלפון: ${phone}` : null,
  ].filter(Boolean).join('\n');

  const { data, error } = await supabase.functions.invoke('send-contact-email', {
    body: { email: contactEmail || LEGAL_CONTACT_EMAIL, message },
  });
  if (error) {
    if (error.context && typeof error.context.json === 'function') {
      try {
        const body = await error.context.json();
        if (body?.error) throw new Error(body.error);
      } catch (parseErr) {
        if (parseErr instanceof Error && parseErr.message !== error.message) throw parseErr;
      }
    }
    throw error;
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
