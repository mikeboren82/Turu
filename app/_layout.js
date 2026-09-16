import { useEffect } from 'react';
import { I18nManager, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFonts, Assistant_400Regular, Assistant_500Medium, Assistant_600SemiBold, Assistant_700Bold, Assistant_800ExtraBold } from '@expo-google-fonts/assistant';
import { Fredoka_600SemiBold, Fredoka_700Bold } from '@expo-google-fonts/fredoka';
import { FrankRuhlLibre_600SemiBold, FrankRuhlLibre_700Bold } from '@expo-google-fonts/frank-ruhl-libre';
import { colors } from '../constants/theme';
import BottomNav from '../components/BottomNav';
import { completeOAuthRedirect } from '../lib/oauth';
import { enforceNotBanned } from '../lib/checkBanned';
import { recordLegalConsentIfNeeded } from '../lib/legal';

// לא כופים RTL ברמת המערכת: על אנדרואיד אמיתי forceRTL הופך אוטומטית flexDirection:'row'
// ל-row-reverse, מה שהפך את כל הפריסה (שנבנתה ואומתה מול הדפדפן, שם I18nManager הוא stub
// שתמיד מחזיר isRTL:false) - כיוון RTL מושג ידנית בקוד עצמו (row-reverse מפורש, textAlign:'right').
if (I18nManager.isRTL) {
  I18nManager.allowRTL(false);
  I18nManager.forceRTL(false);
  // דורש סגירה ופתיחה מחדש של האפליקציה כדי להיכנס לתוקף (בדיוק כמו שכפיית RTL דרשה קודם)
}

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const router = useRouter();

  // תופס התחברות שחוזרת מקישור-קסם (אימייל) או OAuth (Google/Apple) - נעשה כאן, גלובלית,
  // ולא רק ב-login.js, כי קישור-הקסם באימייל חוזר ל-Site URL הראשי של הפרויקט (בדרך כלל "/"),
  // לא בהכרח לעמוד שממנו התחילה ההתחברות. ראו lib/oauth.js.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await completeOAuthRedirect();
        if (cancelled || !result?.session?.user?.id) return;
        const userId = result.session.user.id;
        if (await enforceNotBanned(userId)) {
          router.replace('/login');
          return;
        }
        await recordLegalConsentIfNeeded(userId);
        const [asked, pin, bio] = await Promise.all([
          AsyncStorage.getItem('turu_asked_quick_login'),
          AsyncStorage.getItem('turu_pin_enabled'),
          AsyncStorage.getItem('turu_biometric_enabled'),
        ]);
        if (cancelled) return;
        const alreadySetUp = pin === 'true' || bio === 'true';
        router.replace(asked === 'true' || alreadySetUp ? '/' : '/biometric-prompt');
      } catch (err) {
        console.warn('completeOAuthRedirect failed:', err?.message || err);
        if (!cancelled) router.replace({ pathname: '/login', params: { authError: '1' } });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const [fontsLoaded] = useFonts({
    Assistant_400Regular,
    Assistant_500Medium,
    Assistant_600SemiBold,
    Assistant_700Bold,
    Assistant_800ExtraBold,
    Fredoka_600SemiBold,
    Fredoka_700Bold,
    FrankRuhlLibre_600SemiBold,
    FrankRuhlLibre_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return null;
  }

  return (
    <SafeAreaProvider>
      <View style={{ flex: 1 }}>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.bg },
            animation: 'slide_from_left',
          }}
        />
        <BottomNav />
      </View>
    </SafeAreaProvider>
  );
}
