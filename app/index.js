import { useState, useCallback, useEffect, useMemo, createElement } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, TextInput, ActivityIndicator, Image, Platform, useWindowDimensions } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter, useFocusEffect } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import * as Location from 'expo-location';
import Svg, { Circle, Rect, Polygon, Polyline, Line, Path, G } from 'react-native-svg';
import Header from '../components/Header';
import LoginRequiredModal from '../components/LoginRequiredModal';
import QuickPicker from '../components/QuickPicker';
import LocationQuickPicker, { locationSummary } from '../components/LocationQuickPicker';
import CityAutocomplete from '../components/CityAutocomplete';
import ActivityCard from '../components/ActivityCard';
import {
  CATEGORY_FILTER_OPTIONS, DEFAULT_FILTERS, FILTER_SCHEMA,
  PRICE_OPTIONS, PLACE_TYPE_OPTIONS, BOOKING_OPTIONS, DURATION_OPTIONS, AMENITY_COMFORT_OPTIONS,
} from '../constants/filterSchema';
import { normalizeFilters, rankActivities } from '../lib/filterActivities';
import { whenSummary, hebrewJoin, categorySummary } from '../lib/filterSummaries';
import { supabase } from '../lib/supabase';
import { fetchUserPreferences, saveDefaultHomeFilters } from '../lib/preferences';
import { childrenToDefaultAgeFilter, formatChildAge } from '../lib/children';
import { parseSmartSearchQuery, intentToFilters } from '../lib/smartSearch';
import { fetchApprovedActivities, formatDistance } from '../lib/activities';
import { fetchUserActivityFlags, toggleFavorite, toggleVisited, toggleHidden, fetchAllPersonalNotes } from '../lib/interactions';
import { formatBenefitCardTag } from '../lib/benefits';
import { colors, fonts, radii, spacing } from '../constants/theme';

// המסך הראשי - יש מסך-בית אחד בלבד (בקשת המשתמש 2026-09-12: "יש למחוק את מסך הבית 2, מעכשיו
// יש רק מסך בית אחד"). קודם לכן היו שני מסכי-בית מקבילים (app/index.js ו-app/home2.js) שמוזגו
// יחד לקובץ הזה בשלב קודם, ואז home2.js נמחק לגמרי - זה כל הסיפור, אין יותר מסך שני.

// "☀️ בוקר טוב" וכו' - אלמנט-הקשר קטן, לא שולף את כינוי המשתמש בעצמו (Header.js כבר שולף
// אותו פנימית לתפריט הנפתח, מועבר החוצה דרך onNicknameResolved - אין טעם לשכפל את השליפה).
function greetingForNow() {
  const h = new Date().getHours();
  if (h < 5) return '🌙 לילה טוב';
  if (h < 12) return '☀️ בוקר טוב';
  if (h < 17) return '🌤️ צהריים טובים';
  if (h < 21) return '🌛 ערב טוב';
  return '🌙 לילה טוב';
}

const RECOMMENDATIONS_LIMIT = 8;

const DISCOVERY_TILES = [
  { id: 'nature', emoji: '🌳', label: 'טבע וטיולים', category: 'טבע' },
  { id: 'museums', emoji: '🏛️', label: 'מוזיאונים לילדים', category: 'מוזיאון לילדים' },
  { id: 'playgrounds', emoji: '🛝', label: 'פארקים וגנים', category: 'פארק' },
  { id: 'animals', emoji: '🐾', label: 'חוות ובעלי חיים', category: 'חווה' },
  { id: 'water', emoji: '💦', label: 'פעילויות מים', category: 'פעילות מים' },
  { id: 'crafts', emoji: '🎨', label: 'יצירה וסדנאות', category: 'יצירה' },
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

// יחס הרוחב/גובה של איור הדשא (assets/grass-footer.png).
const GRASS_ASPECT_RATIO = 939 / 148;

// אובייקט-style גולמי (לא דרך StyleSheet.create) ל-<span> אמיתי בווב בלבד - ראו ההערה במקום
// השימוש למטה (JSX) להסבר המלא למה זה חייב להיות span+CSS ולא RN Text/SVG.
const TAGLINE_GRADIENT_SPAN_STYLE = {
  display: 'block', textAlign: 'center', fontFamily: 'Assistant_800ExtraBold', fontSize: 19,
  fontWeight: '800', marginTop: -2, marginBottom: 16,
  backgroundImage: 'linear-gradient(90deg, #1cb0e0, #00647f)',
  backgroundClip: 'text', color: 'transparent',
  // בלי זה, לסימני-פיסוק ניטרליים בסוף הטקסט (כמו "?") אין הקשר-בסיס RTL להיצמד אליו, אז הם
  // נופלים לפי כיוון ברירת המחדל (LTR) ומוצגים בטעות בקצה הימני (תחילת המשפט) במקום השמאלי
  // (סוף המשפט) - נמדד ישירות ב-DOM (getBoundingClientRect לכל תו) לפני התיקון: "?" הופיע ב-
  // x=242, ימני יותר אפילו מהאות הראשונה ("ל" ב-x=232). זו תכונת CSS (direction), לא ה-attribute
  // "dir" ש-RN Web מוסיף אוטומטית ל-<Text> ושכבר תועד ששובר את הגרדיאנט - שני מנגנונים שונים.
  direction: 'rtl',
};

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
  return hebrewJoin(labels);
}

function ChevronDown() {
  return (
    <Svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke={colors.textSecondary} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <Polyline points="6 9 12 15 18 9" />
    </Svg>
  );
}

function CategoryIcon({ color }) {
  return (
    <Svg width={17} height={17} viewBox="0 0 24 24">
      <Path d="M12 2.5c.6 3.1 1.2 5 2.4 6.2 1.2 1.2 3.1 1.8 6.1 2.3-3 .5-4.9 1.1-6.1 2.3-1.2 1.2-1.8 3.1-2.4 6.2-.6-3.1-1.2-5-2.4-6.2-1.2-1.2-3.1-1.8-6.1-2.3 3-.5 4.9-1.1 6.1-2.3 1.2-1.2 1.8-3.1 2.4-6.2z" fill={color} />
      <Circle cx="19.3" cy="4.8" r="1.6" fill={color} opacity={0.75} />
      <Circle cx="4.2" cy="19" r="1.3" fill={color} opacity={0.75} />
    </Svg>
  );
}

function LocationIcon({ color }) {
  return (
    <Svg width={17} height={17} viewBox="0 0 24 24">
      <Path d="M12 21.5s-7.5-6.4-7.5-11.5a7.5 7.5 0 0 1 15 0c0 5.1-7.5 11.5-7.5 11.5z" fill={color} />
      <Circle cx="12" cy="10" r="2.8" fill="#ffffff" />
    </Svg>
  );
}

function FilterRow({ f, isLast, onPress }) {
  return (
    <Pressable style={[styles.filterRow, isLast && styles.filterRowLast]} onPress={onPress}>
      <View style={styles.filterRightGroup}>
        {f.decorEmoji ? <Text style={styles.decorEmoji}>{f.decorEmoji}</Text> : <f.DecorIcon color={f.color} />}
        <View style={styles.filterTextStack}>
          <Text style={styles.filterLabel}>{f.label}</Text>
          <Text style={[styles.filterValue, f.active && styles.filterValueActive]}>{f.subtitle}</Text>
        </View>
      </View>
      <View style={styles.filterLeftGroup}>
        <View style={[styles.iconChip, { backgroundColor: f.tint }]}>
          <f.Icon color={f.color} />
        </View>
        <ChevronDown />
      </View>
    </Pressable>
  );
}

// "למי מחפשים היום?" - מחליף את שורות "מה בא לנו?"/"באיזור שלי" רק למשתמש מחובר עם ילדים
// (ראו isPersonalized ב-HomeScreen). בחירת ילד/ים כאן מעדכנת את filters.age מיידית; מיקום/
// קטגוריה כבר נכנסים אוטומטית מ-default_home_filters השמור, בלי קשר לכרטיס הזה.
function PersonalPicker({ kids, selectedChildIds, onToggleChild }) {
  return (
    <View style={styles.personalCard}>
      <Text style={styles.personalTitle}>למי מחפשים היום?</Text>
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
                {(child.name || 'הילד/ה שלכם') + (formatChildAge(child) ? ` · ${formatChildAge(child)}` : '')}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.personalHint}>הגיל וההעדפות שלכם ייכנסו אוטומטית לחיפוש</Text>
    </View>
  );
}

// "📍 איפה אתם מחפשים?" - prompt קומפקטי בתוך section "✨ רעיונות לידכם היום" עצמו (לא section
// נפרד עם כותרת משלו) - מוצג מעל locked-הקרוסלה (LockedRecommendationCard למטה) כש-
// locationKnown===false, כדי שהפעולה כאן תיראה כ"פותחת" את מה שמתחתיה. שתי הפעולות: "השתמשו
// במיקום שלי" מפעילה ישירות את אותו geolocation flow (בלי לפתוח modal ביניים - אין page reload),
// "בחרו עיר או אזור" פותחת את אותו LocationQuickPicker בדיוק כמו "איפה נוח לכם?" (onPickCity,
// לא modal חדש).
function RecommendationsLocationPrompt({ busy, denied, onUseLocation, onPickCity }) {
  return (
    <View style={styles.recPromptCard}>
      <Text style={styles.recPromptTitle}>📍 איפה אתם מחפשים?</Text>
      <Text style={styles.recPromptSubtitle}>כדי להציג לכם פעילויות שמתאימות להיום באזור שלכם, ספרו לנו איפה לחפש.</Text>
      <View style={styles.recPromptActions}>
        <Pressable style={styles.recPromptPrimaryBtn} onPress={onUseLocation} disabled={busy}>
          {busy ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.recPromptPrimaryBtnText}>📍 השתמשו במיקום שלי</Text>
          )}
        </Pressable>
        <Pressable onPress={onPickCity} hitSlop={8}>
          <Text style={styles.recPromptSecondaryText}>בחרו עיר או אזור</Text>
        </Pressable>
      </View>
      {denied ? <Text style={styles.recPromptDeniedText}>לא הצלחנו לקבל את המיקום. אפשר לבחור עיר במקום.</Text> : null}
    </View>
  );
}

// כרטיסי-פלייסהולדר "נעולים" - מציגים ל-locationKnown===false שיש המלצות אמיתיות מחכות, בלי
// לטעון/להציג nationwide activities אמיתיות (סעיף 3/4 בבקשה) ובלי query נוסף - אין כאן שום
// data fetching, רק Views סטטיים. שונה במכוון מ-SkeletonCard (למעלה): זה state מכוון (locked,
// ממתין לבחירת מיקום), לא loading - לכן אייקון 📍 קבוע במקום shimmer/אנימציה, כדי שלא יראה כמו
// "עוד רגע נטען" (סעיף 5/14 בבקשה). לחיצה פותחת את אותו location picker כמו "בחרו עיר או אזור".
function LockedRecommendationCard({ onPress }) {
  return (
    <Pressable style={styles.recCardWrap} onPress={onPress} accessibilityRole="button" accessibilityLabel="בחרו עיר או אזור כדי לראות את הפעילויות כאן">
      <View style={styles.lockedImage}>
        <Text style={styles.lockedImageIcon}>📍</Text>
      </View>
      <View style={styles.lockedLineWide} />
      <View style={styles.lockedLineNarrow} />
    </Pressable>
  );
}

function Cloud({ x, y, scale = 1, opacity = 0.6 }) {
  return (
    <G transform={`translate(${x}, ${y}) scale(${scale})`} opacity={opacity}>
      <Rect x="4" y="14" width="52" height="20" rx="10" fill="#ffffff" />
      <Circle cx="14" cy="16" r="14" fill="#ffffff" />
      <Circle cx="31" cy="10" r="18" fill="#ffffff" />
      <Circle cx="48" cy="17" r="13" fill="#ffffff" />
    </G>
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

function SkyClouds() {
  return (
    <Svg width="100%" height={230} viewBox="0 0 375 230" style={styles.skyClouds} pointerEvents="none">
      <Cloud x={210} y={18} scale={1.3} opacity={0.5} />
      <Cloud x={40} y={70} scale={0.9} opacity={0.4} />
      <Cloud x={260} y={110} scale={0.7} opacity={0.35} />
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
  // מובייל (כולל האפליקציה הנטיבית - תמיד צרה) מקבל כפתור חיפוש רחב-מלא מתחת לשדה, לא בתוך
  // השורה - קל יותר ללחיצה ביד אחת. דסקטופ/רוחב-רחב (רק ווב) שומר על השורה המשולבת הקיימת.
  // 480px: breakpoint פשוט, לא קשור לתוכן קיים - כמעט כל טלפון (כולל טאבלטים קטנים) נופל מתחתיו.
  const { width: windowWidth } = useWindowDimensions();
  const isNarrowScreen = windowWidth < 480;
  // מדידה אמיתית (onLayout) של שורת ה-Header, כדי ש-SunMascot (position:absolute, מחוץ ל-
  // ScrollView) יתיישר איתה בכל פלטפורמה/מכשיר - ראו הערה מלאה ליד SunMascot למעלה.
  const [headerLayout, setHeaderLayout] = useState(null);
  // כינוי המשתמש לברכת "צהריים טובים <שם>" - מגיע מ-Header (onNicknameResolved), לא נשלף כאן
  // בנפרד, כדי לא לשכפל את קריאת ה-profile שכבר קורית שם בכל מקרה.
  const [nickname, setNickname] = useState('');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [deviceCoords, setDeviceCoords] = useState(null);
  const [categoryQuickOpen, setCategoryQuickOpen] = useState(false);
  const [whereQuickOpen, setWhereQuickOpen] = useState(false);
  // "מה עוד מעניין אתכם?" (discovery shortcuts) - allCategoriesOpen פותח את אותו QuickPicker
  // שכבר קיים ל"מה בא לנו?" (לא מסך/modal חדש), רק ב-multiple=false כדי שבחירה תסגור ותחזיר
  // מיד (ראו toggle ב-components/QuickPicker.js - זו כבר ההתנהגות המובנית שלו). pendingCategory
  // שומר את הקטגוריה שנלחצה כשעדיין אין location ידוע, כדי לבצע את החיפוש מיד אחרי שהמיקום
  // נבחר - בלי לזרוק את המשתמש בחזרה למסך הבית (ראו handleWhereQuickClose למטה).
  const [allCategoriesOpen, setAllCategoriesOpen] = useState(false);
  const [pendingCategory, setPendingCategory] = useState(null);
  const [userId, setUserId] = useState(null);
  const [hasSavedDefault, setHasSavedDefault] = useState(false);
  const [showLoginPrompt, setShowLoginPrompt] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);
  const [defaultNotice, setDefaultNotice] = useState('');
  const [locatingForSearch, setLocatingForSearch] = useState(false);
  const [visibleHomeFilters, setVisibleHomeFilters] = useState([]);
  const [children, setChildren] = useState([]);
  const [selectedChildIds, setSelectedChildIds] = useState(new Set());
  const [smartSearchText, setSmartSearchText] = useState('');
  const [smartSearchLoading, setSmartSearchLoading] = useState(false);
  const [smartSearchError, setSmartSearchError] = useState('');
  const [smartSearchClarify, setSmartSearchClarify] = useState(null); // { message, pendingIntent }
  const [smartSearchClarifyCity, setSmartSearchClarifyCity] = useState('');
  const [recentSearches, setRecentSearches] = useState([]);
  const [recentSearchesOpen, setRecentSearchesOpen] = useState(false);

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
  // "📍 איפה אתם מחפשים?" - מצב-onboarding בתוך section "רעיונות לידכם היום" כשאין locationKnown.
  const [recLocationBusy, setRecLocationBusy] = useState(false);
  const [recLocationDenied, setRecLocationDenied] = useState(false);

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
        if (!cancelled) setRecError(err.message || 'לא הצלחנו לטעון המלצות');
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

  // "בחרו עיר או אזור" (onboarding prompt) פותח את אותו LocationQuickPicker בדיוק כמו "איפה נוח
  // לכם?" - לא modal חדש (סעיף 3/7 בבקשה).
  const handleUseLocationForRecommendations = async () => {
    setRecLocationBusy(true);
    setRecLocationDenied(false);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setRecLocationDenied(true);
        setRecLocationBusy(false);
        return;
      }
      const pos = await Location.getCurrentPositionAsync({});
      setDeviceCoords({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
      setFilters((prev) => ({ ...prev, location: { ...prev.location, mode: 'current', radiusKm: prev.location.radiusKm || 10 } }));
    } catch {
      setRecLocationDenied(true);
    }
    setRecLocationBusy(false);
  };

  // כותרת/תת-כותרת אמיתיות ביחס לאלגוריתם בפועל (סעיף 9 בבקשה) - לא טוענות "מותאם לגיל" סתם:
  // רק אם isPersonalized (יש בפועל age-matching אמיתי מגילאי הילדים, ראו scoreActivity).
  // display name קיים בלבד (filters.location.city) - לא hardcoded ערים (סעיף 8).
  const recHeaderTitle = filters.location?.mode === 'city' && filters.location.city
    ? `רעיונות להיום ליד ${filters.location.city}`
    : filters.location?.mode === 'address' && (filters.location.addressLabel || filters.location.city)
      ? `רעיונות להיום ליד ${filters.location.addressLabel || filters.location.city}`
      : 'רעיונות לידכם היום';
  // locationKnown===false: תת-כותרת קבועה (סעיף 11 בבקשה) - "באזור שלכם" עדיין לא אמיתי (אין
  // location), זו הבטחה למה שמחכה אחרי שיספקו אחד, לא תיאור-מצב. isPersonalized (גיל הילדים)
  // רלוונטי רק כשיש בפועל אזור-חיפוש להתאים אליו.
  const recHeaderSubtitle = !locationKnown
    ? 'פעילויות שוות להיום, ממש באזור שלכם'
    : isPersonalized
      ? 'פעילויות שוות באזור שלכם, מותאמות לגיל הילדים'
      : 'פעילויות שוות באזור שלכם להיום';

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
      showDefaultNotice('נשמר! הפילטרים האלה יתמלאו אוטומטית בכל כניסה ✓');
    } catch (err) {
      showDefaultNotice(`שגיאה בשמירה: ${err.message}`);
    } finally {
      setSavingDefault(false);
    }
  };

  const hasSelectedCategory = filters.category.length > 0;
  const hasChosenLocation = !!filters.location?.mode;
  // ה-CTA של מסלול ההעדפות מוצג רק אחרי interaction אמיתי (לא רק ערכי-ברירת-מחדל) - category/
  // location כבר מתחילים ב-[]/null ב-DEFAULT_FILTERS ורק בחירה בפועל של המשתמש (או ברירת-מחדל
  // ששמר בעבר, ראו fetchUserPreferences למעלה - גם היא "בחירה" לגיטימית) הופכת אותם ל-truthy,
  // אז אין צורך ב-state נפרד רק כדי להבדיל בין "ברירת מחדל" לבין "המשתמש בחר" - הדגלים active
  // הקיימים כבר בדיוק זה. isPersonalized נשאר בהתנהגות הישנה (CTA תמיד מוצג) - מסלול נפרד
  // ("למי מחפשים היום?") שלא חלק מהבקשה הזו.
  const showPreferenceCTA = isPersonalized || hasSelectedCategory || hasChosenLocation;

  const PRIMARY_FILTERS = [
    {
      key: 'category', label: 'מה בא לנו?',
      subtitle: hasSelectedCategory ? categorySummary(filters.category) : 'כל סוגי הפעילויות',
      active: hasSelectedCategory,
      Icon: CategoryIcon, decorEmoji: '🌟', tint: '#fdf3d9', color: '#e8bf36', onPress: () => setCategoryQuickOpen(true),
    },
    {
      key: 'where', label: 'איפה נח לכם?',
      subtitle: hasChosenLocation ? locationSummary(filters.location) : 'באיזור שלי',
      active: hasChosenLocation,
      Icon: LocationIcon, decorEmoji: '🏡', tint: '#e2f5e7', color: '#3fb36d', onPress: () => setWhereQuickOpen(true),
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
      },
    });
  };

  const handleAdvancedFilters = () => {
    router.push({
      pathname: '/activities',
      params: {
        homeFilters: JSON.stringify(filters),
        homeCoords: deviceCoords ? JSON.stringify(deviceCoords) : '',
        openFilters: 'true',
      },
    });
  };

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
      children, fallbackLocation: filters.location?.mode ? filters.location : null,
    });
    const params = { homeFilters: JSON.stringify(builtFilters) };
    if (builtFilters.location.mode === 'address' && builtFilters.location.coords) {
      params.homeCoords = JSON.stringify({
        latitude: builtFilters.location.coords.lat, longitude: builtFilters.location.coords.lng,
      });
    }
    setSmartSearchText('');
    setSmartSearchClarify(null);
    router.push({ pathname: '/activities', params });
  };

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
      if (data.needsClarification) {
        setSmartSearchClarify({ message: data.needsClarification.message, pendingIntent: data.intent, mode: 'street' });
        return;
      }
      // אין מיקום בכלל בחיפוש עצמו, ואין גם מיקום-ברירת-מחדל שמור - לא מנחשים ("אם אין מיקום...
      // הצג שאלה קצרה: באיזה אזור לחפש"). כשיש street זה כבר מטופל למעלה (needsClarification
      // משרת) - זה המקרה השני, "בכלל לא הוזכר מיקום".
      const loc = data.intent.location;
      const hasAnyLocation = !!(loc.city || loc.region || loc.street || loc.coords);
      if (!hasAnyLocation && !filters.location?.mode) {
        setSmartSearchClarify({ message: '📍 באיזה אזור לחפש?', pendingIntent: data.intent, mode: 'plain' });
        return;
      }
      goToSmartSearchResults(data.intent);
    } catch (err) {
      setSmartSearchError(err.message || 'לא הצלחנו להבין את החיפוש, נסו לנסח אחרת');
    } finally {
      setSmartSearchLoading(false);
    }
  };

  // סבב-הבהרה: רחוב הוזכר בלי עיר - לא מנחשים, מבקשים עיר ואז ממשיכים בלי קריאת AI נוספת
  // (ה-Edge Function מדלגת על Claude כש-cityOverride+pendingIntent מגיעים יחד).
  const handleClarifyCity = async () => {
    if (!smartSearchClarify || !smartSearchClarifyCity.trim()) return;
    const city = smartSearchClarifyCity.trim();
    // 'plain' - אין רחוב לגאוקד, רק ממלאים עיר ישירות בקליינט, בלי קריאת שרת נוספת.
    if (smartSearchClarify.mode === 'plain') {
      setSmartSearchClarifyCity('');
      goToSmartSearchResults({ ...smartSearchClarify.pendingIntent, location: { ...smartSearchClarify.pendingIntent.location, city } });
      return;
    }
    setSmartSearchError('');
    setSmartSearchLoading(true);
    try {
      const data = await parseSmartSearchQuery(smartSearchText, {
        cityOverride: city, pendingIntent: smartSearchClarify.pendingIntent,
      });
      if (data.needsClarification) {
        setSmartSearchError('לא הצלחנו לזהות את המיקום, נסו לנסח אחרת');
        return;
      }
      setSmartSearchClarifyCity('');
      goToSmartSearchResults(data.intent);
    } catch (err) {
      setSmartSearchError(err.message || 'לא הצלחנו להבין את החיפוש');
    } finally {
      setSmartSearchLoading(false);
    }
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
      }))
  ), [recActivities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities, excludedRegions, recHiddenIds, recFavoriteIds, recVisitedIds, recNotesByActivity]);

  const handleToggleRecFavorite = async (activityId) => {
    if (!userId) { setShowLoginPrompt(true); return; }
    const next = !recFavoriteIds.has(activityId);
    setRecFavoriteIds((prev) => { const s = new Set(prev); next ? s.add(activityId) : s.delete(activityId); return s; });
    try { await toggleFavorite(userId, activityId, next); }
    catch { setRecFavoriteIds((prev) => { const s = new Set(prev); next ? s.delete(activityId) : s.add(activityId); return s; }); }
  };

  const handleToggleRecVisited = async (activityId) => {
    if (!userId) { setShowLoginPrompt(true); return; }
    const next = !recVisitedIds.has(activityId);
    setRecVisitedIds((prev) => { const s = new Set(prev); next ? s.add(activityId) : s.delete(activityId); return s; });
    try { await toggleVisited(userId, activityId, next); }
    catch { setRecVisitedIds((prev) => { const s = new Set(prev); next ? s.delete(activityId) : s.add(activityId); return s; }); }
  };

  const handleHideRec = async (activityId) => {
    if (!userId) { setShowLoginPrompt(true); return; }
    setRecHiddenIds((prev) => new Set(prev).add(activityId));
    try { await toggleHidden(userId, activityId, true); }
    catch { setRecHiddenIds((prev) => { const s = new Set(prev); s.delete(activityId); return s; }); }
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

  return (
    <View style={styles.screen}>
      <LinearGradient colors={[colors.accentTint, colors.accentTintLight, colors.bg]} style={styles.topGradient} />
      <SkyClouds />
      <SunMascot headerLayout={headerLayout} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* "☀️ בוקר טוב <שם>" - אלמנט-הקשר קטן. השם מגיע מ-Header (onNicknameResolved) - אין
            שליפת profile כפולה כאן. */}
        <View style={styles.greetingRow}>
          <Text style={styles.greetingText}>{greetingForNow()}{nickname ? `, ${nickname}` : ''}</Text>
        </View>
        <Header onMenuPress={() => {}} onHeaderLayout={setHeaderLayout} onNicknameResolved={setNickname} />

        {Platform.OS === 'web' ? (
          // גרדיאנט-טקסט אמיתי (צהוב חם→ירוק רענן) - חייב <span> גולמי, לא <Text> של RN: RN
          // Web מוסיף אוטומטית dir="auto" לכל <Text>, וצירוף dir+background-clip:text שובר
          // את הרינדור בדפדפן (נבדק ישירות - עם dir מוצג צבע אחיד, בלי dir הגרדיאנט תקין).
          // SVG fill=url(#gradient) על <text> נבדק גם הוא ונכשל כאן (מגבלת דפדפן/מנוע נפרדת -
          // גרדיאנט על SVG shapes תקין, על SVG <text> לא) - span+CSS הוא הפתרון היחיד שעבד בפועל.
          createElement('span', { style: TAGLINE_GRADIENT_SPAN_STYLE }, 'לאן קופצים היום?')
        ) : (
          <Text style={styles.tagline}>לאן קופצים היום?</Text>
        )}

        {/* 🔎 חיפוש חכם - תוספת, לא תחליף: הפילטרים הרגילים למטה (מה בא לנו/איפה נח לכם/סינון
            מתקדם) ממשיכים לעבוד זהה לגמרי, בלי שינוי. */}
        <View style={styles.smartSearchCard}>
          <Text style={styles.smartSearchTitle}>🔎 יודעים מה אתם מחפשים?</Text>
          <View style={isNarrowScreen ? styles.smartSearchInputRowStacked : styles.smartSearchInputRow}>
            <TextInput
              style={styles.smartSearchInput}
              placeholder='למשל: "משחקייה ליד רחוב הרצל בתל אביב מחר בבוקר"'
              placeholderTextColor={colors.textMuted}
              value={smartSearchText}
              onChangeText={setSmartSearchText}
              onSubmitEditing={() => handleSmartSearch()}
              returnKeyType="search"
              editable={!smartSearchLoading}
            />
            <Pressable
              style={[
                styles.smartSearchBtn,
                isNarrowScreen && styles.smartSearchBtnFullWidth,
                (smartSearchLoading || !smartSearchText.trim()) && styles.smartSearchBtnDisabled,
              ]}
              onPress={() => handleSmartSearch()}
              disabled={smartSearchLoading || !smartSearchText.trim()}
            >
              {smartSearchLoading ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.smartSearchBtnText}>חיפוש 🔎</Text>}
            </Pressable>
          </View>

          {smartSearchError ? <Text style={styles.smartSearchErrorText}>{smartSearchError}</Text> : null}

          {smartSearchClarify ? (
            <View style={styles.smartSearchClarifyBox}>
              <Text style={styles.smartSearchClarifyText}>{smartSearchClarify.message}</Text>
              <CityAutocomplete
                inputStyle={styles.smartSearchClarifyInput}
                placeholder="הזינו שם עיר..."
                value={smartSearchClarifyCity}
                onChangeText={setSmartSearchClarifyCity}
                onSubmitEditing={handleClarifyCity}
              />
              <Pressable
                style={[styles.smartSearchClarifyBtn, (!smartSearchClarifyCity.trim() || smartSearchLoading) && styles.smartSearchBtnDisabled]}
                onPress={handleClarifyCity}
                disabled={!smartSearchClarifyCity.trim() || smartSearchLoading}
              >
                <Text style={styles.smartSearchBtnText}>{smartSearchLoading ? '...' : 'המשך'}</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.smartSearchIdeasWrap}>
              <Pressable
                style={styles.recentSearchesHeader}
                onPress={() => setRecentSearchesOpen((open) => !open)}
                accessibilityLabel="חיפושים אחרונים"
              >
                <Text style={styles.smartSearchIdeasTitle}>🕐 חיפושים אחרונים</Text>
                <Text style={styles.recentSearchesChevron}>{recentSearchesOpen ? '▲' : '▼'}</Text>
              </Pressable>
              {recentSearchesOpen ? (
                recentSearches.length > 0 ? (
                  <>
                    <View style={styles.smartSearchIdeasRow}>
                      {recentSearches.map((q, i) => (
                        <Pressable
                          key={`${q}-${i}`}
                          style={styles.smartSearchIdeaChip}
                          onPress={() => { setSmartSearchText(q); handleSmartSearch(q); }}
                          disabled={smartSearchLoading}
                        >
                          <Text style={styles.smartSearchIdeaChipText}>{q}</Text>
                        </Pressable>
                      ))}
                    </View>
                    <Pressable onPress={clearRecentSearches} hitSlop={6}>
                      <Text style={styles.clearRecentSearchesText}>🗑️ מחק היסטוריה</Text>
                    </Pressable>
                  </>
                ) : (
                  <Text style={styles.recentSearchesEmptyText}>עדיין אין חיפושים - נסו לחפש משהו למעלה 🔎</Text>
                )
              ) : null}
            </View>
          )}
        </View>

        <View style={styles.orDividerRow}>
          <View style={styles.orDividerLine} />
          <Text style={styles.orDividerText}>או תנו לנו למצוא בשבילכם ✨</Text>
          <View style={styles.orDividerLine} />
        </View>

        {isPersonalized ? (
          <PersonalPicker kids={children} selectedChildIds={selectedChildIds} onToggleChild={toggleChild} />
        ) : (
          <View style={styles.filtersCard}>
            {PRIMARY_FILTERS.map((f, i) => (
              <FilterRow key={f.key} f={f} isLast={i === PRIMARY_FILTERS.length - 1} onPress={f.onPress} />
            ))}
          </View>
        )}

        {visibleHomeFilters.length > 0 ? (
          <View style={styles.extraFiltersWrap}>
            {FILTER_SCHEMA.filter((f) => visibleHomeFilters.includes(f.key)).map((f) => {
              const summary = summaryForHomeFilterKey(f.key, filters);
              return (
                <Pressable key={f.key} style={styles.ageAddRow} onPress={handleAdvancedFilters} hitSlop={8}>
                  <Text style={[styles.ageAddText, summary && styles.ageAddTextActive]}>
                    {summary ? `+ ${f.title}: ${summary}` : `+ ${f.title}`}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {/* ה-CTA שייך למסלול ההעדפות בלבד (מה בא לנו/איפה נוח לכם) - מוצג רק אחרי interaction
            אמיתי (showPreferenceCTA למעלה), ישר מתחת ל-selectors/extraFiltersWrap ובלי מרווח
            גדול, כדי שייקרא ויזואלית כיחידה אחת איתם. כשלא מוצג - פשוט לא render, בלי placeholder
            ובלי disabled state, כדי לא להשאיר מקום ריק ולא לרמוז שהוא חובה גם לחיפוש חופשי
            (זה בדיוק היה הבלבול שהוביל לשינוי הזה - חיפוש חופשי מבצע את עצמו מיידית, ראו
            handleSmartSearch, בלי תלות ב-CTA הזה בכלל). */}
        {showPreferenceCTA ? (
          <Pressable style={styles.searchBtnWrap} onPress={handleGo} disabled={locatingForSearch}>
            <LinearGradient colors={['#1cb0e0', '#00647f']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.searchBtn}>
              {locatingForSearch ? (
                <ActivityIndicator color="#ffffff" size="small" />
              ) : (
                <>
                  <Text style={styles.searchBtnText}>מצאו לי פעילויות</Text>
                  <Text style={styles.searchBtnEmoji}>✨</Text>
                </>
              )}
            </LinearGradient>
          </Pressable>
        ) : null}

        {userId ? (
          <Pressable style={styles.saveDefaultLink} onPress={handleSaveAsDefault} disabled={savingDefault} hitSlop={8}>
            <Text style={styles.saveDefaultText}>
              {savingDefault ? 'שומר...' : hasSavedDefault ? '⭐ עדכן את ברירת המחדל שלי' : '⭐ שמור את הבחירה כברירת מחדל'}
            </Text>
          </Pressable>
        ) : null}
        {defaultNotice ? <Text style={styles.defaultNoticeText}>{defaultNotice}</Text> : null}

        {/* "🎯 סינון מתקדם" הוסר מעמוד הבית (בקשת המשתמש - simplification: עמוד הבית = מתחילים
            חיפוש, עמוד התוצאות = מדייקים). handleAdvancedFilters עצמו נשאר בקוד בלי שינוי -
            עדיין משמש את הקישורים ב-visibleHomeFilters למעלה (פילטרים שהמשתמש עצמו בחר להציג
            בעמוד הבית, פיצ'ר נפרד). "🪄 ספונטני" עבר בפועל לעמוד התוצאות (app/activities.js) -
            לא רק "מוכן לעתיד" יותר, אלא כבר שם. הציטוט התדמיתי עבר ל"עלינו" (app/about.js) -
            עמוד הבית ממוקד בפעולה, לא בסיפור המותג. */}

        {/* ✨ המלצות מותאמות - קרוסלה אופקית: כרטיס גדול + "הצצה" לכרטיס הבא, לא גריד. section
            אחד קבוע (כותרת+תת-כותרת תמיד "✨ רעיונות...", לא section/כותרת נפרדים) -
            locationKnown קובע רק מה מוצג *בתוכו*: prompt+locked-cards כשאין מיקום (בלי לטעון
            nationwide activities אמיתיות בכלל, סעיף 3/4/15 בבקשת השדרוג), אחרת הקרוסלה הרגילה. */}
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>✨ {recHeaderTitle}</Text>
          <Text style={styles.sectionSubtitle}>{recHeaderSubtitle}</Text>
        </View>

        {!locationKnown ? (
          <>
            <RecommendationsLocationPrompt
              busy={recLocationBusy}
              denied={recLocationDenied}
              onUseLocation={handleUseLocationForRecommendations}
              onPickCity={() => setWhereQuickOpen(true)}
            />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recRow}>
              {[0, 1, 2, 3].map((i) => (
                <LockedRecommendationCard key={i} onPress={() => setWhereQuickOpen(true)} />
              ))}
            </ScrollView>
            {/* הרשמה היא תוספת אופציונלית (persistence/personalization), לא תנאי לראות המלצות
                מקומיות - זה כבר קיים ברגע שיש location, גם ל-guest (סעיף 7/10 בבקשה). לכן ניווט
                ישיר ל-/login (אותו flow קיים שכבר יודע להציג הרשמה/כניסה לפי המכשיר) ולא
                LoginRequiredModal המשותף - זה נועד ל"חייבים להתחבר כדי..." (מועדפים/ביקרתי/וכו'),
                וההודעה שלו לא מתאימה כאן. */}
            <Pressable onPress={() => router.push('/login')} hitSlop={8} style={styles.recRegisterHintRow}>
              <Text style={styles.recRegisterHintText}>
                או <Text style={styles.recRegisterHintLink}>הירשמו</Text> כדי שתורו תכיר ותזכור אתכם
              </Text>
            </Pressable>
          </>
        ) : recLoading ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recRow}>
            <SkeletonCard /><SkeletonCard /><SkeletonCard />
          </ScrollView>
        ) : recError ? (
          <Text style={styles.recErrorText}>לא הצלחנו לטעון המלצות כרגע</Text>
        ) : recommendations.length === 0 ? (
          <View style={styles.emptyRecState}>
            <Text style={styles.emptyRecTitle}>קפצנו בכל האזור ולא מצאנו משהו שמתאים בדיוק 🦘</Text>
            <Pressable onPress={handleWidenSearch} hitSlop={8}>
              <Text style={styles.emptyRecAction}>
                {filters.location?.radiusKm ? 'הרחיבו את מרחק הנסיעה' : 'נקו את הסינון'}
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

        {/* 🌳 עוד לגלות - discovery shortcuts: SEE→TAP→RESULTS, לא עוד filter-flow (בקשת
            המשתמש). לא selected state קבוע - לחיצה היא navigation, לא בחירת-filter. */}
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>מה עוד מעניין אתכם?</Text>
          <Text style={styles.sectionSubtitle}>קפצו ישר לפעילויות שאולי תאהבו</Text>
        </View>
        <View style={styles.discoveryGrid}>
          {DISCOVERY_TILES.map((tile) => (
            <Pressable
              key={tile.id}
              style={({ pressed }) => [styles.discoveryTile, pressed && styles.discoveryTilePressed]}
              onPress={() => handleDiscoveryTilePress(tile.category)}
            >
              <Text style={styles.discoveryEmoji}>{tile.emoji}</Text>
              <Text style={styles.discoveryLabel}>{tile.label}</Text>
            </Pressable>
          ))}
        </View>
        {/* "לכל הקטגוריות ←" - פותח את אותו QuickPicker הקיים (מה-בא-לנו), רק multiple=false כדי
            שבחירה תסגור ותחזיר מיד (ראו toggle ב-components/QuickPicker.js) - לא מסך חדש. */}
        <Pressable style={styles.allCategoriesLink} onPress={() => setAllCategoriesOpen(true)} hitSlop={8}>
          <Text style={styles.allCategoriesLinkText}>לכל הקטגוריות ←</Text>
        </Pressable>

        <GrassFooter width={windowWidth} />
      </ScrollView>

      <QuickPicker
        visible={categoryQuickOpen}
        title="מה בא לנו?"
        subtitle="אפשר לבחור כמה קטגוריות"
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
          ל-CTA. value={[]} - זה תמיד "בחירה טרייה", לא ממשיך בחירה קודמת מ"מה בא לנו?". */}
      <QuickPicker
        visible={allCategoriesOpen}
        title="כל הקטגוריות"
        subtitle="בחרו קטגוריה ועברו ישר לתוצאות"
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
      <LoginRequiredModal visible={showLoginPrompt} onClose={() => setShowLoginPrompt(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, paddingBottom: 40 },
  greetingRow: { alignItems: 'flex-end', marginBottom: 2 },
  greetingText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary },
  topGradient: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 320,
  },
  skyClouds: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 230,
  },
  sunMascot: {
    // 'fixed' בווב: הדף עצמו גולל (לא ה-ScrollView הפנימי בלבד), אז 'absolute' רגיל היה נגרר
    // עם התוכן במקום להישאר צמוד לפינת המסך. ב-native ה-ScrollView כן קוצץ את עצמו כראוי,
    // ו-'fixed' לא קיים ב-RN native - 'absolute' שם כבר נשאר במקום כמצופה.
    position: Platform.OS === 'web' ? 'fixed' : 'absolute', top: 46, left: 10,
  },
  // כותרת "לאן קופצים היום?" - ממש מתחת ללוגו (שעבר ל-Header המשותף, מוצג בכל עמוד). גרדיאנט
  // אמיתי (צהוב חם→ירוק רענן) רק בווב
  // דרך background-clip: text; ב-native (RN אמיתי לא תומך ב-CSS gradient-text בלי ספריית
  // masked-view שהוסרה בעבר בכוונה אחרי שהמשתמש דחה שימוש בה על הלוגו) - נופל לצבע ירוק אחיד
  // (הקצה החם-פחות של אותו גרדיאנט), לא ריק/שקוף.
  // native (iOS/Android): אין CSS background-clip בלי תלות native נוספת (הוסרה בעבר בכוונה
  // אחרי שהמשתמש דחה אותה על הלוגו) - צבע אחיד, הקצה הכהה של אותו גרדיאנט בדיוק (תואם לכפתור
  // "יאללה, יוצאים לדרך!").
  tagline: {
    textAlign: 'center', fontFamily: fonts.extraBold, fontSize: 19,
    marginTop: -2, marginBottom: 16, color: '#00647f',
  },
  grassFooter: {
    marginTop: 28, marginHorizontal: -spacing.xl,
  },
  grassFooterFade: { position: 'absolute', top: 0, left: 0 },
  orDividerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 22 },
  orDividerLine: { flex: 1, height: 1, backgroundColor: colors.borderLight },
  orDividerText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textMuted },
  filtersCard: {
    backgroundColor: colors.card, borderRadius: radii.xl, borderWidth: 1, borderColor: colors.borderLight,
    overflow: 'hidden', marginBottom: 18,
  },
  personalCard: {
    backgroundColor: colors.card, borderRadius: radii.xl, borderWidth: 1, borderColor: colors.borderLight,
    padding: 16, marginBottom: 18,
  },
  personalTitle: { fontFamily: fonts.extraBold, fontSize: 16, color: colors.textPrimary, textAlign: 'right', marginBottom: 12 },
  personalChipsRow: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 8 },
  personalChip: {
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.bg,
    borderRadius: radii.pill, paddingVertical: 9, paddingHorizontal: 14,
  },
  personalChipSelected: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  personalChipText: { fontFamily: fonts.semiBold, fontSize: 13.5, color: colors.textSecondary },
  personalChipTextSelected: { color: colors.accent, fontFamily: fonts.bold },
  personalHint: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, textAlign: 'right', marginTop: 10 },
  // "📍 איפה אתם מחפשים?" - אותה שפה עיצובית בדיוק כמו personalCard למעלה (card+borderLight+xl),
  // כדי שירגיש כמו חלק טבעי מהעמוד, לא כמו חסימה/אזהרה (קומפקטי, לא card ענק).
  recPromptCard: {
    backgroundColor: colors.card, borderRadius: radii.xl, borderWidth: 1, borderColor: colors.borderLight,
    padding: 16, marginBottom: 18,
  },
  recPromptTitle: { fontFamily: fonts.extraBold, fontSize: 15.5, color: colors.textPrimary, textAlign: 'right', marginBottom: 4 },
  recPromptSubtitle: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: 'right', marginBottom: 14 },
  recPromptActions: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  recPromptPrimaryBtn: {
    backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 11, paddingHorizontal: 18,
    alignItems: 'center', justifyContent: 'center', flexGrow: 1,
  },
  recPromptPrimaryBtnText: { fontFamily: fonts.bold, fontSize: 13.5, color: '#fff' },
  recPromptSecondaryText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textSecondary, textDecorationLine: 'underline' },
  recPromptDeniedText: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, textAlign: 'right', marginTop: 10 },
  // LockedRecommendationCard - אותם מידות/רדיוס בדיוק כמו SkeletonCard (skeletonImage/Line*
  // למעלה) כדי לשמור על אותו horizontal carousel affordance, אבל opacity מופחת + אייקון 📍 קבוע
  // (לא shimmer) כדי שלא ירגיש כמו loading state (סעיף 5/14 בבקשת השדרוג).
  lockedImage: {
    width: '100%', height: 158, borderRadius: radii.lg, backgroundColor: colors.borderLight,
    alignItems: 'center', justifyContent: 'center', opacity: 0.7,
  },
  lockedImageIcon: { fontSize: 26, opacity: 0.6 },
  lockedLineWide: { width: '80%', height: 14, borderRadius: 7, backgroundColor: colors.borderLight, marginTop: 12, opacity: 0.7 },
  lockedLineNarrow: { width: '50%', height: 12, borderRadius: 6, backgroundColor: colors.borderLight, marginTop: 8, opacity: 0.7 },
  recRegisterHintRow: { alignItems: 'center', marginTop: 14 },
  recRegisterHintText: { fontFamily: fonts.regular, fontSize: 12, color: colors.textMuted, textAlign: 'center' },
  recRegisterHintLink: { fontFamily: fonts.bold, color: colors.accent, textDecorationLine: 'underline' },
  filterRow: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 13, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: colors.borderLight,
  },
  filterRowLast: { borderBottomWidth: 0 },
  filterLeftGroup: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  filterRightGroup: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10 },
  decorEmoji: { fontSize: 26, width: 26, height: 26, textAlign: 'center', lineHeight: 28 },
  iconChip: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  filterTextStack: { alignItems: 'flex-end' },
  filterLabel: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.textPrimary },
  filterValue: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, marginTop: 1 },
  filterValueActive: { fontFamily: fonts.bold, color: colors.accent },
  ageAddRow: { alignItems: 'center', marginBottom: 18 },
  extraFiltersWrap: { alignItems: 'center' },
  ageAddText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textMuted },
  ageAddTextActive: { color: colors.accent, fontFamily: fonts.bold },
  saveDefaultLink: { alignItems: 'center', marginBottom: 14 },
  saveDefaultText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.accent },
  defaultNoticeText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.greenStrong, textAlign: 'center', marginBottom: 10 },
  searchBtnWrap: {
    width: '100%', borderRadius: radii.pill, overflow: 'hidden', marginBottom: 20,
    shadowColor: colors.accent, shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 4,
  },
  searchBtn: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 15,
  },
  searchBtnText: { fontFamily: fonts.bold, fontSize: 16.5, color: '#ffffff' },
  searchBtnEmoji: { fontSize: 16.5 },
  // 🔎 חיפוש חכם - shadow עדין (לא צבע חדש, אותו colors.accent שכבר על המסגרת) בנוסף למסגרת
  // המודגשת הקיימת - מרים ויזואלית את הכרטיס הזה מעל "או בחרו בעצמכם"/הפילטרים הידניים מתחתיו
  // (ל-filtersCard אין shadow בכלל), בלי הפיכתו לכרטיס "כבד" - עדיין אותו padding/רדיוס בדיוק.
  smartSearchCard: {
    backgroundColor: colors.card, borderWidth: 1.5, borderColor: colors.accent,
    borderRadius: radii.xl, padding: spacing.lg, marginBottom: 28,
    shadowColor: colors.accent, shadowOpacity: 0.12, shadowRadius: 14, shadowOffset: { width: 0, height: 5 }, elevation: 2,
  },
  smartSearchTitle: { fontFamily: fonts.extraBold, fontSize: 15.5, color: colors.textPrimary, textAlign: 'right', marginBottom: 12 },
  smartSearchInputRow: { flexDirection: 'row-reverse', gap: 8 },
  // מסך צר (כולל האפליקציה הנטיבית): שדה מלא-רוחב, ואז כפתור מלא-רוחב מתחתיו (לא לצידו) - ראו
  // isNarrowScreen ב-JSX. gap אנכי קטן יותר מהאופקי כדי שהזוג עדיין ירגיש כמו יחידה אחת.
  smartSearchInputRowStacked: { flexDirection: 'column', gap: 10 },
  smartSearchInput: {
    flex: 1, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.pill, paddingVertical: 12, paddingHorizontal: 16,
    fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, textAlign: 'right', writingDirection: 'rtl',
  },
  smartSearchBtn: {
    backgroundColor: colors.accent, borderRadius: radii.pill, paddingHorizontal: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  smartSearchBtnFullWidth: { width: '100%', paddingVertical: 13 },
  smartSearchBtnDisabled: { opacity: 0.5 },
  smartSearchBtnText: { fontFamily: fonts.bold, fontSize: 13.5, color: '#ffffff' },
  smartSearchErrorText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.danger, textAlign: 'center', marginTop: 10 },
  smartSearchClarifyBox: { marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.borderLight },
  smartSearchClarifyText: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.textPrimary, textAlign: 'right', marginBottom: 8 },
  smartSearchClarifyInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 11,
    fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, backgroundColor: colors.bg,
  },
  smartSearchClarifyBtn: {
    backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 12,
    alignItems: 'center', marginTop: 10,
  },
  smartSearchIdeasWrap: { marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.borderLight },
  smartSearchIdeasTitle: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.textSecondary, textAlign: 'right', marginBottom: 8 },
  recentSearchesHeader: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  recentSearchesChevron: { fontSize: 11, color: colors.textMuted, marginBottom: 8 },
  clearRecentSearchesText: { fontFamily: fonts.semiBold, fontSize: 11.5, color: colors.danger, textAlign: 'right', marginTop: 6 },
  recentSearchesEmptyText: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textMuted, textAlign: 'right' },
  smartSearchIdeasRow: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 8 },
  smartSearchIdeaChip: {
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg,
    borderRadius: radii.pill, paddingVertical: 7, paddingHorizontal: 13,
  },
  smartSearchIdeaChipText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.textSecondary },

  sectionHeaderRow: { marginBottom: 12 },
  sectionTitle: { fontFamily: fonts.extraBold, fontSize: 17, color: colors.textPrimary, textAlign: 'right' },
  sectionSubtitle: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: 'right', marginTop: 2 },

  // row רגיל (לא row-reverse) בכוונה - ה-אפליקציה מכבה forceRTL לגמרי (app/_layout.js), אז אין
  // anchor-גלילה מה-RTL האמיתי ו-offset=0 תמיד מציג את הקצה הפיזי-שמאלי של התוכן - row-reverse
  // רק היה מזיז את הכרטיס המדורג-ראשון (הכי רלוונטי) אל הקצה שדורש גלילה כדי לראות.
  recRow: { flexDirection: 'row', gap: 12, paddingBottom: 6 },
  recCardWrap: { width: 260 },
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

  discoveryGrid: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 10, marginBottom: 14 },
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
});
