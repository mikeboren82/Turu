import { useState, useEffect } from 'react';
import { View, Text, Pressable, Modal, Image, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Line } from 'react-native-svg';
import { useRouter, usePathname } from 'expo-router';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { supabase } from '../lib/supabase';
import { clearPin } from '../lib/pin';
import {
  HomeIcon, HeartIcon, UserIcon, ChatIcon, InfoIcon, MailIcon, LogOutIcon, NoteIcon, HelpIcon, GlobeIcon, ChevronLeftIcon,
} from './icons';
import LoginRequiredModal from './LoginRequiredModal';
import FeedbackButton from './FeedbackButton';
import LanguageSheet from './LanguageSheet';
import { useI18n, createStyles, LOCALES } from '../lib/i18n';

// Points left in both languages: the header geometry is physical (back button top-left).
function BackIcon() {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={colors.ink} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <Line x1="15" y1="6" x2="9" y2="12" />
      <Line x1="9" y1="12" x2="15" y2="18" />
    </Svg>
  );
}

// size (2026-09-20, בקשת המשתמש: "כפתור התפריט... גדול יותר") - פרמטר חדש, ברירת-מחדל 16 כמו
// קודם (BackIcon למעלה לא נגע - נשאר 16 קבוע, רק כפתור-התפריט גדל, ראו menuBtn/menuIconSize למטה).
function MenuIcon({ size = 16 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={colors.ink} strokeWidth={1.8} strokeLinecap="round">
      <Line x1="4" y1="7" x2="20" y2="7" />
      <Line x1="4" y1="12" x2="20" y2="12" />
      <Line x1="4" y1="17" x2="20" y2="17" />
    </Svg>
  );
}

export default function Header({
  showBack = false, onMenuPress, hideLogo = false, onHeaderLayout, onNicknameResolved, largeLogo = false,
}) {
  const router = useRouter();
  const { t, locale, dir } = useI18n();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  // logoCompact (2026-09-20) - נמדד בפועל ב-320px: logoImage (250x108, "הלוגו... יותר גדול")
  // גלש פיזית מעבר לקצה המסך וחתך את כפתור-התפריט (right:354 מול viewport 320, docScrollWidth
  // עדיין 320 - clip ע"י overflow:hidden של אב, לא scroll אמיתי). אותו breakpoint/סף בדיוק כמו
  // heroCompact ב-app/index.js (windowWidth<360) - עקביות עם התבנית הקיימת באפליקציה.
  const { width: windowWidth } = useWindowDimensions();
  const logoCompact = windowWidth < 360;
  const [menuOpen, setMenuOpen] = useState(false);
  const [languageSheetOpen, setLanguageSheetOpen] = useState(false);
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
    // /chat (app/chat/index.js) הוא עדיין PlaceholderScreen ("המסך הזה עוד ייבנה") - הניווט
    // עצמו נשאר (לא מפעילים פיצ'ר לא-גמור), אבל תג "בקרוב" הופך את זה למכוון ונגיש במקום
    // "עמום סתם" (היה זהה חזותית לשאר השורות, בלי שום סימון שמסביר את זה).
    { key: 'chat', labelKey: 'nav.menu.chat', path: '/chat', Icon: ChatIcon, comingSoon: true },
    { key: 'about', labelKey: 'nav.menu.about', path: '/about', Icon: InfoIcon },
    { key: 'contact', labelKey: 'nav.menu.contact', path: '/contact', Icon: MailIcon },
    // "משהו לא עובד?" - מתחת ל"צור קשר" בדיוק (בקשת המשתמש), action במקום path: פותח את
    // מודל-הדיווח (FeedbackButton) במקום לנווט לעמוד. HelpIcon ("?") ולא AlertIcon - זה האחרון
    // כמעט זהה ויזואלית ל-InfoIcon ("עלינו") בגודל אייקון-תפריט, ומרגיש כמו אזהרת-מערכת ולא
    // דיווח/עזרה ידידותיים.
    { key: 'feedback', labelKey: 'nav.menu.feedback', action: 'openFeedback', Icon: HelpIcon },
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
        {item.comingSoon ? (
          <View style={styles.comingSoonBadge}>
            <Text style={styles.comingSoonText}>{t('nav.menu.comingSoon')}</Text>
          </View>
        ) : null}
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
          {/* logo-turu-gradient-transparent.png (2026-09-22, "Home Screen Visual Redesign" - new
              main logo. The file the user added, "Logo Turu Gradient.png", is kept UNTOUCHED on
              disk, but it is an opaque RGB PNG with a solid black background baked into the pixels
              (verified via its PNG header: colorType=2, no alpha channel at all - not a resizeMode/
              rendering bug). tools/make-logo-transparent.js produced this cutout version (background
              removed with edge decontamination, see that script's header) so the logo sits cleanly
              on the sky background instead of showing a black box. turu-logo.png (the OLD logo) is
              also kept on disk unchanged/still available.
              Its artwork aspect ratio (1586x992 ≈ 1.60) is very different from the old file's
              (740x333 ≈ 2.22), so resizeMode is "contain" here (not "stretch" - the old file's
              deliberate stretch choice does not transfer: stretching a differently-proportioned
              gradient wordmark would visibly distort it). Box widths below were recalculated for the
              new ratio while keeping the exact same HEIGHT as before on every variant, so the logo
              occupies the same visual scale in the header row it always did - only the width adapts
              to the real artwork shape. */}
          <Image
            source={require('../assets/logo-turu-gradient-transparent.png')}
            style={[
              styles.logoImage,
              logoCompact && styles.logoImageCompact,
              largeLogo && styles.logoImageLarge,
              largeLogo && logoCompact && styles.logoImageLargeCompact,
            ]}
            resizeMode="contain"
          />
        </Pressable>
      )}

      {/* menuBtn (חדש) - לא עוד iconBtn/side המשותף עם כפתור-החזרה (זה נשאר 38px, ללא שינוי) -
          בקשת המשתמש: "כפתור התפריט... גדול יותר", ספציפית לכפתור הזה בלבד. */}
      <Pressable
        style={[styles.iconBtn, styles.menuBtn, styles.sideRight]}
        onPress={handleMenuPress}
        accessibilityLabel={t('nav.header.menuA11y')}
      >
        <MenuIcon size={18} />
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
            {/* שפה - זמינה גם למשתמש אנונימי (לא בתוך אזור מחייב-חיבור), עם שם-שפה מלא ("עברית"/
                "English", לא "עב"/"EN") וה-scheme/persist/RTL-LTR הקיימים דרך LanguageSheet
                (setLocale אחד, מקור-אמת יחיד - lib/i18n). פותח sheet קטן במקום מסך Settings שלם. */}
            <Pressable
              style={({ pressed }) => [styles.dropdownItem, styles.languageRow, pressed && styles.itemPressed]}
              onPress={() => { setMenuOpen(false); setLanguageSheetOpen(true); }}
              accessibilityRole="button"
              accessibilityLabel={`${t('common.language.label')} - ${t('common.language.current', { language: LOCALES[locale].nativeName })}`}
            >
              <GlobeIcon size={17} color={colors.textSecondary} />
              <Text style={[styles.secondaryItemText, styles.languageRowLabel]}>{t('common.language.label')}</Text>
              <View style={styles.languageRowRight}>
                <Text style={styles.languageRowValue}>{LOCALES[locale].nativeName}</Text>
                <View style={{ transform: [{ rotate: dir.forwardRotate }] }}>
                  <ChevronLeftIcon size={12} color={colors.textMuted} />
                </View>
              </View>
            </Pressable>

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

      <LanguageSheet visible={languageSheetOpen} onClose={() => setLanguageSheetOpen(false)} />
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
  // menuBtn (חדש) - גדול מ-side הרגיל (38px), רק לכפתור-התפריט (בקשת המשתמש: "כפתור התפריט...
  // גדול יותר", ספציפית - לא כפתור-החזרה, שנשאר side/38px ללא שינוי). borderRadius עצמאי (24,
  // לא ה-19 המשותף של iconBtn) כדי להישאר עיגול מושלם בגודל החדש.
  // 44x44 (היה 48x48) - בקשת המשתמש: "אפשר גם להקטין את הכפתור, אבל מעט" - יחד עם הלוגו שהתרחב
  // (logoImage למטה), הכפתור נשאר קטן משמעותית מהלוגו כך שהלוגו ממשיך לקבוע את גובה-השורה
  // וה-centerY של שניהם נשאר זהה (alignItems:'center' ב-header, נבדק במדידה בפועל).
  menuBtn: { width: 44, height: 44, borderRadius: 22 },
  logoWrap: { alignItems: 'center' },
  // 212x92 (היה 250x108) - סבב "hero area visual refinement" (2026-09-19, בקשת המשתמש: "the logo
  // occupies a lot of visual space... reduce the logo block modestly. Do NOT make it tiny") -
  // כיווץ עדין (~85%) ששומר על אותו יחס-מתיחה בערך (2.304, היה 2.315), לא צמצום דרסטי.
  // width recalculated for the new logo's real aspect ratio (1586/992 ≈ 1.599), height UNCHANGED
  // (92) - same visual size/prominence as before, no stretch-distortion (see the resizeMode comment
  // above). 92*1.599 ≈ 147.
  logoImage: { width: 147, height: 92 },
  // logoCompact (<360px, ראו ההערה המלאה ליד ה-state למעלה) - אותו יחס-רוחב/גובה בדיוק (1.599),
  // height נשאר 70 כמו קודם. 70*1.599 ≈ 112.
  logoImageCompact: { width: 112, height: 70 },
  // largeLogo (2026-09-20, "TURU HOME SCREEN — SMALL VISUAL POLISH", בקשת המשתמש: "the logo...
  // should feel more prominent... keep its aspect ratio") - Home בלבד מזין largeLogo (ראו
  // app/index.js), שאר המסכים ממשיכים ב-logoImage הרגיל. ×1.10 בדיוק על שני הממדים (212x92 →
  // 233x101, 162x70 → 178x77) - נבחר לא ב-הרגשה אלא נמדד מול הרוחב הפנוי בפועל בשורת ה-header
  // (side:38 + menuBtn:44 + ריפוד-content spacing.xl*2, ב-320px וב-375px כאחד) כדי שהלוגו המוגדל
  // לא יתנגש בכפתור-התפריט (הבאג ההיסטורי שתועד למעלה עם 250x108) - נבדק בפועל בדפדפן בשני
  // הרוחבים. יחס-המתיחה (233/101≈2.307, 178/77≈2.312) נשאר כמעט זהה ל-logoImage/logoImageCompact
  // המקוריים (2.304/2.314 בהתאמה) - "keep aspect ratio" מתקיים.
  // 240x104 / 184x80 (היה 233x101 / 178x77, "small visual polish" round 3, 2026-09-20, בקשת
  // המשתמש: "להגדיל אותו ממש מעט" - עוד קצת, זהירות: נבדק שוב בפועל בדפדפן בשני הרוחבים (320/375)
  // שהלוגו המוגדל-נוסף עדיין לא מתנגש בכפתור-התפריט. יחס-המתיחה (240/104≈2.308, 184/80=2.3)
  // עדיין קרוב ל-2.304/2.314 המקוריים.
  // same recalculation for largeLogo (Home screen only) - height unchanged (104/80), width fitted
  // to the new artwork's real ratio (1.599): 104*1.599 ≈ 166, 80*1.599 ≈ 128.
  logoImageLarge: { width: 166, height: 104 },
  logoImageLargeCompact: { width: 128, height: 80 },

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
  comingSoonBadge: { backgroundColor: colors.yellowTint, borderRadius: radii.pill, paddingVertical: 2, paddingHorizontal: 8 },
  comingSoonText: { fontFamily: fonts.bold, fontSize: 10, color: colors.yellow },

  // "שפה" - אותה שורה בדיוק כמו dropdownItem, רק עם ערך-נוכחי+שברון בקצה הנגדי: התווית מקבלת
  // flex:1 (לא רק flexShrink כמו secondaryItemText הרגיל) כדי "לספוג" את השטח הפנוי ולדחוף את
  // languageRowRight לקצה הנגדי - בלי position:absolute וממשיך לעבוד נכון גם RTL וגם LTR.
  languageRow: {},
  languageRowLabel: { flex: 1 },
  languageRowRight: { flexDirection: d.row, alignItems: 'center', gap: 4 },
  languageRowValue: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textMuted },

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
