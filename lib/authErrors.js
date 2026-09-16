// הודעות שגיאה ידידותיות למשתמש עבור זרימות ההתחברות (Google/Apple/אימייל/טלפון). השגיאה
// הגולמית של Supabase/הספק נרשמת לקונסול לדיבוג בלבד - אף פעם לא מוצגת למשתמש כמו שהיא.
import { t } from './i18n';

// context: 'oauth' | 'emailSend' | 'phoneSend' | 'phoneLogin' | 'verify' | 'adminLogin'
// ההודעה מתורגמת בזמן הקריאה (לפי השפה הפעילה), לא בזמן טעינת המודול.
export function friendlyAuthError(err, context) {
  const raw = String(err?.message || err || '');
  if (raw) console.warn(`[auth:${context}]`, raw);

  if (/rate limit|too many|only request this after|429/i.test(raw)) return t('auth.errors.rateLimit');
  if (/failed to fetch|network request failed|networkerror|load failed/i.test(raw)) return t('auth.errors.network');
  if (/provider is not enabled|unsupported provider/i.test(raw)) return t('auth.errors.providerDisabled');
  if (/invalid login credentials/i.test(raw)) return t('auth.errors.invalidCredentials');
  if (/expired|invalid.*(otp|token|code)|token.*invalid/i.test(raw)) return t('auth.errors.codeInvalid');
  if (/database error saving new user/i.test(raw)) return context === 'phoneLogin' ? t('auth.errors.phoneNotFound') : t('auth.errors.signupFailed');
  if (/validate email|invalid.*email|email.*invalid/i.test(raw)) return t('auth.errors.emailInvalid');
  if ((context === 'phoneSend' || context === 'phoneLogin') && /sms|provider|twilio/i.test(raw)) return t('auth.errors.smsUnavailable');
  if (context === 'oauth') return t('auth.errors.oauthIncomplete');
  return t('auth.errors.generic');
}
