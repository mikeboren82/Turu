import { useState, useMemo, useEffect } from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator, Modal, TextInput } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as Location from 'expo-location';
import Header from '../components/Header';
import SkyBackground from '../components/SkyBackground';
import LoginRequiredModal from '../components/LoginRequiredModal';
import ActivityCard from '../components/ActivityCard';
import ActivitiesMap from '../components/ActivitiesMap';
import FiltersSheet from '../components/FiltersSheet';
import QuickPicker from '../components/QuickPicker';
import ExcludeAreasPicker from '../components/ExcludeAreasPicker';
import LocationQuickPicker, { locationSummary } from '../components/LocationQuickPicker';
import { ChevronDownIcon } from '../components/icons';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { fetchApprovedActivities, formatSearchDistance, fetchSettlementCoords } from '../lib/activities';
import { fetchUserActivityFlags, toggleFavorite, toggleVisited, toggleHidden, savePersonalNote, fetchAllPersonalNotes } from '../lib/interactions';
import { fetchUserPreferences, saveExcludedCategories, saveExcludedCities, saveExcludedRegions } from '../lib/preferences';
import { supabase } from '../lib/supabase';
import { DEFAULT_FILTERS, CATEGORY_FILTER_OPTIONS } from '../constants/filterSchema';
import { categorySummary } from '../lib/filterSummaries';
import { rankActivitiesWithSmartRadius, countActiveFilters, normalizeFilters, getOpenNowInfo, haversineKm, locationWithDrivingTime } from '../lib/filterActivities';
import { formatBenefitCardTag } from '../lib/benefits';
import { parseSmartSearchQuery, intentToFilters } from '../lib/smartSearch';
import { t, useI18n, createStyles } from '../lib/i18n';
import { formatKm } from '../lib/i18n/format';

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
    parts.push(t('activities.spontaneous.badge.openNow'));
  } else if (openInfo.minutesUntilOpenToday != null) {
    parts.push(t('activities.spontaneous.badge.opensIn', { minutes: openInfo.minutesUntilOpenToday }));
  } else if (!openInfo.hasScheduleData) {
    return null;
  }
  if (BOOKING_REQUIRED_VALUES.includes(activity.booking_requirement)) {
    parts.push(t('activities.spontaneous.badge.bookingRequired'));
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(String(value)); } catch { return fallback; }
}

// כפתור "🎯 סינון" - סיכום קומפקטי במקום צ'יפים נפרדים (בקשת המשתמש 2026-09-16: "the first
// real Activity card should appear as early as possible" - שורת-chips קבועה מתחת ל-toolbar
// הוסרה, ה-FilterSheet עצמו נשאר המקום היחיד לערוך/להסיר פילטר בודד). מיקום קודם (geographic
// scope), אחריו קטגוריה, ואז +N לכל שאר הסינונים הפעילים - "N" מגיע מ-countActiveFilters (אותו
// מונה בדיוק שמזין את ה-badge הישן), לא ספירה מקבילה. תמיד תצוגה בלבד מ-state קנוני - לעולם
// לא פרסינג הפוך של הטקסט חזרה לפילטר.
function activitiesFilterSummary(filters) {
  const segments = [];
  if (filters.location?.mode) segments.push(locationSummary(filters.location));
  if (filters.category?.length) segments.push(categorySummary(filters.category));
  if (segments.length === 0) {
    const total = countActiveFilters(filters);
    return total > 0 ? t('activities.header.filterSummaryCountOnly', { count: total }) : null;
  }
  const remaining = countActiveFilters(filters) - segments.length;
  const joined = segments.join(' · ');
  return remaining > 0 ? t('activities.header.filterSummaryMore', { summary: joined, count: remaining }) : joined;
}

export default function ActivitiesScreen() {
  const router = useRouter();
  const { t, locale } = useI18n();
  const { homeFilters, homeCoords, openFilters, view, spontaneous } = useLocalSearchParams();
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
  // תצוגה/מיון - Modal קטן נפרד מ-sheetOpen (הפילטרים), אותו recipe בדיוק (Modal transparent
  // animationType="slide" + backdrop) רק בגודל קטן משמעותית - שני radio-groups בלבד (תצוגה/מיון),
  // לא accordion שלם. סוגר את sheetOpen כשנפתח (ולהפך, ראו onPress למטה) כדי שלעולם לא יהיו
  // שני Modal-ים פתוחים יחד.
  const [displaySheetOpen, setDisplaySheetOpen] = useState(false);
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
  // { message, pendingIntent, mode:'plain'|'street' } - כל עוד לא null, LocationQuickPicker (למטה, ליד
  // ה-gate) פתוח; הבחירה נסגרת דרך handleClarifyPickerClose. אין יותר תיבת-עיר מקומית.
  const [freeSearchClarify, setFreeSearchClarify] = useState(null);

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
        if (!cancelled) setLoadError(err?.message || 'error');
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
      setSpontaneousError('activities.spontaneous.error');
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

  // "⚡ עכשיו" עבר להיות טריגר מעמוד הבית בלבד (למשתמשים מחוברים) - לא עוד chip בתוך
  // FiltersSheet. אותו zרימת-הרשאה בדיוק כמו לחיצה ידנית על הכפתור הישן (toggleSpontaneous
  // עצמו, בלי עותק מקביל) - רק מופעל פעם אחת אוטומטית ב-mount כש-spontaneous=true הגיע
  // ב-route param, בדיוק כמו openFilters/view למעלה.
  useEffect(() => {
    if (spontaneous === 'true') toggleSpontaneous();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        // השרת (smart-search) מחזיר תמיד '📍 באיזו עיר?' - מוצג מהמפתח המקומי כדי שיתורגם.
        setFreeSearchClarify({ messageKey: 'activities.freeSearch.clarifyCity', pendingIntent: data.intent, mode: 'street' });
        return;
      }
      const loc = data.intent.location;
      const hasAnyLocation = !!(loc.city || loc.region || loc.street || loc.coords);
      if (!hasAnyLocation && !filters.location?.mode) {
        setFreeSearchClarify({ messageKey: 'activities.freeSearch.clarifyArea', pendingIntent: data.intent, mode: 'plain' });
        return;
      }
      applyFreeSearchIntent(data.intent);
    } catch {
      setFreeSearchError('activities.freeSearch.errorRephrase');
    } finally {
      setFreeSearchLoading(false);
    }
  };

  // סגירת LocationQuickPicker של ההבהרה (CTA "הציגו לי פעילויות" או לחיצה על הרקע). onChange של
  // הפיקר כבר כתב את הבחירה ל-filters.location בזמן-אמת (אותו חיווט כמו ה-gate), אז כאן רק
  // ממשיכים את החיפוש שהמשתמש הקליד:
  //  - 'plain' (לא הוזכר מיקום בטקסט): applyFreeSearchIntent עם ה-intent המקורי - intentToFilters
  //    כבר נופל ל-fallbackLocation=filters.location כשב-intent אין מיקום, בלי להמציא עיר.
  //  - 'street' (רחוב בלי עיר, הפונקציה ביקשה "באיזו עיר?"): אם נבחרה עיר בפיקר - סבב-הבהרה לשרת
  //    עם cityOverride (גאוקודינג של רחוב+עיר, בדיוק כמו קודם); אם נבחר משהו אחר (אזור/GPS/בכל
  //    הארץ) - אין עיר לגאוקד, מחפשים לפי המיקום שנבחר ומוותרים על הרחוב (לא מנחשים עיר).
  //  - נסגר בלי לבחור כלום: מבטלים את ההבהרה, הטקסט שהוקלד נשאר בשדה.
  const handleClarifyPickerClose = async () => {
    const clarify = freeSearchClarify;
    if (!clarify) return;
    const loc = filters.location;
    if (!loc?.mode) { setFreeSearchClarify(null); return; }
    if (clarify.mode === 'street' && loc.mode === 'city' && (loc.city || '').trim()) {
      setFreeSearchError('');
      setFreeSearchLoading(true);
      try {
        const data = await parseSmartSearchQuery(freeSearchText, { cityOverride: loc.city.trim(), pendingIntent: clarify.pendingIntent });
        if (data.needsClarification) {
          setFreeSearchError('activities.freeSearch.errorLocation');
          setFreeSearchClarify(null);
          return;
        }
        applyFreeSearchIntent(data.intent);
      } catch {
        setFreeSearchError('activities.freeSearch.errorUnderstand');
        setFreeSearchClarify(null);
      } finally {
        setFreeSearchLoading(false);
      }
      return;
    }
    applyFreeSearchIntent(clarify.pendingIntent);
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
      console.error('Failed to save personal note:', err);
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
            ? t('domain.distance.fromYou', { km: formatKm(spontaneousKm) })
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
    // locale: {...a} מעתיק את ערכי ה-getters (ageRange/price/hours) - חישוב מחדש בהחלפת שפה.
    [rankedResult, hiddenIds, favoriteIds, visitedIds, notesByActivity, benefitClubs, spontaneousActive, spontaneousCoords, searchOriginCoords, filters.location?.mode, locale]
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
  // כפתור "🎯 סינון" - סיכום קומפקטי (activitiesFilterSummary למעלה), לא עוד badge מספרי +
  // שורת-chips נפרדת מתחת. spontaneousActive לא נכלל כאן בכוונה - הוא כבר לא "פילטר" בכלל
  // (עבר להיות trigger מעמוד הבית, ראו handleSpontaneous/useEffect(spontaneous) - סעיף 6
  // בתוכנית), אז אין לו ייצוג בתקציר-הסינון.
  const filterSummary = useMemo(() => activitiesFilterSummary(filters), [filters, locale]);
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
      <SkyBackground />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Header showBack onMenuPress={() => {}} />

        {/* כותרת = זהות קבועה ("כל הפעילויות") + ספירה קומפקטית צמודה (בקשת המשתמש 2026-09-16
            השנייה: "the first real Activity card should appear as early as possible" - לא עוד
            שורת-subtitle נפרדת, לא עוד List/Map כאן - הם עברו ל"תצוגה/מיון" ב-toolbar, ראו למטה). */}
        <View style={styles.titleBlock}>
          <View style={styles.titleRow}>
            <Text style={styles.pageTitle} numberOfLines={1}>{t('activities.header.title')}</Text>
            <Text style={styles.titleCount} numberOfLines={1}>
              {isDiscoveryMode ? t('activities.header.discoverySubtitle') : t('activities.header.count', { count: filteredActivities.length })}
            </Text>
          </View>
        </View>

        {/* TOOLBAR - שלושה controls בלבד: סינון (תקציר-מצב קומפקט במקום badge+שורת-chips נפרדת
            מתחת, ראו activitiesFilterSummary למעלה), תצוגה/מיון (מאחד את "📍 לפי מרחק" + "רשימה/
            מפה" הישנים לכפתור אחד), חיפוש. Filter מקבל flex:1 (הכי הרבה מקום, לתקציר הארוך
            מבין השלושה) - Search/תצוגה-ומיון בגודל-תוכן בלבד, לא flex:1 שווה כמו קודם. */}
        <View style={styles.toolbarRow}>
          <Pressable
            style={[styles.toolbarChip, styles.toolbarChipFlexible, styles.toolbarChipPrimary, activeCount > 0 && styles.toolbarChipPrimaryActive]}
            onPress={() => { setDisplaySheetOpen(false); setSheetOpen((v) => !v); }}
            accessibilityRole="button"
            accessibilityLabel={activeCount > 0 ? t('activities.header.filterA11yWithCount', { count: activeCount }) : t('activities.header.filterLabel')}
          >
            <Text style={styles.toolbarChipIcon}>🎯</Text>
            <Text style={styles.toolbarChipTextPrimary} numberOfLines={1} ellipsizeMode="tail">
              {filterSummary ? `${filterSummary}` : t('activities.header.filterLabel')}
            </Text>
          </Pressable>

          {/* "תצוגה/מיון" - מאחד את "📍 לפי מרחק" (toggle בינארי) ואת "רשימה/מפה" (היה בשורת-
              הכותרת) לכפתור אחד קומפקטי; פותח sheet קטן (displaySheetOpen) עם שני radio-groups
              (סעיף 9-10 בבקשה) במקום דרישה תמידית לשני controls נפרדים. שקט (⚙️ בלבד, בלי accent)
              כברירת מחדל; מציג את המצב הלא-ברירת-מחדל בטקסט כשיש (אותו אימוג'י שכבר קיים ל-
              "מרחק"/"מפה", אותו toolbarChipPrimaryActive שכבר קיים ל-active). סוגר את sheetOpen
              (הפילטרים) אם פתוח - לעולם לא שני Modal-ים יחד. */}
          <Pressable
            style={[styles.toolbarChip, styles.toolbarChipCompact, (sortMode === 'distance' || viewMode === 'map') && styles.toolbarChipPrimaryActive]}
            onPress={() => { setSheetOpen(false); setDisplaySheetOpen(true); }}
            accessibilityRole="button"
            accessibilityLabel={t('activities.display.a11y', {
              view: t(viewMode === 'map' ? 'activities.display.map' : 'activities.display.list'),
              sort: t(sortMode === 'distance' ? 'activities.display.byDistance' : 'activities.display.recommended'),
            })}
          >
            <Text
              style={[styles.toolbarChipText, (sortMode === 'distance' || viewMode === 'map') && styles.toolbarChipTextPrimary]}
              numberOfLines={1}
            >
              {viewMode === 'map' && sortMode === 'distance'
                ? t('activities.display.chipMapDistance')
                : viewMode === 'map'
                  ? t('activities.display.chipMap')
                  : sortMode === 'distance'
                    ? t('activities.display.chipDistance')
                    : '⚙️'}
            </Text>
          </Pressable>

          {/* 🔎 חיפוש חופשי - גישה מהירה לאותו Smart Search Engine, פותח/סוגר inline מתחת ל-
              toolbar, בלי ניווט למסך חדש - ראו handleFreeSearch/applyFreeSearchIntent למעלה. */}
          <Pressable style={[styles.toolbarChip, styles.toolbarChipCompact]} onPress={() => setFreeSearchOpen((v) => !v)} accessibilityRole="button">
            <Text style={styles.toolbarChipIcon}>🔍</Text>
            <Text style={styles.toolbarChipText} numberOfLines={1}>{t('common.actions.search')}</Text>
          </Pressable>
        </View>

        {/* "⚡ עכשיו" - הטריגר עבר לעמוד הבית (משתמשים מחוברים בלבד, ראו app/index.js), אבל
            כל עוד המצב פעיל (הגיע דרך route param spontaneous=true) חייבת להישאר דרך לכבות
            אותו בלי לחזור לעמוד הבית - הצ'יפ הישן (FiltersSheet) ושורת ה-active-chips (שגם
            אפשרה את זה) שניהם נעלמו. שקט/מותנה לגמרי (כמו radiusExpandedBanner מתחת) - לא
            תופס מקום כשלא רלוונטי. */}
        {spontaneousActive ? (
          <Pressable onPress={toggleSpontaneous} hitSlop={8} style={styles.spontaneousOffLink}>
            <Text style={styles.spontaneousOffLinkText}>{t('activities.spontaneous.offLink')}</Text>
          </Pressable>
        ) : null}

        {freeSearchOpen && (
          <View style={styles.freeSearchBox}>
            {/* הבהרת-מיקום (2026-09-16, בקשת המשתמש): במקום תיבת-עיר מקומית ("📍 באיזה אזור לחפש?"
                + CityAutocomplete) נפתח *אותו* LocationQuickPicker כמו "איפה נח לכם?" בעמוד הבית
                (ראו ה-Modal למטה ליד ה-gate, ו-handleClarifyPickerClose). כאן נשארת רק שורת-ההסבר,
                שורת-החיפוש עצמה נשארת גלויה מתחתיה. */}
            {freeSearchClarify ? (
              <Text style={styles.freeSearchClarifyText}>{t(freeSearchClarify.messageKey)}</Text>
            ) : null}
            <View style={styles.freeSearchInputRow}>
                <TextInput
                  style={styles.freeSearchInput}
                  placeholder={t('activities.freeSearch.placeholder')}
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
                  {freeSearchLoading ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.freeSearchBtnText}>{t('common.actions.search')}</Text>}
                </Pressable>
            </View>
            {freeSearchError ? <Text style={styles.freeSearchErrorText}>{t(freeSearchError)}</Text> : null}
          </View>
        )}

        {/* שורת ה-active-filter-chips הקבועה הוסרה (בקשת המשתמש 2026-09-16 השנייה: "the user
            came here to see activities" - כל המידע שהיא נשאה עבר לתקציר בכפתור "🎯 סינון"
            עצמו, ראו activitiesFilterSummary למעלה). FiltersSheet נשאר המקום היחיד לערוך/
            להסיר פילטר בודד - אין יותר × על המסך הזה. */}
        {spontaneousError ? <Text style={styles.freeSearchErrorText}>{t(spontaneousError)}</Text> : null}

        {/* 🚗 Smart Radius Expansion - חיווי משני, לא modal ולא warning (סעיף M בבקשה): מוצג רק
            כשבאמת הורחב הרדיוס (searchMetadata.radiusExpanded), נעלם לגמרי אם לא היה צורך. */}
        {!loading && !loadError && searchMetadata.radiusExpanded ? (
          <View style={styles.radiusExpandedBanner}>
            <Text style={styles.radiusExpandedBannerText}>
              {searchMetadata.effectiveRadiusKm === 10
                ? t('activities.smartRadius.expandedSmall')
                : t('activities.smartRadius.expandedTo15')}
            </Text>
          </View>
        ) : null}

        {loading ? (
          <View style={styles.emptyState}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : loadError ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>{t('activities.results.loadError')}</Text>
          </View>
        ) : filteredActivities.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>
              {filters.location?.travelMode === 'walking'
                ? t('activities.results.emptyWalking')
                : t('activities.results.empty')}
            </Text>
            <View style={styles.emptyWidenRow}>
              {/* "הליכה" הוא explicit constraint של המשתמש (בקשת המשתמש: "אל תרחיב את החיפוש ללא
                  ידיעת המשתמש") - לא מרחיבים רדיוס אוטומטית, רק מציעים כאן פעולה מפורשת שהמשתמש
                  צריך ללחוץ עליה. locationWithDrivingTime (lib/filterActivities.js) היא אותה
                  טרנספורמציה בדיוק שגם components/LocationQuickPicker.js משתמש בה כשעוזבים
                  הליכה - לא לוגיקה כפולה. */}
              {filters.location?.travelMode === 'walking' && (
                <Pressable style={styles.emptyWidenChip} onPress={() => setField('location', locationWithDrivingTime(filters.location, 10))}>
                  <Text style={styles.emptyWidenChipText}>{t('activities.results.widen.driving10')}</Text>
                </Pressable>
              )}
              {filters.location?.mode && (
                <Pressable style={styles.emptyWidenChip} onPress={() => setField('location', DEFAULT_FILTERS.location)}>
                  <Text style={styles.emptyWidenChipText}>
                    {widenPreviewCounts.location != null
                      ? t('activities.results.widen.withCount', { label: t('activities.results.widen.nationwide'), count: widenPreviewCounts.location })
                      : t('activities.results.widen.nationwide')}
                  </Text>
                </Pressable>
              )}
              {(filters.hour?.option || filters.hour?.custom) && (
                <Pressable style={styles.emptyWidenChip} onPress={() => setField('hour', DEFAULT_FILTERS.hour)}>
                  <Text style={styles.emptyWidenChipText}>
                    {widenPreviewCounts.hour != null
                      ? t('activities.results.widen.withCount', { label: t('activities.results.widen.hours'), count: widenPreviewCounts.hour })
                      : t('activities.results.widen.hours')}
                  </Text>
                </Pressable>
              )}
              {filters.category?.length > 0 && (
                <Pressable style={styles.emptyWidenChip} onPress={() => setField('category', DEFAULT_FILTERS.category)}>
                  <Text style={styles.emptyWidenChipText}>
                    {widenPreviewCounts.category != null
                      ? t('activities.results.widen.withCount', { label: t('activities.results.widen.allCategories'), count: widenPreviewCounts.category })
                      : t('activities.results.widen.allCategories')}
                  </Text>
                </Pressable>
              )}
              {filters.when?.options?.length > 0 && (
                <Pressable style={styles.emptyWidenChip} onPress={() => setField('when', DEFAULT_FILTERS.when)}>
                  <Text style={styles.emptyWidenChipText}>
                    {widenPreviewCounts.when != null
                      ? t('activities.results.widen.withCount', { label: t('activities.results.widen.anyDay'), count: widenPreviewCounts.when })
                      : t('activities.results.widen.anyDay')}
                  </Text>
                </Pressable>
              )}
            </View>
            <Pressable style={styles.emptyBtn} onPress={clearAll}>
              <Text style={styles.emptyBtnText}>{t('activities.results.clearAllFilters')}</Text>
            </Pressable>
          </View>
        ) : (
          <>
            {/* רשימה/מפה - הבחירה עצמה עברה לשורת ה-subtitle למעלה (ליד מספר התוצאות), כאן רק
                המשך-הרינדור לפי viewMode - אותו state/behavior בדיוק. */}
            {viewMode === 'map' ? (
              <ActivitiesMap activities={sortedActivities} deviceCoords={deviceCoords} />
            ) : spontaneousActive && spontaneousOpenCount === 0 ? (
              // 🪄 ספונטני, אבל שום דבר לא פתוח ברגע זה (סעיף 13 בבקשה) - לא מסך ריק: הודעה
              // ידידותית, ואם יש מידע אמיתי על "נפתח בקרוב" (spontaneousOpensSoon, לא ניחוש) -
              // מציגים אותו; אחרת מציעים להרחיב פילטרים, בלי להמציא פעילויות.
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>{t('activities.spontaneous.emptyTitle')}</Text>
                {spontaneousOpensSoon.length > 0 ? (
                  <>
                    <Text style={styles.spontaneousSoonTitle}>{t('activities.spontaneous.opensSoonTitle')}</Text>
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
                  <Text style={styles.emptyWidenChipText}>{t('activities.spontaneous.emptyHint')}</Text>
                )}
              </View>
            ) : (
              <>
                {spontaneousActive && (
                  <Text style={styles.spontaneousTopTitle}>{t('activities.spontaneous.topTitle')}</Text>
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
                    <Text style={styles.showMoreBtnText}>{t('activities.spontaneous.showMore', { count: filteredActivities.length - SPONTANEOUS_TOP_COUNT })}</Text>
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
            <Text style={styles.noteModalTitle}>{t('activities.note.title')}</Text>
            <Text style={styles.noteModalActivityName}>{noteModalTarget?.activity?.name}</Text>
            <TextInput
              style={styles.noteModalInput}
              value={noteModalDraft}
              onChangeText={setNoteModalDraft}
              multiline
              placeholder={t('activities.note.placeholder')}
              placeholderTextColor={colors.textMuted}
            />
            <View style={styles.noteModalActionsRow}>
              <Pressable
                style={[styles.noteModalSaveBtn, savingNote && styles.noteModalBtnDisabled]}
                onPress={saveNoteModal}
                disabled={savingNote}
              >
                <Text style={styles.noteModalSaveBtnText}>{savingNote ? t('common.actions.saving') : t('activities.note.save')}</Text>
              </Pressable>
              <Pressable style={styles.noteModalCancelBtn} onPress={() => setNoteModalTarget(null)}>
                <Text style={styles.noteModalCancelBtnText}>{t('common.actions.cancel')}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <QuickPicker
        visible={hideCategoriesModalOpen}
        title={t('activities.hide.categoriesTitle')}
        subtitle={t('activities.hide.categoriesSubtitle')}
        options={CATEGORY_FILTER_OPTIONS}
        value={hideDraft}
        multiple
        onChange={setHideDraft}
        onClose={handleConfirmHide}
        doneLabel={t('activities.hide.apply')}
        onReset={() => setHideDraft([])}
        footer={(
          <View>
            <Pressable style={styles.hideFooterRow} onPress={() => setSaveAsDefault((v) => !v)}>
              <View style={[styles.toggleSmall, saveAsDefault ? styles.toggleOnSmall : styles.toggleOffSmall]}>
                <View style={[styles.toggleDotSmall, !saveAsDefault && styles.toggleDotOffSmall]} />
              </View>
              <Text style={styles.hideFooterText}>{t('activities.hide.saveAsDefault')}</Text>
            </Pressable>
            <Text style={styles.hideFooterHint}>{t('activities.hide.saveAsDefaultHint')}</Text>
          </View>
        )}
      />

      <LoginRequiredModal
        visible={showRegisterPromptForHide}
        onClose={() => setShowRegisterPromptForHide(false)}
        title={t('activities.hide.registerTitle')}
        message={t('activities.hide.registerMessage')}
        secondaryLabel={t('activities.hide.registerLater')}
        onSecondary={() => setShowRegisterPromptForHide(false)}
      />

      <ExcludeAreasPicker
        visible={hideLocationsModalOpen}
        value={hideAreasDraft}
        onChange={setHideAreasDraft}
        onClose={handleConfirmHideCities}
        doneLabel={t('activities.hide.apply')}
        onReset={() => setHideAreasDraft({ regions: [], cities: [] })}
        footer={(
          <View>
            <Pressable style={styles.hideFooterRow} onPress={() => setSaveCityAsDefault((v) => !v)}>
              <View style={[styles.toggleSmall, saveCityAsDefault ? styles.toggleOnSmall : styles.toggleOffSmall]}>
                <View style={[styles.toggleDotSmall, !saveCityAsDefault && styles.toggleDotOffSmall]} />
              </View>
              <Text style={styles.hideFooterText}>{t('activities.hide.saveAsDefault')}</Text>
            </Pressable>
            <Text style={styles.hideFooterHint}>{t('activities.hide.saveAsDefaultHint')}</Text>
          </View>
        )}
      />

      <LoginRequiredModal
        visible={showRegisterPromptForHideCities}
        onClose={() => setShowRegisterPromptForHideCities(false)}
        title={t('activities.hide.registerTitle')}
        message={t('activities.hide.registerMessage')}
        secondaryLabel={t('activities.hide.registerLater')}
        onSecondary={() => setShowRegisterPromptForHideCities(false)}
      />

      <Modal visible={showGate} transparent animationType="fade" onRequestClose={() => setShowGate(false)}>
        <Pressable style={styles.gateBackdrop} onPress={() => setShowGate(false)}>
          <Pressable style={styles.gateCard} onPress={() => {}}>
            <Text style={styles.gateTitle}>{t('activities.gate.title')}</Text>
            <Text style={styles.gateSubtitle}>{t('activities.gate.subtitle')}</Text>

            <Pressable style={styles.gateRow} onPress={() => setGateCategoryOpen(true)}>
              <View style={styles.gateRowRight}>
                <Text style={styles.gateRowEmoji}>🌟</Text>
                <View>
                  <Text style={styles.gateRowLabel}>{t('activities.gate.categoryLabel')}</Text>
                  <Text style={styles.gateRowValue}>{filters.category?.length ? categorySummary(filters.category) : t('activities.gate.categoryAll')}</Text>
                </View>
              </View>
              <ChevronDownIcon />
            </Pressable>

            <Pressable style={styles.gateRow} onPress={() => setGateLocationOpen(true)}>
              <View style={styles.gateRowRight}>
                <Text style={styles.gateRowEmoji}>🏡</Text>
                <View>
                  <Text style={styles.gateRowLabel}>{t('activities.gate.locationLabel')}</Text>
                  <Text style={styles.gateRowValue}>{filters.location?.mode ? locationSummary(filters.location) : t('activities.gate.locationAny')}</Text>
                </View>
              </View>
              <ChevronDownIcon />
            </Pressable>

            <Pressable style={styles.gateGoBtn} onPress={() => setShowGate(false)}>
              <Text style={styles.gateGoBtnText}>{t('activities.gate.go')}</Text>
            </Pressable>
            <Pressable onPress={() => setShowGate(false)} hitSlop={8}>
              <Text style={styles.gateSkipText}>{t('activities.gate.skip')}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* מיקום נדרש עבור "ספונטני" - חלון שמסביר למה, במקום שורת-שגיאה קטנה שקל לפספס. תפריט-
          רקע/ביטול = חוזרים למסך כרגיל בלי שום הודעה (בקשת המשתמש: "בלי שקרה כלום"). */}
      <Modal visible={showLocationPermissionModal} transparent animationType="fade" onRequestClose={() => setShowLocationPermissionModal(false)}>
        <Pressable style={styles.gateBackdrop} onPress={() => setShowLocationPermissionModal(false)}>
          <Pressable style={styles.gateCard} onPress={() => {}}>
            <Text style={styles.gateTitle}>{t('activities.locationPermission.title')}</Text>
            <Text style={styles.gateSubtitle}>{t('activities.locationPermission.subtitle')}</Text>
            <Pressable style={styles.gateGoBtn} onPress={confirmLocationPermission}>
              <Text style={styles.gateGoBtnText}>{t('activities.locationPermission.confirm')}</Text>
            </Pressable>
            <Pressable onPress={() => setShowLocationPermissionModal(false)} hitSlop={8}>
              <Text style={styles.gateSkipText}>{t('common.actions.cancel')}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
      <QuickPicker
        visible={gateCategoryOpen}
        title={t('activities.gate.categoryLabel')}
        subtitle={t('activities.gate.categorySubtitle')}
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
      {/* הבהרת-מיקום של החיפוש החופשי ("📍 באיזה אזור לחפש?" / "באיזו עיר?") - אותו רכיב בדיוק כמו
          "איפה נח לכם?" בעמוד הבית, במקום תיבת-עיר מקומית (ראו handleClarifyPickerClose). */}
      <LocationQuickPicker
        visible={!!freeSearchClarify}
        value={filters.location}
        onChange={(v) => setField('location', v)}
        onCoordsResolved={setDeviceCoords}
        onClose={handleClarifyPickerClose}
        deviceCoords={deviceCoords}
      />

      {/* "סינון מתקדם" - נפתח כחלון צף (bottom sheet) מעל התוכן במקום להתרחב inline ולדחוף
          את התוצאות למטה. FiltersSheet עצמו (לוגיקה/עיצוב פנימי/כפתורים) לא השתנה בכלל -
          רק אופן ההצגה שלו (Modal+backdrop סביבו) השתנה. */}
      <Modal visible={sheetOpen} transparent animationType="slide" onRequestClose={() => setSheetOpen(false)}>
        <Pressable style={styles.filterSheetBackdrop} onPress={() => setSheetOpen(false)}>
          <Pressable style={styles.filterSheetContainer} onPress={(e) => e.stopPropagation()}>
            <View style={styles.filterSheetHandleRow}>
              <Pressable style={styles.filterSheetCloseBtn} onPress={() => setSheetOpen(false)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.actions.close')}>
                <Text style={styles.filterSheetCloseBtnText}>✕</Text>
              </Pressable>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              <FiltersSheet
                filters={filters}
                onChange={setField}
                onClearAll={clearAll}
                onCoordsResolved={setDeviceCoords}
                deviceCoords={deviceCoords}
                hiddenCategoryCount={hiddenCategoryCount}
                hiddenAreaCount={hiddenAreaCount}
                onOpenExcludeCategories={openHideCategoriesModal}
                onOpenExcludeAreas={openHideLocationsModal}
              />
            </ScrollView>
            {/* התוצאות כבר מתעדכנות בזמן-אמת מתחת (filteredActivities תלוי ב-filters), אז
                "חפש" רק סוגר את הפאנל וחושף אותן - לא מפעיל חיפוש נפרד. מוצג קבוע מתחת ל-
                ScrollView (לא בתוכו) כדי שיישאר גלוי גם כשגוללים בין סקשני הפילטרים. */}
            <Pressable style={styles.filterSheetSearchBtn} onPress={() => setSheetOpen(false)}>
              <Text style={styles.filterSheetSearchBtnText}>
                {filteredActivities.length > 0
                  ? t('activities.sheet.searchWithCount', { count: filteredActivities.length })
                  : t('activities.sheet.search')}
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* "תצוגה/מיון" - Modal קטן נפרד, אותו recipe בדיוק (transparent+slide+backdrop) כמו
          הפילטרים למעלה, רק פאנל קטן משמעותית: שני radio-groups בלבד, בלי accordion. שורות
          מדמות (בערכי-צבע, לא ייבוא) את ה-Chip הלא-מיוצא מ-FiltersSheet.js. */}
      <Modal visible={displaySheetOpen} transparent animationType="slide" onRequestClose={() => setDisplaySheetOpen(false)}>
        <Pressable style={styles.filterSheetBackdrop} onPress={() => setDisplaySheetOpen(false)}>
          <Pressable style={styles.displaySheetContainer} onPress={(e) => e.stopPropagation()}>
            <View style={styles.filterSheetHandleRow}>
              <Pressable style={styles.filterSheetCloseBtn} onPress={() => setDisplaySheetOpen(false)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.actions.close')}>
                <Text style={styles.filterSheetCloseBtnText}>✕</Text>
              </Pressable>
            </View>
            <Text style={styles.displaySheetSectionTitle}>{t('activities.display.viewTitle')}</Text>
            <View style={styles.displaySheetRow}>
              <Pressable
                style={[styles.displaySheetOption, viewMode === 'list' && styles.displaySheetOptionSelected]}
                onPress={() => { setViewMode('list'); setDisplaySheetOpen(false); }}
                accessibilityRole="radio"
                accessibilityState={{ checked: viewMode === 'list' }}
              >
                <Text style={[styles.displaySheetOptionText, viewMode === 'list' && styles.displaySheetOptionTextSelected]}>{t('activities.display.list')}</Text>
              </Pressable>
              <Pressable
                style={[styles.displaySheetOption, viewMode === 'map' && styles.displaySheetOptionSelected]}
                onPress={() => { setViewMode('map'); setDisplaySheetOpen(false); }}
                accessibilityRole="radio"
                accessibilityState={{ checked: viewMode === 'map' }}
              >
                <Text style={[styles.displaySheetOptionText, viewMode === 'map' && styles.displaySheetOptionTextSelected]}>{t('activities.display.map')}</Text>
              </Pressable>
            </View>
            <Text style={styles.displaySheetSectionTitle}>{t('activities.display.sortTitle')}</Text>
            <View style={styles.displaySheetRow}>
              <Pressable
                style={[styles.displaySheetOption, sortMode === 'recommended' && styles.displaySheetOptionSelected]}
                onPress={() => { setSortMode('recommended'); setDisplaySheetOpen(false); }}
                accessibilityRole="radio"
                accessibilityState={{ checked: sortMode === 'recommended' }}
              >
                <Text style={[styles.displaySheetOptionText, sortMode === 'recommended' && styles.displaySheetOptionTextSelected]}>{t('activities.display.recommended')}</Text>
              </Pressable>
              <Pressable
                style={[styles.displaySheetOption, sortMode === 'distance' && styles.displaySheetOptionSelected]}
                onPress={() => { setSortMode('distance'); setDisplaySheetOpen(false); }}
                accessibilityRole="radio"
                accessibilityState={{ checked: sortMode === 'distance' }}
              >
                <Text style={[styles.displaySheetOptionText, sortMode === 'distance' && styles.displaySheetOptionTextSelected]}>{t('activities.display.byDistance')}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = createStyles((d) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, paddingBottom: 40 },
  titleBlock: { marginTop: 24, marginBottom: 12 },
  pageTitle: { fontFamily: fonts.extraBold, fontSize: 19, color: colors.textPrimary, textAlign: d.textAlign, flexShrink: 0 },
  // כותרת+ספירה בשורה אחת (בקשת המשתמש 2026-09-16 השנייה: "stop using a sentence" עבור מספר
  // התוצאות) - "122" צמוד ל"כל הפעילויות", לא עוד "122 פעילויות נמצאו" בשורה נפרדת. גם
  // isDiscoveryMode (הזמנה-לגלות, לא מספר) יושב באותו slot בדיוק.
  titleRow: { flexDirection: d.row, alignItems: 'baseline', gap: 8 },
  titleCount: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary, flexShrink: 1 },

  freeSearchBox: {
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.borderLight,
    borderRadius: radii.lg, padding: 12, marginBottom: 14,
  },
  freeSearchInputRow: { flexDirection: d.row, gap: 8 },
  freeSearchInput: {
    flex: 1, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.pill, paddingVertical: 10, paddingHorizontal: 14,
    fontFamily: fonts.regular, fontSize: 13.5, color: colors.textPrimary, textAlign: d.textAlign, writingDirection: d.writingDirection,
  },
  freeSearchBtn: {
    backgroundColor: colors.accent, borderRadius: radii.pill, paddingHorizontal: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  freeSearchBtnDisabled: { opacity: 0.5 },
  freeSearchBtnText: { fontFamily: fonts.bold, fontSize: 13, color: '#ffffff' },
  freeSearchClarifyText: { fontFamily: fonts.bold, fontSize: 13, color: colors.textPrimary, textAlign: d.textAlign, marginBottom: 8 },
  freeSearchErrorText: { fontFamily: fonts.semiBold, fontSize: 11.5, color: colors.danger, textAlign: 'center', marginTop: 8 },

  // TOOLBAR - שלושה controls בלבד (סינון/תצוגה+מיון/חיפוש), בלי שורת-chips נפרדת מתחת יותר
  // (בקשת המשתמש 2026-09-16 השנייה: "the first real Activity card should appear as early as
  // possible"). Filter מקבל flex:1 (התקציר שלו הכי ארוך, ראו activitiesFilterSummary) - Search/
  // תצוגה-ומיון בגודל-תוכן בלבד (toolbarChipCompact, לא flex:1 שווה כמו קודם).
  toolbarRow: { flexDirection: d.row, gap: 8, marginBottom: 10, zIndex: 15 },
  toolbarChip: {
    flexDirection: d.row, alignItems: 'center', justifyContent: 'center', gap: 5,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card,
    borderRadius: radii.pill, paddingVertical: 9, paddingHorizontal: 12, minHeight: 38,
  },
  toolbarChipFlexible: { flex: 1, minWidth: 0 },
  toolbarChipCompact: { minWidth: 44 },
  toolbarChipPrimary: { borderColor: colors.border, backgroundColor: colors.card },
  toolbarChipPrimaryActive: { borderWidth: 1.5, borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  toolbarChipIcon: { fontSize: 13 },
  toolbarChipText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary },
  toolbarChipTextPrimary: { fontFamily: fonts.bold, fontSize: 13, color: colors.accent },

  // "⚡ עכשיו פעיל · כבה" - קישור שקט/מותנה-לגמרי (כמו radiusExpandedBanner מתחת), הדרך
  // היחידה שנשארה לכבות עכשיו בלי לחזור לעמוד הבית אחרי שהצ'יפ הישן הוסר.
  spontaneousOffLink: { alignSelf: d.alignStart, marginBottom: 10 },
  spontaneousOffLinkText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.accent },

  spontaneousTopTitle: { fontFamily: fonts.extraBold, fontSize: 15, color: colors.textPrimary, textAlign: d.textAlign, marginBottom: 10 },
  spontaneousSoonTitle: { fontFamily: fonts.bold, fontSize: 14, color: colors.textPrimary, textAlign: 'center', marginTop: 4, marginBottom: 14 },
  showMoreBtn: { alignItems: 'center', paddingVertical: 12, marginTop: 4 },
  showMoreBtnText: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.accent },
  filterSheetBackdrop: { flex: 1, backgroundColor: 'rgba(20,30,35,0.5)', justifyContent: 'flex-end' },
  filterSheetContainer: {
    backgroundColor: colors.bg, borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    maxHeight: '85%', paddingHorizontal: spacing.xl, paddingTop: 10, paddingBottom: 30,
  },
  filterSheetHandleRow: { flexDirection: 'row', justifyContent: d.alignStart, marginBottom: 4 },
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

  hideFooterRow: { flexDirection: d.row, alignItems: 'center', gap: 8, marginTop: 16 },
  hideFooterText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textPrimary },
  hideFooterHint: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, textAlign: d.textAlign, marginTop: 4 },
  toggleSmall: { width: 38, height: 22, borderRadius: 11, justifyContent: 'center' },
  toggleOnSmall: { backgroundColor: colors.accent, alignItems: d.alignEnd },
  toggleOffSmall: { backgroundColor: colors.border, alignItems: d.alignStart },
  toggleDotSmall: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#fff', marginHorizontal: 2 },
  toggleDotOffSmall: {},

  // פאנל "תצוגה/מיון" - אותו filterSheetContainer בדיוק (רקע/פינות-עליונות/padding) רק בלי
  // maxHeight:'85% (תוכן קצר קבוע, שני radio-groups, אין צורך ב-ScrollView פנימי).
  displaySheetContainer: {
    backgroundColor: colors.bg, borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    paddingHorizontal: spacing.xl, paddingTop: 10, paddingBottom: 30,
  },
  displaySheetSectionTitle: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.textPrimary, textAlign: d.textAlign, marginBottom: 8, marginTop: 12 },
  displaySheetRow: { flexDirection: d.row, gap: 8 },
  // מדמה (בערכי-צבע, לא ייבוא) את ה-Chip הלא-מיוצא מ-components/FiltersSheet.js - זהות חזותית
  // בלי תלות חוצת-קובץ.
  displaySheetOption: {
    flex: 1, alignItems: 'center', backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.pill, paddingVertical: 10,
  },
  displaySheetOptionSelected: { backgroundColor: colors.accentTintLight, borderColor: colors.accent },
  displaySheetOptionText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary },
  displaySheetOptionTextSelected: { color: colors.accent, fontFamily: fonts.bold },

  radiusExpandedBanner: {
    backgroundColor: colors.accentTintLight, borderRadius: radii.md, paddingVertical: 9, paddingHorizontal: 14, marginBottom: 12,
  },
  radiusExpandedBannerText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.accent, textAlign: 'center' },

  emptyState: { alignItems: 'center', paddingVertical: 30, paddingHorizontal: 10 },
  emptyTitle: { fontFamily: fonts.semiBold, fontSize: 14, color: colors.textSecondary, textAlign: 'center', marginBottom: 14 },
  emptyWidenRow: { flexDirection: d.row, flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginBottom: 14 },
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
    textAlign: d.textAlign, writingDirection: d.writingDirection, minHeight: 90, textAlignVertical: 'top',
  },
  noteModalActionsRow: { flexDirection: d.row, gap: 10 },
  noteModalCancelBtn: { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border },
  noteModalCancelBtnText: { fontFamily: fonts.bold, fontSize: 14, color: colors.textSecondary },
  noteModalSaveBtn: { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: radii.pill, backgroundColor: colors.accent },
  noteModalBtnDisabled: { opacity: 0.5 },
  noteModalSaveBtnText: { fontFamily: fonts.bold, fontSize: 14, color: '#fff' },
  gateTitle: { fontFamily: fonts.extraBold, fontSize: 18, color: colors.textPrimary, textAlign: 'center' },
  gateSubtitle: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: 'center', marginTop: 4, marginBottom: 18 },
  gateRow: {
    flexDirection: d.row, alignItems: 'center', justifyContent: 'space-between',
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, padding: 14, marginBottom: 10,
  },
  gateRowRight: { flexDirection: d.row, alignItems: 'center', gap: 10, flexShrink: 1 },
  gateRowEmoji: { fontSize: 22 },
  gateRowLabel: { fontFamily: fonts.bold, fontSize: 14, color: colors.textPrimary, textAlign: d.textAlign },
  gateRowValue: { fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary, textAlign: d.textAlign, marginTop: 1 },
  gateGoBtn: {
    backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 14,
    alignItems: 'center', marginTop: 8, marginBottom: 12,
  },
  gateGoBtnText: { fontFamily: fonts.bold, fontSize: 15, color: '#fff' },
  gateSkipText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textMuted, textAlign: 'center', textDecorationLine: 'underline' },
}));
