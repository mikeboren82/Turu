import { View, Text, Image, Pressable } from 'react-native';
import { colors, fonts, radii } from '../constants/theme';
import { useI18n, createStyles } from '../lib/i18n';
import { placeholderImageFor, PLACEHOLDER_IMAGES } from '../lib/placeholderImages';
import { publicImageUrl } from '../lib/googleContent';

// PHASE 1 EXTRACTION (2026-09-19, "safe presentational extraction" - ראו הביקורת הארכיטקטונית) -
// הועבר byte-for-byte מ-app/index.js: משפחת-הכרטיסים "המטושטשים" שהקרוסלה מציגה כש-
// carouselLocationKnown===false (ראו app/index.js). קומפוננטות presentational-בלבד - מקבלות
// activity/index/onPress כ-props, לא קוראות ל-Supabase/lib/activities.js ולא קובעות אילו
// פעילויות מוצגות/באיזה סדר (זה עדיין recommendations/previewActivities ב-HomeScreen, ללא שינוי).
// שים לב: SkeletonCard (app/index.js) *לא* עבר לכאן - הוא תלוי בסטייל recCardWrap המשותף עם
// הקרוסלה האמיתית (לא-נעולה) שנשארת ב-HomeScreen, אז הוצאתו הייתה מחייבת שכפול-סטייל או ownership
// מעורפל - "If a style is shared or ownership is ambiguous: leave it where it is for this phase."

// בוחר תמונה אמיתית עבור כרטיס מטושטש - אותה היררכיה בדיוק כמו ActivityCard.js (imageUrl →
// placeholderImageFor(placeholderGroup)), עם תמונת-branding אמיתית כ-fallback אחרון (במקום
// gradient מצויר) - כדי שתמיד יהיה <Image> אמיתי להפעיל עליו blurRadius, גם לפני
// שהפעילויות האמיתיות נטענות (recActivities עדיין ב-recLoading) - אין רגע של skeleton.
const PREVIEW_FALLBACK_IMAGES = Object.values(PLACEHOLDER_IMAGES).flat();
function sourceForLockedCard(activity, index) {
  // publicImageUrl: a Google Places photo never shows here, even when this card receives an object
  // that bypassed mapActivityRow. It falls through to the placeholder instead (lib/googleContent.js).
  const imageUrl = publicImageUrl(activity?.imageUrl);
  if (imageUrl) return { uri: imageUrl };
  const ph = activity?.placeholderGroup ? placeholderImageFor(activity.placeholderGroup, activity?.id ?? index, activity?.category) : null;
  if (ph) return ph;
  return PREVIEW_FALLBACK_IMAGES[index % PREVIEW_FALLBACK_IMAGES.length];
}

// עוצמת הטשטוש - blurRadius, פרופ' מובנה של RN Image (לא simulation/צורות מצוירות). נבדק ואומת
// גם ב-Expo Web: react-native-web מיישם blurRadius כ-CSS filter:blur() אמיתי על אלמנט ה-DOM שבו
// הוא בפועל מצייר את התמונה (getComputedStyle על אותו אלמנט מחזיר בפועל "blur(5px)" כש-5 - יחס
// 1:1) - לא על ה-<img> הנגיש-בלבד/מוסתר ש-RN Web גם מרנדר בנפרד (ל-onLoad/accessibility), שם
// ה-filter תמיד 'none' וזה תקין - שווה לזכור כשבודקים בדפדפן, כדי לא להסיק בטעות ש-blurRadius "לא
// עובד" מבדיקה על האלמנט הלא-נכון. כלומר blurRadius לבדו מספיק בכל הפלטפורמות, בלי workaround
// נוסף. הורד מ-6 ל-5 (2026-09-16, בקשת המשתמש: "עוד טיפה פחות מטושטש") - עדיין digestible-בלבד
// (אין תוכן קריא בכוונה), רק מעט פחות אגרסיבי.
const BLUR_RADIUS = 5;

// תמונת הכרטיס המטושטש - <Image> אמיתי עם blurRadius אמיתי (ראו הערה מעל). resizeMode="cover"
// ממלא את הפריים לגמרי (לא contain+letterbox כמו ב-ActivityCard הרגיל - כאן ממילא הכל מטושטש,
// אין צורך לשמר את הדמות המלאה של איור ה-placeholder). veil לבן-עדין מעל (לא "שוטף" את התמונה -
// עדיין רואים גוונים/צורות מבעד לו).
function LockedCardImage({ activity, index, icon }) {
  return (
    <View style={styles.lockedCardImageWrap}>
      <Image
        source={sourceForLockedCard(activity, index)}
        resizeMode="cover"
        blurRadius={BLUR_RADIUS}
        style={styles.lockedCardImagePhoto}
      />
      <View pointerEvents="none" style={styles.lockedCardVeil} />
      {icon ? (
        <View pointerEvents="none" style={styles.lockedCardImageIconBadge}>
          <View style={styles.lockedCardIconCircle}>
            <Text style={styles.lockedCardLockIconReal}>{icon}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

// "גוף" הכרטיס המטושטש - קווים מנוקדים ("••••") לא פסי-skeleton מלאים: נקרא כ"מידע מוסתר
// בכוונה" (redacted), לא כ"טוען" - בלי shimmer/אנימציה, בלי טקסט/מיקום אמיתי של הפעילות.
function LockedCardBody() {
  return (
    <View style={styles.lockedCardBody}>
      <Text style={styles.lockedCardRedactedTitle} numberOfLines={1}>{'••••••• ••••'}</Text>
      <Text style={styles.lockedCardRedactedMeta} numberOfLines={1}>{'•••• ••'}</Text>
    </View>
  );
}

// כרטיס-פעילות מטושטש: תמונה אמיתית (activity.imageUrl/placeholderGroup מ-recommendations, אותו
// מקור בדיוק שמזין את הקרוסלה הרגילה כש-carouselLocationKnown===true) עם blurRadius אמיתי של
// React Native Image, לא ציור/simulation. תוכן הכרטיס (כותרת/עיר) לעולם לא נחשף - הגוף מציג רק
// placeholder מנוקד (LockedCardBody).
function BlurredActivityCard({ activity, index, icon, overlay }) {
  return (
    <View style={styles.lockedCardOuter}>
      <LockedCardImage activity={activity} index={index} icon={overlay ? null : icon} />
      <LockedCardBody />
      {overlay}
    </View>
  );
}

// כרטיס 1 בקרוסלה כש-carouselLocationKnown===false: אותו BlurredActivityCard בדיוק כמו כרטיסים 2+
// (תמונה אמיתית+blurRadius מאחורי הכל), עם overlay קריא וחד (לא מטושטש) עליו - לא prompt נפרד
// מעל הקרוסלה. שתי הפעולות (onPress) פותחות את אותו LocationQuickPicker/GPS בדיוק כמו "איפה נח
// לכם?" - מקור-האמת (openLocationPicker) נשאר ב-HomeScreen, מגיע לכאן כ-prop בלבד.
export function LocationPromptCard({ onPress, activity }) {
  const { t } = useI18n();
  return (
    <BlurredActivityCard
      index={0}
      activity={activity}
      overlay={
        <View pointerEvents="box-none" style={styles.lockedCardOverlayWrap}>
          <View style={styles.lockedCardOverlay}>
            <Text style={styles.lockedCardOverlayIcon}>📍</Text>
            <Text style={styles.lockedCardOverlayTitle}>{t('home.locked.title')}</Text>
            <Text style={styles.lockedCardOverlaySubtitle}>{t('home.locked.subtitle')}</Text>
            <Pressable style={styles.lockedCardOverlayBtn} onPress={onPress}>
              <Text style={styles.lockedCardOverlayBtnText}>{t('home.locked.useMyLocation')}</Text>
            </Pressable>
            <Pressable onPress={onPress} hitSlop={8}>
              <Text style={styles.lockedCardOverlaySecondary}>{t('home.locked.chooseCity')}</Text>
            </Pressable>
          </View>
        </View>
      }
    />
  );
}

// כרטיסים 2+ - אותו BlurredActivityCard כמו כרטיס 1, בלי overlay-טופס (רק 🔒 עדין על התמונה) - לא
// חוזרים על הפרומפט/הכפתורים, כל הכרטיס לחיץ ופותח את אותו picker.
export function LockedPreviewCard({ index, onPress, activity }) {
  const { t } = useI18n();
  return (
    <Pressable
      style={({ pressed }) => [pressed && styles.itemPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t('home.locked.previewA11y')}
    >
      <BlurredActivityCard index={index} activity={activity} icon="🔒" />
    </Pressable>
  );
}

const styles = createStyles((d) => ({
  // מעטפת-כרטיס לכל כרטיסי ה"נעול" (כרטיס-1 עם ה-overlay וגם כרטיסים 2+) - שונה מ-recCardWrap
  // המשותף (שאין לו radius/overflow משלו - ActivityCard האמיתי מביא את זה בעצמו) כי כאן צריך
  // clip אחיד לכל הכרטיס (תמונה+גוף+overlay) כדי שה-overlay הקריא בכרטיס 1 יקבל פינות מעוגלות
  // נקיות בלי לגעת בסגנון המשותף של הכרטיסים האמיתיים.
  lockedCardOuter: { width: 260, alignSelf: 'flex-start', borderRadius: radii.lg, overflow: 'hidden' },
  // עטיפת-התמונה המטושטשת - אותו גובה/רוחב בדיוק כמו image ב-ActivityCard.js (158, 100%), עם
  // overflow:'hidden' כדי שה-blurRadius (שמגדיל מעט את "טווח" הפיקסלים המוצג בקצוות) לא ידלוף
  // מחוץ לפינות המעוגלות של הכרטיס. backgroundColor הוא רק רשת-ביטחון לרגע שלפני שהתמונה נטענת.
  lockedCardImageWrap: {
    width: '100%', height: 158, overflow: 'hidden', position: 'relative', backgroundColor: colors.borderLight,
  },
  // ה-<Image> עצמו - כאן ה-blurRadius האמיתי מופעל (ראו LockedCardImage), לא simulation.
  lockedCardImagePhoto: { width: '100%', height: '100%' },
  // "צעיף" לבן עדין מעל התמונה המטושטשת - לא שוטף אותה: עדיין רואים גוונים/צורות מבעד לו, רק
  // מרכך קצת את הניגודיות כדי שהטקסט/אייקונים שמעליו (🔒 / ה-overlay בכרטיס 1) יהיו קריאים על
  // כל תמונה, לא משנה כמה כהה/בהירה.
  lockedCardVeil: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(255,255,255,0.15)' },
  // תג ה-🔒 בכרטיסים 2+ - מרוכז על אזור התמונה בלבד (לא על כל הכרטיס), כמו כפתורי הפעולה
  // (מועדפים/הסתרה) שמונחים על התמונה ב-ActivityCard האמיתי. עיגול לבן-שקוף מתחת לאייקון בשביל
  // ניגודיות עקבית מעל תמונות שונות בבהירות.
  lockedCardImageIconBadge: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center',
  },
  lockedCardIconCircle: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.85)',
    alignItems: 'center', justifyContent: 'center',
  },
  lockedCardLockIconReal: { fontSize: 17 },
  // "גוף" הכרטיס - ראו LockedCardBody. קווים מנוקדים (לא פסי-skeleton אפורים-שטוחים, לא shimmer) -
  // נקראים כ"מידע מוסתר בכוונה" (redacted), לא כ"בטעינה". letterSpacing מרווח את הנקודות כדי
  // שהתבנית תיקרא ברור כ"מוסתר" גם מרחוק, לא כטקסט-שנקטע.
  lockedCardBody: { backgroundColor: colors.card, padding: 14 },
  lockedCardRedactedTitle: {
    fontFamily: fonts.extraBold, fontSize: 15, color: colors.textMuted, textAlign: d.textAlign, letterSpacing: 3,
  },
  lockedCardRedactedMeta: {
    fontFamily: fonts.regular, fontSize: 13, color: colors.textMuted, textAlign: d.textAlign, marginTop: 8, letterSpacing: 3,
  },
  // overlay קריא לכרטיס 1 בלבד - בקשת המשתמש המפורשת (2026-09-16): לא "לשטוף" את כל הכרטיס
  // בלבן (זה מסתיר את התמונה המטושטשת וגורם לכרטיס להיראות ריק/לא-מטושטש) - רק "ריבוע לבן"
  // (קופסה) סביב הטקסט/כפתורים עצמם, כדי שהתמונה המטושטשת תיראה ברור סביב/מאחורי הקופסה בדיוק
  // כמו בכרטיסים 2+. lockedCardOverlayWrap ממרכז את הקופסה בתוך הכרטיס; pointerEvents="box-none"
  // כדי שהשוליים השקופים סביב הקופסה לא יחסמו קליקים על התמונה (לא שממילא יש שם onPress, אבל
  // עקבי עם הכוונה - רק הקופסה עצמה אינטראקטיבית).
  lockedCardOverlayWrap: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: 14,
  },
  lockedCardOverlay: {
    backgroundColor: 'rgba(255,255,255,0.96)', borderRadius: radii.lg, alignItems: 'center',
    paddingVertical: 16, paddingHorizontal: 18, maxWidth: '92%',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.12, shadowRadius: 8, elevation: 3,
  },
  lockedCardOverlayIcon: { fontSize: 20, marginBottom: 4 },
  lockedCardOverlayTitle: { fontFamily: fonts.bold, fontSize: 13, color: colors.textPrimary, textAlign: 'center' },
  lockedCardOverlaySubtitle: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textSecondary, textAlign: 'center', marginTop: 2, marginBottom: 10 },
  lockedCardOverlayBtn: { backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 8, paddingHorizontal: 18 },
  lockedCardOverlayBtnText: { fontFamily: fonts.bold, fontSize: 12.5, color: '#fff' },
  lockedCardOverlaySecondary: {
    fontFamily: fonts.semiBold, fontSize: 11.5, color: colors.textSecondary, textDecorationLine: 'underline', marginTop: 9,
  },
}));
