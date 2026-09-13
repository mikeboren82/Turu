import { useState, useMemo, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, Modal, TextInput } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as Location from 'expo-location';
import Header from '../components/Header';
import LoginRequiredModal from '../components/LoginRequiredModal';
import ActivityCard from '../components/ActivityCard';
import ActivitiesMap from '../components/ActivitiesMap';
import FiltersSheet from '../components/FiltersSheet';
import QuickPicker from '../components/QuickPicker';
import ExcludeAreasPicker from '../components/ExcludeAreasPicker';
import LocationQuickPicker, { locationSummary } from '../components/LocationQuickPicker';
import CityAutocomplete from '../components/CityAutocomplete';
import { ageSummary } from '../components/AgeQuickPicker';
import { ChevronDownIcon } from '../components/icons';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { fetchApprovedActivities, formatSearchDistance, fetchSettlementCoords } from '../lib/activities';
import { fetchUserActivityFlags, toggleFavorite, toggleVisited, toggleHidden, savePersonalNote, fetchAllPersonalNotes } from '../lib/interactions';
import { fetchUserPreferences, saveExcludedCategories, saveExcludedCities, saveExcludedRegions } from '../lib/preferences';
import { supabase } from '../lib/supabase';
import {
  DEFAULT_FILTERS, CATEGORY_FILTER_OPTIONS, PRICE_OPTIONS, PLACE_TYPE_OPTIONS, BOOKING_OPTIONS, DURATION_OPTIONS, AMENITY_COMFORT_OPTIONS, HOUR_OPTIONS, BENEFIT_FILTER_OPTIONS,
} from '../constants/filterSchema';
import { categorySummary, whenSummary, hebrewJoin } from '../lib/filterSummaries';
import { rankActivitiesWithSmartRadius, countActiveFilters, normalizeFilters, getOpenNowInfo, haversineKm, locationWithDrivingTime } from '../lib/filterActivities';
import { formatBenefitCardTag } from '../lib/benefits';
import { parseSmartSearchQuery, intentToFilters } from '../lib/smartSearch';

const BOOKING_REQUIRED_VALUES = ['registration_required', 'advance_booking'];
const SPONTANEOUS_TOP_COUNT = 5;

// 🪄 ספונטני - "למה הפעילות הזו מופיעה עכשיו" (סעיף 11 בבקשת שדרוג הספונטני): רק מידע שהמערכת
// יודעת בפועל (openHours/availableDays/booking_requirement קיימים) - null כשאין נתון, לעולם
// לא מנחש שעה/זמינות. פורמט מרחק בק"מ (לא "דקות נסיעה") בכוונה - אין ל-TuRu מנוע ניווט/ETA,
// "X דקות" היה בגדר המצאת-נתון (סעיף 11/24 באותה בקשה: "אל תמציא מרחק, שעות או זמינות").
function buildSpontaneousBadge(activity) {
  const openInfo = getOpenNowInfo(activity);
  const parts = [];
  if (openInfo.isOpen) {
    parts.push('🟢 פתוח עכשיו');
  } else if (openInfo.minutesUntilOpenToday != null) {
    parts.push(`🕐 נפתח בעוד ${openInfo.minutesUntilOpenToday} דק'`);
  } else if (!openInfo.hasScheduleData) {
    return null;
  }
  if (BOOKING_REQUIRED_VALUES.includes(activity.booking_requirement)) {
    parts.push('🎟️ דורש הזמנה');
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(String(value)); } catch { return fallback; }
}

function labelsFor(options, ids) {
  return (ids || []).map((id) => options.find((o) => o.id === id)?.label || id);
}

// בונה את המשפט הדינמי בראש התוצאות ("פעילויות לילדים בגיל 3–5 בנתניה") מתוך הפילטרים
// הכי "מזהים" (קטגוריה, גיל, מיקום) - שאר הפילטרים מיוצגים בשורת ה-chips שמתחת, לא במשפט עצמו.
function buildSearchSentence(filters) {
  const hasCategory = filters.category?.length > 0;
  const bits = [hasCategory ? categorySummary(filters.category) : 'פעילויות'];
  if (filters.age?.length) bits.push(`לגיל ${ageSummary(filters.age)}`);
  if (filters.location?.mode) bits.push(`ב${locationSummary(filters.location)}`);
  if (!hasCategory && bits.length === 1) return 'כל הפעילויות';
  return bits.join(' ');
}

// רשימת ה-chips הניתנים-להסרה מעל התוצאות - כל chip יודע גם להציג את עצמו וגם לנקות את
// הפילטר שלו (setField עם ערך ברירת המחדל המתאים מתוך DEFAULT_FILTERS).
function buildActiveChips(filters) {
  const chips = [];
  if (filters.category?.length) chips.push({ key: 'category', label: `🎯 ${categorySummary(filters.category)}`, clear: () => DEFAULT_FILTERS.category });
  if (filters.location?.mode) chips.push({ key: 'location', label: `📍 ${locationSummary(filters.location)}`, clear: () => DEFAULT_FILTERS.location });
  if (filters.age?.length) chips.push({ key: 'age', label: `👶 ${ageSummary(filters.age)}`, clear: () => DEFAULT_FILTERS.age });
  if (filters.when?.options?.length) chips.push({ key: 'when', label: `📅 ${whenSummary(filters.when)}`, clear: () => DEFAULT_FILTERS.when });
  if (filters.hour?.option || filters.hour?.custom) {
    const label = filters.hour.custom ? `שעה ${filters.hour.custom.start}` : HOUR_OPTIONS.find((o) => o.id === filters.hour.option)?.label;
    chips.push({ key: 'hour', label: `🕐 ${label}`, clear: () => DEFAULT_FILTERS.hour });
  }
  if (filters.price?.length) chips.push({ key: 'price', label: `💰 ${hebrewJoin(labelsFor(PRICE_OPTIONS, filters.price))}`, clear: () => DEFAULT_FILTERS.price });
  if (filters.placeType?.length) chips.push({ key: 'placeType', label: hebrewJoin(labelsFor(PLACE_TYPE_OPTIONS, filters.placeType)), clear: () => DEFAULT_FILTERS.placeType });
  if (filters.booking?.length) chips.push({ key: 'booking', label: `🎟️ ${hebrewJoin(labelsFor(BOOKING_OPTIONS, filters.booking))}`, clear: () => DEFAULT_FILTERS.booking });
  if (filters.duration?.length) chips.push({ key: 'duration', label: `⏱️ ${hebrewJoin(labelsFor(DURATION_OPTIONS, filters.duration))}`, clear: () => DEFAULT_FILTERS.duration });
  if (filters.amenities?.length) chips.push({ key: 'amenities', label: `♿ ${hebrewJoin(labelsFor(AMENITY_COMFORT_OPTIONS, filters.amenities))}`, clear: () => DEFAULT_FILTERS.amenities });
  if (filters.benefits?.length) chips.push({ key: 'benefits', label: `🎟️ ${hebrewJoin(labelsFor(BENEFIT_FILTER_OPTIONS, filters.benefits))}`, clear: () => DEFAULT_FILTERS.benefits });
  return chips;
}

const SORT_OPTIONS = [
  { id: 'recommended', label: '✨ מומלץ', shortLabel: 'מומלץ' },
  { id: 'distance', label: '📍 הקרובים ביותר', shortLabel: 'הקרובים ביותר' },
];

// ↕️ מיון - chip קומפקטי + תפריט-נפתח קטן (לא Modal, בקשת המשתמש: "אל תוסיף modal גדול בשביל
// שתי אפשרויות בלבד") - אותה טכניקה בדיוק כמו dropdown ה-CityAutocomplete הקיים באותו מסך
// (position:relative על ה-wrapper, position:absolute עם top:'100%' על התפריט) - כבר מוכח שעובד
// בתוך ה-ScrollView הזה, לא מנגנון חדש. הכותרת מציגה תמיד "לפי מרחק"/"הקרובים ביותר" ולא "הכי
// קרוב אליי" - כי ה-origin עשוי להיות עיר/כתובת שחיפשו, לא בהכרח ה-GPS הנוכחי (ראו searchOriginKm
// למעלה) - ה-copy הזה לא מניח בטעות "קרוב אליי" כשבפועל זה "קרוב לתנובות" למשל.
function SortControl({ sortMode, menuOpen, onToggleMenu, onSelect }) {
  const current = SORT_OPTIONS.find((o) => o.id === sortMode) || SORT_OPTIONS[0];
  return (
    <View style={styles.sortWrap}>
      <Pressable
        style={styles.sortChip}
        onPress={onToggleMenu}
        accessibilityRole="button"
        accessibilityState={{ expanded: menuOpen }}
        accessibilityLabel={`מיון: ${current.label}`}
      >
        <Text style={styles.sortChipIcon}>↕️</Text>
        <Text style={styles.sortChipText} numberOfLines={1}>מיון: {current.shortLabel}</Text>
        <View style={{ transform: [{ rotate: menuOpen ? '180deg' : '0deg' }] }}>
          <ChevronDownIcon size={11} />
        </View>
      </Pressable>
      {menuOpen && (
        // אין backdrop-למסך-מלא בכוונה (מיקום-absolute שכזה בתוך ScrollView לא אמין ב-RN) - סגירה
        // בבחירת אפשרות או בלחיצה חוזרת על ה-chip, אותו דפוס בדיוק כמו freeSearchOpen/sheetOpen
        // הקיימים באותו מסך (toggle, לא backdrop-dismiss).
        <View style={styles.sortMenu} accessibilityRole="menu">
          {SORT_OPTIONS.map((opt) => {
            const selected = opt.id === sortMode;
            return (
              <Pressable
                key={opt.id}
                style={[styles.sortMenuItem, selected && styles.sortMenuItemSelected]}
                onPress={() => onSelect(opt.id)}
                accessibilityRole="menuitem"
                accessibilityState={{ selected }}
              >
                <Text style={[styles.sortMenuItemText, selected && styles.sortMenuItemTextSelected]}>{opt.label}</Text>
                {selected && <Text style={styles.sortMenuItemCheck}>✓</Text>}
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

export default function ActivitiesScreen() {
  const router = useRouter();
  const { homeFilters, homeCoords, openFilters, view } = useLocalSearchParams();
  const [filters, setFilters] = useState(() => normalizeFilters(parseJson(homeFilters, {})));
  const [deviceCoords, setDeviceCoords] = useState(() => parseJson(homeCoords, null));
  // כשמגיעים דרך "סינון מתקדם" מהעמוד הראשי - פותחים ישר את הפאנל, אבל עדיין מציגים תוצאות
  // (בניגוד למודל הישן, הפאנל עכשיו inline מעל תוצאות חיות, לא חוסם אותן).
  const [sheetOpen, setSheetOpen] = useState(openFilters === 'true');
  // view=map - מגיע מ-BottomNav (components/BottomNav.js, "🗺️ מפה") כדי לפתוח ישר בתצוגת מפה;
  // בלי הפרמטר (כל שאר הכניסות לעמוד) מתנהג בדיוק כמו קודם - ברירת מחדל 'list'.
  const [viewMode, setViewMode] = useState(() => (view === 'map' ? 'map' : 'list'));
  // ↕️ מיון - 'recommended' (ברירת מחדל, בדיוק ה-order הקיים של rankedResult, ללא שינוי) או
  // 'distance' (מיון-לקוח בלבד מעל אותו result set, ראו sortedActivities למטה - לא חיפוש חדש,
  // לא נוגע ב-Smart Radius/filters/matching). state מקומי גרידא (לא AsyncStorage/DB) - נעלם
  // בחזרה ל-'recommended' עם עזיבת המסך, בדיוק כמו viewMode/sheetOpen למעלה - האפליקציה לא
  // שומרת העדפת-מיון בשום מקום אחר היום, אז לא ממציאים persistence חדש כאן.
  const [sortMode, setSortMode] = useState('recommended');
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  // 🚫 "הסרה" - dropdown יחיד שמאחד את שתי פעולות ההסרה (קטגוריות/אזורים) שהיו קודם שני כפתורים
  // נפרדים על המסך - אותו טכניקת-דרופדאון בדיוק כמו SortControl ממש לידו (position:relative
  // + absolute עם top:'100%'), לא Modal חדש.
  const [hideMenuOpen, setHideMenuOpen] = useState(false);
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [userId, setUserId] = useState(null);
  const [favoriteIds, setFavoriteIds] = useState(new Set());
  const [visitedIds, setVisitedIds] = useState(new Set());
  const [hiddenIds, setHiddenIds] = useState(new Set());
  const [notes, setNotes] = useState([]); // מ-fetchAllPersonalNotes - לכפתור "📝 הערה" בכרטיס הפעילות
  const [noteModalTarget, setNoteModalTarget] = useState(null); // { activity_id, activity: { name } }
  const [noteModalDraft, setNoteModalDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [excludedCategories, setExcludedCategories] = useState([]);
  const [excludedCities, setExcludedCities] = useState([]);
  const [excludedRegions, setExcludedRegions] = useState([]);
  const [benefitClubs, setBenefitClubs] = useState([]);
  const [showLoginPrompt, setShowLoginPrompt] = useState(false);
  // 🚫 "הסר פעילויות" - hideDraft הוא state נפרד מ-filters.excludeCategory בכוונה: הבחירה בפיקר
  // לא משפיעה על התוצאות עד שסוגרים ("החלת הסינון"), אותו דפוס commit-on-close כמו excludedDraft
  // ב-app/profile.js. saveAsDefault נשמר-בזיכרון-בלבד (state מקומי, לא DB) עד ללחיצה על הכפתור.
  const [hideCategoriesModalOpen, setHideCategoriesModalOpen] = useState(false);
  const [hideDraft, setHideDraft] = useState([]);
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [showRegisterPromptForHide, setShowRegisterPromptForHide] = useState(false);
  // ⛔ "לאן לא תרצו להגיע?" - מקביל מבני מלא ל"הסר פעילויות" למעלה, על אזורים+ערים במקום
  // קטגוריות. draft אחד דו-ממדי ({regions, cities}) כי ExcludeAreasPicker מנהל את שני המישורים
  // יחד (ראו components/ExcludeAreasPicker.js).
  const [hideLocationsModalOpen, setHideLocationsModalOpen] = useState(false);
  const [hideAreasDraft, setHideAreasDraft] = useState({ regions: [], cities: [] });
  const [saveCityAsDefault, setSaveCityAsDefault] = useState(false);
  const [showRegisterPromptForHideCities, setShowRegisterPromptForHideCities] = useState(false);
  // "שער" כניסה - הקוד/ה-Modal נשארים (ראו שימוש למטה, gateCategoryOpen/gateLocationOpen עדיין
  // מגיבים אם משהו יפתח אותם), אבל לא נפתח אוטומטית יותר בכניסה. בעבר showGate נפתח לבד כשאין
  // קטגוריה/מיקום שנבחרו - זה בדיוק ה"מסך ריק שחוסם" ששדרוג העמוד (סעיפים 1/3/10/19/21/25 בבקשה)
  // ביקש להחליף ב-Discovery Mode: כניסה בלי פילטרים מציגה מיד את כל הפעילויות מדורגות-חכם, לא
  // שואלת שאלה לפני שמראה משהו. מסומן כ"נשאר לניקוי עתידי" בדוח הסיכום.
  const [showGate, setShowGate] = useState(false);
  const [gateCategoryOpen, setGateCategoryOpen] = useState(false);
  const [gateLocationOpen, setGateLocationOpen] = useState(false);
  const [spontaneousLoading, setSpontaneousLoading] = useState(false);
  const [spontaneousError, setSpontaneousError] = useState('');
  // 🪄 ספונטני - היה פעולה חד-פעמית (בחירת פעילות אקראית + ניווט לעמוד שלה); שודרג ל"מצב" מתמשך:
  // לא מנווט לשום מקום, רק מוסיף בונוס-קרבה-למיקום-חי לדירוג הקיים (ראו spontaneousProximityScore
  // ב-lib/filterActivities.js) מעל הפילטרים הפעילים בדיוק כפי שהם - "לחיצה נוספת" מכבה בחזרה.
  const [spontaneousActive, setSpontaneousActive] = useState(false);
  const [spontaneousCoords, setSpontaneousCoords] = useState(null);
  const [showLocationPermissionModal, setShowLocationPermissionModal] = useState(false);
  // 🔎 חיפוש חופשי קומפקטי - collapsed כברירת מחדל, פותח שדה טקסט קטן שמפעיל את אותו Smart
  // Search Engine בדיוק כמו עמוד הבית (lib/smartSearch.js, parseSmartSearchQuery/intentToFilters) -
  // בלי לנווט/לטעון מסך חדש, רק כותב ל-filters הקיים של העמוד הזה (setFilters).
  const [freeSearchOpen, setFreeSearchOpen] = useState(false);
  const [freeSearchText, setFreeSearchText] = useState('');
  const [freeSearchLoading, setFreeSearchLoading] = useState(false);
  const [freeSearchError, setFreeSearchError] = useState('');
  const [freeSearchClarify, setFreeSearchClarify] = useState(null); // { message, pendingIntent, mode }
  const [freeSearchClarifyCity, setFreeSearchClarifyCity] = useState('');

  // 🚗 Smart Radius Expansion - נקודת-הייחוס למצב 'city' דורשת שליפה מ-DB (טבלת settlements,
  // ראו fetchSettlementCoords), אז זה state+effect נפרד, לא חישוב סינכרוני כמו deviceCoords/
  // location.coords. משתנה מחדש בכל שינוי עיר (ולא נשאר "תקוע" מהעיר הקודמת - סעיף 10 בבקשה:
  // "שינוי מיקום מבצע search חדש, לא משתמש ברדיוס הקודם בטעות").
  const [settlementCoords, setSettlementCoords] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (filters.location?.mode !== 'city' || !filters.location?.city) {
      setSettlementCoords(null);
      return undefined;
    }
    fetchSettlementCoords(filters.location.city).then((coords) => {
      if (!cancelled) setSettlementCoords(coords);
    });
    return () => { cancelled = true; };
  }, [filters.location?.mode, filters.location?.city]);

  // מקור אחיד לנקודת-הייחוס של Smart Radius Expansion (ולניקוד-מרחק ב-city, ראו distanceScore) -
  // 'current'/'address' כבר יש להם קואורדינטות קיימות בפרויקט (deviceCoords/location.coords),
  // 'city' משתמש ב-settlementCoords שנפתר למעלה. שאר המצבים (null/'region') - אין נקודת-ייחוס,
  // ואין הרחבה.
  const searchOriginCoords = useMemo(() => {
    const mode = filters.location?.mode;
    if (mode === 'current') return deviceCoords ? { lat: deviceCoords.latitude, lng: deviceCoords.longitude } : null;
    if (mode === 'address') return filters.location.coords || null;
    if (mode === 'city') return settlementCoords;
    return null;
  }, [filters.location?.mode, filters.location?.coords, deviceCoords, settlementCoords]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [data, { data: { session } }] = await Promise.all([fetchApprovedActivities(), supabase.auth.getSession()]);
        if (cancelled) return;
        setActivities(data);
        if (session?.user?.id) {
          setUserId(session.user.id);
          const [flags, prefs, userNotes] = await Promise.all([
            fetchUserActivityFlags(session.user.id),
            fetchUserPreferences(session.user.id),
            fetchAllPersonalNotes(session.user.id),
          ]);
          if (!cancelled) {
            setFavoriteIds(flags.favoriteIds);
            setVisitedIds(flags.visitedIds);
            setHiddenIds(flags.hiddenIds);
            setExcludedCategories(prefs.excludedCategories);
            setExcludedCities(prefs.excludedCities);
            setExcludedRegions(prefs.excludedRegions);
            setBenefitClubs(prefs.benefitClubs);
            setNotes(userNotes);
            // אם הגענו בלי homeFilters (למשל דרך "🎪 פעילויות" בתפריט, לא דרך עמוד הבית) -
            // מחילים את העדפות-ברירת-המחדל השמורות של המשתמש אוטומטית, בדיוק כמו שעמוד הבית
            // כבר עושה (app/index.js). בלי זה, משתמש ששמר העדפות בפרופיל היה רואה אותן "נעלמות"
            // בכל כניסה שלא דרך עמוד הבית - הפילטרים לא אמורים להישאל מחדש בכל פעם.
            if (!homeFilters && prefs.defaultHomeFilters) {
              setFilters(normalizeFilters(prefs.defaultHomeFilters));
              setShowGate(false);
            }
          }
        }
      } catch (err) {
        if (!cancelled) setLoadError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const requireLogin = () => {
    setShowLoginPrompt(true);
    return false;
  };

  const openHideCategoriesModal = () => {
    // ברירת מחדל: איחוד ההסתרה הקבועה (excludedCategories) והזמנית (filters.excludeCategory)
    // שכבר בתוקף - כך שפתיחה חוזרת של הפיקר מציגה תמיד את המצב האמיתי, בלי כפילויות.
    setHideDraft([...new Set([...excludedCategories, ...(filters.excludeCategory || [])])]);
    setSaveAsDefault(false);
    setHideCategoriesModalOpen(true);
  };

  const handleConfirmHide = async () => {
    setHideCategoriesModalOpen(false);
    setField('excludeCategory', hideDraft);
    if (!saveAsDefault) return;
    if (!userId) {
      setShowRegisterPromptForHide(true);
      return;
    }
    try {
      await saveExcludedCategories(userId, hideDraft);
      setExcludedCategories(hideDraft);
      setField('excludeCategory', []);
    } catch {
      // ההסתרה הזמנית כבר הוחלה למעלה - כישלון שמירה קבועה לא משאיר את המשתמש בלי שום סינון.
    }
  };

  const openHideLocationsModal = () => {
    setHideAreasDraft({
      regions: [...new Set([...excludedRegions, ...(filters.excludeRegion || [])])],
      cities: [...new Set([...excludedCities, ...(filters.excludeCity || [])])],
    });
    setSaveCityAsDefault(false);
    setHideLocationsModalOpen(true);
  };

  const handleConfirmHideCities = async () => {
    setHideLocationsModalOpen(false);
    setField('excludeCity', hideAreasDraft.cities);
    setField('excludeRegion', hideAreasDraft.regions);
    if (!saveCityAsDefault) return;
    if (!userId) {
      setShowRegisterPromptForHideCities(true);
      return;
    }
    try {
      await Promise.all([
        saveExcludedCities(userId, hideAreasDraft.cities),
        saveExcludedRegions(userId, hideAreasDraft.regions),
      ]);
      setExcludedCities(hideAreasDraft.cities);
      setExcludedRegions(hideAreasDraft.regions);
      setField('excludeCity', []);
      setField('excludeRegion', []);
    } catch {
      // ההסתרה הזמנית כבר הוחלה למעלה - כישלון שמירה קבועה לא משאיר את המשתמש בלי שום סינון.
    }
  };

  // מפעיל בפועל אחרי שההרשאה כבר קיימת (או שהמשתמש אישר עכשיו דרך showLocationPermissionModal
  // למטה) - לא מציג יותר שורת-שגיאה קטנה על חוסר-הרשאה; אם ההרשאה עדיין לא מתקבלת (גם אחרי
  // הבקשה המפורשת), פשוט חוזרים למסך כרגיל בלי הודעה (בקשת המשתמש: "בלי שקרה כלום").
  const activateSpontaneous = async () => {
    setSpontaneousLoading(true);
    try {
      const pos = await Location.getCurrentPositionAsync({});
      setSpontaneousCoords({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
      setSpontaneousActive(true);
    } catch {
      setSpontaneousError('משהו השתבש, נסו שוב');
    } finally {
      setSpontaneousLoading(false);
    }
  };

  const toggleSpontaneous = async () => {
    if (spontaneousActive) {
      setSpontaneousActive(false);
      setSpontaneousError('');
      setShowAllSpontaneous(false);
      return;
    }
    setSpontaneousError('');
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status === 'granted') {
      await activateSpontaneous();
      return;
    }
    // עדיין לא אושר - קופץ חלון שמסביר למה נדרש מיקום ונותן אפשרות מפורשת לאשר (במקום שורת-
    // שגיאה קטנה שהמשתמש עלול לפספס), במקום requestForegroundPermissionsAsync ישיר בלי הקשר.
    setShowLocationPermissionModal(true);
  };

  const confirmLocationPermission = async () => {
    setShowLocationPermissionModal(false);
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return; // המשתמש דחה גם את בקשת המערכת - חוזרים למסך בלי שגיאה.
    await activateSpontaneous();
  };

  // 🔎 חיפוש חופשי קומפקטי - אותו זרימת-הבהרה בדיוק כמו app/index.js (handleSmartSearch/
  // handleClarifyCity), רק שבמקום לנווט ל-/activities עם homeFilters (אנחנו כבר כאן), כותבים
  // ישירות ל-filters הקיים דרך applyFreeSearchIntent - "מעדכן את עמוד הפעילויות" כמו שהתבקש,
  // לא פותח מסך נפרד.
  const applyFreeSearchIntent = (intent) => {
    const built = intentToFilters(intent, { fallbackLocation: filters.location?.mode ? filters.location : null });
    setFilters(normalizeFilters(built));
    if (built.location.mode === 'address' && built.location.coords) {
      setDeviceCoords({ latitude: built.location.coords.lat, longitude: built.location.coords.lng });
    }
    setFreeSearchText('');
    setFreeSearchClarify(null);
    setFreeSearchOpen(false);
  };

  const handleFreeSearch = async (overrideText) => {
    const text = (overrideText ?? freeSearchText).trim();
    if (!text) return;
    setFreeSearchError('');
    setFreeSearchClarify(null);
    setFreeSearchLoading(true);
    try {
      const data = await parseSmartSearchQuery(text);
      if (data.needsClarification) {
        setFreeSearchClarify({ message: data.needsClarification.message, pendingIntent: data.intent, mode: 'street' });
        return;
      }
      const loc = data.intent.location;
      const hasAnyLocation = !!(loc.city || loc.region || loc.street || loc.coords);
      if (!hasAnyLocation && !filters.location?.mode) {
        setFreeSearchClarify({ message: '📍 באיזה אזור לחפש?', pendingIntent: data.intent, mode: 'plain' });
        return;
      }
      applyFreeSearchIntent(data.intent);
    } catch (err) {
      setFreeSearchError(err.message || 'לא הצלחנו להבין את החיפוש, נסו לנסח אחרת');
    } finally {
      setFreeSearchLoading(false);
    }
  };

  const handleFreeSearchClarifyCity = async () => {
    if (!freeSearchClarify || !freeSearchClarifyCity.trim()) return;
    const city = freeSearchClarifyCity.trim();
    if (freeSearchClarify.mode === 'plain') {
      setFreeSearchClarifyCity('');
      applyFreeSearchIntent({ ...freeSearchClarify.pendingIntent, location: { ...freeSearchClarify.pendingIntent.location, city } });
      return;
    }
    setFreeSearchError('');
    setFreeSearchLoading(true);
    try {
      const data = await parseSmartSearchQuery(freeSearchText, { cityOverride: city, pendingIntent: freeSearchClarify.pendingIntent });
      if (data.needsClarification) {
        setFreeSearchError('לא הצלחנו לזהות את המיקום, נסו לנסח אחרת');
        return;
      }
      setFreeSearchClarifyCity('');
      applyFreeSearchIntent(data.intent);
    } catch (err) {
      setFreeSearchError(err.message || 'לא הצלחנו להבין את החיפוש');
    } finally {
      setFreeSearchLoading(false);
    }
  };

  const handleToggleFavorite = async (activityId) => {
    if (!userId) return requireLogin();
    const next = !favoriteIds.has(activityId);
    setFavoriteIds((prev) => { const s = new Set(prev); next ? s.add(activityId) : s.delete(activityId); return s; });
    try {
      await toggleFavorite(userId, activityId, next);
    } catch {
      setFavoriteIds((prev) => { const s = new Set(prev); next ? s.delete(activityId) : s.add(activityId); return s; });
    }
  };

  const handleToggleVisited = async (activityId) => {
    if (!userId) return requireLogin();
    const next = !visitedIds.has(activityId);
    setVisitedIds((prev) => { const s = new Set(prev); next ? s.add(activityId) : s.delete(activityId); return s; });
    try {
      await toggleVisited(userId, activityId, next);
    } catch {
      setVisitedIds((prev) => { const s = new Set(prev); next ? s.delete(activityId) : s.add(activityId); return s; });
    }
  };

  const handleHide = async (activityId) => {
    if (!userId) return requireLogin();
    setHiddenIds((prev) => new Set(prev).add(activityId));
    try {
      await toggleHidden(userId, activityId, true);
    } catch {
      setHiddenIds((prev) => { const s = new Set(prev); s.delete(activityId); return s; });
    }
  };

  // 📝 הערה אישית ישירות מכרטיס הפעילות - אותו דפוס בדיוק כמו openNoteModal/saveNoteModal
  // ב-app/my-things.js, רק על notes/notesByActivity המקומיים של העמוד הזה.
  const openNoteModal = (activityId, activityName) => {
    if (!userId) return requireLogin();
    const existing = notes.find((n) => n.activity_id === activityId);
    setNoteModalTarget(existing || { activity_id: activityId, activity: { name: activityName } });
    setNoteModalDraft(existing ? existing.note : '');
  };

  const saveNoteModal = async () => {
    if (!noteModalTarget || !userId) return;
    setSavingNote(true);
    try {
      await savePersonalNote(userId, noteModalTarget.activity_id, noteModalDraft);
      const trimmed = noteModalDraft.trim();
      setNotes((prev) => {
        if (!trimmed) return prev.filter((n) => n.activity_id !== noteModalTarget.activity_id);
        const exists = prev.some((n) => n.activity_id === noteModalTarget.activity_id);
        if (exists) {
          return prev.map((n) => (n.activity_id === noteModalTarget.activity_id ? { ...n, note: trimmed } : n));
        }
        return [...prev, { activity_id: noteModalTarget.activity_id, note: trimmed, activity: noteModalTarget.activity }];
      });
      setNoteModalTarget(null);
    } catch (err) {
      console.error('שגיאה בשמירת ההערה:', err);
    } finally {
      setSavingNote(false);
    }
  };

  const notesByActivity = useMemo(() => new Map(notes.map((n) => [n.activity_id, n.note])), [notes]);

  const [showAllSpontaneous, setShowAllSpontaneous] = useState(false);

  // Smart Radius Expansion - ראו lib/filterActivities.js (rankActivitiesWithSmartRadius) לפירוט
  // המנגנון. searchMetadata מרכיב את מבנה ה-metadata המלא שה-UI צריך (resultCount/radiusExpanded/
  // effectiveRadiusKm מגיעים כבר מוכנים מה-lib; searchOriginType/searchOriginLabel מתווספים כאן
  // כי רק השכבה הזו מכירה את filters.location ברמת UI - lib/filterActivities.js נשאר "טהור",
  // בלי לדעת איך מציגים סוג-מיקום למשתמש).
  const rankedResult = useMemo(
    () => rankActivitiesWithSmartRadius(
      activities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities,
      spontaneousActive ? spontaneousCoords : null, searchOriginCoords, excludedRegions
    ),
    [activities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities, spontaneousActive, spontaneousCoords, searchOriginCoords, excludedRegions]
  );
  const searchMetadata = useMemo(() => ({
    ...rankedResult,
    searchOriginType: filters.location?.mode || null,
    searchOriginLabel: filters.location?.mode === 'city' ? filters.location.city
      : filters.location?.mode === 'address' ? (filters.location.addressLabel || filters.location.city || null)
      : null,
  }), [rankedResult, filters.location]);

  const filteredActivities = useMemo(
    () => rankedResult.activities
      .filter((a) => !hiddenIds.has(a.id))
      .map((a) => {
        // ספונטני פעיל: מרחק אמיתי (ק"מ) מהמיקום החי, לא שם-העיר הכללי (סעיף 11 בבקשה) - רק
        // כשיש בפועל קואורדינטות לשני הצדדים, אחרת נופל לאותה formatDistance הרגילה כמו היום.
        const spontaneousKm = spontaneousActive && spontaneousCoords && a.lat != null && a.lng != null
          ? haversineKm(spontaneousCoords.latitude, spontaneousCoords.longitude, a.lat, a.lng)
          : null;
        // ↕️ מיון לפי מרחק - אותו haversineKm+searchOriginCoords בדיוק ש-formatSearchDistance
        // כבר מחשב לצורך התצוגה (lib/activities.js) - לא מנוע-מרחק מקביל, רק חושפים כאן גם את
        // המספר הגולמי (לא רק המחרוזת המעוצבת) כדי שיהיה ניתן למיין לפיו. searchOriginCoords
        // הוא ה-canonical search origin הקיים (city/address/current, ראו למעלה) - "הקרוב ביותר"
        // תמיד ביחס אליו, לא ביחס ל-GPS הנוכחי בהכרח (בקשת המשתמש: "לא להניח שמרחק=ממני").
        const originLat = searchOriginCoords?.lat ?? searchOriginCoords?.latitude ?? null;
        const originLng = searchOriginCoords?.lng ?? searchOriginCoords?.longitude ?? null;
        const searchOriginKm = originLat != null && originLng != null && a.lat != null && a.lng != null
          ? haversineKm(originLat, originLng, a.lat, a.lng)
          : null;
        return {
          ...a,
          // formatSearchDistance (לא formatDistance הישן) - משתמש ב-searchOriginCoords, שמכסה
          // גם city (מרכז-יישוב) ו-address, לא רק current+deviceCoords; "ממך" מוצג רק כש-mode
          // הוא 'current' בפועל (סעיף L בבקשה), אחרת "מאזור החיפוש".
          distance: spontaneousKm != null
            ? `${spontaneousKm < 10 ? spontaneousKm.toFixed(1) : Math.round(spontaneousKm)} ק"מ ממך`
            : formatSearchDistance(a, searchOriginCoords, filters.location?.mode === 'current'),
          // ספונטני פעיל -> אותה נקודת-ייחוס בדיוק שכבר מוצגת למשתמש כ"distance" למעלה (לא
          // origin אחר "מאחורי הקלעים" שהיה נראה כמו באג - סדר-המיון תמיד תואם את המספר המוצג).
          distanceKm: spontaneousKm != null ? spontaneousKm : searchOriginKm,
          favorite: favoriteIds.has(a.id),
          visited: visitedIds.has(a.id),
          hasNote: notesByActivity.has(a.id),
          benefitTag: formatBenefitCardTag(a.benefits, benefitClubs),
          spontaneousBadge: spontaneousActive ? buildSpontaneousBadge(a) : null,
        };
      }),
    [rankedResult, hiddenIds, favoriteIds, visitedIds, notesByActivity, benefitClubs, spontaneousActive, spontaneousCoords, searchOriginCoords, filters.location?.mode]
  );

  // סעיף N בבקשה: "יש הבדל בין 'לא מצאנו מספיק תוצאות באזור' לבין 'הפילטרים מגבילים מאוד'" -
  // כשאין שום תוצאה (גם אחרי Smart Radius Expansion), מציגים לצד כל צ'יפ-הרחבה קיים כמה תוצאות
  // היו מתקבלות אילו הוסר *רק* הפילטר הזה - כדי שהמשתמש ידע מראש אם שווה ללחוץ, בלי לשנות שום
  // constraint בשקט (השינוי עצמו עדיין קורה רק בלחיצה מפורשת על הצ'יפ, בדיוק כמו היום). מחושב
  // אך ורק כשבאמת אין תוצאות (לא בכל render) - אותה תשתית בדיוק (rankActivitiesWithSmartRadius),
  // לא מנוע-סינון מקביל.
  const widenPreviewCounts = useMemo(() => {
    if (filteredActivities.length !== 0) return {};
    const candidates = {
      location: filters.location?.mode ? { ...filters, location: DEFAULT_FILTERS.location } : null,
      hour: (filters.hour?.option || filters.hour?.custom) ? { ...filters, hour: DEFAULT_FILTERS.hour } : null,
      category: filters.category?.length > 0 ? { ...filters, category: DEFAULT_FILTERS.category } : null,
      when: filters.when?.options?.length > 0 ? { ...filters, when: DEFAULT_FILTERS.when } : null,
    };
    const counts = {};
    for (const [key, relaxed] of Object.entries(candidates)) {
      if (!relaxed) continue;
      counts[key] = rankActivitiesWithSmartRadius(
        activities, relaxed, deviceCoords, excludedCategories, benefitClubs, excludedCities, null, searchOriginCoords, excludedRegions
      ).resultCount;
    }
    return counts;
  }, [filteredActivities.length, filters, activities, deviceCoords, excludedCategories, benefitClubs, excludedCities, searchOriginCoords, excludedRegions]);

  const activeCount = countActiveFilters(filters);
  const activeChips = useMemo(() => buildActiveChips(filters), [filters]);
  const hiddenCategoryCount = new Set([...excludedCategories, ...(filters.excludeCategory || [])]).size;
  const hiddenCityCount = new Set([...excludedCities, ...(filters.excludeCity || [])]).size;
  const hiddenRegionCount = new Set([...excludedRegions, ...(filters.excludeRegion || [])]).size;
  const hiddenAreaCount = hiddenCityCount + hiddenRegionCount;
  // Discovery Mode (סעיפים 1/3/10/19 בבקשה): אין פילטרים פעילים, אין חיפוש-חופשי, אין ספונטני -
  // כותרת-המשנה מרגישה כמו הזמנה-לגלות, לא כמו ספירת-שורות של מסד-נתונים.
  const isDiscoveryMode = activeCount === 0 && !filters.q?.trim() && !spontaneousActive;

  // 🪄 ספונטני - "אין משהו פתוח עכשיו" (סעיף 13 בבקשת השדרוג): openNowCount נגזר מ-scoreActivity
  // עצמו (getOpenNowInfo, לא סינון נפרד) - אם 0, מציגים הודעה + "נפתח בקרוב" אם יש מידע אמיתי,
  // בלי להמציא. הרשימה הרגילה (filteredActivities) נשארת ממוינת לפי הניקוד המשולב תמיד - אין
  // כאן חלוקה בינארית ל-2 מערכים לצורך התצוגה הרגילה, רק לצורך ה-fallback הזה בלבד.
  const spontaneousOpenCount = useMemo(
    () => (spontaneousActive ? filteredActivities.filter((a) => getOpenNowInfo(a).isOpen).length : 0),
    [spontaneousActive, filteredActivities]
  );
  const spontaneousOpensSoon = useMemo(() => {
    if (!spontaneousActive || spontaneousOpenCount > 0) return [];
    return filteredActivities
      .filter((a) => getOpenNowInfo(a).minutesUntilOpenToday != null)
      .sort((a, b) => getOpenNowInfo(a).minutesUntilOpenToday - getOpenNowInfo(b).minutesUntilOpenToday)
      .slice(0, 5);
  }, [spontaneousActive, spontaneousOpenCount, filteredActivities]);
  const spontaneousVisibleActivities = spontaneousActive && !showAllSpontaneous
    ? filteredActivities.slice(0, SPONTANEOUS_TOP_COUNT)
    : filteredActivities;

  // ↕️ מיון - 'recommended' משאיר את הסדר בדיוק כפי שהוא (זהה ל-filteredActivities, אותו
  // reference אפילו - "ברירת המחדל חייבת להישאר בדיוק כמו היום"). 'distance' ממיין *עותק* לפי
  // distanceKm ASC בלבד - לא search חדש, לא נוגע ב-rankedResult/filters/Smart Radius. Array.sort
  // של JS יציב (מובטח מ-ES2019, גם ב-Hermes) - אז תוצאות-בלי-distanceKm (Infinity) נופלות תמיד
  // לסוף בסדר-היציבות המקורי שלהן, ותוצאות עם מרחק-שווה נשארות באותו סדר-מומלץ יחסי ביניהן
  // (secondary sort key) - בדיוק "distance ASC, then existingRank ASC" מהבקשה, בלי צורך
  // בקומפרטור-משני מפורש.
  const sortedActivities = useMemo(() => {
    if (sortMode !== 'distance') return filteredActivities;
    return [...filteredActivities].sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  }, [filteredActivities, sortMode]);

  const setField = (key, value) => setFilters((prev) => ({ ...prev, [key]: value }));
  const clearAll = () => setFilters(DEFAULT_FILTERS);

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Header showBack onMenuPress={() => {}} />

        <View style={styles.titleBlock}>
          <Text style={styles.pageTitle}>{buildSearchSentence(filters)}</Text>
          <Text style={styles.pageSubtitle}>
            {isDiscoveryMode
              ? 'פעילויות שכדאי לגלות ✨'
              : (filteredActivities.length === 1 ? 'פעילות אחת נמצאה' : `${filteredActivities.length} פעילויות נמצאו`)}
          </Text>
        </View>

        {activeChips.length > 0 && (
          <View style={styles.activeChipsRow}>
            {activeChips.map((c) => (
              <Pressable key={c.key} style={styles.activeChip} onPress={() => setField(c.key, c.clear())}>
                <Text style={styles.activeChipText} numberOfLines={1}>{c.label}</Text>
                <Text style={styles.activeChipRemove}>✕</Text>
              </Pressable>
            ))}
          </View>
        )}

        {/* 🔎 חיפוש חופשי - קומפקטי, collapsed כברירת מחדל (סעיפים 2/17 בבקשה): לא תיבת-החיפוש
            הגדולה של עמוד הבית, גישה מהירה בלבד לאותו Smart Search Engine. פותח/סוגר inline,
            בלי ניווט למסך חדש - ראו handleFreeSearch/applyFreeSearchIntent למעלה. */}
        <Pressable style={styles.freeSearchToggle} onPress={() => setFreeSearchOpen((v) => !v)}>
          <Text style={styles.freeSearchToggleIcon}>🔎</Text>
          <Text style={styles.freeSearchToggleText}>חיפוש חופשי</Text>
          <View style={{ transform: [{ rotate: freeSearchOpen ? '180deg' : '0deg' }] }}>
            <ChevronDownIcon size={11} />
          </View>
        </Pressable>
        {freeSearchOpen && (
          <View style={styles.freeSearchBox}>
            {freeSearchClarify ? (
              <View>
                <Text style={styles.freeSearchClarifyText}>{freeSearchClarify.message}</Text>
                <CityAutocomplete
                  inputStyle={styles.freeSearchInput}
                  placeholder="הזינו שם עיר..."
                  value={freeSearchClarifyCity}
                  onChangeText={setFreeSearchClarifyCity}
                  onSubmitEditing={handleFreeSearchClarifyCity}
                />
                <Pressable
                  style={[styles.freeSearchBtn, (!freeSearchClarifyCity.trim() || freeSearchLoading) && styles.freeSearchBtnDisabled]}
                  onPress={handleFreeSearchClarifyCity}
                  disabled={!freeSearchClarifyCity.trim() || freeSearchLoading}
                >
                  <Text style={styles.freeSearchBtnText}>{freeSearchLoading ? '...' : 'המשך'}</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.freeSearchInputRow}>
                <TextInput
                  style={styles.freeSearchInput}
                  placeholder='למשל: "משחקייה ליד הרצל בתל אביב מחר בבוקר"'
                  placeholderTextColor={colors.textMuted}
                  value={freeSearchText}
                  onChangeText={setFreeSearchText}
                  onSubmitEditing={() => handleFreeSearch()}
                  returnKeyType="search"
                  editable={!freeSearchLoading}
                />
                <Pressable
                  style={[styles.freeSearchBtn, (freeSearchLoading || !freeSearchText.trim()) && styles.freeSearchBtnDisabled]}
                  onPress={() => handleFreeSearch()}
                  disabled={freeSearchLoading || !freeSearchText.trim()}
                >
                  {freeSearchLoading ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.freeSearchBtnText}>חיפוש</Text>}
                </Pressable>
              </View>
            )}
            {freeSearchError ? <Text style={styles.freeSearchErrorText}>{freeSearchError}</Text> : null}
          </View>
        )}

        <Pressable style={styles.advToggle} onPress={() => setSheetOpen((v) => !v)}>
          <Text style={styles.advToggleIcon}>🎯</Text>
          <Text style={styles.advToggleText}>סינון{activeCount > 0 ? ` · ${activeCount}` : ''}</Text>
          <View style={{ transform: [{ rotate: sheetOpen ? '180deg' : '0deg' }] }}>
            <ChevronDownIcon size={12} />
          </View>
        </Pressable>

        {/* RESULT CONTROLS - "↕️ מיון" בצד ימין, "🚫 הסרה" (dropdown המאחד את שתי פעולות ההסרה
            הקודמות) בצד שמאל, באותה שורה - לפי בקשת המשתמש. כפתור "⚡ פעילויות עכשיו" הוסר
            מהמסך (לוגיקת הספונטני עצמה - toggleSpontaneous/spontaneousProximityScore/הדירוג -
            נשארה בקוד בלי שינוי, פשוט אין עוד טריגר UI שמפעיל אותה מהמסך הזה). */}
        <View style={styles.resultControlsRow}>
          {!loading && !loadError && filteredActivities.length > 0 && (
            <SortControl
              sortMode={sortMode}
              menuOpen={sortMenuOpen}
              onToggleMenu={() => { setSortMenuOpen((v) => !v); setHideMenuOpen(false); }}
              onSelect={(mode) => { setSortMode(mode); setSortMenuOpen(false); }}
            />
          )}

          <View style={styles.hideMenuWrap}>
            <Pressable
              style={styles.hideMenuChip}
              onPress={() => { setHideMenuOpen((v) => !v); setSortMenuOpen(false); }}
              accessibilityRole="button"
              accessibilityState={{ expanded: hideMenuOpen }}
              accessibilityLabel={`הסרה מהחיפוש${hiddenAreaCount + hiddenCategoryCount > 0 ? `, ${hiddenAreaCount + hiddenCategoryCount} פעילים` : ''}`}
            >
              <Text style={styles.hideMenuChipIcon}>🚫</Text>
              <Text style={styles.hideMenuChipText} numberOfLines={1}>
                הסרה{hiddenAreaCount + hiddenCategoryCount > 0 ? ` · ${hiddenAreaCount + hiddenCategoryCount}` : ''}
              </Text>
              <View style={{ transform: [{ rotate: hideMenuOpen ? '180deg' : '0deg' }] }}>
                <ChevronDownIcon size={11} />
              </View>
            </Pressable>
            {hideMenuOpen && (
              <View style={styles.hideMenu} accessibilityRole="menu">
                <Pressable
                  style={styles.hideMenuItem}
                  onPress={() => { setHideMenuOpen(false); openHideCategoriesModal(); }}
                  accessibilityRole="menuitem"
                >
                  <Text style={styles.hideMenuItemText}>
                    {hiddenCategoryCount > 0 ? `🚫 ${hiddenCategoryCount} קטגוריות מוסתרות` : '🚫 הסר פעילויות מהחיפוש'}
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.hideMenuItem}
                  onPress={() => { setHideMenuOpen(false); openHideLocationsModal(); }}
                  accessibilityRole="menuitem"
                >
                  <Text style={styles.hideMenuItemText}>
                    {hiddenAreaCount > 0 ? `⛔ ${hiddenAreaCount} אזורים מוסתרים` : '⛔ הסר אזורים מהחיפוש'}
                  </Text>
                </Pressable>
              </View>
            )}
          </View>
        </View>

        {/* 🚗 Smart Radius Expansion - חיווי משני, לא modal ולא warning (סעיף M בבקשה): מוצג רק
            כשבאמת הורחב הרדיוס (searchMetadata.radiusExpanded), נעלם לגמרי אם לא היה צורך. */}
        {!loading && !loadError && searchMetadata.radiusExpanded ? (
          <View style={styles.radiusExpandedBanner}>
            <Text style={styles.radiusExpandedBannerText}>
              {searchMetadata.effectiveRadiusKm === 10
                ? 'הרחבנו קצת את החיפוש כדי למצוא לכם עוד פעילויות ✨'
                : 'הרחבנו את החיפוש עד 15 ק״מ כדי למצוא לכם עוד פעילויות ✨'}
            </Text>
          </View>
        ) : null}

        {loading ? (
          <View style={styles.emptyState}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : loadError ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>לא הצלחנו לטעון פעילויות: {loadError}</Text>
          </View>
        ) : filteredActivities.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>
              {filters.location?.travelMode === 'walking'
                ? 'לא מצאנו פעילויות ממש במרחק הליכה 🚶'
                : '😕 לא מצאנו פעילות שמתאימה בדיוק לחיפוש שלכם.'}
            </Text>
            <View style={styles.emptyWidenRow}>
              {/* "הליכה" הוא explicit constraint של המשתמש (בקשת המשתמש: "אל תרחיב את החיפוש ללא
                  ידיעת המשתמש") - לא מרחיבים רדיוס אוטומטית, רק מציעים כאן פעולה מפורשת שהמשתמש
                  צריך ללחוץ עליה. locationWithDrivingTime (lib/filterActivities.js) היא אותה
                  טרנספורמציה בדיוק שגם components/LocationQuickPicker.js משתמש בה כשעוזבים
                  הליכה - לא לוגיקה כפולה. */}
              {filters.location?.travelMode === 'walking' && (
                <Pressable style={styles.emptyWidenChip} onPress={() => setField('location', locationWithDrivingTime(filters.location, 10))}>
                  <Text style={styles.emptyWidenChipText}>🚗 חפשו עד 10 דק' נסיעה</Text>
                </Pressable>
              )}
              {filters.location?.mode && (
                <Pressable style={styles.emptyWidenChip} onPress={() => setField('location', DEFAULT_FILTERS.location)}>
                  <Text style={styles.emptyWidenChipText}>
                    📍 הראה בכל הארץ{widenPreviewCounts.location != null ? ` (${widenPreviewCounts.location})` : ''}
                  </Text>
                </Pressable>
              )}
              {(filters.hour?.option || filters.hour?.custom) && (
                <Pressable style={styles.emptyWidenChip} onPress={() => setField('hour', DEFAULT_FILTERS.hour)}>
                  <Text style={styles.emptyWidenChipText}>
                    🕐 הרחבת שעות{widenPreviewCounts.hour != null ? ` (${widenPreviewCounts.hour})` : ''}
                  </Text>
                </Pressable>
              )}
              {filters.category?.length > 0 && (
                <Pressable style={styles.emptyWidenChip} onPress={() => setField('category', DEFAULT_FILTERS.category)}>
                  <Text style={styles.emptyWidenChipText}>
                    🎯 הצגת כל הפעילויות{widenPreviewCounts.category != null ? ` (${widenPreviewCounts.category})` : ''}
                  </Text>
                </Pressable>
              )}
              {filters.when?.options?.length > 0 && (
                <Pressable style={styles.emptyWidenChip} onPress={() => setField('when', DEFAULT_FILTERS.when)}>
                  <Text style={styles.emptyWidenChipText}>
                    📅 בדיקת כל יום{widenPreviewCounts.when != null ? ` (${widenPreviewCounts.when})` : ''}
                  </Text>
                </Pressable>
              )}
            </View>
            <Pressable style={styles.emptyBtn} onPress={clearAll}>
              <Text style={styles.emptyBtnText}>נקה את כל הפילטרים</Text>
            </Pressable>
          </View>
        ) : (
          <>
            {/* VIEW - רשימה/מפה כ-segmented control ויזואלי אחד (track יחיד עם border, כל
                Pressable הוא "חצי" פנימי בלי מסגרת עצמאית) - אותו behavior/state בדיוק
                (viewMode), רק restyling. */}
            <View style={styles.viewToggleRow} accessibilityRole="tablist">
              <Pressable
                style={[styles.viewToggleBtn, viewMode === 'list' && styles.viewToggleBtnActive]}
                onPress={() => setViewMode('list')}
                accessibilityRole="tab"
                accessibilityState={{ selected: viewMode === 'list' }}
              >
                <Text style={[styles.viewToggleText, viewMode === 'list' && styles.viewToggleTextActive]}>📋 רשימה</Text>
              </Pressable>
              <Pressable
                style={[styles.viewToggleBtn, viewMode === 'map' && styles.viewToggleBtnActive]}
                onPress={() => setViewMode('map')}
                accessibilityRole="tab"
                accessibilityState={{ selected: viewMode === 'map' }}
              >
                <Text style={[styles.viewToggleText, viewMode === 'map' && styles.viewToggleTextActive]}>🗺️ מפה</Text>
              </Pressable>
            </View>

            {viewMode === 'map' ? (
              <ActivitiesMap activities={sortedActivities} deviceCoords={deviceCoords} />
            ) : spontaneousActive && spontaneousOpenCount === 0 ? (
              // 🪄 ספונטני, אבל שום דבר לא פתוח ברגע זה (סעיף 13 בבקשה) - לא מסך ריק: הודעה
              // ידידותית, ואם יש מידע אמיתי על "נפתח בקרוב" (spontaneousOpensSoon, לא ניחוש) -
              // מציגים אותו; אחרת מציעים להרחיב פילטרים, בלי להמציא פעילויות.
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>🪄 לא מצאנו משהו שמתאים בדיוק לעכשיו</Text>
                {spontaneousOpensSoon.length > 0 ? (
                  <>
                    <Text style={styles.spontaneousSoonTitle}>🕐 נפתחות בקרוב</Text>
                    {spontaneousOpensSoon.map((a) => (
                      <ActivityCard
                        key={a.id}
                        {...a}
                        onToggleFavorite={() => handleToggleFavorite(a.id)}
                        onToggleVisited={() => handleToggleVisited(a.id)}
                        onOpenNote={() => openNoteModal(a.id, a.title)}
                        onHide={() => handleHide(a.id)}
                      />
                    ))}
                  </>
                ) : (
                  <Text style={styles.emptyWidenChipText}>נסו להרחיב את המיקום או לשנות את הפילטרים.</Text>
                )}
              </View>
            ) : (
              <>
                {spontaneousActive && (
                  <Text style={styles.spontaneousTopTitle}>🪄 הכי מתאים עכשיו</Text>
                )}
                {(spontaneousActive ? spontaneousVisibleActivities : sortedActivities).map((a) => (
                  <ActivityCard
                    key={a.id}
                    {...a}
                    onToggleFavorite={() => handleToggleFavorite(a.id)}
                    onToggleVisited={() => handleToggleVisited(a.id)}
                    onOpenNote={() => openNoteModal(a.id, a.title)}
                    onHide={() => handleHide(a.id)}
                  />
                ))}
                {spontaneousActive && !showAllSpontaneous && filteredActivities.length > SPONTANEOUS_TOP_COUNT && (
                  <Pressable style={styles.showMoreBtn} onPress={() => setShowAllSpontaneous(true)}>
                    <Text style={styles.showMoreBtnText}>הצג עוד פעילויות ({filteredActivities.length - SPONTANEOUS_TOP_COUNT})</Text>
                  </Pressable>
                )}
              </>
            )}
          </>
        )}
      </ScrollView>
      <LoginRequiredModal visible={showLoginPrompt} onClose={() => setShowLoginPrompt(false)} />

      <Modal visible={!!noteModalTarget} transparent animationType="fade" onRequestClose={() => setNoteModalTarget(null)}>
        <Pressable style={styles.gateBackdrop} onPress={() => setNoteModalTarget(null)}>
          <Pressable style={styles.gateCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.noteModalTitle}>הערה אישית</Text>
            <Text style={styles.noteModalActivityName}>{noteModalTarget?.activity?.name}</Text>
            <TextInput
              style={styles.noteModalInput}
              value={noteModalDraft}
              onChangeText={setNoteModalDraft}
              multiline
              placeholder="כתבו כאן הערה פרטית..."
              placeholderTextColor={colors.textMuted}
            />
            <View style={styles.noteModalActionsRow}>
              <Pressable
                style={[styles.noteModalSaveBtn, savingNote && styles.noteModalBtnDisabled]}
                onPress={saveNoteModal}
                disabled={savingNote}
              >
                <Text style={styles.noteModalSaveBtnText}>{savingNote ? 'שומר...' : 'שמירת הערה'}</Text>
              </Pressable>
              <Pressable style={styles.noteModalCancelBtn} onPress={() => setNoteModalTarget(null)}>
                <Text style={styles.noteModalCancelBtnText}>ביטול</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <QuickPicker
        visible={hideCategoriesModalOpen}
        title="🚫 הסר פעילויות מהחיפוש"
        subtitle="בחרו דברים שאתם מעדיפים לא לראות בתוצאות."
        options={CATEGORY_FILTER_OPTIONS}
        value={hideDraft}
        multiple
        onChange={setHideDraft}
        onClose={handleConfirmHide}
        doneLabel="החלת הסינון"
        onReset={() => setHideDraft([])}
        footer={(
          <View>
            <Pressable style={styles.hideFooterRow} onPress={() => setSaveAsDefault((v) => !v)}>
              <View style={[styles.toggleSmall, saveAsDefault ? styles.toggleOnSmall : styles.toggleOffSmall]}>
                <View style={[styles.toggleDotSmall, !saveAsDefault && styles.toggleDotOffSmall]} />
              </View>
              <Text style={styles.hideFooterText}>שמור את הבחירה כברירת מחדל</Text>
            </Pressable>
            <Text style={styles.hideFooterHint}>הבחירה תישמר ותשמש אתכם גם בחיפושים הבאים.</Text>
          </View>
        )}
      />

      <LoginRequiredModal
        visible={showRegisterPromptForHide}
        onClose={() => setShowRegisterPromptForHide(false)}
        title="🔒 רוצים שתורו תזכור את ההעדפות שלכם?"
        message="הירשמו בחינם, ותוכלו לשמור את הבחירות שלכם ולהשתמש בהן בכל פעם שתחזרו."
        secondaryLabel="אולי אחר כך"
        onSecondary={() => setShowRegisterPromptForHide(false)}
      />

      <ExcludeAreasPicker
        visible={hideLocationsModalOpen}
        value={hideAreasDraft}
        onChange={setHideAreasDraft}
        onClose={handleConfirmHideCities}
        doneLabel="החלת הסינון"
        onReset={() => setHideAreasDraft({ regions: [], cities: [] })}
        footer={(
          <View>
            <Pressable style={styles.hideFooterRow} onPress={() => setSaveCityAsDefault((v) => !v)}>
              <View style={[styles.toggleSmall, saveCityAsDefault ? styles.toggleOnSmall : styles.toggleOffSmall]}>
                <View style={[styles.toggleDotSmall, !saveCityAsDefault && styles.toggleDotOffSmall]} />
              </View>
              <Text style={styles.hideFooterText}>שמור את הבחירה כברירת מחדל</Text>
            </Pressable>
            <Text style={styles.hideFooterHint}>הבחירה תישמר ותשמש אתכם גם בחיפושים הבאים.</Text>
          </View>
        )}
      />

      <LoginRequiredModal
        visible={showRegisterPromptForHideCities}
        onClose={() => setShowRegisterPromptForHideCities(false)}
        title="🔒 רוצים שתורו תזכור את ההעדפות שלכם?"
        message="הירשמו בחינם, ותוכלו לשמור את הבחירות שלכם ולהשתמש בהן בכל פעם שתחזרו."
        secondaryLabel="אולי אחר כך"
        onSecondary={() => setShowRegisterPromptForHideCities(false)}
      />

      <Modal visible={showGate} transparent animationType="fade" onRequestClose={() => setShowGate(false)}>
        <Pressable style={styles.gateBackdrop} onPress={() => setShowGate(false)}>
          <Pressable style={styles.gateCard} onPress={() => {}}>
            <Text style={styles.gateTitle}>מה מחפשים היום?</Text>
            <Text style={styles.gateSubtitle}>ספרו לנו קצת ונציג לכם פעילויות מתאימות</Text>

            <Pressable style={styles.gateRow} onPress={() => setGateCategoryOpen(true)}>
              <View style={styles.gateRowRight}>
                <Text style={styles.gateRowEmoji}>🌟</Text>
                <View>
                  <Text style={styles.gateRowLabel}>מה בא לנו?</Text>
                  <Text style={styles.gateRowValue}>{filters.category?.length ? categorySummary(filters.category) : 'כל סוגי הפעילויות'}</Text>
                </View>
              </View>
              <ChevronDownIcon />
            </Pressable>

            <Pressable style={styles.gateRow} onPress={() => setGateLocationOpen(true)}>
              <View style={styles.gateRowRight}>
                <Text style={styles.gateRowEmoji}>🏡</Text>
                <View>
                  <Text style={styles.gateRowLabel}>באיזור שלי</Text>
                  <Text style={styles.gateRowValue}>{filters.location?.mode ? locationSummary(filters.location) : 'איפה שנוח לכם'}</Text>
                </View>
              </View>
              <ChevronDownIcon />
            </Pressable>

            <Pressable style={styles.gateGoBtn} onPress={() => setShowGate(false)}>
              <Text style={styles.gateGoBtnText}>הצג פעילויות</Text>
            </Pressable>
            <Pressable onPress={() => setShowGate(false)} hitSlop={8}>
              <Text style={styles.gateSkipText}>דלגו, הראו לי הכל</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* מיקום נדרש עבור "ספונטני" - חלון שמסביר למה, במקום שורת-שגיאה קטנה שקל לפספס. תפריט-
          רקע/ביטול = חוזרים למסך כרגיל בלי שום הודעה (בקשת המשתמש: "בלי שקרה כלום"). */}
      <Modal visible={showLocationPermissionModal} transparent animationType="fade" onRequestClose={() => setShowLocationPermissionModal(false)}>
        <Pressable style={styles.gateBackdrop} onPress={() => setShowLocationPermissionModal(false)}>
          <Pressable style={styles.gateCard} onPress={() => {}}>
            <Text style={styles.gateTitle}>📍 נדרשת גישה למיקום</Text>
            <Text style={styles.gateSubtitle}>צריך לאשר גישה למיקום כדי להשתמש בכפתור הזה</Text>
            <Pressable style={styles.gateGoBtn} onPress={confirmLocationPermission}>
              <Text style={styles.gateGoBtnText}>אישור גישה למיקום</Text>
            </Pressable>
            <Pressable onPress={() => setShowLocationPermissionModal(false)} hitSlop={8}>
              <Text style={styles.gateSkipText}>ביטול</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
      <QuickPicker
        visible={gateCategoryOpen}
        title="מה בא לנו?"
        subtitle="אפשר לבחור כמה קטגוריות"
        options={CATEGORY_FILTER_OPTIONS}
        value={filters.category}
        multiple
        showAll
        onChange={(v) => setField('category', v)}
        onClose={() => setGateCategoryOpen(false)}
      />
      <LocationQuickPicker
        visible={gateLocationOpen}
        value={filters.location}
        onChange={(v) => setField('location', v)}
        onCoordsResolved={setDeviceCoords}
        onClose={() => setGateLocationOpen(false)}
        deviceCoords={deviceCoords}
      />

      {/* "סינון מתקדם" - נפתח כחלון צף (bottom sheet) מעל התוכן במקום להתרחב inline ולדחוף
          את התוצאות למטה. FiltersSheet עצמו (לוגיקה/עיצוב פנימי/כפתורים) לא השתנה בכלל -
          רק אופן ההצגה שלו (Modal+backdrop סביבו) השתנה. */}
      <Modal visible={sheetOpen} transparent animationType="slide" onRequestClose={() => setSheetOpen(false)}>
        <Pressable style={styles.filterSheetBackdrop} onPress={() => setSheetOpen(false)}>
          <Pressable style={styles.filterSheetContainer} onPress={(e) => e.stopPropagation()}>
            <View style={styles.filterSheetHandleRow}>
              <Pressable style={styles.filterSheetCloseBtn} onPress={() => setSheetOpen(false)} hitSlop={8}>
                <Text style={styles.filterSheetCloseBtnText}>✕</Text>
              </Pressable>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              <FiltersSheet
                filters={filters}
                onChange={setField}
                onClearAll={clearAll}
                onCoordsResolved={setDeviceCoords}
              />
            </ScrollView>
            {/* התוצאות כבר מתעדכנות בזמן-אמת מתחת (filteredActivities תלוי ב-filters), אז
                "חפש" רק סוגר את הפאנל וחושף אותן - לא מפעיל חיפוש נפרד. מוצג קבוע מתחת ל-
                ScrollView (לא בתוכו) כדי שיישאר גלוי גם כשגוללים בין סקשני הפילטרים. */}
            <Pressable style={styles.filterSheetSearchBtn} onPress={() => setSheetOpen(false)}>
              <Text style={styles.filterSheetSearchBtnText}>
                🔍 חפש{filteredActivities.length > 0 ? ` (${filteredActivities.length})` : ''}
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, paddingBottom: 40 },
  titleBlock: { marginTop: 24, marginBottom: 14 },
  pageTitle: { fontFamily: fonts.extraBold, fontSize: 19, color: colors.textPrimary, textAlign: 'right' },
  pageSubtitle: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.textSecondary, marginTop: 2, textAlign: 'right' },

  activeChipsRow: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  activeChip: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 6,
    backgroundColor: colors.accentTintLight, borderWidth: 1, borderColor: colors.accent,
    borderRadius: radii.pill, paddingVertical: 6, paddingHorizontal: 12,
  },
  activeChipText: { fontFamily: fonts.bold, fontSize: 12, color: colors.accent, maxWidth: 160 },
  activeChipRemove: { fontFamily: fonts.bold, fontSize: 11, color: colors.accent },

  // 🔎 חיפוש חופשי - כלי משני-אך-נגיש (סעיף 25 בבקשה: "כמו כלי ניווט, לא אזור עצמאי") - גוון
  // ניטרלי (card/border/textSecondary) בכוונה, לא accent-כחול כמו "🎯 סינון" ממש מתחתיו, כדי
  // שההיררכיה הוויזואלית תבדיל בין "כלי חיפוש נוסף" (עדין) ל"כלי הסינון המרכזי" (בולט יותר).
  freeSearchToggle: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card,
    borderRadius: radii.pill, paddingVertical: 9, marginBottom: 8,
  },
  freeSearchToggleIcon: { fontSize: 13 },
  freeSearchToggleText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary },
  freeSearchBox: {
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.borderLight,
    borderRadius: radii.lg, padding: 12, marginBottom: 14,
  },
  freeSearchInputRow: { flexDirection: 'row-reverse', gap: 8 },
  freeSearchInput: {
    flex: 1, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.pill, paddingVertical: 10, paddingHorizontal: 14,
    fontFamily: fonts.regular, fontSize: 13.5, color: colors.textPrimary, textAlign: 'right', writingDirection: 'rtl',
  },
  freeSearchBtn: {
    backgroundColor: colors.accent, borderRadius: radii.pill, paddingHorizontal: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  freeSearchBtnDisabled: { opacity: 0.5 },
  freeSearchBtnText: { fontFamily: fonts.bold, fontSize: 13, color: '#ffffff' },
  freeSearchClarifyText: { fontFamily: fonts.bold, fontSize: 13, color: colors.textPrimary, textAlign: 'right', marginBottom: 8 },
  freeSearchErrorText: { fontFamily: fonts.semiBold, fontSize: 11.5, color: colors.danger, textAlign: 'center', marginTop: 8 },

  advToggle: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1.5, borderColor: colors.accent, backgroundColor: colors.accentTintLight,
    borderRadius: radii.pill, paddingVertical: 10, marginBottom: 10,
  },
  advToggleIcon: { fontSize: 14 },
  advToggleText: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.accent },

  // RESULT CONTROLS - "↕️ מיון" בצד ימין, "🚫 הסרה" בצד שמאל, באותה שורה. flexWrap כדי שאם
  // התוויות הארוכות לא נכנסות ברוחב-מסך צר מאוד, הן יורדות לשורה חדשה במקום overflow אופקי.
  resultControlsRow: {
    flexDirection: 'row-reverse', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8,
    marginBottom: 10, zIndex: 15,
  },
  spontaneousTopTitle: { fontFamily: fonts.extraBold, fontSize: 15, color: colors.textPrimary, textAlign: 'right', marginBottom: 10 },
  spontaneousSoonTitle: { fontFamily: fonts.bold, fontSize: 14, color: colors.textPrimary, textAlign: 'center', marginTop: 4, marginBottom: 14 },
  showMoreBtn: { alignItems: 'center', paddingVertical: 12, marginTop: 4 },
  showMoreBtnText: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.accent },
  filterSheetBackdrop: { flex: 1, backgroundColor: 'rgba(20,30,35,0.5)', justifyContent: 'flex-end' },
  filterSheetContainer: {
    backgroundColor: colors.bg, borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    maxHeight: '85%', paddingHorizontal: spacing.xl, paddingTop: 10, paddingBottom: 30,
  },
  filterSheetHandleRow: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 4 },
  filterSheetCloseBtn: {
    width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
  },
  filterSheetCloseBtnText: { fontFamily: fonts.bold, fontSize: 14, color: colors.textSecondary },
  filterSheetSearchBtn: {
    backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 14,
    alignItems: 'center', marginTop: 12,
  },
  filterSheetSearchBtnText: { fontFamily: fonts.bold, fontSize: 15, color: '#fff' },

  // כפתורי "🚫 הסר פעילויות" / "⛔ אזורים שלא להציג" - במכוון שקטים/משניים (טקסט בלבד, בלי
  // מסגרת/רקע), בניגוד ל-advToggle הבולט למעלה - אלה פעולות מתקדמות, לא אמורות להתחרות עם
  // "סינון מתקדם". שני הכפתורים באותה שורה כדי לא לתפוס עוד שורה אנכית מיותרת בעמוד.
  // 🚫 "הסרה" - dropdown באותה משפחת-עיצוב בדיוק כמו sortChip/sortMenu (chip + תפריט-נפתח
  // absolute) - ה-chip הזה יושב בצד שמאל של השורה (בקשת המשתמש), אז התפריט מוצמד ל-left:0
  // (לא right:0 כמו sortMenu) כדי לא "לברוח" מקצה המסך.
  hideMenuWrap: { position: 'relative', zIndex: 15, alignItems: 'flex-start' },
  hideMenuChip: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 6,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card,
    borderRadius: radii.pill, paddingVertical: 8, paddingHorizontal: 14, minHeight: 36,
  },
  hideMenuChipIcon: { fontSize: 13 },
  hideMenuChipText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary },
  hideMenu: {
    position: 'absolute', top: '100%', left: 0, marginTop: 4, minWidth: 220,
    backgroundColor: colors.card, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    shadowColor: '#000', shadowOpacity: 0.12, shadowOffset: { width: 0, height: 4 }, shadowRadius: 10,
    elevation: 6, overflow: 'hidden', zIndex: 15,
  },
  hideMenuItem: {
    paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: colors.borderLight, minHeight: 44, justifyContent: 'center',
  },
  hideMenuItemText: { fontFamily: fonts.semiBold, fontSize: 13.5, color: colors.textPrimary, textAlign: 'right' },

  hideFooterRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, marginTop: 16 },
  hideFooterText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textPrimary },
  hideFooterHint: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, textAlign: 'right', marginTop: 4 },
  toggleSmall: { width: 38, height: 22, borderRadius: 11, justifyContent: 'center' },
  toggleOnSmall: { backgroundColor: colors.accent, alignItems: 'flex-start' },
  toggleOffSmall: { backgroundColor: colors.border, alignItems: 'flex-end' },
  toggleDotSmall: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#fff', marginHorizontal: 2 },
  toggleDotOffSmall: {},

  // ↕️ מיון - chip יחיד לא-נמתח (בניגוד ל-viewToggleBtn למטה, שם flex:1) כדי לא "להתחרות" עם
  // כפתורי רשימה/מפה מתחתיו - שורה נפרדת משלו, לא נדחס לאותה שורה (בקשת המשתמש: לא ליצור שורה
  // אופקית עמוסה ב-375px). zIndex גבוה כדי שהתפריט-הנפתח יופיע מעל viewToggleRow/כרטיסי-הפעילות
  // שמתחתיו, אותו עיקרון כמו CityAutocomplete הקיים.
  sortWrap: { position: 'relative', zIndex: 15, alignItems: 'flex-start' },
  sortChip: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 6,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card,
    borderRadius: radii.pill, paddingVertical: 8, paddingHorizontal: 14, minHeight: 36,
  },
  sortChipIcon: { fontSize: 13 },
  sortChipText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary },
  sortMenu: {
    position: 'absolute', top: '100%', right: 0, marginTop: 4, minWidth: 190,
    backgroundColor: colors.card, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    shadowColor: '#000', shadowOpacity: 0.12, shadowOffset: { width: 0, height: 4 }, shadowRadius: 10,
    elevation: 6, overflow: 'hidden', zIndex: 15,
  },
  sortMenuItem: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: colors.borderLight, minHeight: 44,
  },
  sortMenuItemSelected: { backgroundColor: colors.accentTintLight },
  sortMenuItemText: { fontFamily: fonts.semiBold, fontSize: 13.5, color: colors.textPrimary },
  sortMenuItemTextSelected: { color: colors.accent, fontFamily: fonts.bold },
  sortMenuItemCheck: { fontFamily: fonts.bold, fontSize: 13, color: colors.accent },

  // רשימה/מפה - segmented control ויזואלי אחד: track יחיד עם מסגרת+padding, וכל "חצי" פנימי
  // בלי מסגרת עצמאית משלו (בניגוד לשני כפתורי-pill נפרדים כמו קודם).
  viewToggleRow: {
    flexDirection: 'row-reverse', gap: 4, marginBottom: 12, padding: 4,
    borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card,
  },
  viewToggleBtn: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: radii.pill },
  viewToggleBtnActive: { backgroundColor: colors.accent },
  viewToggleText: { fontFamily: fonts.bold, fontSize: 13, color: colors.textSecondary },
  viewToggleTextActive: { color: '#fff' },

  radiusExpandedBanner: {
    backgroundColor: colors.accentTintLight, borderRadius: radii.md, paddingVertical: 9, paddingHorizontal: 14, marginBottom: 12,
  },
  radiusExpandedBannerText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.accent, textAlign: 'center' },

  emptyState: { alignItems: 'center', paddingVertical: 30, paddingHorizontal: 10 },
  emptyTitle: { fontFamily: fonts.semiBold, fontSize: 14, color: colors.textSecondary, textAlign: 'center', marginBottom: 14 },
  emptyWidenRow: { flexDirection: 'row-reverse', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginBottom: 14 },
  emptyWidenChip: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, borderRadius: radii.pill, paddingVertical: 8, paddingHorizontal: 14 },
  emptyWidenChipText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textSecondary },
  emptyBtn: { borderWidth: 1.5, borderColor: colors.accent, borderRadius: radii.pill, paddingVertical: 11, paddingHorizontal: 18 },
  emptyBtnText: { fontFamily: fonts.bold, fontSize: 13, color: colors.accent },

  gateBackdrop: { flex: 1, backgroundColor: 'rgba(20,30,35,0.5)', justifyContent: 'center', padding: spacing.xl },
  gateCard: { backgroundColor: colors.card, borderRadius: radii.xl, padding: spacing.xl },

  noteModalTitle: { fontFamily: fonts.extraBold, fontSize: 17, color: colors.textPrimary, textAlign: 'center', marginBottom: 4 },
  noteModalActivityName: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginBottom: 14 },
  noteModalInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12, marginBottom: 14,
    fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, backgroundColor: colors.bg,
    textAlign: 'right', writingDirection: 'rtl', minHeight: 90, textAlignVertical: 'top',
  },
  noteModalActionsRow: { flexDirection: 'row-reverse', gap: 10 },
  noteModalCancelBtn: { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border },
  noteModalCancelBtnText: { fontFamily: fonts.bold, fontSize: 14, color: colors.textSecondary },
  noteModalSaveBtn: { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: radii.pill, backgroundColor: colors.accent },
  noteModalBtnDisabled: { opacity: 0.5 },
  noteModalSaveBtnText: { fontFamily: fonts.bold, fontSize: 14, color: '#fff' },
  gateTitle: { fontFamily: fonts.extraBold, fontSize: 18, color: colors.textPrimary, textAlign: 'center' },
  gateSubtitle: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: 'center', marginTop: 4, marginBottom: 18 },
  gateRow: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, padding: 14, marginBottom: 10,
  },
  gateRowRight: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10, flexShrink: 1 },
  gateRowEmoji: { fontSize: 22 },
  gateRowLabel: { fontFamily: fonts.bold, fontSize: 14, color: colors.textPrimary, textAlign: 'right' },
  gateRowValue: { fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary, textAlign: 'right', marginTop: 1 },
  gateGoBtn: {
    backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 14,
    alignItems: 'center', marginTop: 8, marginBottom: 12,
  },
  gateGoBtnText: { fontFamily: fonts.bold, fontSize: 15, color: '#fff' },
  gateSkipText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textMuted, textAlign: 'center', textDecorationLine: 'underline' },
});
