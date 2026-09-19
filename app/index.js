import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { View, Text, ScrollView, Pressable, TextInput, ActivityIndicator, Image, Platform, Linking, Modal, useWindowDimensions, Animated } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter, useFocusEffect } from 'expo-router';
import * as Location from 'expo-location';
import Svg, { Circle, Polyline, Line } from 'react-native-svg';
import Header from '../components/Header';
import SkyBackground from '../components/SkyBackground';
import LoginRequiredModal from '../components/LoginRequiredModal';
import QuickPicker from '../components/QuickPicker';
import LocationQuickPicker, { locationSummary } from '../components/LocationQuickPicker';
import ActivityCard from '../components/ActivityCard';
import { ChevronLeftIcon } from '../components/icons';
import HomeHero from '../components/HomeHero';
import { LocationPromptCard, LockedPreviewCard } from '../components/LockedPreviewCard';
import GrassFooter from '../components/GrassFooter';
import {
  CATEGORY_FILTER_OPTIONS, DEFAULT_FILTERS, FILTER_SCHEMA,
  PRICE_OPTIONS, PLACE_TYPE_OPTIONS, BOOKING_OPTIONS, DURATION_OPTIONS, AMENITY_COMFORT_OPTIONS,
} from '../constants/filterSchema';
import { normalizeFilters, rankActivitiesWithSmartRadius } from '../lib/filterActivities';
import { whenSummary, listJoin } from '../lib/filterSummaries';
import { supabase } from '../lib/supabase';
import { fetchUserPreferences, saveDefaultHomeFilters } from '../lib/preferences';
import { childrenToDefaultAgeFilter, formatChildAge } from '../lib/children';
import { parseSmartSearchQuery, intentToFilters, needsAreaClarification } from '../lib/smartSearch';
import { requestCurrentPosition, CURRENT_POSITION_ERROR_KEYS } from '../lib/currentPosition';
import { fetchApprovedActivities, formatDistance, fetchSettlementCoords } from '../lib/activities';
import { fetchUserActivityFlags, toggleFavorite, toggleVisited, fetchAllPersonalNotes, toggleWithFeedback, hideActivityWithFeedback } from '../lib/interactions';
import { formatBenefitCardTag } from '../lib/benefits';
import { buildMatchReasons, selectedChildAges } from '../lib/matchReasons';
import {
  shouldApplyHomeDefaults, buildCarouselFilters, resolveCommittedHomeLocation,
  buildResultsParams, resolveSmartSearchCoords,
} from '../lib/homeSession';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { useI18n, createStyles, t } from '../lib/i18n';
import { categoryLabel, compactLocationText } from '../lib/i18n/format';

// המסך הראשי - יש מסך-בית אחד בלבד (בקשת המשתמש 2026-09-12: "יש למחוק את מסך הבית 2, מעכשיו
// יש רק מסך בית אחד"). קודם לכן היו שני מסכי-בית מקבילים (app/index.js ו-app/home2.js) שמוזגו
// יחד לקובץ הזה בשלב קודם, ואז home2.js נמחק לגמרי - זה כל הסיפור, אין יותר מסך שני.

const RECOMMENDATIONS_LIMIT = 8;

// תקרת-רוחב לתוכן עמוד הבית בדסקטופ (2026-09-19, בקשת המשתמש) - בלי זה כרטיס-החיפוש נמתח כמעט
// לרוחב-מסך מלא ב-1280px+. ~480 נשאר קרוב-מספיק לרוחב מסך-נייד ריאלי (375-414) כדי שאותה פריסה
// שאומתה בפועל ב-mobile תרגיש "אותו דבר, רק ממורכז" בדסקטופ - לא רדיזיין-רספונסיבי נפרד.
const CONTENT_MAX_WIDTH = 480;

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
// 2026-09-20 (סבב-עידון חזותי שלישי, "TURU home reference mockup" סעיף 7) - נבנה מחדש מ-JSX
// אחיד-RTL (d.row, chip צבוע-קטן+ערך יחד בצד-הקריאה, chevron בקצה השני) למבנה שלוש-עמודות
// פיזי-מוחלט (flexDirection:'row' רגיל, לא d.row): [אייקון גדול בקצה הפיזי-שמאלי] - [עמודת-
// כותרת+ערך, flex:1, טקסט מיושר-ימין] - [chevron בקצה הפיזי-ימני]. זו דרישה מפורשת ומכוונת של
// ה-mockup, שונה מכל שאר הרכיבים בקובץ הזה (שם RTL-אוטומטי תמיד נכון) - "Do not let RTL
// automatic layout reverse these visual positions. Explicitly control the layout if necessary."
// f.title (חדש, קבוע - "מה עושים?"/"איפה?") מוצג תמיד עכשיו מעל f.subtitle (הערך בפועל/ה"ריק"
// המעודכן) - שתי שורות, לא עוד שורה-יחידה שמתחלפת. ה-chip הצבוע-קטן (compactFieldIconChip,
// 15px) הוחלף באמוג'י גדול חשוף (guidedIntentEmoji, בלי רקע) - תואם את ה-mockup, שם האייקונים
// מוצגים "as-is" בלי chip צבוע מסביבם.
function GuidedIntentSegment({ f }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.guidedIntentSegment, pressed && styles.compactFieldPressed]}
      onPress={f.onPress}
      accessibilityRole="button"
      accessibilityLabel={t('home.guided.a11yLabel', { label: f.label, value: f.a11yValue || f.subtitle })}
      accessibilityHint={f.a11yHint}
    >
      <Image source={f.decorIcon} style={styles.guidedIntentIconImage} resizeMode="contain" />
      <View style={styles.guidedIntentSegmentMain}>
        <Text style={styles.guidedIntentTitle} numberOfLines={1}>{f.title}</Text>
        <Text
          style={[styles.guidedIntentValue, f.active && styles.compactFieldValueActive]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {f.subtitle}
        </Text>
      </View>
      <View style={styles.guidedIntentChevron}>
        <ChevronLeftIcon size={14} color={colors.textMuted} />
      </View>
    </Pressable>
  );
}

// שתי שורות זו-מתחת-לזו, כל אחת שדה-בחירה מעוגל ונפרד בפני עצמו (2026-09-20, סבב-עידון שישי,
// בקשת המשתמש: "should visually read as TWO separate rounded selection fields... DO NOT use
// only a horizontal divider between two compressed rows" - היה בעבר משטח-אחד עם guidedIntentDivider
// דק ביניהן, שונה עכשיו: guidedIntentControl הוא רק מרווח (gap) בין שני GuidedIntentSegment
// עצמאיים, וכל GuidedIntentSegment נושא רקע/מסגרת/radius משלו - ראו הסטיילים למטה). סדר תצוגה:
// מה עושים קודם, איפה נח לכם אחריו (בקשת המשתמש - סדר-הקריאה האנכי, לא סדר ה-array שנשאר
// [where, category] מסיבות היסטוריות של הפריסה האופקית הקודמת).
function GuidedSearchIntentControl({ fields }) {
  const [where, category] = fields;
  return (
    <View style={styles.guidedIntentControl}>
      <GuidedIntentSegment f={category} />
      <GuidedIntentSegment f={where} />
    </View>
  );
}

// "למי מחפשים היום?" - מחליף את הבוררים "מה עושים?"/"איפה נח לכם?" רק למשתמש מחובר עם ילדים
// (ראו isPersonalized ב-HomeScreen). בחירת ילד/ים כאן מעדכנת את filters.age מיידית; מיקום/
// קטגוריה כבר נכנסים אוטומטית מ-default_home_filters השמור, בלי קשר לכרטיס הזה.
// bare (2026-09-19, בקשת המשתמש: כרטיס-חיפוש דו-מצבי אחד) - כש-true מדלג על ה-card הפרטי שלו
// (רקע/border/radius/margin משלו) כי הוא מקונן עכשיו בתוך smartSearchCard כשמצב "בחירה מהירה"
// פעיל למשתמש מותאם-אישית - בלי זה היה יוצא "קופסה בתוך קופסה". שום שינוי בתוכן/state/handlers -
// עדיין אותו title/chips/hint בדיוק.
function PersonalPicker({ kids, selectedChildIds, onToggleChild, bare }) {
  const { t } = useI18n();
  return (
    <View style={bare ? styles.personalCardBare : styles.personalCard}>
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

export default function HomeScreen() {
  const router = useRouter();
  const { t, locale } = useI18n();
  const { width: windowWidth } = useWindowDimensions();
  // רוחב-התוכן בפועל (לא windowWidth הגולמי) - לאחר שה-ScrollView content קיבל תקרת-רוחב
  // (CONTENT_MAX_WIDTH, styles.content) עבור GrassFooter, כדי שהאיור ימשיך לכסות בדיוק את רוחב
  // התוכן שמעליו, לא את המסך המלא שמעבר לו בדסקטופ.
  const contentWidth = Math.min(windowWidth, CONTENT_MAX_WIDTH);
  // 2026-09-20 (סבב-עידון חזותי שלישי, בקשת המשתמש: "On smaller screens: slightly reduce
  // side-action typography/icon size if necessary, preserve touch targets... prevent Hebrew
  // labels from wrapping") - שני הפעולות הצדדיות (heroRow) גדלו משמעותית בסבב הזה, ומתחת ל-360px
  // (למשל 320×568, בדיקת-רוחב מפורשת בבקשה - סעיף 11) "בחירה מהירה" בגודל המלא כמעט נוגעת בקצה
  // המסך. heroCompact מקטין מעט טיפוגרפיה/אייקון של הפעולות הצדדיות בלבד באותם מסכים צרים - לא
  // נוגע ברדאר/בכרטיס/בכותרת, ולא בהתנהגות כלשהי (numberOfLines={1} כבר מנע גלישה-לשתי-שורות
  // מלכתחילה, זה רק שוליים בטוחים יותר בפועל).
  const heroCompact = windowWidth < 360;
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [deviceCoords, setDeviceCoords] = useState(null);
  // 🏠 homeLocation - "מיקום מחויב" (2026-09-19, תיקון-באג שאותר בביקורת הארכיטקטונית: "the
  // discovery carousel currently ranks using the same `filters` object used by Quick Choice...
  // opening Quick Choice and changing category/location before pressing 'מצאו פעילויות' must not
  // re-rank the carousel"). נפרד לגמרי מ-filters.location (הטיוטה החיה של "איפה?" ב"בחירה
  // מהירה") - מתעדכן רק בשתי נקודות מפורשות: (א) פתרון-מיקום ראשוני כש-homeLocation עדיין null
  // (GPS/עיר-אורח/ברירת-מחדל שמורה, או הבחירה הראשונה של המשתמש עצמו כשעדיין אין שום מיקום ידוע -
  // ראו resolveCommittedHomeLocation, lib/homeSession.js: prevHomeLocation||candidateLocation,
  // לא דורסת מיקום-מחויב קיים), (ב) commit מפורש בכל פעולת-חיפוש/ניווט אמיתית (handleGo/
  // goToSmartSearchResults/navigateToCategoryResults למטה - "כשלוחצים על 'מצאו פעילויות', החיפוש
  // מתבצע כרגיל", כולל commit של המיקום שנבחר). ראו buildCarouselFilters למטה לשימוש בפועל.
  const [homeLocation, setHomeLocation] = useState(null);
  // 🚗 Smart Radius Expansion עבור קרוסלת-ההמלצות (2026-09-20, בקשת המשתמש: "בקרוסלה, כשאני
  // בוחר ינוב לדוגמא... זה לא מראה לי אפשרויות בצורן או כפר יונה, למרות שהם עומדים בקריטריונים" -
  // אומת ישירות מול ה-DB: "ינוב" עצמו מתאים ל-2 פעילויות בלבד (התאמת-שם-עיר מדויקת), אבל 187
  // פעילויות נמצאות בפועל בטווח 10 ק"מ מינוב (כפר יונה/קדימה-צורן כלולות, כ-2/4.85 ק"מ בהתאמה) -
  // כלומר יש כאן פער-עקביות אמיתי, לא "התנהגות מכוונת": app/activities.js כבר פותר בדיוק את זה
  // (settlementCoords/searchOriginCoords/rankActivitiesWithSmartRadius, ראו שם) לעמוד-התוצאות
  // המלא, אבל קרוסלת-עמוד-הבית (recommendations, למטה) קראה עד עכשיו ל-rankActivities הפשוט
  // עם originCoords:null קבוע - בלי הרחבה גיאוגרפית בכלל במצב 'city'. אותו state+effect בדיוק
  // כמו app/activities.js (לא מימוש-כפול - reuse מלא של fetchSettlementCoords/
  // rankActivitiesWithSmartRadius הקיימים). תלוי ב-homeLocation (לא filters.location) - אותו
  // תיקון-הפרדה בדיוק (ראו ההערה ליד homeLocation למעלה).
  const [settlementCoords, setSettlementCoords] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (homeLocation?.mode !== 'city' || !homeLocation?.city) {
      setSettlementCoords(null);
      return undefined;
    }
    fetchSettlementCoords(homeLocation.city).then((coords) => {
      if (!cancelled) setSettlementCoords(coords);
    });
    return () => { cancelled = true; };
  }, [homeLocation?.mode, homeLocation?.city]);
  // אותו מקור-אמת בדיוק כמו app/activities.js (searchOriginCoords) - 'current'/'address' כבר יש
  // להם קואורדינטות קיימות, 'city' משתמש ב-settlementCoords שנפתר למעלה. homeLocation (לא
  // filters.location) - ראו ההערה המלאה ליד homeLocation למעלה.
  const searchOriginCoords = useMemo(() => {
    const mode = homeLocation?.mode;
    if (mode === 'current') return deviceCoords ? { lat: deviceCoords.latitude, lng: deviceCoords.longitude } : null;
    if (mode === 'address') return homeLocation.coords || null;
    if (mode === 'city') return settlementCoords;
    return null;
  }, [homeLocation?.mode, homeLocation?.coords, deviceCoords, settlementCoords]);
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
  // "very subtle tactile scale response" (2026-09-20, בקשת המשתמש) - Animated.Value יחיד, לא
  // state: onPressIn/onPressOut מכווצים/משחזרים מעט את כל הרדאר (transform.scale, useNativeDriver
  // כן - זה View/transform רגיל, לא צורת-SVG כמו ה-pulse ב-NearMeRadar).
  const nearMePressScale = useRef(new Animated.Value(1)).current;
  const nearMePressIn = () => Animated.spring(nearMePressScale, { toValue: 0.96, useNativeDriver: true, speed: 40, bounciness: 0 }).start();
  const nearMePressOut = () => Animated.spring(nearMePressScale, { toValue: 1, useNativeDriver: true, speed: 30, bounciness: 6 }).start();
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
  // "בחירה מהירה" | "חיפוש חופשי" - איזה תוכן מוצג בתוך כרטיס-החיפוש (2026-09-19, בקשת המשתמש:
  // progressive disclosure - מצב אחד גלוי בכל רגע, לא עוד "או" בין טקסט-חופשי לבחירה-מונחית).
  // state מקומי-בלבד (לא AsyncStorage/DB) בכוונה - סעיף 21 בבקשה: "the simplest existing state
  // mechanism appropriate for Home, no permanent account-level persistence just for this". נשרד
  // ברירת-מחדל null (2026-09-20, "change the DEFAULT BEHAVIOR and information hierarchy" - בקשת
  // המשתמש המפורשת: "neither side mode should be selected... no search mode active... no expanded
  // search panel... The Home screen should feel clean") - מבטלת שוב את הסבב הקודם ('guided'
  // כברירת-מחדל, שבעצמו ביטל את ה-"INTENTIONAL DEVIATION #2" המקורי). חוזרים בפועל ל-null/אף-
  // מצב-לא-נבחר שהיה כאן במקור - שלישי-בשורה בהיפוך-כיוון הזה, לא ניחוש: כל פעם לפי בקשה מפורשת
  // אחרונה. "שווה לגלות"/הקרוסלה תחתיו לא תלויים ב-state הזה כלל (ראו ה-JSX למטה - מחוץ ל-
  // {searchMode ? ... : null}) - נשארים גלויים תמיד, גם כברירת-מחדל.
  const [searchMode, setSearchMode] = useState(null);
  // מעבר מצב הוא presentation-בלבד (HIDE != DELETE) - לא נוגע ב-filters.category/filters.location
  // (WHAT/WHERE) ולא ב-smartSearchText; שניהם ממשיכים לחיות ב-state כרגיל, רק לא מוצגים כשהמצב
  // השני פעיל. reset ל-searchFocused כן קורה כאן - בלי זה, לחיצה חוזרת על "חיפוש חופשי" הייתה
  // עלולה להראות מיד dropdown-היסטוריה "תקוע" מ-focus ישן על שדה שכבר לא existed.
  // toggle-לסגירה (חדש, 2026-09-20) - בקשת המשתמש: "Tap the active mode again → collapses...
  // Home screen returns to the clean DEFAULT state" - לחיצה על המצב הפעיל כרגע מחזירה ל-null
  // (לא no-op כמו קודם); לחיצה על המצב השני תמיד מחליפה ישירות (אף פעם לא שני הפאנלים יחד -
  // כבר היה נכון קודם, כי זה set ישיר ל-mode הנלחץ, לא toggle תלוי-מצב-קודם).
  const switchSearchMode = (mode) => {
    setSearchMode((prev) => (prev === mode ? null : mode));
    setSearchFocused(false);
  };
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
            setFilters((prev) => {
              if (prev.location?.mode) return prev;
              const next = { ...prev.location, mode: 'current', radiusKm: prev.location.radiusKm || 10 };
              // homeLocation (ראו ההערה המלאה ליד ה-state למעלה) - "פתרון-מיקום ראשוני", לא
              // עריכת-טיוטה: resolveCommittedHomeLocation לא דורסת אם כבר יש מיקום-מחויב (לא
              // אמור לקרות כאן בפועל, ה-effect רץ פעם אחת ב-mount, אבל אותה הגנה בכל זאת - עקביות
              // עם שתי הקריאות האחרות ל-resolveCommittedHomeLocation).
              setHomeLocation((prevHome) => resolveCommittedHomeLocation(prevHome, next));
              return { ...prev, location: next };
            });
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
          setFilters((prev) => {
            if (prev.location?.mode) return prev;
            const next = { ...prev.location, ...saved };
            setHomeLocation((prevHome) => resolveCommittedHomeLocation(prevHome, next));
            return { ...prev, location: next };
          });
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

  // בחירה מחיפושים אחרונים רק ממלאת את שדה החיפוש - לא מריצה חיפוש. המשתמש יכול עוד לשנות את
  // הטקסט/מה עושים/איפה, והחיפוש מתבצע רק בלחיצה על "מצאו פעילויות" (או Enter), כמו הקלדה רגילה.
  const handleRecentSearchPress = (q) => {
    clearSearchBlurTimeout();
    setSearchFocused(false);
    setSmartSearchText(q);
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

  // homeDefaultsInitializedRef (2026-09-19, תיקון-באג שאותר בביקורת הארכיטקטונית) - "האם כבר
  // אתחלנו את ברירות-המחדל השמורות ב-session הזה של Home פעם אחת". ref (לא state - לא אמור
  // להשפיע על רינדור בעצמו) שחי לכל אורך חיי המופע הזה של HomeScreen: false פעם אחת ב-mount,
  // true לצמיתות אחרי הפעם הראשונה שה-focus effect למטה הצליח לטעון prefs בפועל (גם אם לא היה
  // default_home_filters/ילדים לטעון בפועל - "ניסינו" נחשב "אתחלנו", ראו shouldApplyHomeDefaults
  // ב-lib/homeSession.js). בלי זה: חזרה למיקוד (למשל Back ממסך-תוצאות) הייתה טוענת מחדש את
  // ברירת-המחדל השמורה ודורסת בחירה מפורשת שהמשתמש כבר עשה ב"בחירה מהירה" באותו session (לדוגמה
  // שינה מיקום מ-ינוב לנתניה, חיפש, לחץ Back - וה-effect היה מחזיר את זה לינוב). לא הושבת ה-
  // effect כולו (ראו ההערה המלאה למטה על מה שכן ממשיך להתרענן בכל מיקוד).
  const homeDefaultsInitializedRef = useRef(false);

  // useFocusEffect (לא useEffect רגיל) - בדיוק כמו app/profile.js - כדי שכל המעברים בין מצבים
  // (התחברות/התנתקות/הוספת-הסרת ילד ב-/profile) ישתקפו נכון בכניסה הבאה למסך הבית, לא רק
  // ב-mount הראשוני. כשאין session בכלל - מאפסים ל"לא מחובר" (חשוב: בלי זה, משתמש שמתנתק
  // עדיין היה רואה את המצב האישי הישן עד רענון ידני) - זו לא "דריסת בחירה מפורשת", זו שיקוף-אמת
  // של מצב-התחברות, אז לא מוגנת ע"י homeDefaultsInitializedRef (ראו ההערה שם).
  //
  // הפרדה בין "מתרענן בכל מיקוד" (session/flags/notes/children/excludedCategories/
  // excludedCities/excludedRegions/benefitClubs/visibleHomeFilters/hasSavedDefault - כולם נתוני-
  // שרת שאין להם UI לעריכה-מיידית בתוך Home עצמו, אז אין להם את בעיית-הדריסה בכלל) לבין "מאתחל
  // רק פעם אחת למופע-Home" (filters מ-defaultHomeFilters, selectedChildIds="כל הילדים",
  // filters.age מגילאי-הילדים - שלושתם *כן* ניתנים לעריכה מפורשת ב-Home: "בחירה מהירה"/toggleChild)
  // - מוגנים ע"י shouldApplyHomeDefaults(homeDefaultsInitializedRef.current), lib/homeSession.js.
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
          // מתרענן בכל מיקוד - נתוני-שרת בלי UI-עריכה מיידית ב-Home (ראו ההערה המלאה למעלה).
          setVisibleHomeFilters(prefs.visibleHomeFilters);
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
          // מאתחל-פעם-אחת-בלבד - filters/selectedChildIds ניתנים לעריכה מפורשת ב-Home עצמו
          // ("בחירה מהירה"/toggleChild), אז דריסתם בכל מיקוד הייתה מוחקת בחירה פעילה (ראו
          // ההערה המלאה ליד homeDefaultsInitializedRef למעלה).
          if (shouldApplyHomeDefaults(homeDefaultsInitializedRef.current)) {
            if (prefs.defaultHomeFilters) {
              const normalized = normalizeFilters(prefs.defaultHomeFilters);
              setFilters(normalized);
              setHasSavedDefault(true);
              // homeLocation (ראו ההערה המלאה ליד ה-state) - ברירת-המחדל השמורה נחשבת גם היא
              // "פתרון-מיקום ראשוני" לקרוסלה, לא רק ל"בחירה מהירה" - עדיין לא דורסת מיקום-מחויב
              // קיים (resolveCommittedHomeLocation), ליתר-ביטחון אם homeLocation כבר נפתר קודם
              // (למשל ע"י bootstrap-effect ה-GPS) באותו mount.
              setHomeLocation((prevHome) => resolveCommittedHomeLocation(prevHome, normalized.location));
            }
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
            homeDefaultsInitializedRef.current = true;
          }
        } catch {
          // אם טעינת ההעדפות נכשלת, פשוט ממשיכים עם ברירת המחדל הרגילה - homeDefaultsInitializedRef
          // נשאר false (לא "אתחלנו" בפועל), כך שהזדמנות-אתחול עתידית (מיקוד הבא שיצליח) עדיין פתוחה.
        }
      })();
      return () => { cancelled = true; };
    }, [])
  );

  // "למי מחפשים היום?" מוצג רק למשתמש מחובר עם לפחות ילד אחד - כלל קריטי: כל שאר המשתמשים
  // (לא מחוברים, מחוברים בלי ילדים, מחוברים שהסירו את כל הילדים) חייבים לראות בדיוק את מסך
  // הבית הרגיל בלי שום שינוי.
  const isPersonalized = !!userId && children.length > 0;

  // locationKnown - "האם יש מיקום ידוע *כרגע*, כולל טיוטה לא-מוגשת ב'בחירה מהירה'". מוגדר אך
  // ורק לפי filters.location.mode - אותו source-of-truth שכבר משמש את "איפה נוח לכם?" (סעיף 13
  // בבקשה: לא state נפרד) - ולא לפי account status: guest יכול להיות עם location ידוע (GPS/עיר
  // שמורה), מחובר יכול להיות בלי (סעיף 2). 'region' לא נחשב "ידוע" מספיק - זה בחירה גסה (7
  // אזורי-ארץ), לא "רעיונות ליד" אמיתיים; לא ניתן לבחירה מהמסך הזה בלאו הכי.
  // שימוש: navigateToCategoryResults/handleDiscoveryTilePress/handleAllCategoriesSelect (למטה) -
  // אלה כולם פעולות-ניווט מפורשות ("SEE→TAP→RESULTS"), לא הקרוסלה - לחיצה על shortcut-גילוי היא
  // עצמה כבר "הגשה" מיידית, אז שימוש בטיוטה החיה כאן הוא נכון ומכוון, לא אותה בעיה כמו הקרוסלה.
  const locationKnown = filters.location?.mode === 'current' || filters.location?.mode === 'city' || filters.location?.mode === 'address';

  // carouselLocationKnown (חדש, 2026-09-19, תיקון-באג שאותר בביקורת הארכיטקטונית) - "✨ שווה
  // לגלות" (הקרוסלה, למטה) חייבת שער נפרד מ-locationKnown: אותו שער בדיוק (מבוסס filters.location
  // הטיוטה) היה גורם ל-guest בלי מיקום ידוע לראות את הקרוסלה "נפתחת" (עוברת מכרטיסי-Preview
  // מטושטשים לקרוסלה אמיתית) ברגע שבחר עיר ב"בחירה מהירה", עוד *לפני* לחיצה על "מצאו פעילויות" -
  // אותה בעיית "טיוטה מדליפה לקרוסלה" בדיוק, רק כ-flip של שער-תצוגה במקום שינוי-דירוג. מבוסס
  // homeLocation (המיקום *המחויב*, ראו ההערה המלאה ליד ה-state) - נשאר false (מציג את כרטיסי-
  // ה-Preview המטושטשים) עד commit אמיתי: פתרון-מיקום ראשוני (bootstrap/ברירת-מחדל שמורה/הבחירה
  // הראשונה שהמשתמש עצמו עושה כשעדיין אין מיקום ידוע כלל) או הגשת-חיפוש מפורשת.
  const carouselLocationKnown = homeLocation?.mode === 'current' || homeLocation?.mode === 'city' || homeLocation?.mode === 'address';

  // מקור-אמת יחיד לפתיחת בחירת-מיקום: אותה פונקציה בדיוק עבור צ'יפ "איפה נח לכם?" למעלה וכרטיסי
  // ה-Preview ב"✨ שווה לגלות היום" כש-carouselLocationKnown===false (סעיף 8/9/27 בבקשה) - לא
  // flow geolocation נפרד (כך שהיה קודם ב-handleUseLocationForRecommendations שהוסר) ולא modal
  // חדש. אותו LocationQuickPicker משותף (whereQuickOpen, ראו ה-JSX למטה) - ה-onChange שלו הוא
  // שקובע homeLocation דרך resolveCommittedHomeLocation, לא הפונקציה הזו עצמה.
  const openLocationPicker = () => setWhereQuickOpen(true);

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

  // onChange משותף לשני מופעי ה-LocationQuickPicker (WHERE ב"בחירה מהירה"/כרטיס-Preview נעול,
  // והבהרת-מיקום של חיפוש חופשי, ראו ה-JSX למטה) - תמיד מעדכן את הטיוטה (filters.location, כרגיל),
  // ו*בנוסף* "פותר" את homeLocation דרך resolveCommittedHomeLocation (lib/homeSession.js) אם הוא
  // עדיין null: "פתרון-מיקום ראשוני" (המשתמש עדיין לא היה לו מיקום ידוע כלל - למשל לחיצה על
  // כרטיס-Preview נעול) מחויב מיד; עריכת-טיוטה *אחרי* שכבר יש מיקום-מחויב לא נוגעת בו (ראו
  // ההערה המלאה ליד homeLocation) - זה בדיוק מה ש-prevHome||v עושה.
  const handleLocationFieldChange = (v) => {
    setField('location', v);
    setHomeLocation((prevHome) => resolveCommittedHomeLocation(prevHome, v));
  };

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

  // סדר המערך קובע את סדר-התצוגה ב-filtersRow (flexDirection:'row' רגיל, לא row-reverse - נבדק
  // חזותית בדפדפן, לא רק מהנחת flexDirection): הדף לא forceRTL ברמת ה-layout (רק textAlign/
  // writingDirection ידניים) - 'row' רגיל מתנהג כמו LTR-layout, אז הפריט הראשון במערך יושב
  // משמאל. לכן "where" (איפה?) ראשון -> משמאל, "category" (מה עושים?) שני -> מימין - זו הדרישה
  // (WHAT מימין, WHERE משמאל ב-RTL), לא הפוך.
  // title (2026-09-20, סבב-עידון חזותי שלישי - "TURU home reference mockup") - כותרת-שורה קבועה
  // וקצרה (בדיוק כמו ב-mockup: "מה עושים?"/"איפה?"), מוצגת עכשיו תמיד ליד ה-value (ראו
  // GuidedIntentSegment למעלה) - לא עוד f.label הארוך (whereLabel="איפה נח לכם?"), שנשאר כפי
  // שהיה ומוזן עדיין רק ל-accessibilityLabel (a11yHint/a11yValue nan/label לא נגעו). subtitle
  // (value-line) גם עודכן: ה"ריק" של WHERE עכשיו t('home.guided.whereA11yEmpty')="בחרו מיקום"
  // (היה domain.location.compact.where="איפה?", אותה מחרוזת כמו הכותרת החדשה - היה יוצא כפילות
  // חזותית "איפה? / איפה?"); ה"ריק" של קטגוריה עכשיו t('domain.summary.all')="כל הקטגוריות"
  // (היה home.guided.whatEmpty="מה עושים?", אותה בעיה). שני המפתחות האלה כבר היו קיימים ומוזנים
  // בפועל ל-a11yValue באותו מקום בדיוק - זה רק חושף אותם גם חזותית, לא לוגיקה חדשה.
  const PRIMARY_FILTERS = [
    {
      key: 'where', label: t('home.guided.whereLabel'), title: t('domain.location.compact.where'),
      subtitle: hasChosenLocation ? compactLocationText(filters.location) : t('home.guided.whereA11yEmpty'),
      // a11yValue: התיאור המלא (locationSummary המשותף, לא הגרסה הקומפקטית) - compactLocationLabel
      // כבר לא מאבד מידע סמנטי בפועל, אבל אין סיבה לא לתת ל-screen reader את הניסוח המלא ביותר
      // הקיים כשזה כבר מחושב בכל מקרה.
      a11yValue: hasChosenLocation ? locationSummary(filters.location) : t('home.guided.whereA11yEmpty'),
      a11yHint: t('home.guided.whereHint'),
      active: hasChosenLocation,
      // decorIcon (חדש) - אייקון-PNG אמיתי מ-assets/ (בקשת המשתמש: "יש אייקון של בית - להחליף
      // באיפה") - מוצג בפועל ב-GuidedIntentSegment. decorEmoji (🏡) נשאר בכוונה - עדיין מוזן
      // ל-CompactFilterField (הפקד-הישן, מאחורי SHOW_UNIFIED_GUIDED_SEARCH - לא מוצג כרגע, אבל
      // לא שבור), לא כפילות-מיותרת.
      decorIcon: require('../assets/house-tree.png'), decorEmoji: '🏡', tint: '#e2f5e7', onPress: openLocationPicker,
    },
    {
      key: 'category', label: t('home.guided.whatLabel'), title: t('home.guided.whatEmpty'),
      subtitle: hasSelectedCategory ? compactCategoryLabel(filters.category) : t('domain.summary.all'),
      // a11yValue: כשהתצוגה מכווצת ל-"N סוגי פעילויות" (2+), ה-screen reader עדיין מקבל את
      // הרשימה המלאה של הקטגוריות הנבחרות בפועל - לא רק את המספר.
      a11yValue: filters.category.length > 0 ? listJoin(filters.category.map(categoryLabel)) : t('domain.summary.all'),
      a11yHint: t('home.guided.whatHint'),
      active: hasSelectedCategory,
      // decorIcon (חדש) - אייקון-PNG אמיתי (בקשת המשתמש: "יש אייקון של ג'ירפה - להחליף במה
      // עושים"). decorEmoji (🦒) נשאר לאותה סיבה כמו למעלה (CompactFilterField).
      decorIcon: require('../assets/giraffe.png'), decorEmoji: '🦒', tint: '#fdf3d9', onPress: () => setCategoryQuickOpen(true),
    },
  ];

  const handleGo = async () => {
    let goFilters = filters;
    let goCoords = deviceCoords;

    if (!filters.location?.mode) {
      setLocatingForSearch(true);
      // אותו מודול קנוני כמו goNearMe/LocationQuickPicker.useCurrentLocation - לא GPS גולמי.
      // כישלון מכל סוג (הרשאה/timeout/קואורדינטות) → אותו fallback הקיים בדיוק: פותחים ישר את
      // פיקר המיקום (LocationQuickPicker, כולל "המיקום הנוכחי שלי" - מבקש הרשאה שוב - וגם בחירה
      // ידנית של עיר) בלי הודעת-שגיאה נפרדת, כדי שהמשתמש ישלים את הבחירה במקום אחד.
      const result = await requestCurrentPosition(Location);
      setLocatingForSearch(false);
      if (!result.ok) {
        setWhereQuickOpen(true);
        return;
      }
      goCoords = result.coords;
      goFilters = { ...filters, location: { ...filters.location, mode: 'current', radiusKm: filters.location.radiusKm || 10 } };
      setDeviceCoords(goCoords);
      setFilters(goFilters);
    }

    // homeLocation - commit מפורש (ראו ההערה המלאה ליד ה-state): "מצאו פעילויות" הוא בדיוק
    // הרגע שבו טיוטת "בחירה מהירה" (goFilters.location, בין אם הייתה כבר ב-filters ובין אם
    // נפתרה הרגע דרך GPS למעלה) הופכת ל"מיקום מחויב" חדש עבור קרוסלת-הגילוי - לא guard, דריסה
    // ישירה (זו פעולת-הגשה מפורשת, לא עדכון-רקע).
    setHomeLocation(goFilters.location);

    router.push({
      pathname: '/activities',
      params: buildResultsParams({ filters: goFilters, coords: goCoords, childAges: childAgesForSearch }),
    });
  };

  const handleAdvancedFilters = () => {
    router.push({
      pathname: '/activities',
      params: buildResultsParams({
        filters, coords: deviceCoords, childAges: childAgesForSearch, extra: { openFilters: 'true' },
      }),
    });
  };

  // "⚡ עכשיו" (בקשת המשתמש 2026-09-16): הטריגר עבר לכאן ממסך התוצאות, למשתמשים מחוברים
  // בלבד (ראו הקישור המותנה ב-userId למטה) - הלוגיקה עצמה (GPS/הרשאה/דירוג) לא זזה בכלל,
  // עדיין גרה במלואה ב-app/activities.js (toggleSpontaneous) ומופעלת שם דרך route param
  // spontaneous=true, אותו דפוס param בדיוק כמו openFilters/view למעלה.
  const handleSpontaneous = () => {
    router.push({
      pathname: '/activities',
      params: buildResultsParams({
        filters, coords: deviceCoords, childAges: childAgesForSearch, extra: { spontaneous: 'true' },
      }),
    });
  };

  // מבצע בפועל את בקשת ה-GPS (אחרי שההרשאה כבר קיימת, או שאושרה הרגע דרך המודל למטה) ומנווט
  // ל-/activities. filters נבנה מ-DEFAULT_FILTERS נקי (לא filters של Home) עם location.mode:
  // 'current' בלבד - קטגוריה/גיל/וכו' נשארים ריקים בכוונה ("ALL activity categories", סעיף 6).
  // nearMe:'true' הוא ה-param היחיד שדורש קוד ב-activities.js (קובע sortMode:'distance' פעם
  // אחת ב-mount, בדיוק כמו spontaneous/view) - location.mode:'current'+radiusKm:10 כבר עצמם
  // גורמים ל-Smart Radius/דירוג-מרחק/matchesLocation הקיימים לפעול, בלי לגעת ב-lib/filterActivities.js.
  // איתור בפועל (2026-09-19, בקשת המשתמש: "using the recently hardened current-position logic") -
  // requestCurrentPosition/lib/currentPosition.js, אותו מודול קנוני ש-LocationQuickPicker.useCurrentLocation
  // כבר משתמש בו (timeout 20s + ולידציית-קואורדינטות, לא רק try/catch גולמי) - לא מימוש-GPS שני.
  // קריאה חוזרת ל-requestForegroundPermissionsAsync כאן בטוחה: ברגע ש-goNearMe נקרא (משני
  // הקוראים שלה למטה) ההרשאה כבר ידועה כ-granted, אז הבקשה חוזרת מיד בלי לבקש שוב מהמשתמש.
  const goNearMe = async () => {
    if (nearMeInFlightRef.current) return;
    nearMeInFlightRef.current = true;
    setNearMeLoading(true);
    setNearMeError('');
    try {
      const result = await requestCurrentPosition(Location);
      if (!result.ok) {
        // הרשאה קיימת אבל איתור בפועל נכשל (GPS כבוי/timeout/קואורדינטות לא שמישות) - לא מנווטים
        // עם קואורדינטות מזויפות; שגיאה שקטה עם "נסו שוב"/"בחרו עיר במקום" (LocationQuickPicker הקיים).
        setNearMeError(CURRENT_POSITION_ERROR_KEYS[result.error]);
        return;
      }
      // radiusKm: null (היה 10, 2026-09-20 "CENTRAL RADAR update") - "מה קרוב?" הוא shortcut-
      // גילוי ("הכי קרוב אליי עכשיו"), לא בורר-רדיוס: matchesLocation (lib/filterActivities.js)
      // מתעלם לגמרי ממרחק כש-radiusKm הוא null/undefined (אותה טכניקה כמו locationWithNoTravelPreference
      // ב-LocationQuickPicker), אז כל הפעילויות המאושרות זכאיות - בלי לפסול תוצאה רחוקה בטעות
      // רק כי היא מעבר ל-10/15 ק"מ. app/activities.js (nearMe==='true') הוא זה שממיין לפי מרחק
      // וחותך ל-50 הקרובות ביותר בפועל (ראו sortedActivities שם) - "50 תוצאות" הוא תקרת-כמות,
      // לא רדיוס גיאוגרפי חדש.
      const nearMeFilters = {
        ...DEFAULT_FILTERS,
        location: { ...DEFAULT_FILTERS.location, mode: 'current', radiusKm: null },
      };
      router.push({
        pathname: '/activities',
        params: buildResultsParams({
          filters: nearMeFilters, coords: result.coords, childAges: childAgesForSearch, extra: { nearMe: 'true' },
        }),
      });
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
    // homeLocation - commit מפורש (ראו ההערה המלאה ליד ה-state): לחיצה על shortcut-גילוי היא
    // עצמה פעולת-הגשה (נכנסים ישר לתוצאות), אז filters.location הנוכחי (תמיד truthy כאן - שני
    // הקוראים בודקים locationKnown קודם) הופך למיקום-מחויב עבור הקרוסלה, בדיוק כמו handleGo.
    setHomeLocation(filters.location);
    router.push({
      pathname: '/activities',
      params: buildResultsParams({
        filters: { ...DEFAULT_FILTERS, category: [category], location: filters.location },
        coords: deviceCoords,
        childAges: childAgesForSearch,
      }),
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
    // כמו כל שאר הניווטים מהבית (handleAdvancedFilters/handleSpontaneous/navigateToCategoryResults):
    // מסך התוצאות מקבל את נקודת ה-GPS רק מכאן, ובלעדיה "השתמשו במיקום שלי" בבורר לא היה מסנן לפי
    // מרחק. בטוח ל"בלי מיקום": distanceScore/searchOriginCoords קוראים deviceCoords רק במצב 'current'.
    const params = buildResultsParams({
      filters: builtFilters,
      coords: resolveSmartSearchCoords(builtFilters, deviceCoords),
      childAges: childAgesForSearch,
      coordsMode: 'omit-if-absent',
    });
    // homeLocation - commit מפורש (ראו ההערה המלאה ליד ה-state): חיפוש-חכם מוגש הוא גם-כן פעולת-
    // הגשה, בדיוק כמו handleGo/navigateToCategoryResults. builtFilters.location (לא filters.location
    // הטיוטה) - המיקום *בפועל* שישמש את החיפוש הזה (למשל עיר שזוהתה מהטקסט החופשי עצמו), לא
    // בהכרח זהה לערך שעדיין יושב ב"איפה?" הבלתי-מוגש.
    setHomeLocation(builtFilters.location);
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

  // כרטיס-חיפוש דו-מצבי (2026-09-19, בקשת המשתמש: "submission uses the ACTIVE MODE's intended
  // inputs" - סעיף 22) - נקודת-כניסה אחת ל-CTA וגם ל-Enter מהמקלדת, בלי handler כפול. לפני הסבב
  // הזה ההכרעה הייתה לפי "יש טקסט מוקלד?" (heuristic טקסט-מנצח כי שני הקלטים תמיד היו גלויים
  // יחד); עכשיו יש בורר-מצב מפורש, אז ההכרעה לפי המצב הפעיל עצמו - לא לפי מה שנשאר בשדה-טקסט
  // מוסתר משהייה קודמת במצב האחר (זה בדיוק מה שסעיף 22 הזהיר מפניו: "switching back to guided
  // mode should not accidentally submit a hidden free-text q"). handleSmartSearch/handleGo עצמם
  // ללא שינוי - עדיין אותו צינור-AI/מסלול-מודרך בדיוק, כולל fallbackCategory/fallbackLocation
  // הקיימים ב-goToSmartSearchResults (למעלה) - ראו ההערה המלאה שם: המצב המובנה (WHAT/WHERE)
  // עדיין משפיע על תוצאות "חיפוש חופשי" כערוץ-גיבוי, אפילו כשהוא מוסתר במצב הזה - זו התנהגות
  // קיימת/מכוונת מלפני הסבב הזה (a609e5b ואילך: "טקסט מפורש מנצח, אחרת נופלים לבחירה המובנית"),
  // לא לוגיקת-מיזוג חדשה - לא שיניתי אותה כאן, רק מדווח עליה בדוח הסיכום כמבוקש (סעיף 22/46).
  const handleActiveModeSearch = () => {
    if (searchMode === 'free') { handleSmartSearch(); return; }
    handleGo();
  };

  // --- ✨ המלצות מותאמות (קרוסלה אופקית) ---
  const recNotesByActivity = useMemo(() => new Map(recNotes.map((n) => [n.activity_id, n.note])), [recNotes]);

  // carouselFilters (חדש, 2026-09-19, תיקון-באג שאותר בביקורת הארכיטקטונית: "the discovery
  // carousel currently ranks using the same `filters` object used by Quick Choice... opening
  // Quick Choice and changing category/location before pressing 'מצאו פעילויות' must not
  // re-rank the carousel") - buildCarouselFilters (lib/homeSession.js) מפריד את קלט-הדירוג של
  // הקרוסלה מהטיוטה החיה: category תמיד [] (לא "קרוסלת-מוזיאונים זמנית" רק כי זה מה שנבחר עכשיו
  // ב"מה עושים?" הבלתי-מוגש), location מגיע מ-homeLocation (המיקום *המחויב*, לא filters.location
  // הטיוטה - ראו ההערה המלאה ליד ה-state). שאר השדות (age/when/hour/וכו') ממשיכים לבוא מ-filters
  // כרגיל - הם לא ניתנים לעריכה מיידית מתוך Home (ראו ההערה המלאה ב-lib/homeSession.js).
  const carouselFilters = useMemo(
    () => buildCarouselFilters(filters, homeLocation, DEFAULT_FILTERS.location),
    [filters, homeLocation]
  );

  // rankActivitiesWithSmartRadius (היה rankActivities הפשוט) - ראו ההערה המלאה ליד
  // settlementCoords/searchOriginCoords למעלה: מוסיף בדיוק את שלב-ההרחבה שהיה חסר (10/15 ק"מ
  // מ-searchOriginCoords כשיש פחות מ-10 תוצאות בהתאמת-שם-עיר ראשונית), אותו מנגנון-קיים-ומאומת
  // בדיוק כמו app/activities.js - לא לוגיקת-הרחבה חדשה. מחזירה אובייקט {activities, resultCount,
  // radiusExpanded, effectiveRadiusKm} ולא מערך ישירות - `.activities` בלבד נחוץ כאן (הקרוסלה לא
  // מציגה חיווי "הורחב הרדיוס", בניגוד לעמוד-התוצאות המלא). carouselFilters (לא filters הטיוטה) -
  // ראו ההערה המלאה למעלה.
  const recommendations = useMemo(() => (
    rankActivitiesWithSmartRadius(recActivities, carouselFilters, deviceCoords, excludedCategories, benefitClubs, excludedCities, null, searchOriginCoords, excludedRegions)
      .activities
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
  ), [recActivities, carouselFilters, deviceCoords, excludedCategories, benefitClubs, excludedCities, excludedRegions, searchOriginCoords, recHiddenIds, recFavoriteIds, recVisitedIds, recNotesByActivity, locale, childAgesForSearch]);

  // 4 הפעילויות הראשונות מתוך recommendations - מוזנות לכרטיסים המטושטשים (LocationPromptCard/
  // LockedPreviewCard) כש-carouselLocationKnown===false. אותו מקור-נתונים בדיוק כמו הקרוסלה הרגילה -
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

  // כרטיס-חיפוש דו-מצבי: CTA יחיד למודול (מוצג תמיד, בין אם guided ובין אם free - לא מותנה, כדי
  // שלא יגרום ל-layout shift). התוקף/הטקסט/הפעולה תלויים במצב הפעיל בלבד (searchMode) - לא
  // בטקסט שהוקלד בעבר במצב אחר (סעיף 22/23/24 בבקשה - "ONE ACTIVE MODE = ONE PRIMARY CONTROL").
  // onPress=handleActiveModeSearch: אותה נקודת-כניסה שמשמשת גם את onSubmitEditing של שדה הטקסט
  // (Enter, רק קיים במצב free ממילא) - אין handler כפול.
  const activeCtaDisabled = smartSearchLoading || locatingForSearch
    || (searchMode === 'free' ? !smartSearchText.trim() : !canSubmitGuidedSearch);
  const unifiedCtaButton = (
    <Pressable
      style={[styles.smartSearchBtn, styles.smartSearchBtnFullWidth, activeCtaDisabled && styles.smartSearchBtnDisabled]}
      onPress={handleActiveModeSearch}
      disabled={activeCtaDisabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: activeCtaDisabled }}
    >
      {smartSearchLoading || locatingForSearch ? (
        <ActivityIndicator color="#ffffff" size="small" />
      ) : (
        // חץ (2026-09-20, סבב-עידון רביעי - בקשת המשתמש: "צריך להיות בדיוק הפוך, מימין לשמאל,
        // וצריך להיות אחרי המשפט, לא לפני") - היה קודם ← אחרי-הטקסט-פיזית-בקצה-הימני (כיוון "→",
        // שקורא כ"לפני" הטקסט כשסורקים RTL - התחלה=ימין). עכשיו הפוך: החץ עצמו מצביע ← (כיוון-
        // הקריאה בעברית) והוא פיזית בקצה השמאלי - "אחרי" הטקסט בסדר-הקריאה (שמתחיל בימין, איפה
        // שהטקסט יושב עכשיו). View פיזי (flexDirection:'row', לא d.row) עם שני Text נפרדים, בסדר
        // [חץ, טקסט] - כך החץ תמיד פיזית-משמאל והטקסט תמיד פיזית-מימין, בכל שפה/כיוון.
        <View style={styles.smartSearchBtnRow}>
          <Text style={styles.smartSearchBtnArrow}>←</Text>
          <Text style={styles.smartSearchBtnText}>{t(searchMode === 'free' ? 'home.search.ctaFree' : 'home.search.cta')}</Text>
        </View>
      )}
    </Pressable>
  );

  // מה שהיה כאן nearMeStandaloneAction (בקר-רדאר עצמאי, מעל כרטיס-החיפוש) פורק ושולב ישירות
  // בתוך heroRow ב-JSX הראשי למטה (2026-09-20, "TURU home reference mockup" - הרדאר עכשיו עמודת-
  // המרכז של שורה תלת-חלקית, לא בלוק נפרד מעליה) - כל הלוגיקה (handleNearMePress/nearMeLoading/
  // nearMeError/nearMePressIn/Out) עדיין בשימוש-חוזר מלא ובלי שום שינוי, רק ה-JSX-מארז זז.

  // מודל-הסבר לפני בקשת הרשאת המערכת (סעיף 11/8) - לא קופצת ישר בקשת הרשאה של המערכת בלי הקשר.
  // אותו דפוס Modal+Pressable-backdrop+כרטיס בדיוק כמו activities.js (gateBackdrop/gateCard)
  // ו-LoginRequiredModal. יושב מחוץ ל-ScrollView (כמו שאר ה-Modal-ים בעמוד) - Modal הוא portal,
  // המיקום ב-JSX לא משפיע על היכן הוא מצטייר.
  const nearMeExplainerModal = (
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
  );

  return (
    <View style={styles.screen}>
      <SkyBackground />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Header onMenuPress={() => {}} />

        {/* 🧭 הירו - כותרת "לאן קופצים היום?"+קו-מבטא+שורת-הירו התלת-חלקית (חיפוש חופשי |
            רדאר "מה קרוב?" | בחירה מהירה). PHASE 1 EXTRACTION (2026-09-19, "safe presentational
            extraction" - ראו הביקורת הארכיטקטונית): הועבר byte-for-byte ל-components/HomeHero.js
            (עם NearMeRadar המקונן, components/NearMeRadar.js) - שום שינוי חזותי/state-ownership,
            רק ה-JSX/סטיילים-הפנימיים עברו לקובץ נפרד. כל ה-state/handlers (searchMode/heroCompact/
            nearMeLoading/nearMeError/nearMePressScale/switchSearchMode/handleNearMePress/
            nearMePressIn/Out/setWhereQuickOpen) עדיין גרים ב-HomeScreen בלי שום שינוי - מוזנים
            כ-props בלבד. ראו app/index.js (גרסה קודמת בהיסטוריית git) או components/HomeHero.js
            להסבר המלא על כל אחד מהם. */}
        <HomeHero
          searchMode={searchMode}
          onSwitchMode={switchSearchMode}
          heroCompact={heroCompact}
          nearMeLoading={nearMeLoading}
          nearMeError={nearMeError}
          nearMePressScale={nearMePressScale}
          onNearMePress={handleNearMePress}
          onNearMePressIn={nearMePressIn}
          onNearMePressOut={nearMePressOut}
          onChooseCityInstead={() => setWhereQuickOpen(true)}
        />

        {/* כרטיס-חיפוש דו-מצבי (2026-09-19, בקשת המשתמש: "ONE USER INTENTION = ONE CLEAR PATH" -
            progressive disclosure). מוצג רק כש-searchMode !== null (2026-09-20, "TURU home
            reference mockup" סעיף 5/6/7 - "INTENTIONAL DEVIATION #2": במצב ההתחלתי אף מצב לא
            נבחר, ואין כרטיס/פאנל מוצג כלל, עד בחירה מפורשת בשורת-הירו מעל). בורר-המצב עצמו
            (searchModeRow הישן) הוסר מכאן - הבחירה עכשיו קורית אך ורק בשתי הפעולות הצדדיות
            בשורת-הירו. ה-CTA (unifiedCtaButton) עדיין יחיד ותמיד באותו מיקום יחסי (תחתית הכרטיס).*/}
        {searchMode ? (
        <View style={styles.smartSearchCard}>
          {searchMode === 'free' ? (
            <>
              <Text style={styles.searchFreeLabel}>{t('home.search.freeLabel')}</Text>
              <View style={styles.smartSearchInputWrap}>
                <SearchIcon />
                <TextInput
                  ref={searchInputRef}
                  style={styles.smartSearchInput}
                  placeholder={t('home.search.placeholder')}
                  placeholderTextColor={colors.textMuted}
                  value={smartSearchText}
                  onChangeText={setSmartSearchText}
                  onSubmitEditing={() => handleSmartSearch()}
                  onFocus={() => { clearSearchBlurTimeout(); setSearchFocused(true); }}
                  onBlur={() => { searchBlurTimeoutRef.current = setTimeout(() => setSearchFocused(false), 150); }}
                  returnKeyType="search"
                  editable={!smartSearchLoading}
                />
              </View>

              {smartSearchError ? <Text style={styles.smartSearchErrorText}>{smartSearchError}</Text> : null}

              {searchFocused && !smartSearchText.trim() && recentSearches.length > 0 ? (
                // dropdown תלוי-פוקוס, רק בתוך מצב "חיפוש חופשי" (סעיף 19 בבקשה: לא מוצג כלל
                // ב"בחירה מהירה") - ראו הערה מלאה ליד searchFocused/clearSearchBlurTimeout למעלה.
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
            </>
          ) : isPersonalized ? (
            // "למי מחפשים היום?" - guided-mode-content עבור משתמש מחובר עם ילדים, מקונן עכשיו
            // בתוך אותו smartSearchCard (bare, ראו PersonalPicker) - לא כרטיס נפרד מתחתיו.
            <PersonalPicker kids={children} selectedChildIds={selectedChildIds} onToggleChild={toggleChild} bare />
          ) : (
            // WHAT+WHERE - שני מימושים חיים זה-לצד-זה לצורך השוואה חזותית, SHOW_UNIFIED_GUIDED_SEARCH
            // בראש הקובץ בוחר איזה מוצג (ראו ההערה המלאה ליד הדגל). ללא שינוי בעצם הבחירה הזו.
            SHOW_UNIFIED_GUIDED_SEARCH ? (
              <GuidedSearchIntentControl fields={PRIMARY_FILTERS} />
            ) : (
              <View style={styles.filtersRow}>
                {PRIMARY_FILTERS.map((f) => (
                  <CompactFilterField key={f.key} f={f} onPress={f.onPress} />
                ))}
              </View>
            )
          )}
          {searchMode !== 'free' ? extraFiltersBlock : null}
          {unifiedCtaButton}
        </View>
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

        {/* קרוסלת-הגילוי האופקית: כרטיס גדול + "הצצה" לכרטיס הבא, לא גריד. carouselLocationKnown
            (לא locationKnown - ראו ההערה המלאה ליד ה-state, תיקון-הפרדה מטיוטת "בחירה מהירה")
            קובע רק מה מוצג בתוכה: כרטיסי-Preview עם פעילויות אמיתיות מהמאגר (recommendations, אותו מקור-
            נתונים בדיוק כמו הקרוסלה הרגילה) אבל מטושטשות (BlurView), כשאין מיקום, אחרת הקרוסלה
            הרגילה הלא-מטושטשת. הכותרת ("✨ שווה לגלות") הוסרה (2026-09-19, בקשת המשתמש: "תמחק
            את 'שווה לגלות'... רק את הכותרת") - recSectionHeaderRow/recSectionTitle/recHeaderTitle
            הוסרו איתה; recCarouselWrap.marginTop למטה שומר על מרווח סביר במקום המרווח+הכותרת
            שהיו כאן קודם. */}
        <View style={styles.recCarouselWrap}>
          {!carouselLocationKnown ? (
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
            <Text style={styles.sectionTitle}>{t('home.discovery.title')}</Text>
          </View>
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

        {/* קישור-מעבר ל"מסך הבית 2" הוסר (2026-09-19, תיקון-באג שאותר בביקורת הארכיטקטונית:
            "/home2 is a live Expo Router route... reachable... not a real product path... We do
            not want /home2 to remain part of the product") - app/home2.js עצמו הועבר (byte-for-
            byte, לא נמחק) ל-components/_archived/home2.js, אותו דפוס-שימור בדיוק כמו
            components/_archived/SunMascot.js - קובץ מחוץ ל-app/ אינו route של expo-router
            (file-based routing), אז /home2 כבר לא נגיש כלל, לא רק "בלי לינק גלוי". */}
        <GrassFooter width={contentWidth} />
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
        onChange={handleLocationFieldChange}
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
        onChange={handleLocationFieldChange}
        onCoordsResolved={setDeviceCoords}
        onConfirm={handleClarifyConfirm}
        onClose={handleClarifyDismiss}
        deviceCoords={deviceCoords}
      />
      <LoginRequiredModal visible={showLoginPrompt} onClose={() => setShowLoginPrompt(false)} />
      {nearMeExplainerModal}
    </View>
  );
}

const styles = createStyles((d) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  // paddingBottom:0 - איור הדשא (GrassFooter) הוא האלמנט האחרון והוא צריך להיגמר בדיוק מעל
  // סרגל-הניווט התחתון, בלי רצועה ריקה מתחתיו. maxWidth+alignSelf:'center' (2026-09-19, בקשת
  // המשתמש: "do not allow the Home search card to become absurdly wide merely because the
  // viewport is 1280px") - שום מסך אחר בפרויקט לא הגדיר עדיין תקרת-רוחב לתוכן (נבדק: אין
  // maxWidth ברמת-container דומה בשום מקום אחר), אז זו התקרה הראשונה מסוגה, לא reuse של דפוס
  // קיים. CONTENT_MAX_WIDTH (למעלה) גם מוזן ל-GrassFooter במקום windowWidth הגולמי, כדי שהאיור
  // ימשיך להתאים בדיוק לרוחב-בפועל של התוכן, לא לרוחב המסך המלא מעליו.
  content: { padding: spacing.xl, paddingBottom: 0, width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' },
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

  // GuidedSearchIntentControl (2026-09-20, סבב-עידון שישי, בקשת המשתמש: "should visually read
  // as TWO separate rounded selection fields... DO NOT use only a horizontal divider" - guidedIntentControl
  // עצמו כבר לא נושא bg/border/radius משלו, רק gap בין שני GuidedIntentSegment עצמאיים - כל אחד
  // מהם עכשיו שדה מעוגל ונפרד בזכות עצמו (ראו guidedIntentSegment למטה).
  // marginHorizontal:-6 (חדש) - בקשת המשתמש: "שני הפילטרים... יותר ארוכים לצדדים" - מרחיב את
  // שתי שורות מה-עושים/איפה מעט מעבר לריפוד הרגיל של smartSearchCard (16), בלי לגעת בכפתור
  // "מצאו פעילויות" שמתחת (נשאר ברוחב-התוכן הרגיל של הכרטיס).
  guidedIntentControl: { gap: 8, marginBottom: 14, marginHorizontal: -6 },
  // כל שורה - שדה-בחירה מעוגל עצמאי (לא עוד משטח-אחד+חוצץ-דק) - bg/border/radius עכשיו כאן,
  // לא ב-guidedIntentControl. flexDirection:'row' פיזי (לא d.row) - ראו ההערה המלאה ליד
  // GuidedIntentSegment למעלה: [אייקון][עמודת-טקסט flex:1][chevron], בסדר-JSX הזה בדיוק, כך
  // שהאייקון תמיד פיזית-משמאל וה-chevron תמיד פיזית-מימין בלי קשר לכיוון-הקריאה. paddingHorizontal
  // 16 כדי שיתאים לשדה-בעל-מסגרת אמיתי, לא רק שורה בתוך קופסה חיצונית. גובה הוקטן שוב (48, היה
  // 60/68/76; paddingVertical 6, היה 8/11/14) - בקשת המשתמש: "פחות גבוהות... ויותר ארוכות" +
  // "החלק הלבן... צריך להיות כולו יותר קטן, פרופורציונלית, ביחס לכפתורים [הצדדיים]".
  // backgroundColor: colors.card/#fff (חזרה מ-colors.bg שנוסה בסבב קודם) - בקשת המשתמש: "תוריד
  // את הצבע ברקע של הקוביות... שהפס הקטן מסביב ישאר אבל בפנים יהיה צבע לבן לגמרי כמו הרקע" -
  // לבן זהה בדיוק לרקע smartSearchCard החיצוני (שגם הוא colors.card), רק ה-border (borderLight)
  // ממשיך לתחום את השורה חזותית.
  // paddingVertical:4/minHeight:42 (היה 6/48) + paddingHorizontal:10 (היה 14) - בקשת המשתמש:
  // "יותר דחוסים מלמעלה אבל יותר ארוכים לצדדים" - עוד סבב באותו כיוון שכבר אושר (ראו ההערה
  // למעלה), יחד עם guidedIntentControl.marginHorizontal:-6 להרחבה הפיזית.
  guidedIntentSegment: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.borderLight, borderRadius: radii.lg,
    paddingVertical: 4, paddingHorizontal: 10, minHeight: 42,
  },
  // Image אמיתי (assets/giraffe.png / assets/house-tree.png, היה אמוג'י-Text 🦒/🏡). בלי chip
  // צבוע מסביב, תמיד בקצה הפיזי-שמאלי (ראו ההערה המלאה למעלה). 42px (היה 36/30) - בקשת המשתמש:
  // "תגדיל עוד את האייקונים של הג'ירפה והבית".
  // 46x46 (היה 42x42) - בקשת המשתמש: "האימוג'י מולם צריך להיות קצת יותר גדול" (יחד עם הקטנת
  // הטקסט לצדו, ראו guidedIntentTitle/guidedIntentValue למטה).
  guidedIntentIconImage: { width: 46, height: 46, flexShrink: 0 },
  // gap: 0 (היה 3) - בקשת המשתמש: "'מה עושים' ו'הכל' צריכים להיות יותר צמודים... כנ"ל 'איפה'/
  // 'ינוב'" - חל על שתי השורות (guidedIntentTitle/Value משותפים לשתיהן, לא סטייל נפרד לכל שורה).
  guidedIntentSegmentMain: {
    flex: 1, minWidth: 0, gap: 0,
  },
  // ChevronLeftIcon מצביע שמאלה = "קדימה/פותח בורר" בעברית; באנגלית מסתובב ימינה. המיקום שלו
  // בשורה (פיזית-ימני, ראו guidedIntentSegment) לא קשור לכיוון שהוא מצביע אליו. paddingLeft קטן
  // ("comfortable padding around it... don't let it compete with the text") - מרווח נוסף מהטקסט
  // מעבר ל-gap הכללי של השורה.
  guidedIntentChevron: { transform: [{ rotate: d.forwardRotate }], flexShrink: 0, paddingLeft: 2 },
  // כותרת-שורה קבועה (guidedIntentTitle) + ערך (guidedIntentValue) - שתי שורות מוערמות בתוך
  // guidedIntentSegmentMain, שתיהן מיושרות d.textAlign (ימין בעברית - "צמודות" ל-chevron
  // הפיזי-ימני, ראו ה-mockup). בקשת המשתמש (spec מדויק): כותרת ~21px/700/lineHeight 25, ערך
  // ~16px/400/lineHeight 21 - fontFamily נשאר turu (fonts.bold/fonts.regular - אותם קבצי-גופן
  // קיימים, לא גופן חדש), רק מידות/משקל/line-height/מרווח שונו בהתאם למפרט.
  // 18/21 (היה 19/23) - בקשת המשתמש: "'מה עושים' פונט מעט קטן יותר... כנ"ל 'איפה'" - עוד הקטנה
  // קלה, נוסף לגיבוב-כיווני "דחיפה למטה" (יחד עם lineHeight המצומצם - ראו guidedIntentSegmentMain
  // gap:0 - התווית כולה יורדת ומתקרבת לערך שמתחתיה).
  guidedIntentTitle: { fontFamily: fonts.bold, fontSize: 18, lineHeight: 21, color: colors.textPrimary, textAlign: d.textAlign },
  // #8A9097 (היה colors.textSecondary/#59656d) - בקשת המשתמש: hex מדויק לצבע הערך המשני
  // ("כל הקטגוריות"/"עד 15 דק' ממני"), שונה מטוקן-האפור הכללי הקיים.
  // 15.5/18 (היה 14.5/19) - בקשת המשתמש: "'הכל' פונט מעט גדול יותר... כנ"ל 'ינוב'" - lineHeight
  // גם ירד קמעה (19→18) כך שהערך "עולה למעלה" ומתקרב לכותרת שמעליו (gap:0 ב-guidedIntentSegmentMain).
  guidedIntentValue: { minWidth: 0, fontFamily: fonts.regular, fontSize: 15.5, lineHeight: 18, color: '#8A9097', textAlign: d.textAlign },
  personalCard: {
    backgroundColor: colors.card, borderRadius: radii.xl, borderWidth: 1, borderColor: colors.borderLight,
    padding: 16, marginBottom: 18,
  },
  // גרסת bare (ראו PersonalPicker) - בלי רקע/border/radius/padding משלה, smartSearchCard כבר נותן
  // את כל אלה; marginBottom קטן יותר כי extraFiltersBlock/ה-CTA שמתחת כבר בתוך אותו כרטיס.
  personalCardBare: { marginBottom: 10 },
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
  ageAddRow: { alignItems: 'center', marginBottom: 18 },
  extraFiltersWrap: { alignItems: 'center' },
  ageAddText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textMuted },
  ageAddTextActive: { color: colors.accent, fontFamily: fonts.bold },
  saveDefaultLink: { alignItems: 'center', marginBottom: 14 },
  saveDefaultText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.accent },
  defaultNoticeText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.greenStrong, textAlign: 'center', marginBottom: 10 },
  // מודל-הסבר: אותם טוקנים בדיוק כמו LoginRequiredModal (colors.card/radii.xl/fonts.extraBold),
  // כדי שהוא יראה כמו חלק מאותה "שפת מודלים" קיימת ולא רכיב חדש.
  nearMeModalBackdrop: { flex: 1, backgroundColor: 'rgba(20,30,35,0.4)', justifyContent: 'center', padding: spacing.xl },
  nearMeModalCard: { backgroundColor: colors.card, borderRadius: radii.xl, padding: spacing.xl, alignItems: 'center' },
  nearMeModalTitle: { fontFamily: fonts.extraBold, fontSize: 17, color: colors.textPrimary, textAlign: 'center', marginBottom: 8 },
  nearMeModalBody: { fontFamily: fonts.regular, fontSize: 13.5, color: colors.textSecondary, textAlign: 'center', lineHeight: 19, marginBottom: 18 },
  nearMeModalPrimaryBtn: { backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 12, paddingHorizontal: 28 },
  nearMeModalPrimaryBtnText: { fontFamily: fonts.bold, fontSize: 14, color: '#fff' },
  nearMeModalSecondaryText: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.textSecondary, marginTop: 12 },
  // כרטיס-חיפוש דו-מצבי: משטח-white אחד (לא שני כרטיסים), מוצג רק כש-searchMode !== null (ראו
  // ה-JSX - הבחירה עצמה עברה לגמרי ל-heroRow מעל). הכותרת עצמה מחוץ לכרטיס (searchModuleTitle
  // למעלה). border/shadow עדינים (לא מסגרת accent עבה) כדי שהכרטיס יתבלוט בעדינות בלי להרגיש כבד.
  // padding/borderRadius/marginTop/shadow הוגדלו בסבב-העידון השלישי (בקשת המשתמש: "feels too
  // compressed and generic... should feel like a substantial floating search module") - עדיין
  // "לא גבוה מיותר", רק נדיב יותר. marginTop קטן מפריד אותו מכיתוב-המרחק בלי לגעת בו (heroRow/
  // heroDistanceRow עצמם, שנשארו ללא שינוי-מבני).
  // marginHorizontal:-10 (חדש, סבב-עידון תשיעי, בקשת המשתמש: "החלון... צריך להיות יותר רחב,
  // מתוח לצדדים... ולרקע הלבן... לתת עוד קצת אורך") - הכרטיס "דולף" מעט מעבר לריפוד הרגיל של
  // content (spacing.xl=22 בכל צד, ראו styles.content למטה), בלי לגעת בריפוד הגלובלי הזה עצמו
  // (שממשיך לשמש את הכותרת/שורת-הירו מעליו) - רק הכרטיס הזה מתרחב מעט לצדדים.
  // padding 16/borderRadius 22 (היה 22/26) - בקשת המשתמש: "החלק הלבן... צריך להיות כולו יותר
  // קטן, פרופורציונלית, ביחס לכפתורים [הצדדיים]" - לא רק השורות/הכפתור בפנים (guidedIntentSegment/
  // smartSearchBtn למטה), גם המעטפת החיצונית עצמה מתכווצת מעט בהתאם. marginTop/marginBottom/
  // marginHorizontal לא נגעו - אלה מיקום/מרווחים-מהעמוד, לא הפרופורציה הפנימית של הכרטיס עצמו.
  // marginBottom: 0 (היה 16) - בקשת המשתמש: "2 הכותרות... צריך שהן יהיו בדיוק באמצע בין מה
  // שמעליהן לבין מה שמתחתיהן". נמדד בפועל בדפדפן: ה-padding הפנימי של הכרטיס עצמו (16, למטה)
  // כבר תורם 16px גלויים מתחת ל-CTA לפני שמגיעים לקצה-הכרטיס - marginBottom נוסף מעליו היה
  // מכפיל את המרווח ("above") הרבה מעבר ל-"below" (sectionHeaderRow.marginBottom, ראו שם).
  // הריפוד הפנימי (16) נשאר המקור היחיד למרווח-הבסיס כאן, ו-sectionHeaderRow תואם אותו בדיוק.
  smartSearchCard: {
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.accentTintLight,
    // marginTop:2 (היה 6) - חלק מאותה בקשה (heroRow.marginBottom למעלה) - עוד צמצום-מרווח קטן
    // בין שורת-הירו לכרטיס-הפילטרים.
    borderRadius: 22, padding: 16, marginHorizontal: -10, marginTop: 2, marginBottom: 0,
    shadowColor: colors.accent, shadowOpacity: 0.1, shadowRadius: 18, shadowOffset: { width: 0, height: 6 }, elevation: 3,
  },
  // "חפשו במילים שלכם" - תווית-כוונה קטנה מעל שדה הטקסט, קיימת רק במצב "חיפוש חופשי" (מלמדת
  // "אפשר סתם לתאר מה שרוצים", בלי לחזור על "או בחרו" הישן שכבר לא רלוונטי - הבורר עצמו מעליה
  // כבר עשה את הבחירה בין המצבים).
  searchFreeLabel: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.textSecondary, textAlign: d.textAlign, marginBottom: 8 },
  // כרטיס-חיפוש: שדה הטקסט הוא הקלט היחיד בשורה הזו (אין יותר כפתור "חיפוש" לצידו) - ה-pill/
  // border/bg יושבים כאן כדי שאייקון-החיפוש יישב "בתוך" השדה חזותית, לא ליד שדה נפרד. row: אייקון
  // ראשון בכיוון-הקריאה, TextInput ממלא את השאר. marginBottom נותן את המרווח הבסיסי לפני מה
  // שמתחת (שגיאה/חיפושים אחרונים).
  smartSearchInputWrap: {
    flexDirection: d.row, alignItems: 'center', gap: 6, marginBottom: 16,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.pill, paddingHorizontal: 14,
  },
  smartSearchInput: {
    flex: 1, paddingVertical: 12,
    fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, textAlign: d.textAlign, writingDirection: d.writingDirection,
  },
  // paddingVertical 12 (היה 18) - בקשת המשתמש: "כפתור 'מצאו פעילויות' צריך להיות יותר נמוך
  // (פרופורציה, לא מיקום)" + "החלק הלבן... כולו יותר קטן ביחס לכפתורים [הצדדיים]".
  // colors.accent (חזרה מ-'#006786' המותאם-אישית מהסבב הקודם) - בקשת המשתמש המפורשת: "הצבע של
  // הכפתור 'מצאו פעילויות' צריך להיות בדיוק אותו צבע כמו הכפתור המרכזי [הרדאר]" - הרדאר משתמש
  // ב-colors.accent (ראו NearMeRadar למעלה בקובץ), אז חזרה לאותו טוקן בדיוק כאן, לא גוון קרוב.
  smartSearchBtn: {
    backgroundColor: colors.accent, borderRadius: radii.pill, paddingHorizontal: 22,
    alignItems: 'center', justifyContent: 'center',
  },
  smartSearchBtnFullWidth: { width: '100%', paddingVertical: 12 },
  smartSearchBtnDisabled: { opacity: 0.5 },
  smartSearchBtnRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  smartSearchBtnText: { fontFamily: fonts.bold, fontSize: 16, color: '#ffffff' },
  smartSearchBtnArrow: { fontSize: 17, fontFamily: fonts.bold, color: '#ffffff' },
  smartSearchErrorText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.danger, textAlign: 'center', marginTop: 10 },
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

  // marginTop:0/marginBottom:16 - עכשיו משמש רק את "💡 מה עוד מעניין אתכם?" (2026-09-20,
  // "typography and section-heading refinement": "שווה לגלות" קיבל recSectionHeaderRow/
  // recSectionTitle נפרדים למטה, כדי לא לשנות בטעות את הכותרת הזו - "preserve everything else").
  // מעל "מה עוד מעניין אתכם?" - recCarouselWrap.marginBottom (16, ראו שם) עדיין תואם בדיוק,
  // אז המרווח הסימטרי 16/16 סביב הכותרת הזו נשאר בדיוק כפי שהיה.
  sectionHeaderRow: { marginTop: 0, marginBottom: 16 },
  // שורת-כותרת ממורכזת (עדיין משמשת רק את "מה עוד מעניין אתכם?" - ראו לעיל). האימוג'י (✨/💡)
  // שהיה כאן הוסר מה-JSX (בקשת המשתמש: "להוריד לכולם את האימוג'י") - homeHeadingIcon שהיה
  // משרת אותו נמחק, לא בשימוש יותר.
  sectionTitleRow: { flexDirection: d.row, alignItems: 'center', justifyContent: 'center', gap: 6 },
  sectionTitle: { fontFamily: fonts.extraBold, fontSize: 24, color: colors.textPrimary, textAlign: d.textAlign },

  // recCarouselWrap - marginTop:20 (חדש, 2026-09-19, "תמחק את 'שווה לגלות'... רק את הכותרת") -
  // recSectionHeaderRow/recSectionTitle (הכותרת עצמה, שתרמה 22 מעליה+14 מתחתיה סביב שורת-טקסט)
  // הוסרו לגמרי; 20 שומר מרווח סביר-בודד בין smartSearchCard/heroRow לקרוסלה במקומם, בלי טקסט.
  // marginBottom:16 (ללא שינוי) - ראו ההערה ליד ה-JSX למעלה: המרווח האחיד לפני "💡 מה עוד מעניין
  // אתכם?" יושב כאן, לא בתוך recRow/emptyRecState/recErrorText עצמם (שממשיכים לשרת את התפקיד
  // הפנימי-להם - ריווח מתחת לצללי הכרטיסים בגלילה, לא ריווח בין-סקשנים). 16 - תואם בדיוק את
  // sectionHeaderRow.marginBottom (16, ראו שם) כך שהמרווח מעל/מתחת "💡 מה עוד מעניין אתכם?" יוצא
  // שווה בדיוק, לא רק "בערך" (בקשת המשתמש, סבב שני).
  recCarouselWrap: { marginTop: 20, marginBottom: 16 },

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
