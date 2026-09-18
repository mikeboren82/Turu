import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { View, Text, ScrollView, Pressable, TextInput, ActivityIndicator, Image, Platform, Linking, Modal, useWindowDimensions } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter, useFocusEffect } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import * as Location from 'expo-location';
import Svg, { Circle, Polygon, Polyline, Line, Path, G } from 'react-native-svg';
import Header from '../components/Header';
import SkyBackground from '../components/SkyBackground';
import LoginRequiredModal from '../components/LoginRequiredModal';
import QuickPicker from '../components/QuickPicker';
import LocationQuickPicker, { locationSummary } from '../components/LocationQuickPicker';
import ActivityCard from '../components/ActivityCard';
import { ChevronLeftIcon } from '../components/icons';
import {
  CATEGORY_FILTER_OPTIONS, DEFAULT_FILTERS, FILTER_SCHEMA,
  PRICE_OPTIONS, PLACE_TYPE_OPTIONS, BOOKING_OPTIONS, DURATION_OPTIONS, AMENITY_COMFORT_OPTIONS,
} from '../constants/filterSchema';
import { normalizeFilters, rankActivities } from '../lib/filterActivities';
import { whenSummary, listJoin } from '../lib/filterSummaries';
import { supabase } from '../lib/supabase';
import { fetchUserPreferences, saveDefaultHomeFilters } from '../lib/preferences';
import { childrenToDefaultAgeFilter, formatChildAge } from '../lib/children';
import { parseSmartSearchQuery, intentToFilters, needsAreaClarification } from '../lib/smartSearch';
import { fetchApprovedActivities, formatDistance } from '../lib/activities';
import { placeholderImageFor, PLACEHOLDER_IMAGES } from '../lib/placeholderImages';
import { fetchUserActivityFlags, toggleFavorite, toggleVisited, fetchAllPersonalNotes, toggleWithFeedback, hideActivityWithFeedback } from '../lib/interactions';
import { formatBenefitCardTag } from '../lib/benefits';
import { buildMatchReasons, selectedChildAges } from '../lib/matchReasons';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { useI18n, createStyles, t } from '../lib/i18n';
import { categoryLabel, compactLocationText, placeName } from '../lib/i18n/format';

// המסך הראשי - יש מסך-בית אחד בלבד (בקשת המשתמש 2026-09-12: "יש למחוק את מסך הבית 2, מעכשיו
// יש רק מסך בית אחד"). קודם לכן היו שני מסכי-בית מקבילים (app/index.js ו-app/home2.js) שמוזגו
// יחד לקובץ הזה בשלב קודם, ואז home2.js נמחק לגמרי - זה כל הסיפור, אין יותר מסך שני.

const RECOMMENDATIONS_LIMIT = 8;

// ניסוי חזותי (2026-09-16): פקד-כוונת-חיפוש מאוחד (GuidedSearchIntentControl) אחד עם שני
// סגמנטים לחיצים במקום שני Selection Pills נפרדים - ראו ההשוואה בדוח. true = מציג את הגרסה
// המאוחדת החדשה; false = חוזר לשני ה-pills הישנים (CompactFilterField/filtersRow) בלי לגעת
// באף קוד אחר - נתיב-נסיגה מיידי, לא feature-flag מורכב. אין state/logic אחר תלוי בדגל הזה.
const SHOW_UNIFIED_GUIDED_SEARCH = true;

const DISCOVERY_TILES = [
  { id: 'nature', emoji: '🌳', category: 'טבע' }, // i18n-ignore
  { id: 'museums', emoji: '🏛️', category: 'מוזיאון לילדים' }, // i18n-ignore
  { id: 'playgrounds', emoji: '🛝', category: 'פארק' }, // i18n-ignore
  { id: 'animals', emoji: '🐾', category: 'חווה' }, // i18n-ignore
  { id: 'water', emoji: '💦', category: 'פעילות מים' }, // i18n-ignore
  { id: 'crafts', emoji: '🎨', category: 'יצירה' }, // i18n-ignore
];

// תמונות-fallback לכרטיסי ה"נעול" כש-locationKnown===false, כשלפעילות עצמה אין imageUrl/
// placeholderGroup תואם (או שהפעילות עדיין לא נטענה) - אותן 4 תמונות JPG אמיתיות שכבר קיימות
// בפרויקט (lib/placeholderImages.js, assets/placeholders/) ומשמשות בכל האפליקציה ל"אין תמונה",
// לא asset חדש. מסתובבות לפי אינדקס כדי שהקרוסלה לא תיראה כמו אותה תמונה 4 פעמים.
const PREVIEW_FALLBACK_IMAGES = Object.values(PLACEHOLDER_IMAGES);

// שורת שלד-כרטיס בזמן טעינת ההמלצות - בלי טקסט "טוען...", רק מלבנים אפורים בגובה/רוחב של
// ActivityCard אמיתי כדי שהקרוסלה לא "קופצת" כשהנתונים מגיעים.
function SkeletonCard() {
  return (
    <View style={styles.recCardWrap}>
      <View style={styles.skeletonImage} />
      <View style={styles.skeletonLineWide} />
      <View style={styles.skeletonLineNarrow} />
    </View>
  );
}

// "🕐 חיפושים אחרונים" - מוחלף מ"💡 רעיונות לחיפוש" הקבוע (בקשת המשתמש): נשמר מקומית במכשיר
// בלבד (AsyncStorage - שקול ל-localStorage בעברית שלה, אבל עובד גם ב-native, לא רק web), לא
// ב-DB ולא קשור לחשבון המשתמש.
const RECENT_SEARCHES_KEY = 'turu_recent_searches';
const RECENT_SEARCHES_MAX = 5;

// "✨ רעיונות להיום" - מיקום-אורח (guest) שנשמר מקומית בלבד (AsyncStorage, אותו דפוס בדיוק כמו
// RECENT_SEARCHES_KEY למעלה - לא ארכיטקטורת-persistence מקבילה). רק city/address (לא 'current') -
// GPS לא נשמר כאן בכוונה, כי קואורדינטות ישנות מתיישנות; "current" נגזר מחדש בכל טעינה מבדיקת
// הרשאה שקטה (getForegroundPermissionsAsync, ראו למטה), לא מ-storage. משתמש מחובר לא כותב לכאן
// בכלל - יש לו כבר default_home_filters אמיתי ב-DB (saveDefaultHomeFilters), שני מקורות-אמת
// יריבים לאותו דבר היו רק מבלבלים.
const GUEST_HOME_LOCATION_KEY = 'turu_guest_home_location';

// יחס הרוחב/גובה של איור הדשא (assets/grass-footer.png).
const GRASS_ASPECT_RATIO = 939 / 148;

// לכל מפתח פילטר "ניתן-להוספה" (מה שהמשתמש הפעיל בעמוד האישי, ראו app/profile.js) - איך
// לתקצר את הערך הנוכחי שלו לטקסט קצר בקישור העדין במסך הראשי.
const HOME_FILTER_OPTIONS_BY_KEY = {
  price: PRICE_OPTIONS, placeType: PLACE_TYPE_OPTIONS, booking: BOOKING_OPTIONS,
  duration: DURATION_OPTIONS, amenities: AMENITY_COMFORT_OPTIONS,
};

function summaryForHomeFilterKey(key, filters) {
  if (key === 'when') return filters.when?.options?.length ? whenSummary(filters.when) : null;
  const options = HOME_FILTER_OPTIONS_BY_KEY[key];
  const selected = filters[key];
  if (!options || !selected?.length) return null;
  const labels = selected.map((id) => options.find((o) => o.id === id)?.label || id);
  return listJoin(labels);
}

// תצוגה-בלבד לשדה הקומפקטי "איפה?" בעמוד הבית: compactLocationText (lib/i18n/format.js) - אותם
// ענפים בדיוק כמו compactLocationLabel המקומי הקודם, רק מתורגם לפי השפה הפעילה.

// תצוגה-בלבד לשדה הקומפקטי "מה עושים?" בעמוד הבית: סיכום סמנטי של הקטגוריות הנבחרות.
// filters.category הוא מערך של הלייבלים עצמם (CATEGORY_OPTIONS ב-constants/filterSchema.js:
// id===label, אין טבלת-מיפוי נפרדת) - "פארק" כבר הערך המלא, לא ID לפענוח.
// 0 -> "מה עושים?" (הבקרה עצמה היא ה-affordance, ראו CompactFilterField/GuidedIntentSegment).
// 1 -> השם עצמו. 2 -> ניסוח טבעי (listJoin, "יצירה וג'ימבורי") *רק* אם המחרוזת המשורשרת
// נשארת קצרה מספיק לשורה אחת בפקד-הכוונה-המאוחד ב-375px (נמדד בפועל בדפדפן, לא ניחוש) -
// אחרת נופל לאותה "2 סוגי פעילויות" כמו 3+, כדי לא לייצר "...ופארקים ו..." חתוך. 3+ -> תמיד
// "N סוגי פעילויות" - אף פעם לא שרשור שמות (המשתמש תמיד יודע כמה נבחרו בלי לנחש מהריכוז).
const CATEGORY_JOIN_MAX_CHARS = 16;
function compactCategoryLabel(selected) {
  if (!selected || selected.length === 0) return t('home.guided.whatEmpty');
  if (selected.length === 1) return categoryLabel(selected[0]);
  if (selected.length === 2) {
    const joined = listJoin(selected.map(categoryLabel));
    if (joined.length <= CATEGORY_JOIN_MAX_CHARS) return joined;
  }
  return t('domain.summary.activityTypes', { count: selected.length });
}

function ChevronDown() {
  return (
    <Svg width={9.5} height={9.5} viewBox="0 0 24 24" fill="none" stroke={colors.textSecondary} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
      <Polyline points="6 9 12 15 18 9" />
    </Svg>
  );
}

// אייקון חיפוש מונוכרומטי-עדין לשדה החיפוש החופשי - לא אימוג'י (יש כבר "🔎" בטקסט הכפתור "חיפוש
// 🔎" ולא רוצים שני חיפושים-חזותיים שונים), ולא ספרייה חדשה - SVG מקומי עם אותם primitives
// (Svg/Circle/Line) שכבר בשימוש בכל שאר האייקונים בקובץ הזה. מכוון (לא צבוע/badge) בכוונה: זו
// affordance פונקציונלית לשדה הראשי, לא מזהה-קטגוריה מעוטר כמו האייקונים ב"מה עושים/איפה נח לכם".
function SearchIcon({ size = 18, color = colors.textMuted }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="11" cy="11" r="7" />
      <Line x1="21" y1="21" x2="16.65" y2="16.65" />
    </Svg>
  );
}

// "כפתור-בחירה" (selection pill) ל"מה עושים?"/"איפה נח לכם?" (2026-09-16, מעבר מ"שדה קומפקטי"
// ל-pill אמיתי - בקשת המשתמש: הבקרות האלה הן טריגר-בחירה קליל, לא עוד שדה-טופס). בלי label נפרד
// מעל הכפתור - הבקרה עצמה היא ה-affordance, כשלא נבחר כלום f.subtitle כבר מציג "מה עושים?"/
// "איפה?" בעצמו (ראו compactCategoryLabel/compactLocationLabel). f.label הסמנטי לא נעלם - הוא
// עדיין מוזן ל-accessibilityLabel/accessibilityHint, רק לא מרונדר יותר כ-Text חזותי משלו. בלי
// wrapper View חיצוני יותר (לא צריך flex:1/half-width - ה-pill גודלו לפי תוכן, ראו
// compactFieldButton). האייקון המקורי (decorEmoji - 🌟/🏡) חוזר בתוך chip צבוע קטן (tint מקורי).
// row-reverse: הילד הראשון (ה-chip) יושב מימין, הערך אחריו, ה-chevron בקצה השמאלי.
function CompactFilterField({ f, onPress }) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.compactFieldButton,
        f.active && styles.compactFieldButtonActive,
        pressed && styles.compactFieldPressed,
      ]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t('home.guided.a11yLabel', { label: f.label, value: f.a11yValue || f.subtitle })}
      accessibilityHint={f.a11yHint}
    >
      <View style={[styles.compactFieldIconChip, { backgroundColor: f.tint }]}>
        <Text style={styles.compactFieldEmoji}>{f.decorEmoji}</Text>
      </View>
      <Text
        style={[styles.compactFieldValue, f.active && styles.compactFieldValueActive]}
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {f.subtitle}
      </Text>
      <ChevronDown />
    </Pressable>
  );
}

// ניסוי (2026-09-16, ראו SHOW_UNIFIED_GUIDED_SEARCH): פקד-כוונת-חיפוש מאוחד - משטח אחד (border/
// bg/radius יחיד), שתי שורות לחיצות במלוא הרוחב זו-מתחת-לזו (לא עוד שורה אופקית אחת - עם ערכים
// ארוכים בעברית זה יצא צפוף מדי, ראו סבב-בדיקה חזותי 2026-09-16 השני). Presentation-only: לא
// כפילות לוגיקה - משתמש באותו PRIMARY_FILTERS/state/handlers/pickers בדיוק כמו CompactFilterField,
// רק העטיפה החזותית שונה. chevron (ChevronLeftIcon, components/icons.js) חוזר הפעם: בשורה
// במלוא-הרוחב האייקון הצבוע+הטקסט כבר לא מספיקים כרמז-לחיצה יחיד כמו בפקד הקומפקטי הקודם -
// אותה קונבנציית "השורה הזו פותחת בורר" כמו ב-app/profile.js/FiltersSheet.js.
function GuidedIntentSegment({ f }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.guidedIntentSegment, pressed && styles.compactFieldPressed]}
      onPress={f.onPress}
      accessibilityRole="button"
      accessibilityLabel={t('home.guided.a11yLabel', { label: f.label, value: f.a11yValue || f.subtitle })}
      accessibilityHint={f.a11yHint}
    >
      <View style={styles.guidedIntentSegmentMain}>
        <View style={[styles.compactFieldIconChip, { backgroundColor: f.tint }]}>
          <Text style={styles.compactFieldEmoji}>{f.decorEmoji}</Text>
        </View>
        <Text
          style={[styles.guidedIntentValue, f.active && styles.compactFieldValueActive]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {f.subtitle}
        </Text>
      </View>
      <View style={styles.guidedIntentChevron}>
        <ChevronLeftIcon size={12} color={colors.textMuted} />
      </View>
    </Pressable>
  );
}

// שתי שורות זו-מתחת-לזו בתוך משטח אחד (guidedIntentControl), לא שני controls נפרדים - קו
// דק (guidedIntentDivider) ביניהן במקום "·" הקודם, כדי שיקראו כקבוצה אחת. סדר תצוגה: מה עושים
// קודם, איפה נח לכם אחריו (בקשת המשתמש - סדר-הקריאה האנכי, לא סדר ה-array שנשאר [where, category]
// מסיבות היסטוריות של הפריסה האופקית הקודמת).
function GuidedSearchIntentControl({ fields }) {
  const [where, category] = fields;
  return (
    <View style={styles.guidedIntentControl}>
      <GuidedIntentSegment f={category} />
      <View style={styles.guidedIntentDivider} />
      <GuidedIntentSegment f={where} />
    </View>
  );
}

// "למי מחפשים היום?" - מחליף את הבוררים "מה עושים?"/"איפה נח לכם?" רק למשתמש מחובר עם ילדים
// (ראו isPersonalized ב-HomeScreen). בחירת ילד/ים כאן מעדכנת את filters.age מיידית; מיקום/
// קטגוריה כבר נכנסים אוטומטית מ-default_home_filters השמור, בלי קשר לכרטיס הזה.
function PersonalPicker({ kids, selectedChildIds, onToggleChild }) {
  const { t } = useI18n();
  return (
    <View style={styles.personalCard}>
      <Text style={styles.personalTitle}>{t('home.personal.title')}</Text>
      <View style={styles.personalChipsRow}>
        {kids.map((child) => {
          const selected = selectedChildIds.has(child.id);
          return (
            <Pressable
              key={child.id}
              style={[styles.personalChip, selected && styles.personalChipSelected]}
              onPress={() => onToggleChild(child.id)}
            >
              <Text style={[styles.personalChipText, selected && styles.personalChipTextSelected]}>
                {formatChildAge(child)
                  ? t('home.personal.childWithAge', { name: child.name || t('home.personal.childFallback'), age: formatChildAge(child) })
                  : (child.name || t('home.personal.childFallback'))}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.personalHint}>{t('home.personal.hint')}</Text>
    </View>
  );
}

// בוחר תמונה אמיתית עבור כרטיס מטושטש - אותה היררכיה בדיוק כמו ActivityCard.js (imageUrl →
// placeholderImageFor(placeholderGroup)), עם תמונת-branding אמיתית כ-fallback אחרון (במקום
// gradient מצויר) - כדי שתמיד יהיה <Image> אמיתי להפעיל עליו blurRadius, גם לפני
// שהפעילויות האמיתיות נטענות (recActivities עדיין ב-recLoading) - אין רגע של skeleton.
function sourceForLockedCard(activity, index) {
  if (activity?.imageUrl) return { uri: activity.imageUrl };
  const ph = activity?.placeholderGroup ? placeholderImageFor(activity.placeholderGroup) : null;
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
// מקור בדיוק שמזין את הקרוסלה הרגילה כש-locationKnown===true - ראו recommendations useMemo למעלה,
// ובלי fetch חדש) עם blurRadius אמיתי של React Native Image, לא ציור/simulation. תוכן הכרטיס
// (כותרת/עיר) לעולם לא נחשף - הגוף מציג רק placeholder מנוקד (LockedCardBody).
function BlurredActivityCard({ activity, index, icon, overlay }) {
  return (
    <View style={styles.lockedCardOuter}>
      <LockedCardImage activity={activity} index={index} icon={overlay ? null : icon} />
      <LockedCardBody />
      {overlay}
    </View>
  );
}

// כרטיס 1 בקרוסלה כש-locationKnown===false: אותו BlurredActivityCard בדיוק כמו כרטיסים 2+ (תמונה
// אמיתית+blurRadius מאחורי הכל), עם overlay קריא וחד (לא מטושטש) עליו - לא prompt נפרד מעל
// הקרוסלה. שתי הפעולות פותחות את אותו LocationQuickPicker/GPS בדיוק כמו "איפה נח לכם?"
// (openLocationPicker/setWhereQuickOpen - מקור-אמת יחיד, לא flow-geolocation נפרד וגם לא modal
// חדש).
function LocationPromptCard({ onPress, activity }) {
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
function LockedPreviewCard({ index, onPress, activity }) {
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

// גובה+רוחב הכוכב/שמש נגזרים ממדידה אמיתית של שורת ה-Header (onHeaderLayout, ראו HomeScreen)
// במקום ערך top קבוע - ערך קבוע התאים בדיוק לדפדפן (שם אין status bar/insets) אבל לא תאם
// למכשיר אמיתי (הכפתור והשמש יצאו בגבהים שונים). fallback ל-46 עד שהמדידה הראשונה מגיעה.
function SunMascot({ headerLayout }) {
  const top = headerLayout ? headerLayout.y + headerLayout.height / 2 - 28 : 46;
  return (
    <Svg width={56} height={56} viewBox="0 0 120 120" style={[styles.sunMascot, { top }]} pointerEvents="none">
      <G>
        {[...Array(10)].map((_, i) => {
          const angle = (i * 36 * Math.PI) / 180;
          const x1 = 60 + Math.cos(angle) * 40;
          const y1 = 60 + Math.sin(angle) * 40;
          const x2 = 60 + Math.cos(angle) * 50;
          const y2 = 60 + Math.sin(angle) * 50;
          return <Line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#ffc23d" strokeWidth={7} strokeLinecap="round" />;
        })}
      </G>
      <Circle cx="60" cy="60" r="36" fill="#ffcb52" />
      <Circle cx="46" cy="52" r="4.5" fill="#f8ab2e" opacity={0.5} />
      <Circle cx="76" cy="66" r="6" fill="#f8ab2e" opacity={0.4} />
      <Circle cx="46" cy="70" r="4.5" fill="#ff9fc7" opacity={0.55} />
      <Circle cx="78" cy="52" r="4.5" fill="#ff9fc7" opacity={0.55} />
      <Path d="M45 56 Q49 51 53 56" fill="none" stroke="#7a4a12" strokeWidth={3} strokeLinecap="round" />
      <Path d="M63 56 Q67 51 71 56" fill="none" stroke="#7a4a12" strokeWidth={3} strokeLinecap="round" />
      <Path d="M47 66 Q59 76 70 65" fill="none" stroke="#7a4a12" strokeWidth={3} strokeLinecap="round" />
      <Circle cx="86" cy="82" r="15" fill="none" stroke="#007598" strokeWidth={5} />
      <Line x1="96" y1="92" x2="106" y2="102" stroke="#007598" strokeWidth={6} strokeLinecap="round" />
    </Svg>
  );
}

// רוחב/גובה מחושבים במספרים מוחלטים (לא aspectRatio על ה-View + '100%' על ה-Image) - השילוב
// הזה ידוע כבעייתי ב-Yoga על אנדרואיד (נצפה בפועל: התמונה נחתכה/הוצגה רק בחלק מהרוחב על מכשיר
// אמיתי, למרות שברשת זה עבד מושלם) - width/height מפורשים בפיקסלים על שני האלמנטים עוקפים את
// זה לגמרי, בלי תלות בחישוב פנימי של aspectRatio+percent.
function GrassFooter({ width }) {
  const height = width / GRASS_ASPECT_RATIO;
  return (
    <View style={[styles.grassFooter, { width, height }]} pointerEvents="none">
      <Image
        source={require('../assets/grass-footer.png')}
        style={{ width, height }}
        resizeMode="stretch"
      />
      <LinearGradient
        colors={[colors.bg, colors.bg, 'transparent']}
        locations={[0, 0.05, 0.42]}
        style={[styles.grassFooterFade, { width, height }]}
      />
    </View>
  );
}

export default function HomeScreen() {
  const router = useRouter();
  const { t, locale } = useI18n();
  const { width: windowWidth } = useWindowDimensions();
  // מדידה אמיתית (onLayout) של שורת ה-Header, כדי ש-SunMascot (position:absolute, מחוץ ל-
  // ScrollView) יתיישר איתה בכל פלטפורמה/מכשיר - ראו הערה מלאה ליד SunMascot למעלה.
  const [headerLayout, setHeaderLayout] = useState(null);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [deviceCoords, setDeviceCoords] = useState(null);
  const [categoryQuickOpen, setCategoryQuickOpen] = useState(false);
  const [whereQuickOpen, setWhereQuickOpen] = useState(false);
  // "מה עוד מעניין אתכם?" (discovery shortcuts) - allCategoriesOpen פותח את אותו QuickPicker
  // שכבר קיים ל"מה עושים?" (לא מסך/modal חדש), רק ב-multiple=false כדי שבחירה תסגור ותחזיר
  // מיד (ראו toggle ב-components/QuickPicker.js - זו כבר ההתנהגות המובנית שלו). pendingCategory
  // שומר את הקטגוריה שנלחצה כשעדיין אין location ידוע, כדי לבצע את החיפוש מיד אחרי שהמיקום
  // נבחר - בלי לזרוק את המשתמש בחזרה למסך הבית (ראו handleWhereQuickClose למטה).
  const [allCategoriesOpen, setAllCategoriesOpen] = useState(false);
  const [pendingCategory, setPendingCategory] = useState(null);
  // "📍 מה יש סביבי?" - preset נפרד מ-handleGo/filters.location: מכוון תמיד למיקום ה-GPS
  // הנוכחי בפועל (לא city/filters.location שנבחרו קודם ב-guided search - סעיפים 7/15/22
  // בבקשה), ולא נוגע ב-filters של עמוד הבית בכלל (setFilters לעולם לא נקרא כאן) - כך שחזרה
  // ל-Home אחרי Near Me משאירה את הבחירות המודרכות בדיוק כפי שהיו. ה-explainer/permission/GPS
  // logic חיים כאן (לא ב-app/activities.js כמו "⚡ עכשיו") כי אין להם auth gate ואין navigation
  // קודם - כל הזרימה קורית לפני שמנווטים בכלל.
  const [nearMeLoading, setNearMeLoading] = useState(false);
  const [nearMeError, setNearMeError] = useState(''); // '' | i18n key
  const [showNearMeExplainer, setShowNearMeExplainer] = useState(false);
  const nearMeInFlightRef = useRef(false);
  const [userId, setUserId] = useState(null);
  const [hasSavedDefault, setHasSavedDefault] = useState(false);
  const [showLoginPrompt, setShowLoginPrompt] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);
  const [defaultNotice, setDefaultNotice] = useState('');
  const [locatingForSearch, setLocatingForSearch] = useState(false);
  const [visibleHomeFilters, setVisibleHomeFilters] = useState([]);
  const [children, setChildren] = useState([]);
  const [selectedChildIds, setSelectedChildIds] = useState(new Set());
  // גילאי-בשנים של הילדים *שנבחרו* ל"למי מחפשים היום?" (לא כל children בפרופיל) - ל"✓ למה זה
  // מתאים" (lib/matchReasons.js) בלבד: גם בקרוסלת ההמלצות כאן, וגם מועבר הלאה ל-/activities
  // (homeChildAges למטה) כדי שאותה שורת-הסבר תעבוד גם שם. לא נוגע ב-filters.age (bands) הקיים.
  const childAgesForSearch = useMemo(() => selectedChildAges(children, selectedChildIds), [children, selectedChildIds]);
  const [smartSearchText, setSmartSearchText] = useState('');
  const [smartSearchLoading, setSmartSearchLoading] = useState(false);
  const [smartSearchError, setSmartSearchError] = useState('');
  // חיפוש חופשי שממתין לבחירת מיקום בבורר הקנוני: { pendingIntent, mode: 'plain'|'street', prevLocation }
  const [smartSearchClarify, setSmartSearchClarify] = useState(null);
  const [recentSearches, setRecentSearches] = useState([]);
  // חיפושים אחרונים כ-dropdown תלוי-פוקוס, לא section קבוע (בקשת המשתמש 2026-09-16 השנייה:
  // "כמו מנוע חיפוש מודרני" - נעלם/מופיע לפי פוקוס בשדה, לא toggle ידני). searchFocused נשלט
  // מ-onFocus/onBlur של ה-TextInput למטה, בלי screen-wide touch-dismiss (בקשת המשתמש: לא לעטוף
  // את כל מסך הבית ב-TouchableWithoutFeedback רק בשביל זה, אלא אם בדיקה בדפדפן תוכיח שזה הכרחי
  // ושזה לא פוגע בקרוסלה/discovery/CTA/גלילה - עדיין לא הוכח כזה). blurTimeoutRef עוקף את מרוץ
  // ה-blur-לפני-press הקלאסי ב-React Native Web (mousedown על ה-Pressable של שורת-היסטוריה/×/
  // נקה-הכל מעביר focus בדפדפן ומפעיל onBlur *לפני* שה-onClick/press עצמו מגיע) - onBlur לא סוגר
  // מיד, רק אחרי השהיה קצרה; לחיצה על שורה/×/נקה-הכל מבטלת את ה-timeout ומריצה את הפעולה שלה
  // תוך כדי שהפאנל עדיין mounted. searchInputRef מאפשר להחזיר פוקוס לשדה במפורש אחרי מחיקת
  // פריט/נקה-הכל (כדי שהשדה "יישאר ממוקד" בפועל גם ב-web, לא רק ב-state שלנו).
  const [searchFocused, setSearchFocused] = useState(false);
  const searchInputRef = useRef(null);
  const searchBlurTimeoutRef = useRef(null);

  useEffect(() => () => {
    if (searchBlurTimeoutRef.current) clearTimeout(searchBlurTimeoutRef.current);
  }, []);

  // ✨ המלצות מותאמות - excludedCategories/excludedCities/benefitClubs זהים בדיוק למה
  // ש-app/activities.js טוען, כדי שהקרוסלה כאן תתאים לאותם חוקי-דירוג/הסתרה בדיוק כמו עמוד
  // התוצאות.
  const [recActivities, setRecActivities] = useState([]);
  const [recLoading, setRecLoading] = useState(true);
  const [recError, setRecError] = useState(null);
  const [recFavoriteIds, setRecFavoriteIds] = useState(new Set());
  const [recVisitedIds, setRecVisitedIds] = useState(new Set());
  const [recHiddenIds, setRecHiddenIds] = useState(new Set());
  const [recNotes, setRecNotes] = useState([]);
  const [excludedCategories, setExcludedCategories] = useState([]);
  const [excludedCities, setExcludedCities] = useState([]);
  const [excludedRegions, setExcludedRegions] = useState([]);
  const [benefitClubs, setBenefitClubs] = useState([]);

  useEffect(() => {
    AsyncStorage.getItem(RECENT_SEARCHES_KEY).then((raw) => {
      if (!raw) return;
      try { setRecentSearches(JSON.parse(raw)); } catch { /* ערך פגום - מתעלמים, לא קורסים */ }
    });
  }, []);

  // כל הפעילויות המאושרות - נטען פעם אחת בלבד ב-mount (לא ב-useFocusEffect כמו user/children
  // למטה): payload כבד (אלפי פעילויות, ראו lib/activities.js) - טעינה חוזרת בכל חזרה למסך הבית
  // תהיה מיותרת ויקרה. הדירוג עצמו (recommendations, useMemo למטה) עדיין מתעדכן חי ככל
  // שהפילטרים/מיקום/מועדפים משתנים, בלי לדרוש fetch חדש.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setRecLoading(true);
      try {
        const data = await fetchApprovedActivities();
        if (!cancelled) setRecActivities(data);
      } catch (err) {
        if (!cancelled) setRecError(err || true);
      } finally {
        if (!cancelled) setRecLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // locationKnown bootstrap (ראו הערה מלאה ליד isPersonalized/locationKnown למטה) - רץ פעם אחת
  // ב-mount, לפני שיודעים בכלל אם יש session מחובר. אם מתברר מאוחר יותר (ה-useFocusEffect למטה)
  // שיש session עם default_home_filters משלו - הוא ידרוס את זה, וזה בסדר (last-write-wins, בלי
  // מרוץ אמיתי כי אף אחד מהם לא כותב ל-storage/DB של הצד השני).
  // שלב 1: הרשאת מיקום כבר קיימת? getForegroundPermissionsAsync (לא request!) רק *קורא* סטטוס -
  // לעולם לא מציג פרומפט מערכת (סעיף 5 בבקשה: "אל תבקש permission אוטומטית ב-page load"). אם
  // המשתמש כבר אישר בעבר, זה "Priority 2" (סעיף 2) - fetch שקט, בלי ליפול חזרה על עיר-שמורה.
  // שלב 2 (רק אם אין הרשאה): עיר ששמר guest בביקור קודם (GUEST_HOME_LOCATION_KEY) - "Priority 3".
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { status } = await Location.getForegroundPermissionsAsync();
        if (!cancelled && status === 'granted') {
          const pos = await Location.getCurrentPositionAsync({});
          if (!cancelled) {
            setDeviceCoords({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
            setFilters((prev) => (prev.location?.mode
              ? prev
              : { ...prev, location: { ...prev.location, mode: 'current', radiusKm: prev.location.radiusKm || 10 } }));
          }
          return;
        }
      } catch { /* אין הרשאה בפועל/GPS לא זמין - נופלים בחזרה לעיר שמורה (guest) למטה */ }
      if (cancelled) return;
      const raw = await AsyncStorage.getItem(GUEST_HOME_LOCATION_KEY);
      if (cancelled || !raw) return;
      try {
        const saved = JSON.parse(raw);
        if (saved?.mode === 'city' && saved.city) {
          setFilters((prev) => (prev.location?.mode ? prev : { ...prev, location: { ...prev.location, ...saved } }));
        }
      } catch { /* ערך פגום - מתעלמים */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // שמירת guest location - רק city (לא 'current', ראו הערה ליד GUEST_HOME_LOCATION_KEY למעלה),
  // ורק כשאין session (משתמש מחובר כבר כותב ל-DB דרך handleSaveAsDefault, לא לכאן). לא כותב
  // כשעדיין אין בחירה אמיתית (mode ריק) - כדי לא לדרוס עיר שמורה קודמת בברירת-המחדל החולפת
  // של הרינדור הראשון.
  useEffect(() => {
    if (userId || filters.location?.mode !== 'city' || !filters.location?.city) return;
    AsyncStorage.setItem(GUEST_HOME_LOCATION_KEY, JSON.stringify(filters.location));
  }, [userId, filters.location]);

  const recordRecentSearch = (text) => {
    setRecentSearches((prev) => {
      const next = [text, ...prev.filter((q) => q !== text)].slice(0, RECENT_SEARCHES_MAX);
      AsyncStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
      return next;
    });
  };

  const clearRecentSearches = () => {
    setRecentSearches([]);
    AsyncStorage.removeItem(RECENT_SEARCHES_KEY);
  };

  const removeRecentSearch = (text) => {
    setRecentSearches((prev) => {
      const next = prev.filter((q) => q !== text);
      AsyncStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
      return next;
    });
  };

  // ראו הערה מפורטת ליד searchFocused למעלה - עוקף מרוץ blur-לפני-press. clearSearchBlurTimeout
  // מבוטל בתחילת כל handler-לחיצה בפאנל (שורה/×/נקה-הכל) לפני שממשיכים בפעולה שלו עצמו.
  const clearSearchBlurTimeout = () => {
    if (searchBlurTimeoutRef.current) {
      clearTimeout(searchBlurTimeoutRef.current);
      searchBlurTimeoutRef.current = null;
    }
  };

  const handleRecentSearchPress = (q) => {
    clearSearchBlurTimeout();
    setSearchFocused(false);
    setSmartSearchText(q);
    handleSmartSearch(q);
  };

  const handleRemoveRecentSearch = (q) => {
    clearSearchBlurTimeout();
    removeRecentSearch(q);
    searchInputRef.current?.focus();
  };

  const handleClearRecentSearches = () => {
    clearSearchBlurTimeout();
    clearRecentSearches();
    searchInputRef.current?.focus();
  };

  // useFocusEffect (לא useEffect רגיל) - בדיוק כמו app/profile.js - כדי שכל המעברים בין מצבים
  // (התחברות/התנתקות/הוספת-הסרת ילד ב-/profile) ישתקפו נכון בכניסה הבאה למסך הבית, לא רק
  // ב-mount הראשוני. כשאין session בכלל - מאפסים ל"לא מחובר" (חשוב: בלי זה, משתמש שמתנתק
  // עדיין היה רואה את המצב האישי הישן עד רענון ידני).
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const { data: { session } } = await supabase.auth.getSession();
        if (cancelled) return;
        if (!session?.user?.id) {
          setUserId(null);
          setChildren([]);
          setSelectedChildIds(new Set());
          setRecFavoriteIds(new Set());
          setRecVisitedIds(new Set());
          setRecHiddenIds(new Set());
          setRecNotes([]);
          setExcludedCategories([]);
          setExcludedCities([]);
          setExcludedRegions([]);
          setBenefitClubs([]);
          return;
        }
        setUserId(session.user.id);
        try {
          const [prefs, flags, notes] = await Promise.all([
            fetchUserPreferences(session.user.id),
            fetchUserActivityFlags(session.user.id),
            fetchAllPersonalNotes(session.user.id),
          ]);
          if (cancelled) return;
          setVisibleHomeFilters(prefs.visibleHomeFilters);
          if (prefs.defaultHomeFilters) {
            setFilters(normalizeFilters(prefs.defaultHomeFilters));
            setHasSavedDefault(true);
          }
          setExcludedCategories(prefs.excludedCategories);
          setExcludedCities(prefs.excludedCities);
          setExcludedRegions(prefs.excludedRegions);
          setBenefitClubs(prefs.benefitClubs);
          setRecFavoriteIds(flags.favoriteIds);
          setRecVisitedIds(flags.visitedIds);
          setRecHiddenIds(flags.hiddenIds);
          setRecNotes(notes);
          const kids = prefs.children || [];
          setChildren(kids);
          // ברירת מחדל: כל הילדים "נבחרים" ל"למי מחפשים היום?" - תואם בדיוק את מה שכבר קרה
          // בשקט עד היום (childrenToDefaultAgeFilter על כל הילדים), רק עכשיו זה גם ה-UI.
          setSelectedChildIds(new Set(kids.map((c) => c.id)));
          // גיל ברירת המחדל מגיע מגילאי הילדים (מחושב טרי מתאריך לידה - ראו lib/children.js),
          // לא מ-default_home_filters.age שעלול "לקפוא" בערך ישן - גובר עליו כשיש ילדים.
          // עדיין state מקומי בלבד: שינוי הגיל בחיפוש בודד לא נשמר בחזרה לפרופיל - setField
          // רגיל, לא כותב ל-DB.
          const ageDefaults = childrenToDefaultAgeFilter(kids);
          if (ageDefaults.length > 0) {
            setFilters((prev) => ({ ...prev, age: ageDefaults }));
          }
        } catch {
          // אם טעינת ההעדפות נכשלת, פשוט ממשיכים עם ברירת המחדל הרגילה
        }
      })();
      return () => { cancelled = true; };
    }, [])
  );

  // "למי מחפשים היום?" מוצג רק למשתמש מחובר עם לפחות ילד אחד - כלל קריטי: כל שאר המשתמשים
  // (לא מחוברים, מחוברים בלי ילדים, מחוברים שהסירו את כל הילדים) חייבים לראות בדיוק את מסך
  // הבית הרגיל בלי שום שינוי.
  const isPersonalized = !!userId && children.length > 0;

  // "✨ רעיונות להיום" - locationKnown קובע האם מציגים את הקרוסלה כ"קרוב אליכם" (מסונן/מדורג
  // לפי מיקום אמיתי) או את onboarding-prompt במקומה. מוגדר אך ורק לפי filters.location.mode -
  // אותו source-of-truth שכבר משמש את "איפה נוח לכם?" (סעיף 13 בבקשה: לא state נפרד) - ולא לפי
  // account status: guest יכול להיות עם location ידוע (GPS/עיר שמורה), מחובר יכול להיות בלי
  // (סעיף 2). 'region' לא נחשב "ידוע" מספיק לצורך הקרוסלה - זה בחירה גסה (7 אזורי-ארץ), לא
  // "רעיונות ליד" אמיתיים; לא ניתן לבחירה מהמסך הזה בלאו הכי.
  const locationKnown = filters.location?.mode === 'current' || filters.location?.mode === 'city' || filters.location?.mode === 'address';

  // מקור-אמת יחיד לפתיחת בחירת-מיקום: אותה פונקציה בדיוק עבור צ'יפ "איפה נח לכם?" למעלה וכרטיסי
  // ה-Preview ב"רעיונות לידכם היום" כש-locationKnown===false (סעיף 8/9/27 בבקשה) - לא flow
  // geolocation נפרד (כך שהיה קודם ב-handleUseLocationForRecommendations שהוסר) ולא modal חדש.
  const openLocationPicker = () => setWhereQuickOpen(true);

  // כותרת/תת-כותרת אמיתיות ביחס לאלגוריתם בפועל (סעיף 9 בבקשה) - לא טוענות "מותאם לגיל" סתם:
  // רק אם isPersonalized (יש בפועל age-matching אמיתי מגילאי הילדים, ראו scoreActivity).
  // display name קיים בלבד (filters.location.city) - לא hardcoded ערים (סעיף 8).
  // "ב-עיר" מול "ליד עיר" (בקשת המשתמש 2026-09-16): mode:'city' בלי מרחק-נסיעה בפועל על גביה -
  // בחירת עיר "נקייה" - matchesLocation (lib/filterActivities.js) ממילא מסנן כאן תמיד להתאמת-עיר
  // מדויקת, אז "ב" מדויק. ברגע שיש הליכה/כל-מרחק/נסיעה-בדקות בפועל הכוונה המפורשת של המשתמש היא
  // "מסביב ל-X ק"מ מהעיר", לא "רק בעיר עצמה" - "ליד" מתאר את זה נכון. התנאי כאן זהה בכוונה
  // ל-3 הענפים הראשונים ב-compactLocationLabel למעלה (לא סתם !!travelMode - "נסיעה" בלי
  // travelMinutes מספרי הוא שריד-state לא-פעיל, compactLocationLabel עצמו נופל בו לשם העיר
  // הרגיל, אז גם הכותרת כאן חייבת ליפול לאותו "ב" בדיוק, לא סתם לבדוק אם travelMode קיים).
  // mode:'address' (כתובת מגואוקדדת, לא שם-עיר) תמיד "ליד" - התאמת-מרחק מנקודה, אף פעם לא "בדיוק שם".
  const cityHasTravelModifier = filters.location?.mode === 'city' && (
    filters.location.travelMode === 'walking'
    || filters.location.travelMode === 'any'
    || (filters.location.travelMode === 'driving' && typeof filters.location.travelMinutes === 'number')
  );
  const recHeaderTitle = filters.location?.mode === 'city' && filters.location.city
    ? cityHasTravelModifier
      ? t('home.recs.titleNearPlace', { place: placeName(filters.location.city) })
      : t('home.recs.titleInCity', { place: placeName(filters.location.city) })
    : filters.location?.mode === 'address' && (filters.location.addressLabel || filters.location.city)
      ? t('home.recs.titleNearPlace', { place: placeName(filters.location.addressLabel || filters.location.city) })
      : t('home.recs.titleDefault');
  // locationKnown===false: תת-כותרת קבועה (סעיף 11 בבקשה) - "באזור שלכם" עדיין לא אמיתי (אין
  // location), זו הבטחה למה שמחכה אחרי שיספקו אחד, לא תיאור-מצב. isPersonalized (גיל הילדים)
  // רלוונטי רק כשיש בפועל אזור-חיפוש להתאים אליו.
  const recHeaderSubtitle = !locationKnown
    ? t('home.recs.subtitleNoLocation')
    : isPersonalized
      ? t('home.recs.subtitlePersonalized')
      : t('home.recs.subtitleDefault');

  const toggleChild = (childId) => {
    setSelectedChildIds((prev) => {
      const next = new Set(prev);
      next.has(childId) ? next.delete(childId) : next.add(childId);
      const ageDefaults = childrenToDefaultAgeFilter(children.filter((c) => next.has(c.id)));
      setFilters((prevFilters) => ({ ...prevFilters, age: ageDefaults }));
      return next;
    });
  };

  const setField = (key, value) => setFilters((prev) => ({ ...prev, [key]: value }));
  const clearAllFilters = () => setFilters(DEFAULT_FILTERS);

  const showDefaultNotice = (text) => {
    setDefaultNotice(text);
    setTimeout(() => setDefaultNotice(''), 3000);
  };

  const handleSaveAsDefault = async () => {
    if (!userId) {
      setShowLoginPrompt(true);
      return;
    }
    setSavingDefault(true);
    try {
      await saveDefaultHomeFilters(userId, filters);
      setHasSavedDefault(true);
      showDefaultNotice(t('home.defaults.saved'));
    } catch {
      showDefaultNotice(t('home.defaults.saveError'));
    } finally {
      setSavingDefault(false);
    }
  };

  const hasSelectedCategory = filters.category.length > 0;
  const hasChosenLocation = !!filters.location?.mode;
  // האם ל"מצאו לי פעילויות" יש בחירה משמעותית לבצע - לא אם ה-CTA מוצג (הוא מוצג תמיד עכשיו, ראו
  // ה-Pressable למטה) אלא אם הוא ACTIVE או DISABLED. handleGo עצמו תמיד "בר-ביצוע" טכנית (גם עם
  // ברירות-המחדל הוא ינסה GPS/יפתח את פיקר המיקום) - אין ל-guided search validation אמיתי מעבר
  // לזה, אז ה"תקפות" כאן היא קריטריון UX בלבד: category/location כבר מתחילים ב-[]/null ב-
  // DEFAULT_FILTERS, ורק בחירה בפועל של המשתמש (או ברירת-מחדל ששמר בעבר, ראו fetchUserPreferences
  // למעלה - גם היא "בחירה" לגיטימית) הופכת אותם ל-truthy - בדיוק הדגלים active הקיימים כבר, בלי
  // state כפול. isPersonalized תמיד "בחירה תקפה" (מסלול "למי מחפשים היום?" הנפרד).
  const canSubmitGuidedSearch = isPersonalized || hasSelectedCategory || hasChosenLocation;
  // כרטיס-חיפוש מאוחד (2026-09-16): ה-CTA היחיד תקף אם יש כוונה משמעותית כלשהי - טקסט חופשי
  // שהוקלד, או בחירה מודרכת תקפה (canSubmitGuidedSearch למעלה, ללא שינוי בהגדרה שלו עצמה) - "או"
  // פשוט, לא היוריסטיקה חדשה: משלב את שני תנאי-ה-active הקיימים של שני הכפתורים הישנים.
  const canSubmitUnifiedSearch = !!smartSearchText.trim() || canSubmitGuidedSearch;

  // סדר המערך קובע את סדר-התצוגה ב-filtersRow (flexDirection:'row' רגיל, לא row-reverse - נבדק
  // חזותית בדפדפן, לא רק מהנחת flexDirection): הדף לא forceRTL ברמת ה-layout (רק textAlign/
  // writingDirection ידניים) - 'row' רגיל מתנהג כמו LTR-layout, אז הפריט הראשון במערך יושב
  // משמאל. לכן "where" (איפה?) ראשון -> משמאל, "category" (מה עושים?) שני -> מימין - זו הדרישה
  // (WHAT מימין, WHERE משמאל ב-RTL), לא הפוך.
  const PRIMARY_FILTERS = [
    {
      key: 'where', label: t('home.guided.whereLabel'),
      subtitle: hasChosenLocation ? compactLocationText(filters.location) : t('domain.location.compact.where'),
      // a11yValue: התיאור המלא (locationSummary המשותף, לא הגרסה הקומפקטית) - compactLocationLabel
      // כבר לא מאבד מידע סמנטי בפועל, אבל אין סיבה לא לתת ל-screen reader את הניסוח המלא ביותר
      // הקיים כשזה כבר מחושב בכל מקרה.
      a11yValue: hasChosenLocation ? locationSummary(filters.location) : t('home.guided.whereA11yEmpty'),
      a11yHint: t('home.guided.whereHint'),
      active: hasChosenLocation,
      decorEmoji: '🏡', tint: '#e2f5e7', onPress: openLocationPicker,
    },
    {
      key: 'category', label: t('home.guided.whatLabel'),
      subtitle: compactCategoryLabel(filters.category),
      // a11yValue: כשהתצוגה מכווצת ל-"N סוגי פעילויות" (2+), ה-screen reader עדיין מקבל את
      // הרשימה המלאה של הקטגוריות הנבחרות בפועל - לא רק את המספר.
      a11yValue: filters.category.length > 0 ? listJoin(filters.category.map(categoryLabel)) : t('domain.summary.all'),
      a11yHint: t('home.guided.whatHint'),
      active: hasSelectedCategory,
      decorEmoji: '🌟', tint: '#fdf3d9', onPress: () => setCategoryQuickOpen(true),
    },
  ];

  const handleGo = async () => {
    let goFilters = filters;
    let goCoords = deviceCoords;

    if (!filters.location?.mode) {
      setLocatingForSearch(true);
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          // במקום הודעת-טקסט ("לא אישרתם גישה...") - פותחים ישר את פיקר המיקום (LocationQuickPicker
          // כולל שם "המיקום הנוכחי שלי" - מבקש הרשאה שוב - וגם בחירה ידנית של עיר) כדי שהמשתמש
          // ישלים את הבחירה במקום אחד, בלי לחזור ולנחש מה "באיזור שלי" למעלה אומר.
          setWhereQuickOpen(true);
          return;
        }
        const pos = await Location.getCurrentPositionAsync({});
        goCoords = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        goFilters = { ...filters, location: { ...filters.location, mode: 'current', radiusKm: filters.location.radiusKm || 10 } };
        setDeviceCoords(goCoords);
        setFilters(goFilters);
      } catch {
        setWhereQuickOpen(true);
        return;
      } finally {
        setLocatingForSearch(false);
      }
    }

    router.push({
      pathname: '/activities',
      params: {
        homeFilters: JSON.stringify(goFilters),
        homeCoords: goCoords ? JSON.stringify(goCoords) : '',
        homeChildAges: JSON.stringify(childAgesForSearch),
      },
    });
  };

  const handleAdvancedFilters = () => {
    router.push({
      pathname: '/activities',
      params: {
        homeFilters: JSON.stringify(filters),
        homeCoords: deviceCoords ? JSON.stringify(deviceCoords) : '',
        homeChildAges: JSON.stringify(childAgesForSearch),
        openFilters: 'true',
      },
    });
  };

  // "⚡ עכשיו" (בקשת המשתמש 2026-09-16): הטריגר עבר לכאן ממסך התוצאות, למשתמשים מחוברים
  // בלבד (ראו הקישור המותנה ב-userId למטה) - הלוגיקה עצמה (GPS/הרשאה/דירוג) לא זזה בכלל,
  // עדיין גרה במלואה ב-app/activities.js (toggleSpontaneous) ומופעלת שם דרך route param
  // spontaneous=true, אותו דפוס param בדיוק כמו openFilters/view למעלה.
  const handleSpontaneous = () => {
    router.push({
      pathname: '/activities',
      params: {
        homeFilters: JSON.stringify(filters),
        homeCoords: deviceCoords ? JSON.stringify(deviceCoords) : '',
        homeChildAges: JSON.stringify(childAgesForSearch),
        spontaneous: 'true',
      },
    });
  };

  // מבצע בפועל את בקשת ה-GPS (אחרי שההרשאה כבר קיימת, או שאושרה הרגע דרך המודל למטה) ומנווט
  // ל-/activities. filters נבנה מ-DEFAULT_FILTERS נקי (לא filters של Home) עם location.mode:
  // 'current' בלבד - קטגוריה/גיל/וכו' נשארים ריקים בכוונה ("ALL activity categories", סעיף 6).
  // nearMe:'true' הוא ה-param היחיד שדורש קוד ב-activities.js (קובע sortMode:'distance' פעם
  // אחת ב-mount, בדיוק כמו spontaneous/view) - location.mode:'current'+radiusKm:10 כבר עצמם
  // גורמים ל-Smart Radius/דירוג-מרחק/matchesLocation הקיימים לפעול, בלי לגעת ב-lib/filterActivities.js.
  const goNearMe = async () => {
    if (nearMeInFlightRef.current) return;
    nearMeInFlightRef.current = true;
    setNearMeLoading(true);
    setNearMeError('');
    try {
      const pos = await Location.getCurrentPositionAsync({});
      const coords = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
      const nearMeFilters = {
        ...DEFAULT_FILTERS,
        location: { ...DEFAULT_FILTERS.location, mode: 'current', radiusKm: 10 },
      };
      router.push({
        pathname: '/activities',
        params: {
          homeFilters: JSON.stringify(nearMeFilters),
          homeCoords: JSON.stringify(coords),
          homeChildAges: JSON.stringify(childAgesForSearch),
          nearMe: 'true',
        },
      });
    } catch {
      // הרשאה קיימת אבל איתור בפועל נכשל (GPS כבוי/timeout/וכו', סעיף 13) - לא מנווטים עם
      // קואורדינטות מזויפות; שגיאה שקטה עם "נסו שוב"/"בחרו עיר במקום" (LocationQuickPicker הקיים).
      setNearMeError('home.nearMe.errors.locationFailed');
    } finally {
      setNearMeLoading(false);
      nearMeInFlightRef.current = false;
    }
  };

  // לחיצה על "📍 מה יש סביבי?": בודק את מצב ההרשאה האמיתי (לא מבקש ישר) - סעיף 6/8/12.
  // canAskAgain===false מפורש (לא falsy סתם) הוא היחיד שנחשב "חסום" - undefined (למשל בווב, ראו
  // סעיף 26) לא נחשב חסום, כדי לא להציג "פתחו הגדרות" בטעות בפלטפורמה שלא תומכת בזה.
  const handleNearMePress = async () => {
    if (nearMeInFlightRef.current) return;
    setNearMeError('');
    const { status, canAskAgain } = await Location.getForegroundPermissionsAsync();
    if (status === 'granted') {
      await goNearMe();
      return;
    }
    if (canAskAgain === false) {
      setNearMeError('home.nearMe.errors.blocked');
      return;
    }
    setShowNearMeExplainer(true);
  };

  // "אפשר גישה למיקום" במודל ההסבר: רק עכשיו מבקשים בפועל את הרשאת המערכת (סעיף 9) - אישור
  // ממשיך אוטומטית ל-GPS+ניווט בלי לחייב לחיצה חוזרת על "מה יש סביבי?".
  const confirmNearMePermission = async () => {
    setShowNearMeExplainer(false);
    const { status, canAskAgain } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      setNearMeError(canAskAgain === false ? 'home.nearMe.errors.blocked' : 'home.nearMe.errors.denied');
      return;
    }
    await goNearMe();
  };

  // "לא עכשיו": סוגר בלי שום השפעה - נשארים בעמוד הבית, בלי שגיאה/נג'וג (סעיף 10).
  const dismissNearMeExplainer = () => setShowNearMeExplainer(false);

  // "מה עוד מעניין אתכם?" (discovery shortcuts) - SEE→TAP→RESULTS: אותו מנגנון ניווט/מסך-תוצאות
  // בדיוק כמו handleAdvancedFilters/handleGo למעלה (homeFilters+homeCoords ל-/activities), לא
  // search engine נפרד. location (אם ידוע) עובר יחד עם הקטגוריה - Smart Radius Expansion הקיים
  // ב-app/activities.js לוקח את זה משם והלאה, כולל אם יש מעט תוצאות (סעיף 3 בבקשה). שאר
  // הפילטרים (גיל/מחיר/וכו') מתאפסים בכוונה - זה shortcut ל"גלו קטגוריה", לא המשך של שאר
  // הבחירות שאולי כבר קיימות ב-filters.
  const navigateToCategoryResults = (category) => {
    router.push({
      pathname: '/activities',
      params: {
        homeFilters: JSON.stringify({ ...DEFAULT_FILTERS, category: [category], location: filters.location }),
        homeCoords: deviceCoords ? JSON.stringify(deviceCoords) : '',
        homeChildAges: JSON.stringify(childAgesForSearch),
      },
    });
  };

  // locationKnown (מוגדר למטה, זהה למנגנון "רעיונות להיום") כבר מכסה את כל סדר-העדיפויות
  // המבוקש (location שנבחר בסשן > saved/default > current-location שכבר אושר) - אין צורך
  // בלוגיקת-עדיפות נפרדת כאן, זו בדיוק המשמעות של locationKnown. אם לא ידוע - פותחים את אותו
  // LocationQuickPicker כמו "איפה נוח לכם?" (לא modal חדש) ושומרים את הקטגוריה הממתינה.
  const handleDiscoveryTilePress = (category) => {
    if (locationKnown) {
      navigateToCategoryResults(category);
    } else {
      setPendingCategory(category);
      setWhereQuickOpen(true);
    }
  };

  // סוגר את LocationQuickPicker; אם היה pendingCategory (המשתמש לחץ קודם על shortcut בלי
  // location ידוע) וממש נבחר מיקום בפועל - ממשיכים ישר לתוצאות, בלי לחזור למסך הבית ובלי לדרוש
  // לחיצה חוזרת על הקטגוריה (בדיוק ה-flow המבוקש: CATEGORY TAP → ASK → SELECTED → RESULTS).
  // אם המשתמש סגר בלי לבחור (backdrop/החלטה לוותר) - הקטגוריה הממתינה פשוט מתבטלת בשקט.
  const handleWhereQuickCloseFromDiscovery = () => {
    setWhereQuickOpen(false);
    if (pendingCategory) {
      const category = pendingCategory;
      setPendingCategory(null);
      if (filters.location?.mode) navigateToCategoryResults(category);
    }
  };

  const handleAllCategoriesSelect = (ids) => {
    setAllCategoriesOpen(false);
    const category = ids[0];
    if (!category) return;
    if (locationKnown) {
      navigateToCategoryResults(category);
    } else {
      setPendingCategory(category);
      setWhereQuickOpen(true);
    }
  };

  // 🔎 חיפוש חכם - טקסט חופשי → Edge Function (ניתוח-שפה) → intentToFilters (טהור, קליינט,
  // lib/smartSearch.js) → אותו filters שכל שאר המסך כבר משתמש בו. שום דבר כאן לא מדלג על
  // rankActivities/applyFilters הקיימים ב-app/activities.js.
  const goToSmartSearchResults = (intent) => {
    const builtFilters = intentToFilters(intent, {
      children,
      // מיקום המסך (WHERE / מה שנבחר זה עתה בבורר-ההבהרה / GPS / ברירת-מחדל) הוא מיקום מפורש -
      // עובר בערוץ fallbackLocation, לא כעיר בתוך ה-intent של המודל.
      fallbackLocation: filters.location?.mode ? filters.location : null,
      // כרטיס-חיפוש מאוחד (2026-09-16): בחירת "מה עושים?" המובנית לא נמחקת בשקט כשהטקסט עצמו
      // לא ציין קטגוריה - אותו דפוס עדיפות בדיוק כמו fallbackLocation למעלה (טקסט מפורש מנצח,
      // אחרת נופלים לבחירה המובנית הקיימת). ראו lib/smartSearch.js.
      fallbackCategory: filters.category?.length ? filters.category : null,
    });
    const params = { homeFilters: JSON.stringify(builtFilters), homeChildAges: JSON.stringify(childAgesForSearch) };
    if (builtFilters.location.mode === 'address' && builtFilters.location.coords) {
      params.homeCoords = JSON.stringify({
        latitude: builtFilters.location.coords.lat, longitude: builtFilters.location.coords.lng,
      });
    } else if (deviceCoords) {
      // כמו כל שאר הניווטים מהבית (handleAdvancedFilters/handleSpontaneous/navigateToCategoryResults):
      // מסך התוצאות מקבל את נקודת ה-GPS רק מכאן, ובלעדיה "השתמשו במיקום שלי" בבורר לא היה מסנן לפי
      // מרחק. בטוח ל"בלי מיקום": distanceScore/searchOriginCoords קוראים deviceCoords רק במצב 'current'.
      params.homeCoords = JSON.stringify(deviceCoords);
    }
    setSmartSearchText('');
    setSmartSearchClarify(null);
    router.push({ pathname: '/activities', params });
  };

  // הודעות-שגיאה מה-Edge Function הן קופי עברי מאושר (מכסה יומית/ניסוח) - בעברית מוצגות כמו קודם;
  // בכל שפה אחרת, או כשההודעה אינה קופי שלנו (שגיאת רשת/ספק גולמית), מוצגת הודעה מקומית ידידותית.
  const friendlySearchError = (err, fallbackKey) => (
    locale === 'he' && /[\u0590-\u05FF]/.test(err?.message || '') ? err.message : t(fallbackKey)
  );

  const handleSmartSearch = async (overrideText) => {
    const text = (overrideText ?? smartSearchText).trim();
    if (!text) return;
    // חיפוש חכם פתוח גם למי שלא מחובר (supabase/functions/smart-search - rate-limit לפי IP
    // כשאין user, לא חוסם עם 401) - לא לחסום כאן בקליינט, זה סותר את העיצוב של ה-Edge Function עצמה.
    recordRecentSearch(text);
    setSmartSearchError('');
    setSmartSearchClarify(null);
    setSmartSearchLoading(true);
    try {
      const data = await parseSmartSearchQuery(text);
      // חסר הקשר גאוגרפי → בורר-המיקום הקנוני ("איפה נוח לכם?" - אותו רכיב של WHERE, עם כל
      // האפשרויות שלו כולל "בלי מיקום"), לא תיבה inline. prevLocation נשמר כדי שסגירה בלי בחירה
      // תחזיר את מסך הבית בדיוק למצבו הקודם. 'street' = השרת ביקש עיר לרחוב שהוזכר; 'plain' = לא
      // הוזכר מיקום בכלל ואין מיקום ידוע במסך (needsAreaClarification - "בלי מיקום" נחשב מיקום ידוע).
      if (data.needsClarification) {
        setSmartSearchClarify({ pendingIntent: data.intent, mode: 'street', prevLocation: filters.location });
        return;
      }
      if (needsAreaClarification(data.intent, filters.location)) {
        setSmartSearchClarify({ pendingIntent: data.intent, mode: 'plain', prevLocation: filters.location });
        return;
      }
      goToSmartSearchResults(data.intent);
    } catch (err) {
      setSmartSearchError(friendlySearchError(err, 'home.search.errorParse'));
    } finally {
      setSmartSearchLoading(false);
    }
  };

  // "הציגו לי פעילויות" בבורר-המיקום של החיפוש הממתין. הבורר כבר כתב את הבחירה ל-filters.location
  // (אותו state של WHERE), ומכאן ממשיכים את החיפוש שהמשתמש הקליד - אותה לוגיקה בדיוק כמו
  // handleClarifyPickerClose במסך התוצאות:
  //  - המיקום עובר בערוץ המפורש (fallbackLocation = filters.location, ב-goToSmartSearchResults) -
  //    לא מוזרק ל-intent.location.city, שם הוא נראה כמו ניחוש-מודל ומודח לטקסט (a609e5b).
  //  - 'street' + עיר: סבב-הבהרה לשרת עם cityOverride (גאוקודינג רחוב+עיר; העיר מסומנת
  //    citySource:'user' ב-parseSmartSearchQuery). בחירה אחרת (אזור/GPS/בלי מיקום) - אין עיר לגאוקד,
  //    מחפשים לפי מה שנבחר ומוותרים על הרחוב (לא מנחשים עיר).
  //  - "בלי מיקום" (mode:'nationwide') הוא בחירה, לא "חסר": הוא לא יפתח את הבורר שוב.
  const handleClarifyConfirm = async () => {
    const clarify = smartSearchClarify;
    const loc = filters.location;
    if (!clarify || !loc?.mode) return;
    if (clarify.mode === 'street' && loc.mode === 'city' && (loc.city || '').trim()) {
      setSmartSearchError('');
      setSmartSearchLoading(true);
      try {
        const data = await parseSmartSearchQuery(smartSearchText, { cityOverride: loc.city.trim(), pendingIntent: clarify.pendingIntent });
        if (data.needsClarification) {
          setSmartSearchError(t('home.search.errorLocation'));
          setSmartSearchClarify(null);
          return;
        }
        goToSmartSearchResults(data.intent);
      } catch (err) {
        setSmartSearchError(friendlySearchError(err, 'home.search.errorParseShort'));
        setSmartSearchClarify(null);
      } finally {
        setSmartSearchLoading(false);
      }
      return;
    }
    goToSmartSearchResults(clarify.pendingIntent);
  };

  // סגירה בלי "הציגו לי פעילויות" (רקע/חזרה) - זה *לא* "בלי מיקום": חוזרים למסך הבית, הטקסט
  // שהוקלד נשאר בשדה, לא מנווטים, ומיקום המסך חוזר למה שהיה לפני שהבורר נפתח.
  const handleClarifyDismiss = () => {
    if (smartSearchClarify) setField('location', smartSearchClarify.prevLocation);
    setSmartSearchClarify(null);
  };

  // כרטיס-חיפוש מאוחד (2026-09-16) - נקודת-כניסה אחת ל-CTA וגם ל-Enter מהמקלדת, בלי handler
  // כפול: יש טקסט חופשי → עובר את צינור ה-AI הקיים (handleSmartSearch, ללא שינוי בו עצמו) -
  // WHAT/WHERE המובנים עדיין משפיעים על התוצאה דרך fallbackCategory/fallbackLocation בתוך
  // goToSmartSearchResults למעלה. אין טקסט בכלל → המסלול המודרך הישיר הקיים (handleGo, ללא
  // שינוי) - הוא כבר יודע להשתמש ב-filters (WHAT/WHERE) כמות שהם, כולל בקשת GPS אם צריך.
  const handleUnifiedSearch = () => {
    if (smartSearchText.trim()) { handleSmartSearch(); return; }
    handleGo();
  };

  // --- ✨ המלצות מותאמות (קרוסלה אופקית) ---
  const recNotesByActivity = useMemo(() => new Map(recNotes.map((n) => [n.activity_id, n.note])), [recNotes]);

  const recommendations = useMemo(() => (
    rankActivities(recActivities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities, null, null, excludedRegions)
      .filter((a) => !recHiddenIds.has(a.id))
      .slice(0, RECOMMENDATIONS_LIMIT)
      .map((a) => ({
        ...a,
        distance: formatDistance(a, deviceCoords),
        favorite: recFavoriteIds.has(a.id),
        visited: recVisitedIds.has(a.id),
        hasNote: recNotesByActivity.has(a.id),
        benefitTag: formatBenefitCardTag(a.benefits, benefitClubs),
        // "✓ למה זה מתאים" - אין מצב ספונטני בעמוד הבית (זה רק קישור אל /activities), אז תמיד
        // buildMatchReasons; אותה פונקציה משותפת בדיוק כמו app/activities.js.
        matchReason: buildMatchReasons(a, { childAges: childAgesForSearch }),
      }))
  ), [recActivities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities, excludedRegions, recHiddenIds, recFavoriteIds, recVisitedIds, recNotesByActivity, locale, childAgesForSearch]);

  // 4 הפעילויות הראשונות מתוך recommendations - מוזנות לכרטיסים המטושטשים (LocationPromptCard/
  // LockedPreviewCard) כש-locationKnown===false. אותו מקור-נתונים בדיוק כמו הקרוסלה הרגילה -
  // undefined (recActivities עדיין בטעינה) מטופל בתוך BlurredActivityCard עצמו (fallback מדומה).
  const previewActivities = useMemo(() => recommendations.slice(0, 4), [recommendations]);

  // אותה לוגיקה משותפת בדיוק כמו app/activities.js (lib/interactions.js) - התנהגות עקבית
  // בשני המקומות שבהם הפעולות האלה מופיעות, לא שני מימושים מקבילים.
  const handleToggleRecFavorite = (activityId) => {
    if (!userId) { setShowLoginPrompt(true); return; }
    const next = !recFavoriteIds.has(activityId);
    toggleWithFeedback(setRecFavoriteIds, activityId, next, () => toggleFavorite(userId, activityId, next));
  };

  const handleToggleRecVisited = (activityId) => {
    if (!userId) { setShowLoginPrompt(true); return; }
    const next = !recVisitedIds.has(activityId);
    toggleWithFeedback(setRecVisitedIds, activityId, next, () => toggleVisited(userId, activityId, next));
  };

  const handleHideRec = (activityId) => {
    if (!userId) { setShowLoginPrompt(true); return; }
    hideActivityWithFeedback(setRecHiddenIds, userId, activityId);
  };

  // הרחבת-חיפוש מהירה למצב "לא מצאנו כלום" - רק פעולות אמיתיות: מגדילים רדיוס נסיעה קיים (אם
  // יש) או מנקים את כל הפילטרים, בלי להמציא "עוד תוצאות" שלא קיימות.
  const handleWidenSearch = () => {
    const loc = filters.location;
    if (loc?.radiusKm) {
      setField('location', { ...loc, radiusKm: null });
      return;
    }
    clearAllFilters();
  };

  // "+ מחיר/גיל/..." (קישורים עדינים לפילטרים מתקדמים, ראו visibleHomeFilters) - אותו JSX בדיוק
  // נחוץ בשני הענפים (isPersonalized/רגיל) מתחת לחיפוש המודרך, אז מחושב פעם אחת כאן במקום
  // להישכפל.
  const extraFiltersBlock = visibleHomeFilters.length > 0 ? (
    <View style={styles.extraFiltersWrap}>
      {FILTER_SCHEMA.filter((f) => visibleHomeFilters.includes(f.key)).map((f) => {
        const summary = summaryForHomeFilterKey(f.key, filters);
        return (
          <Pressable key={f.key} style={styles.ageAddRow} onPress={handleAdvancedFilters} hitSlop={8}>
            <Text style={[styles.ageAddText, summary && styles.ageAddTextActive]}>
              {summary ? t('home.extraFilter.withValue', { title: f.title, summary }) : t('home.extraFilter.empty', { title: f.title })}
            </Text>
          </Pressable>
        );
      })}
    </View>
  ) : null;

  // כרטיס-חיפוש מאוחד (2026-09-16): CTA יחיד לכל המודול (טקסט חופשי + מה עושים/איפה נח לכם ביחד,
  // לא שני מסלולים נפרדים) - מוצג תמיד (לא מותנה), כדי שלא יגרום ל-layout shift כשמשהו נבחר/מוקלד.
  // canSubmitUnifiedSearch (למעלה) קובע רק active מול disabled - לא render. onPress=
  // handleUnifiedSearch: אותה נקודת-כניסה שמשמשת גם את onSubmitEditing של שדה הטקסט (Enter) -
  // אין handler כפול.
  const unifiedCtaButton = (
    <Pressable
      style={[
        styles.smartSearchBtn,
        styles.smartSearchBtnFullWidth,
        (smartSearchLoading || locatingForSearch || !canSubmitUnifiedSearch) && styles.smartSearchBtnDisabled,
      ]}
      onPress={handleUnifiedSearch}
      disabled={smartSearchLoading || locatingForSearch || !canSubmitUnifiedSearch}
      accessibilityRole="button"
      accessibilityState={{ disabled: smartSearchLoading || locatingForSearch || !canSubmitUnifiedSearch }}
    >
      {smartSearchLoading || locatingForSearch ? (
        <ActivityIndicator color="#ffffff" size="small" />
      ) : (
        <Text style={styles.smartSearchBtnText}>{t('home.search.cta')}</Text>
      )}
    </Pressable>
  );

  return (
    <View style={styles.screen}>
      <SkyBackground />
      <SunMascot headerLayout={headerLayout} />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Header onMenuPress={() => {}} onHeaderLayout={setHeaderLayout} showLanguageSwitcher />

        {/* 🧭 "לאן קופצים היום?" - כותרת-העל של כל מודול החיפוש (קלט חופשי + מה עושים/איפה נח
            לכם, טופס אחד), לכן מחוץ לכרטיס עצמו - לא רק כותרת של שדה הטקסט הפנימי. האייקון חלק
            ממערכת כותרות-section אחידה בעמוד הבית (ראו homeHeadingIcon/sectionTitleRow). תת-כותרת
            (2026-09-16, בקשת המשתמש) - אותה sectionSubtitle בדיוק כמו שתי הכותרות האחרות, כדי
            שהמבנה יהיה זהה בשלושתן: עטיפה חיצונית (searchModuleHeaderWrap) נושאת את המרווח
            מעל/מתחת, שורת אייקון+כותרת פנימית (searchModuleTitleRow) בלי margin משלה - בדיוק כמו
            sectionHeaderRow/sectionTitleRow למטה.

            "📍 מה יש סביבי?" (2026-09-16, בקשת המשתמש) - quick action קומפקטי על אותה שורה בדיוק
            (searchModuleHeaderRow), בצד הנגדי לכותרת ב-RTL/LTR (d.row הופך אוטומטית - לא ordering
            קשיח). בכוונה לא עוד CTA ראשי: pill דק, בלי מילוי/צל, מאותה משפחה חזותית כמו
            LanguageSwitcher/saveDefaultLink הקיימים - לא שפת-עיצוב חדשה. titleBlock מקבל flex:1
            כדי שכותרת+תת-כותרת ימשיכו לתפוס את רוב הרוחב והפעולה הקצרה לא "תדחוף"/תגרום ל-wrap. */}
        <View style={styles.searchModuleHeaderWrap}>
          <View style={styles.searchModuleHeaderRow}>
            <View style={styles.searchModuleTitleBlock}>
              <View style={styles.searchModuleTitleRow}>
                <Text style={styles.homeHeadingIcon}>🧭</Text>
                <Text style={styles.searchModuleTitle}>{t('home.search.title')}</Text>
              </View>
              <Text style={styles.sectionSubtitle}>{t('home.search.subtitle')}</Text>
            </View>
            <Pressable
              style={({ pressed }) => [styles.nearMeAction, pressed && styles.nearMeActionPressed]}
              onPress={handleNearMePress}
              disabled={nearMeLoading}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('home.nearMe.a11yLabel')}
            >
              {nearMeLoading ? (
                <ActivityIndicator size="small" color={colors.accent} />
              ) : (
                <Text style={styles.nearMeActionIcon}>📍</Text>
              )}
              <Text style={styles.nearMeActionText} numberOfLines={1}>
                {nearMeLoading ? t('home.nearMe.loading') : t('home.nearMe.action')}
              </Text>
            </Pressable>
          </View>
          {nearMeError ? (
            <View style={styles.nearMeErrorRow}>
              <Text style={styles.nearMeErrorText}>{t(nearMeError)}</Text>
              <View style={styles.nearMeErrorActions}>
                <Pressable onPress={handleNearMePress} hitSlop={8}>
                  <Text style={styles.nearMeErrorLink}>{t('common.actions.retry')}</Text>
                </Pressable>
                <Text style={styles.nearMeErrorDot}>·</Text>
                <Pressable onPress={() => setWhereQuickOpen(true)} hitSlop={8}>
                  <Text style={styles.nearMeErrorLink}>{t('home.nearMe.errors.chooseCity')}</Text>
                </Pressable>
                {nearMeError === 'home.nearMe.errors.blocked' && Platform.OS !== 'web' ? (
                  <>
                    <Text style={styles.nearMeErrorDot}>·</Text>
                    <Pressable onPress={() => Linking.openSettings()} hitSlop={8}>
                      <Text style={styles.nearMeErrorLink}>{t('home.nearMe.errors.openSettings')}</Text>
                    </Pressable>
                  </>
                ) : null}
              </View>
            </View>
          ) : null}
        </View>

        {/* מודל-הסבר לפני בקשת הרשאת המערכת (סעיף 8) - לא קופצת ישר בקשת הרשאה של המערכת בלי
            הקשר. אותו דפוס Modal+Pressable-backdrop+כרטיס בדיוק כמו activities.js (gateBackdrop/
            gateCard) ו-LoginRequiredModal, רק עם עיצוב/טקסט ייעודיים ל-Near Me - לא framework חדש. */}
        <Modal visible={showNearMeExplainer} transparent animationType="fade" onRequestClose={dismissNearMeExplainer}>
          <Pressable style={styles.nearMeModalBackdrop} onPress={dismissNearMeExplainer}>
            <Pressable style={styles.nearMeModalCard} onPress={() => {}}>
              <Text style={styles.nearMeModalTitle}>{t('home.nearMe.explainer.title')}</Text>
              <Text style={styles.nearMeModalBody}>{t('home.nearMe.explainer.body')}</Text>
              <Pressable style={styles.nearMeModalPrimaryBtn} onPress={confirmNearMePermission}>
                <Text style={styles.nearMeModalPrimaryBtnText}>{t('home.nearMe.explainer.confirm')}</Text>
              </Pressable>
              <Pressable onPress={dismissNearMeExplainer} hitSlop={8}>
                <Text style={styles.nearMeModalSecondaryText}>{t('home.nearMe.explainer.notNow')}</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>

        {/* כרטיס-חיפוש מאוחד (2026-09-16, סבב פישוט נוסף) - טופס אחד עם קלטים אופציונליים
            (טקסט חופשי, מה עושים, איפה נח לכם) ו-CTA יחיד (unifiedCtaButton למטה) - לא שני
            מסלולי-חיפוש נפרדים עם שני כפתורים ומפריד "או" ביניהם. handleUnifiedSearch כבר יודע
            לשלב טקסט+בחירה מובנית (fallbackCategory/fallbackLocation ב-goToSmartSearchResults). */}
        <View style={styles.smartSearchCard}>
          <View style={styles.smartSearchInputWrap}>
            <SearchIcon />
            <TextInput
              ref={searchInputRef}
              style={styles.smartSearchInput}
              placeholder={t('home.search.placeholder')}
              placeholderTextColor={colors.textMuted}
              value={smartSearchText}
              onChangeText={setSmartSearchText}
              onSubmitEditing={handleUnifiedSearch}
              onFocus={() => { clearSearchBlurTimeout(); setSearchFocused(true); }}
              onBlur={() => { searchBlurTimeoutRef.current = setTimeout(() => setSearchFocused(false), 150); }}
              returnKeyType="search"
              editable={!smartSearchLoading}
            />
          </View>

          {smartSearchError ? <Text style={styles.smartSearchErrorText}>{smartSearchError}</Text> : null}

          {searchFocused && !smartSearchText.trim() && recentSearches.length > 0 ? (
            // dropdown תלוי-פוקוס (לא section קבוע יותר) - ראו הערה מלאה ליד searchFocused/
            // clearSearchBlurTimeout למעלה. יושב באותו מקום בדיוק בזרימה הרגילה, מתחת לשדה
            // החיפוש ובתוך אותו smartSearchCard - בלי overlay/position:absolute נפרד (אין
            // infrastructure כזה בקובץ, ואין סיבה טובה להוסיף אחד רק בשביל זה).
            <View style={styles.smartSearchIdeasWrap}>
              <View style={styles.recentSearchesHeader}>
                <Text style={styles.smartSearchIdeasTitle}>{t('home.recent.title')}</Text>
                <Pressable onPress={handleClearRecentSearches} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('home.recent.clearAllA11y')}>
                  <Text style={styles.clearRecentSearchesText}>{t('common.actions.clearAll')}</Text>
                </Pressable>
              </View>
              <View style={styles.smartSearchIdeasList}>
                {recentSearches.map((q, i) => (
                  <View key={`${q}-${i}`} style={styles.recentSearchRow}>
                    <Pressable
                      style={styles.recentSearchRowMain}
                      onPress={() => handleRecentSearchPress(q)}
                      disabled={smartSearchLoading}
                      accessibilityRole="button"
                      accessibilityLabel={t('home.recent.searchAgainA11y', { query: q })}
                    >
                      <Text style={styles.recentSearchIcon}>🕐</Text>
                      <Text style={styles.recentSearchText} numberOfLines={1} ellipsizeMode="tail">{q}</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => handleRemoveRecentSearch(q)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={t('home.recent.removeA11y', { query: q })}
                    >
                      <Text style={styles.recentSearchDelete}>×</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          {/* WHAT+WHERE (מה עושים/איפה נח לכם) יושבים ישירות בתוך הכרטיס המאוחד - בלי container/
              card נוסף סביבם (לא "קופסה בתוך קופסה"). מפריד "או" קליל (searchOrDivider) לפני
              השורה מתקשר שזו בחירה חלופית לטקסט החופשי (הקלד-או-בחר), בלי לפצל לשני טפסים/CTA
              נפרדים - עדיין קלט אחד משלים לאותו טופס, ה-CTA עדיין יחיד. "או בחרו" קוצר ל"או" בלבד
              (2026-09-16) - כותרת-המשנה מעל "לאן קופצים היום?" כבר אומרת "...או בחרו מה מתאים
              לכם", אז אין טעם לחזור על "בחרו" פעמיים באותו מודול קטן. isPersonalized (PersonalPicker,
              כבר card עצמאי בפני עצמו עם רקע/borderWidth משלו) נשאר מחוץ לכרטיס המאוחד בכוונה -
              קופסה-בתוך-קופסה גם אם רק למשתמש הזה - זהה להתנהגות הקודמת עבור המקרה הזה בלבד (בלי
              מפריד "או" משלו); ה-CTA עדיין יחיד לכל המסך (unifiedCtaButton, אותו מופע-JSX בשני
              הענפים - אף פעם לא מרונדר פעמיים יחד). */}
          {!isPersonalized ? (
            <View style={styles.searchOrDivider}>
              <View style={styles.searchOrDividerLine} />
              <Text style={styles.searchOrDividerText}>{t('home.search.or')}</Text>
              <View style={styles.searchOrDividerLine} />
            </View>
          ) : null}
          {/* WHAT+WHERE - שני מימושים חיים זה-לצד-זה לצורך השוואה חזותית (סעיף 22 בבקשה:
              "preserve an easy rollback path", בלי feature-flag מורכב) - SHOW_UNIFIED_GUIDED_SEARCH
              בראש הקובץ בוחר איזה מוצג. הישן (Selection Pills, 2026-09-16): כל pill מתגמד לפי
              התוכן שלו ויושב בשורה אחת כל עוד יש מקום, flexWrap מוריד את השני לשורה משלו רק אם
              צריך. החדש (GuidedSearchIntentControl): משטח-כוונה מאוחד אחד, ראו ההערה שם. */}
          {!isPersonalized ? (
            SHOW_UNIFIED_GUIDED_SEARCH ? (
              <GuidedSearchIntentControl fields={PRIMARY_FILTERS} />
            ) : (
              <View style={styles.filtersRow}>
                {PRIMARY_FILTERS.map((f) => (
                  <CompactFilterField key={f.key} f={f} onPress={f.onPress} />
                ))}
              </View>
            )
          ) : null}
          {!isPersonalized ? extraFiltersBlock : null}
          {!isPersonalized ? unifiedCtaButton : null}
        </View>

        {isPersonalized ? (
          <>
            <PersonalPicker kids={children} selectedChildIds={selectedChildIds} onToggleChild={toggleChild} />
            {extraFiltersBlock}
            {unifiedCtaButton}
          </>
        ) : null}

        {userId ? (
          <Pressable style={styles.saveDefaultLink} onPress={handleSaveAsDefault} disabled={savingDefault} hitSlop={8}>
            <Text style={styles.saveDefaultText}>
              {savingDefault ? t('common.actions.saving') : hasSavedDefault ? t('home.defaults.update') : t('home.defaults.save')}
            </Text>
          </Pressable>
        ) : null}
        {/* "⚡ עכשיו" (בקשת המשתמש 2026-09-16) - חזר לעמוד הבית, למשתמשים מחוברים בלבד, כקישור
            שקט באותה משפחה חזותית בדיוק כמו "⭐ שמור ברירת מחדל" מעלינו - לא כפתור נפרד/כבד
            יותר. handleSpontaneous בלבד; ה-GPS/הרשאה/דירוג עצמם עדיין ב-app/activities.js. */}
        {userId ? (
          <Pressable style={styles.saveDefaultLink} onPress={handleSpontaneous} hitSlop={8}>
            <Text style={styles.saveDefaultText}>{t('home.defaults.spontaneous')}</Text>
          </Pressable>
        ) : null}
        {defaultNotice ? <Text style={styles.defaultNoticeText}>{defaultNotice}</Text> : null}

        {/* "🎯 סינון מתקדם" הוסר מעמוד הבית (בקשת המשתמש - simplification: עמוד הבית = מתחילים
            חיפוש, עמוד התוצאות = מדייקים). handleAdvancedFilters עצמו נשאר בקוד בלי שינוי -
            עדיין משמש את הקישורים ב-visibleHomeFilters למעלה (פילטרים שהמשתמש עצמו בחר להציג
            בעמוד הבית, פיצ'ר נפרד). "🪄 ספונטני" חזר לעמוד הבית (2026-09-16, למשתמשים מחוברים
            בלבד - ראו handleSpontaneous/הקישור מעלינו) אחרי שקודם לכן עבר לעמוד התוצאות; הלוגיקה
            עצמה נשארה שם, רק הכניסה אליה זזה. הציטוט התדמיתי עבר ל"עלינו" (app/about.js) -
            עמוד הבית ממוקד בפעולה, לא בסיפור המותג. */}

        {/* ✨ המלצות מותאמות - קרוסלה אופקית: כרטיס גדול + "הצצה" לכרטיס הבא, לא גריד. section
            אחד קבוע (כותרת+תת-כותרת תמיד "✨ רעיונות...", לא section/כותרת נפרדים) -
            locationKnown קובע רק מה מוצג *בתוכו*: כרטיסי-Preview עם פעילויות אמיתיות מהמאגר
            (recommendations, אותו מקור-נתונים בדיוק כמו הקרוסלה הרגילה) אבל מטושטשות (BlurView),
            כשאין מיקום, אחרת הקרוסלה הרגילה הלא-מטושטשת. */}
        <View style={styles.sectionHeaderRow}>
          <View style={styles.sectionTitleRow}>
            <Text style={styles.homeHeadingIcon}>✨</Text>
            <Text style={styles.sectionTitle}>{recHeaderTitle}</Text>
          </View>
          <Text style={styles.sectionSubtitle}>{recHeaderSubtitle}</Text>
        </View>

        {/* recCarouselWrap (2026-09-16, בקשת המשתמש: שלוש כותרות-ה-section זהות) - marginBottom
            קבוע כאן, זהה בכל חמשת המצבים האפשריים (carousel/loading/error/ריק), כדי שהמרווח מעל
            "💡 מה עוד מעניין אתכם?" יצא זהה למרווח מעל "✨ פעילויות לידכם היום" (זה שמגיע מ-
            smartSearchCard.marginBottom למעלה) - בלי ה-wrapper הזה כל branch היה תורם מרווח-סיום
            שונה משלו (recRow: רק paddingBottom:6, emptyRecState: 8, recErrorText: 20). */}
        <View style={styles.recCarouselWrap}>
          {!locationKnown ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recRow}>
              <LocationPromptCard onPress={openLocationPicker} activity={previewActivities[0]} />
              {[1, 2, 3].map((i) => (
                <LockedPreviewCard key={i} index={i} onPress={openLocationPicker} activity={previewActivities[i]} />
              ))}
            </ScrollView>
          ) : recLoading ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recRow}>
              <SkeletonCard /><SkeletonCard /><SkeletonCard />
            </ScrollView>
          ) : recError ? (
            <Text style={styles.recErrorText}>{t('home.recs.loadError')}</Text>
          ) : recommendations.length === 0 ? (
            <View style={styles.emptyRecState}>
              <Text style={styles.emptyRecTitle}>{t('home.recs.emptyTitle')}</Text>
              <Pressable onPress={handleWidenSearch} hitSlop={8}>
                <Text style={styles.emptyRecAction}>
                  {filters.location?.radiusKm ? t('home.recs.widenDistance') : t('home.recs.clearFilters')}
                </Text>
              </Pressable>
            </View>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recRow}>
              {recommendations.map((a) => (
                <View key={a.id} style={styles.recCardWrap}>
                  <ActivityCard
                    {...a}
                    onToggleFavorite={() => handleToggleRecFavorite(a.id)}
                    onToggleVisited={() => handleToggleRecVisited(a.id)}
                    onOpenNote={() => router.push(`/activity/${a.id}`)}
                    onHide={() => handleHideRec(a.id)}
                  />
                </View>
              ))}
            </ScrollView>
          )}
        </View>

        {/* 🌳 עוד לגלות - discovery shortcuts: SEE→TAP→RESULTS, לא עוד filter-flow (בקשת
            המשתמש). לא selected state קבוע - לחיצה היא navigation, לא בחירת-filter. */}
        <View style={styles.sectionHeaderRow}>
          <View style={styles.sectionTitleRow}>
            <Text style={styles.homeHeadingIcon}>💡</Text>
            <Text style={styles.sectionTitle}>{t('home.discovery.title')}</Text>
          </View>
          <Text style={styles.sectionSubtitle}>{t('home.discovery.subtitle')}</Text>
        </View>
        <View style={styles.discoveryGrid}>
          {DISCOVERY_TILES.map((tile) => (
            <Pressable
              key={tile.id}
              style={({ pressed }) => [styles.discoveryTile, pressed && styles.discoveryTilePressed]}
              onPress={() => handleDiscoveryTilePress(tile.category)}
            >
              <Text style={styles.discoveryEmoji}>{tile.emoji}</Text>
              <Text style={styles.discoveryLabel}>{t(`home.discovery.tiles.${tile.id}`)}</Text>
            </Pressable>
          ))}
        </View>
        {/* "לכל הקטגוריות ←" - פותח את אותו QuickPicker הקיים (מה-בא-לנו), רק multiple=false כדי
            שבחירה תסגור ותחזיר מיד (ראו toggle ב-components/QuickPicker.js) - לא מסך חדש. */}
        <Pressable style={styles.allCategoriesLink} onPress={() => setAllCategoriesOpen(true)} hitSlop={8}>
          <Text style={styles.allCategoriesLinkText}>{t('home.discovery.allCategories')}</Text>
        </Pressable>

        <GrassFooter width={windowWidth} />
      </ScrollView>

      <QuickPicker
        visible={categoryQuickOpen}
        title={t('home.pickers.categoryTitle')}
        subtitle={t('home.pickers.categorySubtitle')}
        options={CATEGORY_FILTER_OPTIONS}
        value={filters.category}
        multiple
        showAll
        onChange={(v) => setField('category', v)}
        onClose={() => setCategoryQuickOpen(false)}
      />
      {/* "לכל הקטגוריות" (מ"מה עוד מעניין אתכם?") - אותה קומפוננטה בדיוק כמו QuickPicker למעלה,
          מופע נפרד כי ההתנהגות-אחרי-בחירה שונה לגמרי: כאן זו navigation מיידית לתוצאות
          (multiple=false, ראו handleAllCategoriesSelect), לא עדכון filters.category ממתין
          ל-CTA. value={[]} - זה תמיד "בחירה טרייה", לא ממשיך בחירה קודמת מ"מה עושים?". */}
      <QuickPicker
        visible={allCategoriesOpen}
        title={t('home.pickers.allTitle')}
        subtitle={t('home.pickers.allSubtitle')}
        options={CATEGORY_FILTER_OPTIONS}
        value={[]}
        multiple={false}
        onChange={handleAllCategoriesSelect}
        onClose={() => setAllCategoriesOpen(false)}
      />
      <LocationQuickPicker
        visible={whereQuickOpen}
        value={filters.location}
        onChange={(v) => setField('location', v)}
        onCoordsResolved={setDeviceCoords}
        onClose={handleWhereQuickCloseFromDiscovery}
        deviceCoords={deviceCoords}
      />
      {/* חיפוש חופשי שחסר לו הקשר גאוגרפי - אותו רכיב בדיוק (לא עותק), אותו state (filters.location),
          כמו ההבהרה המקבילה במסך התוצאות. onConfirm = "הציגו לי פעילויות" ממשיך את החיפוש; onClose
          (רקע/חזרה) = ביטול בלי לנווט. מוסתר בזמן סבב-השרת של רחוב+עיר, כדי שלא יישלח פעמיים. */}
      <LocationQuickPicker
        visible={!!smartSearchClarify && !smartSearchLoading}
        value={filters.location}
        onChange={(v) => setField('location', v)}
        onCoordsResolved={setDeviceCoords}
        onConfirm={handleClarifyConfirm}
        onClose={handleClarifyDismiss}
        deviceCoords={deviceCoords}
      />
      <LoginRequiredModal visible={showLoginPrompt} onClose={() => setShowLoginPrompt(false)} />
    </View>
  );
}

const styles = createStyles((d) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  // paddingBottom:0 - איור הדשא (GrassFooter) הוא האלמנט האחרון והוא צריך להיגמר בדיוק מעל
  // סרגל-הניווט התחתון, בלי רצועה ריקה מתחתיו.
  content: { padding: spacing.xl, paddingBottom: 0 },
  sunMascot: {
    // 'fixed' בווב: הדף עצמו גולל (לא ה-ScrollView הפנימי בלבד), אז 'absolute' רגיל היה נגרר
    // עם התוכן במקום להישאר צמוד לפינת המסך. ב-native ה-ScrollView כן קוצץ את עצמו כראוי,
    // ו-'fixed' לא קיים ב-RN native - 'absolute' שם כבר נשאר במקום כמצופה.
    // Opposite the menu button, which stays top-right in both languages (Header is physical).
    position: Platform.OS === 'web' ? 'fixed' : 'absolute', top: 46, left: 10,
  },
  grassFooter: {
    marginTop: 28, marginHorizontal: -spacing.xl,
  },
  grassFooterFade: { position: 'absolute', top: 0, left: 0 },
  // WHAT+WHERE side-by-side, כ-pills קומפקטיים (2026-09-16, מעבר מ"שדה חצי-רוחב" ל-selection
  // pill - בקשת המשתמש). 'row' רגיל (לא row-reverse!) - נבדק ויזואלית בדפדפן, לא רק מהנחה: הדף
  // לא forceRTL ברמת ה-layout (טקסט מיושר-ימין ידנית בלבד), אז 'row' מתנהג LTR - הפריט הראשון
  // במערך (PRIMARY_FILTERS[0]="where"/איפה?) יושב פיזית משמאל, השני ("category"/מה עושים?)
  // מימין. זו בדיוק הדרישה (WHAT מימין, WHERE משמאל) - row-reverse היה הופך את זה. flexWrap
  // מחליף את selectorsStacked/filtersColumn הישנים: כל pill מתגמד לפי תוכן (בלי flex:1) ונשאר
  // בשורה אחת כל עוד יש מקום; רק אם שני ערכים ארוכים ביחד לא נכנסים (למשל ~320px), ה-wrap מוריד
  // pill שני לשורה משלו בלי לוותר על צורת ה-pill (לא חוזר לשדה מלא-רוחב).
  // d.rowReverse: 'row' בעברית (WHAT מימין) - באנגלית תמונת-ראי (WHAT משמאל).
  filtersRow: { flexDirection: d.rowReverse, flexWrap: 'wrap', gap: 6, marginBottom: 18 },
  // מפריד "או" קליל בין הטקסט החופשי (+חיפושים אחרונים) לבין WHAT+WHERE: שתי קווי flex:1
  // סימטריים סביב הטקסט - ריכוז אוטומטי בלי textAlign, ולכן RTL-safe מעצם הסימטריה. בלי
  // רקע/border/צל - נשמע כמו מפריד שקט, לא כותרת-section רביעית (searchModuleTitle/
  // sectionTitle משתמשים ב-bold+גודל גדול יותר בכוונה, כדי שההבדל יהיה ברור). הטקסט עצמו "או"
  // בלבד (לא "או בחרו") - כותרת-המשנה מעל "לאן קופצים היום?" כבר אומרת "...או בחרו מה מתאים
  // לכם", אין טעם לחזור על "בחרו" פעמיים.
  // marginTop/marginBottom שווים בכוונה (בקשת המשתמש 2026-09-16): לפני התיקון marginTop:14 +
  // smartSearchInputWrap.marginBottom:16 מלמעלה (30) מול marginBottom:12 בלבד מלמטה - המפריד ישב
  // קרוב משמעותית לשורות WHAT/WHERE מאשר לשדה החיפוש. 4+16=20 מלמעלה, 20 מלמטה - מרכוז אמיתי.
  searchOrDivider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4, marginBottom: 20 },
  searchOrDividerLine: { flex: 1, height: 1, backgroundColor: colors.borderLight },
  searchOrDividerText: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted },
  // "כפתור-בחירה" (selection pill), לא שדה-טופס: radii.pill (היה radii.lg - מלבן מעוגל) +
  // alignSelf:'flex-start' (לא flex:1) + maxWidth נותנים גודל-לפי-תוכן עם תקרה סבירה, במקום
  // שני שדות שכל אחד תמיד תופס בדיוק חצי מרוחב השורה. אין יותר label נפרד מעל ה-pill (2026-09-16,
  // פישוט קודם) - הבקרה עצמה (אייקון+ערך, ראו CompactFilterField) היא ה-affordance וה-label גם
  // יחד; "מה עושים?"/"איפה?" מוצגים כערך ברירת-המחדל בתוך ה-pill (compactCategoryLabel/
  // compactLocationLabel) כשלא נבחר כלום. ה-label הסמנטי (f.label) עדיין קיים ב-data ומוזן ל-
  // accessibilityLabel של ה-pill (screen reader), רק לא מרונדר יותר כ-Text חזותי.
  // padding/gap/maxWidth נמדדו בפועל בדפדפן (getBoundingClientRect, לא ניחוש): שתי הדוגמאות
  // המורכבות שצריכות לשבת יחד בשורה אחת ב-375px ("3 סוגי פעילויות"+"30 דק' מנתניה", וגם "יצירה
  // וסדנאות"+"45 דק' מתנובות") לא נכנסו יחד ברוחב הזמין בפועל בכרטיס (293px) עם paddingHorizontal
  // 14/gap 6 (היו יוצאות ל-~300-309px, ה-wrap היה מוריד pill שני לשורה משלו גם ב-375px, לא רק
  // ב-~320px כמו שצריך) - צומצם ל-10/4 (ועדיין הרבה יותר נדיב מה-6/3 של השדה-הקומפקטי הישן) כדי
  // שהזוגות האלה בפועל יכנסו בנוחות עם שוליים אמיתיים, לא רק בדיוק-בקושי.
  compactFieldButton: {
    flexDirection: d.row, alignItems: 'center', alignSelf: 'flex-start', gap: 4,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.borderLight, borderRadius: radii.pill,
    paddingVertical: 10, paddingHorizontal: 10, minHeight: 42, maxWidth: 170,
  },
  // מצב "נבחר" עדין - אותו דפוס בדיוק כמו personalChipSelected למטה (tint בהיר + border accent),
  // לא כפתור-CTA כחול רווי: ה-pill לא צריך להתחרות עם unifiedCtaButton על תשומת-הלב.
  compactFieldButtonActive: { backgroundColor: colors.accentTintLight, borderColor: colors.accent, borderWidth: 1.5 },
  compactFieldPressed: { opacity: 0.6 },
  // אותו chip צבוע מקורי - 15px (בין ה-16px של השדה-הישן ל-18px שנוסה קודם ולא נכנס בזוגות
  // המורכבים ב-375px, ראו מדידה ליד compactFieldButton).
  compactFieldIconChip: { width: 15, height: 15, borderRadius: 6, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  compactFieldEmoji: { fontSize: 9, textAlign: 'center', lineHeight: 11.5 },
  // flexShrink (לא flex:1 כמו קודם) - flex:1 היה נכון רק כש-wrapper אילץ רוחב-קבוע (חצי-שדה);
  // עכשיו שה-pill מתגמד לפי תוכן עם maxWidth כתקרה, flex:1 היה "נלחם" בחישוב הגודל הטבעי.
  // minWidth:0 עדיין נחוץ כדי ש-numberOfLines/ellipsizeMode יוכלו בכלל לקצץ אם התקרה מגיעה.
  compactFieldValue: { flexShrink: 1, minWidth: 0, fontFamily: fonts.semiBold, fontSize: 13.5, color: colors.textSecondary, textAlign: d.textAlign },
  compactFieldValueActive: { fontFamily: fonts.bold, color: colors.accent },

  // GuidedSearchIntentControl (2026-09-16, סבב שני: חזרה ל-two full-width rows במקום שורה
  // אופקית אחת - בקשת המשתמש, ראו ההערה המלאה ליד הפונקציה עצמה). משטח אחד: bg/border/radius
  // יחידים, קלילים יותר משדה החיפוש החופשי (smartSearchInputWrap למטה - bg שם colors.bg +
  // border colors.border, כאן card+borderLight - "not styled like a text input"). radii.lg
  // (לא radii.pill כמו קודם) - pill על קופסה בגובה שתי-שורות היה יוצא כמו קפסולה, לא כרטיס-רשימה.
  guidedIntentControl: {
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.borderLight,
    borderRadius: radii.lg, marginBottom: 18, overflow: 'hidden',
  },
  // שורה במלוא הרוחב (בלי flexShrink/maxWidth כמו הפקד הקומפקטי הישן) - justifyContent:
  // 'space-between' עם flexDirection:'row-reverse' דוחף את קבוצת אייקון+טקסט (guidedIntentSegmentMain)
  // לקצה ימין (תחילת-קריאה ב-RTL) ואת ה-chevron לקצה שמאל (כיוון-קריאה-הבא), אותה קונבנציה
  // בדיוק כמו שורות "פותח בורר" ב-app/profile.js/FiltersSheet.js.
  guidedIntentSegment: {
    flexDirection: d.row, alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 13, paddingHorizontal: 14, minHeight: 46,
  },
  guidedIntentSegmentMain: {
    flexDirection: d.row, alignItems: 'center', gap: 8, flex: 1, minWidth: 0,
  },
  // ChevronLeftIcon מצביע שמאלה = "קדימה/פותח בורר" בעברית; באנגלית מסתובב ימינה.
  guidedIntentChevron: { transform: [{ rotate: d.forwardRotate }] },
  // קו דק בין שתי השורות - לא "·" בין שני segments יותר (הפריסה כבר לא אופקית) - מפריד עדין,
  // לא heavy divider (בקשת המשתמש: "Do not use a strong divider").
  guidedIntentDivider: { height: 1, backgroundColor: colors.borderLight },
  // flex:1 (לא flexShrink כמו בפקד הקומפקטי הישן) - השורה עכשיו במלוא-הרוחב, אז לערך יש הרבה
  // יותר מקום; numberOfLines/ellipsizeMode ב-GuidedIntentSegment עדיין המוצא-האחרון לערכים
  // ארוכים במיוחד, לא כיווץ-טיפוגרפיה.
  guidedIntentValue: { flex: 1, minWidth: 0, fontFamily: fonts.semiBold, fontSize: 13.5, color: colors.textSecondary, textAlign: d.textAlign },
  personalCard: {
    backgroundColor: colors.card, borderRadius: radii.xl, borderWidth: 1, borderColor: colors.borderLight,
    padding: 16, marginBottom: 18,
  },
  personalTitle: { fontFamily: fonts.extraBold, fontSize: 16, color: colors.textPrimary, textAlign: d.textAlign, marginBottom: 12 },
  personalChipsRow: { flexDirection: d.row, flexWrap: 'wrap', gap: 8 },
  personalChip: {
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.bg,
    borderRadius: radii.pill, paddingVertical: 9, paddingHorizontal: 14,
  },
  personalChipSelected: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  personalChipText: { fontFamily: fonts.semiBold, fontSize: 13.5, color: colors.textSecondary },
  personalChipTextSelected: { color: colors.accent, fontFamily: fonts.bold },
  personalHint: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, textAlign: d.textAlign, marginTop: 10 },
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
  ageAddRow: { alignItems: 'center', marginBottom: 18 },
  extraFiltersWrap: { alignItems: 'center' },
  ageAddText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textMuted },
  ageAddTextActive: { color: colors.accent, fontFamily: fonts.bold },
  saveDefaultLink: { alignItems: 'center', marginBottom: 14 },
  saveDefaultText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.accent },
  defaultNoticeText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.greenStrong, textAlign: 'center', marginBottom: 10 },
  // "לאן קופצים היום?" - כותרת-העל של כל מודול החיפוש (מחוץ לכרטיס, ראו ה-JSX), לא רק של החיפוש
  // החופשי בתוכו. עטיפה חיצונית (searchModuleHeaderWrap) נושאת marginTop/marginBottom - בדיוק
  // אותו מבנה כמו sectionHeaderRow למטה (2026-09-16, בקשת המשתמש: שלוש הכותרות "בדיוק אותו דבר",
  // ועכשיו גם תת-כותרת לכולן) - spacing.xl תואם את marginBottom של smartSearchCard שמתחת, כדי
  // שהמרווח מעל כותרת "פעילויות לידכם היום" ייצא זהה. searchModuleTitleRow (אייקון 🧭+הכותרת)
  // עצמו בלי margin משלו יותר - בדיוק כמו sectionTitleRow - כי תת-הכותרת (sectionSubtitle, עם
  // marginTop:2 משלה) יושבת אחריו בתוך אותה עטיפה, לא ה-row עצמו נוגע בכרטיס שמתחת.
  searchModuleHeaderWrap: { marginTop: spacing.xl, marginBottom: 12 },
  // שורת-העל: כותרת+תת-כותרת (searchModuleTitleBlock, flex:1) מול "📍 מה יש סביבי?" בצד הנגדי -
  // alignItems:'flex-start' כדי שה-pill יתיישר עם שורת האייקון+כותרת, לא יימתח לגובה שתי השורות.
  searchModuleHeaderRow: { flexDirection: d.row, alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  searchModuleTitleBlock: { flex: 1, minWidth: 0 },
  searchModuleTitleRow: { flexDirection: d.row, alignItems: 'center', gap: 6 },
  searchModuleTitle: {
    fontFamily: fonts.extraBold, fontSize: 17, color: colors.textPrimary, textAlign: d.textAlign,
  },
  // "📍 מה יש סביבי?" - quick action, לא CTA: pill דק (border, לא מילוי), בלי צל, מאותה משפחה
  // חזותית כמו LanguageSwitcher/saveDefaultLink - visually secondary ל"מצאו פעילויות". flexShrink:0
  // כדי שלא "ייקרס" כש-titleBlock לוחץ עליו ב-320px; הטקסט עצמו קצר מספיק כדי לא להזדקק ל-wrap.
  nearMeAction: {
    flexDirection: d.row, alignItems: 'center', gap: 4, flexShrink: 0,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.accentTintLight,
    borderRadius: radii.pill, paddingHorizontal: 10, paddingVertical: 8, marginTop: 2,
  },
  nearMeActionPressed: { opacity: 0.6 },
  nearMeActionIcon: { fontSize: 13 },
  nearMeActionText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.accent },
  nearMeErrorRow: { marginTop: 8 },
  nearMeErrorText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.danger, textAlign: d.textAlign },
  nearMeErrorActions: { flexDirection: d.row, alignItems: 'center', gap: 6, marginTop: 4 },
  nearMeErrorLink: { fontFamily: fonts.bold, fontSize: 12, color: colors.accent },
  nearMeErrorDot: { fontSize: 12, color: colors.textMuted },
  // מודל-הסבר: אותם טוקנים בדיוק כמו LoginRequiredModal (colors.card/radii.xl/fonts.extraBold),
  // כדי שהוא יראה כמו חלק מאותה "שפת מודלים" קיימת ולא רכיב חדש.
  nearMeModalBackdrop: { flex: 1, backgroundColor: 'rgba(20,30,35,0.4)', justifyContent: 'center', padding: spacing.xl },
  nearMeModalCard: { backgroundColor: colors.card, borderRadius: radii.xl, padding: spacing.xl, alignItems: 'center' },
  nearMeModalTitle: { fontFamily: fonts.extraBold, fontSize: 17, color: colors.textPrimary, textAlign: 'center', marginBottom: 8 },
  nearMeModalBody: { fontFamily: fonts.regular, fontSize: 13.5, color: colors.textSecondary, textAlign: 'center', lineHeight: 19, marginBottom: 18 },
  nearMeModalPrimaryBtn: { backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 12, paddingHorizontal: 28 },
  nearMeModalPrimaryBtnText: { fontFamily: fonts.bold, fontSize: 14, color: '#fff' },
  nearMeModalSecondaryText: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.textSecondary, marginTop: 12 },
  // 🔎 כרטיס-חיפוש מאוחד: חיפוש חופשי + "או שנמצא לכם" + חיפוש מודרך - הכל בתוך משטח-white אחד
  // (לא שני כרטיסים). הכותרת עברה מחוץ לכרטיס (searchModuleTitle למעלה) - אין לו יותר marginTop
  // נשימה משלו, זה כבר מטופל על-ידי marginBottom של הכותרת. border/shadow עדינים (לא מסגרת
  // accent עבה) כדי שהכרטיס יתבלוט בעדינות בלי להרגיש כבד.
  smartSearchCard: {
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.accentTintLight,
    borderRadius: radii.xl, padding: spacing.lg, marginBottom: 22,
    shadowColor: colors.accent, shadowOpacity: 0.08, shadowRadius: 14, shadowOffset: { width: 0, height: 5 }, elevation: 2,
  },
  // כרטיס-חיפוש מאוחד: שדה הטקסט הוא הקלט היחיד בשורה הזו (אין יותר כפתור "חיפוש" לצידו) - ה-
  // pill/border/bg יושבים כאן כדי שאייקון-החיפוש יישב "בתוך" השדה חזותית, לא ליד שדה נפרד.
  // row-reverse: SearchIcon (ילד ראשון) מימין, TextInput ממלא את השאר. marginBottom נותן את
  // המרווח הבסיסי לפני מה שמתחת (חיפושים אחרונים/מפריד "או"/PersonalPicker) - המפריד "או"
  // עצמו (searchOrDivider) יושב נמוך יותר, ממש לפני WHAT+WHERE, לא כאן.
  smartSearchInputWrap: {
    flexDirection: d.row, alignItems: 'center', gap: 6, marginBottom: 16,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.pill, paddingHorizontal: 14,
  },
  smartSearchInput: {
    flex: 1, paddingVertical: 12,
    fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, textAlign: d.textAlign, writingDirection: d.writingDirection,
  },
  smartSearchBtn: {
    backgroundColor: colors.accent, borderRadius: radii.pill, paddingHorizontal: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  smartSearchBtnFullWidth: { width: '100%', paddingVertical: 13 },
  smartSearchBtnDisabled: { opacity: 0.5 },
  smartSearchBtnText: { fontFamily: fonts.bold, fontSize: 13.5, color: '#ffffff' },
  smartSearchErrorText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.danger, textAlign: 'center', marginTop: 10 },
  // בלי borderTop/paddingTop משלו בכוונה (2026-09-15): קו-מפריד כאן היה נערם חזותית עם
  // searchOrDivider החדש שמתחתיו כשההיסטוריה מכווצת - מרווח בלבד מספיק, searchOrDivider הוא
  // המפריד המשמעותי היחיד בין חיפוש-חופשי לבחירה-מונחית.
  // חיפושים אחרונים כ-dropdown תלוי-פוקוס (2026-09-16, סבב שני) - יושב באותו מקום-JSX בדיוק
  // כמו קודם (מתחת לשדה, בתוך אותו smartSearchCard), רק בלי accordion ידני (recentSearchesOpen
  // הוסר) - נראה/נעלם לפי searchFocused, ראו ההערה המלאה ליד ה-state עצמו.
  smartSearchIdeasWrap: { marginTop: 12 },
  smartSearchIdeasTitle: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.textSecondary, textAlign: d.textAlign },
  recentSearchesHeader: { flexDirection: d.row, alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  // "נקה הכל" - פעולה משנית שקטה בכותרת הפאנל (בקשת המשתמש), לא כפתור ראשי - אותו צבע-אזהרה
  // עדין (colors.danger) שהיה על "🗑️ מחק היסטוריה" הקודם.
  clearRecentSearchesText: { fontFamily: fonts.semiBold, fontSize: 11.5, color: colors.danger, textAlign: d.textAlign },
  smartSearchIdeasList: { gap: 2 },
  // שורה במלוא-הרוחב (לא chip מתגמד-לתוכן כמו קודם) - "כמו מנוע חיפוש מודרני": אייקון+טקסט
  // לחיצים יחד (recentSearchRowMain, מבצע את החיפוש), × נפרד בקצה (מוחק פריט בודד בלבד, לא
  // מבצע חיפוש - לכן Pressable משלו, לא חלק מ-recentSearchRowMain).
  recentSearchRow: {
    flexDirection: d.row, alignItems: 'center', justifyContent: 'space-between', gap: 8,
    paddingVertical: 8,
  },
  recentSearchRowMain: { flexDirection: d.row, alignItems: 'center', gap: 8, flex: 1, minWidth: 0 },
  recentSearchIcon: { fontSize: 12 },
  recentSearchText: { flex: 1, minWidth: 0, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, textAlign: d.textAlign },
  recentSearchDelete: { fontSize: 16, color: colors.textMuted, paddingHorizontal: 4, fontFamily: fonts.regular },

  sectionHeaderRow: { marginBottom: 12 },
  // שורת-כותרת עם אייקון סמנטי (🧭/✨/💡) - חלק ממערכת כותרות-section אחידה בעמוד הבית (ראו גם
  // searchModuleTitleRow למעלה): row-reverse+gap+alignItems:'center' זהים בשלושתם כך שהאייקון
  // תמיד יושב באותו מקום/גודל/יישור ביחס לטקסט, בלי קשר לגודל הפונט של הכותרת עצמה.
  sectionTitleRow: { flexDirection: d.row, alignItems: 'center', gap: 6 },
  sectionTitle: { fontFamily: fonts.extraBold, fontSize: 17, color: colors.textPrimary, textAlign: d.textAlign },
  sectionSubtitle: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: d.textAlign, marginTop: 2 },
  // גודל אחיד לאייקון בכל שלוש כותרות ה-section (searchModuleTitle/sectionTitle גם משתמשות
  // באותו fontSize:17 אחרי האיחוד - ראו searchModuleTitleRow למעלה - אז זה כבר לא רק "פיצוי" על
  // הבדל גודל, אלא עקביות מלאה: אותו אייקון, אותו גודל, בכל שלוש הכותרות).
  homeHeadingIcon: { fontSize: 15 },

  // marginBottom קבוע - ראו ההערה ליד ה-JSX (recCarouselWrap) למעלה: המרווח האחיד לפני "💡 מה
  // עוד מעניין אתכם?" יושב כאן, לא בתוך recRow/emptyRecState/recErrorText עצמם (שממשיכים לשרת
  // את התפקיד הפנימי-להם - ריווח מתחת לצללי הכרטיסים בגלילה, לא ריווח בין-סקשנים).
  recCarouselWrap: { marginBottom: 16 },

  // row רגיל (לא row-reverse) בכוונה - ה-אפליקציה מכבה forceRTL לגמרי (app/_layout.js), אז אין
  // anchor-גלילה מה-RTL האמיתי ו-offset=0 תמיד מציג את הקצה הפיזי-שמאלי של התוכן - row-reverse
  // רק היה מזיז את הכרטיס המדורג-ראשון (הכי רלוונטי) אל הקצה שדורש גלילה כדי לראות.
  recRow: { flexDirection: 'row', gap: 12, paddingBottom: 6 },
  recCardWrap: { width: 260, alignSelf: 'flex-start' },
  recErrorText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textMuted, textAlign: 'center', marginBottom: 20 },

  skeletonImage: { width: '100%', height: 158, borderRadius: radii.lg, backgroundColor: colors.borderLight },
  skeletonLineWide: { width: '80%', height: 14, borderRadius: 7, backgroundColor: colors.borderLight, marginTop: 12 },
  skeletonLineNarrow: { width: '50%', height: 12, borderRadius: 6, backgroundColor: colors.borderLight, marginTop: 8 },

  emptyRecState: {
    alignItems: 'center', paddingVertical: 26, paddingHorizontal: spacing.lg,
    backgroundColor: colors.card, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.borderLight, marginBottom: 8,
  },
  emptyRecTitle: { fontFamily: fonts.bold, fontSize: 14, color: colors.textPrimary, textAlign: 'center', marginBottom: 10 },
  emptyRecAction: { fontFamily: fonts.bold, fontSize: 13, color: colors.accent },

  discoveryGrid: { flexDirection: d.row, flexWrap: 'wrap', gap: 10, marginBottom: 14 },
  discoveryTile: {
    width: '31%', aspectRatio: 1, backgroundColor: colors.card, borderRadius: radii.lg,
    borderWidth: 1, borderColor: colors.borderLight, alignItems: 'center', justifyContent: 'center', gap: 6, padding: 6,
  },
  discoveryEmoji: { fontSize: 26 },
  discoveryLabel: { fontFamily: fonts.semiBold, fontSize: 11.5, color: colors.textSecondary, textAlign: 'center' },
  // pressed state עדין בלבד (רקע קליל, בלי scale/אנימציה) - "tap feedback מיידי, לא מוגזם"
  // (בקשת המשתמש). לא selected state קבוע - זה נעלם ברגע שמרימים את האצבע, כי הלחיצה היא
  // navigation, לא בחירת filter (סעיף 7 בבקשה).
  discoveryTilePressed: { backgroundColor: colors.accentTintLight, borderColor: colors.accentTint },
  allCategoriesLink: { alignSelf: 'center', marginBottom: 24 },
  allCategoriesLinkText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.accent },
}));
