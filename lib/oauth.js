import { Platform } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { supabase } from './supabase';

// חייב לרוץ פעם אחת (לא בכל קריאה) כדי שהדפדפן/WebView יסגור את עצמו נכון אחרי חזרה
// מה-OAuth redirect - זו הדרישה הרשמית של expo-web-browser.
WebBrowser.maybeCompleteAuthSession();

// זרימת OAuth דרך דפדפן (לא SDK native של Google/Apple) - עובדת על web/Expo Go/dev-client
// כאחד בלי build native, כי אין עדיין ios.bundleIdentifier/android.package מוגדרים בפרויקט.
// כשיהיה build native אמיתי בעתיד, אותה זרימה ממשיכה לעבוד בלי שינוי קוד (רק חוויה קצת פחות
// "native-feeling" מ-SDK ייעודי). Supabase Dashboard -> Authentication -> Providers צריך
// שה-provider יהיה מוגדר שם (Client ID/Secret מ-Google Cloud Console / Apple Developer) -
// עד אז זה נכשל בשגיאה ברורה, לא תקוע.
// signInWithOAuth רק בונה URL (בלי קריאת שרת) - אם הספק כבוי ב-Supabase (Apple, נכון להיום),
// המשתמש היה מנותב לדף JSON גולמי של שגיאה. בודקים מראש מול /auth/v1/settings (ציבורי); אם
// הבדיקה עצמה נכשלת (רשת) - ממשיכים כרגיל ולא חוסמים.
async function assertProviderEnabled(provider) {
  let enabled = true;
  try {
    const res = await fetch(`${process.env.EXPO_PUBLIC_SUPABASE_URL}/auth/v1/settings`, {
      headers: { apikey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY },
    });
    if (res.ok) enabled = (await res.json())?.external?.[provider] !== false;
  } catch {
    return;
  }
  if (!enabled) throw new Error('provider is not enabled');
}

async function signInWithProvider(provider) {
  await assertProviderEnabled(provider);
  const redirectTo = AuthSession.makeRedirectUri();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error) throw error;
  if (!data?.url) throw new Error('לא התקבלה כתובת התחברות מהשרת');

  if (Platform.OS === 'web') {
    // בדפדפן: ניווט מלא של הדף (לא חלון popup) - openAuthSessionAsync פותח popup דרך
    // window.open, וזה נחסם ע"י הדפדפן כי הקריאה מגיעה אחרי await ל-signInWithOAuth,
    // כלומר כבר לא "צמוד" מספיק לקליק המקורי של המשתמש. ניווט מלא לא נחסם אף פעם.
    // אחרי החזרה מ-Google/Apple, completeOAuthRedirect() (נקרא ב-login.js בעלייה) ממשיך.
    window.location.assign(data.url);
    return new Promise(() => {}); // הדף עוזב עכשיו - אין למה "לחזור" מכאן
  }

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);

  if (result.type === 'cancel' || result.type === 'dismiss') {
    return { cancelled: true };
  }
  if (result.type !== 'success' || !result.url) {
    throw new Error('ההתחברות לא הושלמה - נסו שוב');
  }

  // הטוקנים חוזרים ב-fragment (#access_token=...) ולא ב-query string - צריך לפרק ידנית
  // כי detectSessionInUrl:false ב-lib/supabase.js (בכוונה, כדי לא להתנגש בין web/native).
  const hashPart = result.url.split('#')[1];
  if (!hashPart) {
    const params = new URL(result.url).searchParams;
    const errorDescription = params.get('error_description') || params.get('error');
    throw new Error(errorDescription || 'ההתחברות נכשלה - ייתכן שהספק עדיין לא מוגדר ב-Supabase');
  }
  const hashParams = new URLSearchParams(hashPart);
  const access_token = hashParams.get('access_token');
  const refresh_token = hashParams.get('refresh_token');
  if (!access_token || !refresh_token) {
    throw new Error(hashParams.get('error_description') || 'לא התקבל טוקן התחברות תקין');
  }

  const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
    access_token,
    refresh_token,
  });
  if (sessionError) throw sessionError;

  return { cancelled: false, session: sessionData.session };
}

export function signInWithGoogle() {
  return signInWithProvider('google');
}

export function signInWithApple() {
  return signInWithProvider('apple');
}

// נקרא בעלייה של login.js (web בלבד) - תופס את access_token/refresh_token שחוזרים ב-
// fragment של ה-URL אחרי ניווט מלא חזרה מ-Google/Apple (ראו signInWithProvider למעלה).
// מחזיר null אם אין fragment רלוונטי (עלייה רגילה, לא חזרה מ-OAuth).
export async function completeOAuthRedirect() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const hash = window.location.hash;

  // כשההתחברות נכשלת בצד Supabase (למשל Client secret שגוי), הוא מחזיר לאתר עם error_code
  // ב-query וב-hash במקום טוקנים. בלי הבדיקה הזו המשתמש נחת בדף הבית בלי שום הודעה.
  const query = new URLSearchParams(window.location.search);
  const hashParams0 = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  if (query.get('error_code') || hashParams0.get('error_code')) {
    const description = query.get('error_description') || hashParams0.get('error_description') || query.get('error') || hashParams0.get('error');
    window.history.replaceState(null, '', window.location.pathname);
    throw new Error(description || 'ההתחברות נכשלה');
  }

  if (!hash || !hash.includes('access_token')) return null;

  const hashParams = new URLSearchParams(hash.slice(1));
  // ניקוי מיידי של ה-hash מה-URL - לא רוצים שהטוקן יישאר גלוי בשורת הכתובת/יתפרש שוב ברענון.
  window.history.replaceState(null, '', window.location.pathname + window.location.search);

  const access_token = hashParams.get('access_token');
  const refresh_token = hashParams.get('refresh_token');
  if (!access_token || !refresh_token) {
    throw new Error(hashParams.get('error_description') || 'ההתחברות נכשלה - נסו שוב');
  }

  const { data, error } = await supabase.auth.setSession({ access_token, refresh_token });
  if (error) throw error;
  return { session: data.session };
}
