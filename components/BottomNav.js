import { useState, useEffect } from 'react';
import { View, Text, Pressable } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts } from '../constants/theme';
import { supabase } from '../lib/supabase';
import LoginRequiredModal from './LoginRequiredModal';
import { HomeIcon, CategoryIcon, HeartIcon, UserIcon } from './icons';
import { useI18n, createStyles } from '../lib/i18n';

// סרגל-ניווט תחתון - קבוע בכל מסך באפליקציה (בקשת המשתמש: "צריך להופיע בכל אחד מהמסכים...
// קבוע כמו הלוגו שלמעלה") - מרונדר פעם אחת ב-app/_layout.js, מחוץ ל-<Stack>. לפני זה הוצג רק
// בעמוד הבית (app/index.js) - הוסר משם.
// "שמורים"/"פרופיל" מנווטים ל-routes קיימים בלבד (my-things/profile) - אין יעד חדש/שבור.
// "מפה" הוחלף ב"פעילויות" (בקשת המשתמש) - מוביל ישר לעמוד התוצאות ברשימה הרגילה, לא לתצוגת
// מפה; תצוגת המפה עדיין קיימת בעמוד עצמו (viewMode toggle, app/activities.js) למי שרוצה אותה.
const NAV_ITEMS = [
  { key: 'home', labelKey: 'nav.bottom.home', path: '/', Icon: HomeIcon },
  { key: 'activities', labelKey: 'nav.bottom.activities', path: '/activities', Icon: CategoryIcon },
  { key: 'saved', labelKey: 'nav.bottom.saved', path: { pathname: '/my-things', params: { tab: 'saved' } }, matchPath: '/my-things', Icon: HeartIcon, requiresAuth: true },
  { key: 'profile', labelKey: 'nav.bottom.profile', path: '/profile', Icon: UserIcon },
];

export default function BottomNav() {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  // מנוהל כאן פנימית (לא props מההורה) - עכשיו שהקומפוננטה חיה ב-_layout.js, מעל כל מסך,
  // אין "הורה טבעי" יחיד שיכול לספק isLoggedIn/onAuthRequired - אותו דפוס בדיוק כמו Header,
  // ששולף session בעצמו.
  const [session, setSession] = useState(null);
  const [showLoginPrompt, setShowLoginPrompt] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      if (!cancelled) setSession(s);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => { cancelled = true; sub.subscription.unsubscribe(); };
  }, []);

  const handlePress = (item) => {
    if (item.requiresAuth && !session) {
      setShowLoginPrompt(true);
      return;
    }
    router.push(item.path);
  };

  return (
    <>
      <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 10) }]}>
        {NAV_ITEMS.map((item) => {
          const active = pathname === (item.matchPath || item.path);
          return (
            <Pressable key={item.key} style={styles.item} onPress={() => handlePress(item)} hitSlop={6}>
              <item.Icon size={20} color={active ? colors.accent : colors.textMuted} />
              <Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>{t(item.labelKey)}</Text>
            </Pressable>
          );
        })}
      </View>
      <LoginRequiredModal visible={showLoginPrompt} onClose={() => setShowLoginPrompt(false)} />
    </>
  );
}

const styles = createStyles((d) => ({
  // View רגיל, לא sticky/fixed - כ"אח" קבוע-גובה אחרי ה-<Stack> (לא בתוכו) בתוך root עם
  // flex:1 (app/_layout.js), ה-Stack שמעליו תמיד תופס את שאר הגובה - זה כל מה שצריך כדי
  // שהסרגל יישאר למטה על כל מסך.
  bar: {
    flexDirection: d.row, backgroundColor: colors.card, borderTopWidth: 1, borderTopColor: colors.borderLight,
    paddingTop: 8,
  },
  item: { flex: 1, alignItems: 'center', gap: 3 },
  label: { fontFamily: fonts.semiBold, fontSize: 11, color: colors.textMuted },
  labelActive: { color: colors.accent, fontFamily: fonts.bold },
}));
