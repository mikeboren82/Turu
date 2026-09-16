import { useState, useEffect } from 'react';
import { View, Text, Pressable, Modal, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Line } from 'react-native-svg';
import { useRouter, usePathname } from 'expo-router';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { supabase } from '../lib/supabase';
import { clearPin } from '../lib/pin';
import { HomeIcon, HeartIcon, UserIcon, ChatIcon, InfoIcon, MailIcon, LogOutIcon, NoteIcon, AlertIcon } from './icons';
import LoginRequiredModal from './LoginRequiredModal';
import FeedbackButton from './FeedbackButton';
import LanguageSwitcher from './LanguageSwitcher';
import { useI18n, createStyles } from '../lib/i18n';

// Points left in both languages: the header geometry is physical (back button top-left).
function BackIcon() {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={colors.ink} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <Line x1="15" y1="6" x2="9" y2="12" />
      <Line x1="9" y1="12" x2="15" y2="18" />
    </Svg>
  );
}

function MenuIcon() {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={colors.ink} strokeWidth={1.8} strokeLinecap="round">
      <Line x1="4" y1="7" x2="20" y2="7" />
      <Line x1="4" y1="12" x2="20" y2="12" />
      <Line x1="4" y1="17" x2="20" y2="17" />
    </Svg>
  );
}

export default function Header({ showBack = false, onMenuPress, hideLogo = false, onHeaderLayout, onNicknameResolved, showLanguageSwitcher = false }) {
  const router = useRouter();
  const { t } = useI18n();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const [menuOpen, setMenuOpen] = useState(false);
  const [session, setSession] = useState(null);
  const [nickname, setNickname] = useState('');
  const [stars, setStars] = useState(0);
  const [children, setChildren] = useState([]);
  const [showDestinationsPrompt, setShowDestinationsPrompt] = useState(false);
  const [authPromptMessage, setAuthPromptMessage] = useState('');
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  // "משהו לא עובד?" (בקשת המשתמש 2026-09-12) - הכפתור-המרחף הגלובלי הוסר, הפיצ'ר עבר לכאן
  // כפריט בתפריט, מתחת ל"צור קשר" - אותו FeedbackButton בדיוק, רק נשלט (visible/onClose) במקום
  // כפתור עצמאי.
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      if (!cancelled) setSession(s);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => { cancelled = true; sub.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!session?.user?.id) { setNickname(''); setStars(0); setChildren([]); return; }
    supabase.from('profiles').select('nickname, stars, children').eq('id', session.user.id).maybeSingle().then(({ data, error }) => {
      if (cancelled) return;
      if (!error && data) {
        setNickname(data.nickname || '');
        setStars(data.stars ?? 0);
        setChildren(Array.isArray(data.children) ? data.children : []);
        return;
      }
      // stars עוד לא קיים ב-DB (0020_recommendation_stars.sql לא רץ) - נופל חזרה לכינוי+ילדים.
      supabase.from('profiles').select('nickname, children').eq('id', session.user.id).maybeSingle().then(({ data: basic }) => {
        if (!cancelled) {
          setNickname(basic?.nickname || '');
          setStars(0);
          setChildren(Array.isArray(basic?.children) ? basic.children : []);
        }
      });
    });
    return () => { cancelled = true; };
  }, [session?.user?.id]);

  // הודעת-כינוי-מוסכם החוצה למי שצריך אותו מחוץ ל-Header עצמו (למשל ברכת-שלום במסך הבית) -
  // אותו דפוס בדיוק כמו onHeaderLayout, כדי לא לשכפל את שליפת ה-profile שכבר קורית כאן.
  useEffect(() => {
    onNicknameResolved?.(nickname);
  }, [nickname, onNicknameResolved]);

  const handleMenuPress = () => {
    onMenuPress?.();
    setMenuOpen(true);
  };

  // אותה לוגיקת התנתקות בדיוק כמו app/profile.js (handleLogout) - שני המקומות היחידים בקוד
  // שקוראים ל-signOut, אז חשוב שיישארו זהים: מנקים גם PIN מקומי וגם את דגל "נשאל כבר על כניסה
  // מהירה" כדי שהמכשיר לא "יזכור" משתמש שהתנתק במפורש.
  const handleLogout = async () => {
    setShowLogoutConfirm(false);
    await supabase.auth.signOut();
    await clearPin();
    await AsyncStorage.removeItem('turu_asked_quick_login');
    router.replace('/login');
  };

  const isActive = (path) => pathname === path;

  // "היעדים שלי" ו"ההערות שלי" מובילים שניהם ל-app/my-things.js (עמוד "❤️ הדברים שלי" המאוחד),
  // רק עם טאב פתוח שונה (?tab=notes) - לא שני routes נפרדים.
  const primaryItems = [
    { key: 'activities', labelKey: 'nav.menu.activities', path: '/activities', Icon: HomeIcon },
    {
      key: 'destinations', labelKey: 'nav.menu.destinations', path: '/my-things', Icon: HeartIcon, requiresAuth: true,
      authMessageKey: 'nav.menu.destinationsAuth',
    },
    {
      key: 'notes', labelKey: 'nav.menu.notes', path: '/my-things?tab=notes', Icon: NoteIcon, requiresAuth: true,
      authMessageKey: 'nav.menu.notesAuth',
    },
    ...(session ? [{ key: 'profile', labelKey: 'nav.menu.profile', path: '/profile', Icon: UserIcon }] : []),
  ];

  const secondaryItems = [
    { key: 'chat', labelKey: 'nav.menu.chat', path: '/chat', Icon: ChatIcon },
    { key: 'about', labelKey: 'nav.menu.about', path: '/about', Icon: InfoIcon },
    { key: 'contact', labelKey: 'nav.menu.contact', path: '/contact', Icon: MailIcon },
    // "משהו לא עובד?" - מתחת ל"צור קשר" בדיוק (בקשת המשתמש), action במקום path: פותח את
    // מודל-הדיווח (FeedbackButton) במקום לנווט לעמוד.
    { key: 'feedback', labelKey: 'nav.menu.feedback', action: 'openFeedback', Icon: AlertIcon },
  ];

  // בלי session - במקום ניווט לעמוד ריק, פותחים LoginRequiredModal עם הסבר מותאם-הקשר לפריט
  // שנלחץ (authMessage לכל פריט requiresAuth למעלה).
  const handleItemPress = (item) => {
    setMenuOpen(false);
    if (item.action === 'openFeedback') {
      setFeedbackOpen(true);
      return;
    }
    if (item.requiresAuth && !session) {
      setAuthPromptMessage(item.authMessageKey ? t(item.authMessageKey) : t('common.loginRequired.defaultMessage'));
      setShowDestinationsPrompt(true);
      return;
    }
    router.push(item.path);
  };

  const renderMenuRow = (item, { primary }) => {
    const active = isActive(item.path);
    return (
      <Pressable
        key={item.key}
        style={({ pressed }) => [styles.dropdownItem, active && styles.dropdownItemActive, pressed && styles.itemPressed]}
        onPress={() => handleItemPress(item)}
      >
        <item.Icon size={primary ? 18 : 17} color={active ? colors.accent : primary ? colors.textPrimary : colors.textSecondary} />
        <Text
          style={[primary ? styles.primaryItemText : styles.secondaryItemText, active && styles.itemTextActive]}
          numberOfLines={1}
        >
          {t(item.labelKey)}
        </Text>
      </Pressable>
    );
  };

  return (
    <View
      style={styles.header}
      onLayout={onHeaderLayout ? (e) => onHeaderLayout(e.nativeEvent.layout) : undefined}
    >
      {showBack ? (
        <Pressable
          style={[styles.iconBtn, styles.side, styles.sideLeft]}
          onPress={() => router.back()}
          accessibilityLabel={t('nav.header.backA11y')}
        >
          <BackIcon />
        </Pressable>
      ) : (
        <View style={[styles.side, styles.sideLeft]} />
      )}

      {!hideLogo && (
        <Pressable style={styles.logoWrap} onPress={() => router.push('/')} accessibilityLabel={t('nav.header.logoA11y')}>
          <Image source={require('../assets/turu-logo.png')} style={styles.logoImage} resizeMode="contain" />
        </Pressable>
      )}

      {/* בורר-שפה (רק בעמוד הבית): absolute מעל כפתור התפריט, באותו צד - לא דוחף תוכן ולא נוגע
          בלוגו או ב-SunMascot של app/index.js (שיושב בצד הנגדי). מרונדר לפני כפתור התפריט כדי שבחפיפת
          hitSlop הכפתור יישאר עליון. */}
      {showLanguageSwitcher ? <LanguageSwitcher style={styles.languageSwitcher} /> : null}

      <Pressable
        style={[styles.iconBtn, styles.side, styles.sideRight]}
        onPress={handleMenuPress}
        accessibilityLabel={t('nav.header.menuA11y')}
      >
        <MenuIcon />
      </Pressable>

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setMenuOpen(false)}>
          <View style={[styles.dropdown, { marginTop: insets.top + 60 }]}>
            {session ? (
              <Pressable
                style={({ pressed }) => [styles.authArea, pressed && styles.itemPressed]}
                onPress={() => { setMenuOpen(false); router.push('/profile'); }}
              >
                <View style={styles.authAvatar}>
                  <Text style={styles.authAvatarText}>{(nickname || '?')[0]}</Text>
                </View>
                <View style={styles.authTextWrap}>
                  <Text style={styles.authGreeting} numberOfLines={1}>{nickname ? t('nav.menu.greeting', { name: nickname }) : t('nav.menu.greetingNoName')}</Text>
                  <Text style={styles.authSubLink}>{t('nav.menu.profile')}</Text>
                  {children.length > 0 && (
                    <Text style={styles.authKidsLine}>{t('nav.menu.kids', { count: children.length })}</Text>
                  )}
                </View>
                {stars > 0 && <Text style={styles.authStars}>⭐{stars}</Text>}
              </Pressable>
            ) : (
              <Pressable
                style={({ pressed }) => [styles.ctaRow, pressed && styles.itemPressed]}
                onPress={() => { setMenuOpen(false); router.push('/login'); }}
              >
                <UserIcon size={18} color={colors.accent} />
                <Text style={styles.ctaText}>{t('nav.menu.login')}</Text>
              </Pressable>
            )}

            <View style={styles.dropdownDivider} />
            {primaryItems.map((item) => renderMenuRow(item, { primary: true }))}
            <View style={styles.dropdownDivider} />
            {secondaryItems.map((item) => renderMenuRow(item, { primary: false }))}

            {session ? (
              <>
                <View style={styles.dropdownDivider} />
                <Pressable
                  style={({ pressed }) => [styles.dropdownItem, pressed && styles.itemPressed]}
                  onPress={() => { setMenuOpen(false); setShowLogoutConfirm(true); }}
                >
                  <LogOutIcon size={17} color={colors.textSecondary} />
                  <Text style={styles.logoutItemText} numberOfLines={1}>{t('nav.menu.logout')}</Text>
                </Pressable>
              </>
            ) : null}

            <View style={styles.dropdownDivider} />
            <View style={styles.legalRow}>
              <Pressable onPress={() => { setMenuOpen(false); router.push('/terms'); }}>
                <Text style={styles.legalLinkText}>{t('nav.menu.terms')}</Text>
              </Pressable>
              <Text style={styles.legalDot}>·</Text>
              <Pressable onPress={() => { setMenuOpen(false); router.push('/privacy'); }}>
                <Text style={styles.legalLinkText}>{t('nav.menu.privacy')}</Text>
              </Pressable>
            </View>
          </View>
        </Pressable>
      </Modal>

      <LoginRequiredModal
        visible={showDestinationsPrompt}
        onClose={() => setShowDestinationsPrompt(false)}
        message={authPromptMessage}
      />

      <Modal visible={showLogoutConfirm} transparent animationType="fade" onRequestClose={() => setShowLogoutConfirm(false)}>
        <Pressable style={styles.confirmBackdrop} onPress={() => setShowLogoutConfirm(false)}>
          <Pressable style={styles.confirmCard} onPress={() => {}}>
            <Text style={styles.confirmTitle}>{t('nav.menu.logoutConfirm')}</Text>
            <View style={styles.confirmActionsRow}>
              <Pressable style={styles.confirmCancelBtn} onPress={() => setShowLogoutConfirm(false)}>
                <Text style={styles.confirmCancelText}>{t('common.actions.cancel')}</Text>
              </Pressable>
              <Pressable style={styles.confirmLogoutBtn} onPress={handleLogout}>
                <Text style={styles.confirmLogoutText}>{t('nav.menu.logout')}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <FeedbackButton visible={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </View>
  );
}

const styles = createStyles((d) => ({
  // Physical in both languages on purpose: back ← stays top-left (the English convention, and the
  // approved Hebrew layout), menu top-right. Only the dropdown's contents follow the reading direction.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  side: { width: 38, height: 38 },
  sideLeft: {},
  sideRight: {},
  iconBtn: {
    borderRadius: 19,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoWrap: { alignItems: 'center' },
  logoImage: { width: 132, height: 92 },
  // מעל כפתור התפריט (38px, ממורכז בשורה של ~104px → מתחיל ב-~33px): גובה הבורר 30, top:-4 → ~7px רווח מעל הכפתור.
  languageSwitcher: { position: 'absolute', right: 0, top: -4 },

  backdrop: { flex: 1, alignItems: 'flex-end' },
  dropdown: {
    marginRight: 18, minWidth: 220, maxWidth: 280,
    backgroundColor: colors.card, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border,
    paddingVertical: 6, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6,
    overflow: 'hidden',
  },

  itemPressed: { opacity: 0.6 },

  // אזור עליון - זהות/CTA. אותו tint עדין (accentTintLight) בשני המצבים: "ברור אך לא אגרסיבי".
  authArea: {
    flexDirection: d.row, alignItems: 'center', gap: 10,
    paddingVertical: 14, paddingHorizontal: 16, backgroundColor: colors.accentTintLight,
  },
  authAvatar: {
    width: 30, height: 30, borderRadius: 15, backgroundColor: colors.accent,
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  authAvatarText: { fontFamily: fonts.bold, fontSize: 13, color: '#fff' },
  authTextWrap: { flex: 1, minWidth: 0 },
  authGreeting: { fontFamily: fonts.extraBold, fontSize: 14.5, color: colors.accent, textAlign: d.textAlign },
  authSubLink: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.accent, textAlign: d.textAlign, marginTop: 1, opacity: 0.8 },
  authKidsLine: { fontFamily: fonts.regular, fontSize: 11, color: colors.textMuted, textAlign: d.textAlign, marginTop: 3 },
  authStars: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.yellow, flexShrink: 0 },

  ctaRow: {
    flexDirection: d.row, alignItems: 'center', gap: 10,
    paddingVertical: 14, paddingHorizontal: 16, backgroundColor: colors.accentTintLight,
  },
  ctaText: { fontFamily: fonts.extraBold, fontSize: 14.5, color: colors.accent, textAlign: d.textAlign },

  dropdownDivider: { height: 1, backgroundColor: colors.border, marginVertical: 6 },

  dropdownItem: {
    flexDirection: d.row, alignItems: 'center', gap: 12,
    paddingVertical: 13, paddingHorizontal: 16, minHeight: 48,
  },
  dropdownItemActive: { backgroundColor: colors.accentTintLight },
  primaryItemText: { flexShrink: 1, fontFamily: fonts.bold, fontSize: 14.5, color: colors.textPrimary, textAlign: d.textAlign },
  secondaryItemText: { flexShrink: 1, fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary, textAlign: d.textAlign },
  itemTextActive: { color: colors.accent },

  logoutItemText: { fontFamily: fonts.semiBold, fontSize: 13.5, color: colors.textSecondary, textAlign: d.textAlign },

  legalRow: {
    flexDirection: d.row, alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, paddingHorizontal: 16,
  },
  legalLinkText: { fontFamily: fonts.regular, fontSize: 11, color: colors.textMuted },
  legalDot: { fontFamily: fonts.regular, fontSize: 11, color: colors.textMuted },

  confirmBackdrop: {
    flex: 1, backgroundColor: 'rgba(20,30,35,0.4)', justifyContent: 'center', alignItems: 'center', padding: spacing.xl,
  },
  confirmCard: { width: '100%', maxWidth: 320, backgroundColor: colors.card, borderRadius: radii.xl, padding: spacing.xl },
  confirmTitle: { fontFamily: fonts.extraBold, fontSize: 16, color: colors.textPrimary, textAlign: 'center', marginBottom: 18 },
  confirmActionsRow: { flexDirection: d.row, gap: 10 },
  confirmCancelBtn: {
    flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: radii.pill,
    borderWidth: 1, borderColor: colors.border,
  },
  confirmCancelText: { fontFamily: fonts.bold, fontSize: 14, color: colors.textSecondary },
  confirmLogoutBtn: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: radii.pill, backgroundColor: colors.textSecondary },
  confirmLogoutText: { fontFamily: fonts.bold, fontSize: 14, color: '#fff' },
}));
