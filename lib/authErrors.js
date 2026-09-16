// הודעות שגיאה ידידותיות למשתמש עבור זרימות ההתחברות (Google/Apple/אימייל/טלפון). השגיאה
// הגולמית של Supabase/הספק נרשמת לקונסול לדיבוג בלבד - אף פעם לא מוצגת למשתמש כמו שהיא.
const COPY = {
  rateLimit: 'נשלחו יותר מדי בקשות. נסו שוב בעוד דקה.',
  network: 'אין חיבור, או שהשרת לא זמין כרגע. בדקו את החיבור ונסו שוב.',
  providerDisabled: 'ההתחברות בדרך הזו עדיין לא זמינה. אפשר להמשיך עם Google או עם אימייל.',
  codeInvalid: 'הקוד שגוי או שפג תוקפו. נסו שוב או שלחו קוד חדש.',
  emailInvalid: 'כתובת האימייל לא תקינה.',
  phoneNotFound: 'לא מצאנו חשבון עם המספר הזה. כדי להירשם, עברו ל"הרשמה".',
  signupFailed: 'לא הצלחנו ליצור את החשבון. נסו שוב.',
  smsUnavailable: 'שליחת קוד בסמס לא זמינה כרגע. אפשר להמשיך עם אימייל.',
  oauthIncomplete: 'ההתחברות לא הושלמה. נסו שוב.',
  generic: 'משהו השתבש. נסו שוב.',
};

// context: 'oauth' | 'emailSend' | 'phoneSend' | 'phoneLogin' | 'verify'
export function friendlyAuthError(err, context) {
  const raw = String(err?.message || err || '');
  if (raw) console.warn(`[auth:${context}]`, raw);

  if (/rate limit|too many|only request this after|429/i.test(raw)) return COPY.rateLimit;
  if (/failed to fetch|network request failed|networkerror|load failed/i.test(raw)) return COPY.network;
  if (/provider is not enabled|unsupported provider/i.test(raw)) return COPY.providerDisabled;
  if (/expired|invalid.*(otp|token|code)|token.*invalid/i.test(raw)) return COPY.codeInvalid;
  if (/database error saving new user/i.test(raw)) return context === 'phoneLogin' ? COPY.phoneNotFound : COPY.signupFailed;
  if (/validate email|invalid.*email|email.*invalid/i.test(raw)) return COPY.emailInvalid;
  if ((context === 'phoneSend' || context === 'phoneLogin') && /sms|provider|twilio/i.test(raw)) return COPY.smsUnavailable;
  if (context === 'oauth') return COPY.oauthIncomplete;
  return COPY.generic;
}
