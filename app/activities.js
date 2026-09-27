import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { View, Text, ScrollView, FlatList, Pressable, ActivityIndicator, Modal, TextInput, useWindowDimensions } from 'react-native';
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
import { formatSearchDistance, fetchSettlementCoords } from '../lib/activities';
import { useActivitiesCatalogue } from '../lib/useActivitiesCatalogue';
import { resolveResultsView, RESULTS_VIEW } from '../lib/catalogueCache';
import { fetchUserActivityFlags, toggleFavorite, toggleVisited, savePersonalNote, fetchAllPersonalNotes, toggleWithFeedback, hideActivityWithFeedback } from '../lib/interactions';
import { fetchUserPreferences, saveExcludedCategories, saveExcludedCities, saveExcludedRegions } from '../lib/preferences';
import { supabase } from '../lib/supabase';
import { DEFAULT_FILTERS, CATEGORY_FILTER_OPTIONS } from '../constants/filterSchema';
import { categorySummary, buildResultsSummarySegments, buildActiveChips, shouldReopenLocationChooser } from '../lib/filterSummaries';
import { BROWSE_GROUP_OPTIONS, withManualCategorySelection } from '../lib/browseGroups';
import { rankActivitiesWithSmartRadius, countAdditionalActiveFilters, normalizeFilters, getOpenNowInfo, haversineKm, locationWithDrivingTime } from '../lib/filterActivities';
import { formatBenefitCardTag } from '../lib/benefits';
import { buildMatchReasons } from '../lib/matchReasons';
import { parseSmartSearchQuery, intentToFilters } from '../lib/smartSearch';
import { paramsChanged } from '../lib/homeSession';
import { isBroadDiscovery, diversifyResults } from '../lib/resultDiversity';
import { t, useI18n, createStyles } from '../lib/i18n';
import { formatKm } from '../lib/i18n/format';

const BOOKING_REQUIRED_VALUES = ['registration_required', 'advance_booking'];
const SPONTANEOUS_TOP_COUNT = 5;

// keyExtractor (2026-09-20, "Performance Phase 1" audit סעיף 4B) - הועבר ל-module scope: אין לו
// שום תלות ב-state/props של הקומפוננטה, אז אין שום סיבה שהוא ייווצר-מחדש בכל רינדור (בניגוד
// ל-renderActivityCard, שכן תלוי ב-handlers ולכן useCallback בתוך הקומפוננטה).
const keyExtractor = (a) => String(a.id);

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

// כפתור "🎯 סינון" - תקציר-ספירה בלבד, לא עוד תיאור-ערכים (עד 2026-09-21 הציג כאן מיקום/קטגוריה
// כטקסט - "Active Search Constraints Chips" task, req 6 "avoid duplicate UI": מאז שלכל מימד-פילטר
// פעיל (כולל מיקום/קטגוריה) יש עכשיו צ'יפ עצמאי-להסרה משלו בשורה מעל ה-toolbar (buildActiveChips,
// lib/filterSummaries.js), חזרה על אותו ערך כאן הייתה מציגה את אותו אילוץ פעמיים.
// countAdditionalActiveFilters, not countActiveFilters (2026-09-27, "Activities Top-Area
// Simplification" task, section 7): location and category are BOTH already visible live in the
// interactive smart summary right above this button whenever they're active (buildResultsSummarySegments),
// so this count must not double-report them - see the full note on countAdditionalActiveFilters
// (lib/filterActivities.js) for why that is a separate function rather than changing
// countActiveFilters itself (other callers still need the unmodified 7-dimension count).
function activitiesFilterSummary(filters) {
  const total = countAdditionalActiveFilters(filters);
  return total > 0 ? t('activities.header.filterSummaryCountOnly', { count: total }) : null;
}

export default function ActivitiesScreen() {
  const router = useRouter();
  const { t, locale } = useI18n();
  // Desktop compaction (2026-09-27, "Activities Top-Area Simplification" section 9) - same
  // useWindowDimensions breakpoint convention already used elsewhere in the app (e.g. Header.js's
  // logoCompact<360). Only affects THIS screen's own spacing/max-width (contentDesktop/
  // titleBlockDesktop below) - Header.js/SkyBackground.js themselves are untouched ("do not
  // redesign the global header").
  const { width: windowWidth } = useWindowDimensions();
  const isDesktop = windowWidth >= 800;
  const { homeFilters, homeCoords, openFilters, view, spontaneous, nearMe, homeChildAges } = useLocalSearchParams();
  const [filters, setFilters] = useState(() => normalizeFilters(parseJson(homeFilters, {})));
  const [deviceCoords, setDeviceCoords] = useState(() => parseJson(homeCoords, null));
  // גילאי הילדים *שנבחרו לחיפוש* בעמוד הבית (app/index.js: selectedChildAges, לא כל הילדים
  // בפרופיל) - מגיע כפרמטר-route קטן בדיוק כמו homeFilters/homeCoords, אך ורק לצורך שורת-
  // ההסבר "✓ מתאים לגילים..." (lib/matchReasons.js) - לא נוגע בשום פילטר/דירוג. הגעה ישירה
  // לעמוד (בלי homeChildAges, למשל מהתפריט) -> [] -> ageMatchFact פשוט לא מציע הסבר-גיל.
  const [childAges, setChildAges] = useState(() => parseJson(homeChildAges, []));
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
  // שומרת העדפת-מיון בשום מקום אחר היום, אז לא ממציאים persistence חדש כאן. "מה קרוב?" (nearMe)
  // מתחיל כבר ב-'distance' - ראו ההערה המלאה למטה ליד lastSeenNavParams, אותו מקור בדיוק.
  const [sortMode, setSortMode] = useState(() => (nearMe === 'true' ? 'distance' : 'recommended'));
  // Bug fix (2026-09-25, "Home CTA returns zero results while Quick Search works"; extended the
  // same day by the "Search / Location State Consistency Sweep" audit to every piece of state below
  // that is seeded from a route param, not just the original three): expo-router's Stack navigator
  // reuses an already-mounted screen instance instead of remounting it when the same route is
  // pushed again ("removes duplicate screens when pushing a route that is already in the stack",
  // docs.expo.dev/router/advanced/stack) - confirmed to apply here specifically because
  // components/BottomNav.js navigates via router.dismissTo, which explicitly keeps a target
  // screen's own instance alive in the stack rather than unmounting it. So every one-shot
  // useState(paramValue) above (filters/deviceCoords/childAges/sheetOpen/viewMode/sortMode) only
  // ever ran for the FIRST /activities push this screen instance ever saw - going back to Home
  // (e.g. via the bottom nav), picking a different location/opening filters again/switching to map
  // view and pressing the main search CTA again reused that same instance and silently kept every
  // one of those stale values from the first visit. Quick Search/FiltersSheet never hit this
  // because they write straight into this state in-place (no navigation, no route param involved) -
  // only the Home->push path goes through this parse-once seam.
  //
  // Fixed with React's documented "adjust state during render" pattern (not a useEffect): comparing
  // the just-rendered params against the last ones we actually seeded state from, and calling the
  // setters right here in the render body when they differ. This is deliberately NOT a useEffect
  // (paramsChanged, lib/homeSession.js) fixed the original 3-field version of this bug that way,
  // but the "Search / Location State Consistency Sweep" audit found that an effect leaves one full
  // render painted with the STALE state before the effect corrects it a tick later - on a reused
  // instance that can flash the wrong result list or a false "nothing found" empty state for a
  // frame. Adjusting state directly during render instead means React discards that stale render
  // before it ever paints, so the very first frame the user sees already reflects the new params.
  // Calling multiple setters here is safe and terminates: on the very next render `lastSeenNavParams`
  // already equals the current params, so this block simply does not run again until Home pushes
  // something new. `spontaneous` participates in the comparison (so a repeat push toward the same
  // instance is still detected) but is deliberately NOT reset here - it drives a live GPS/permission
  // side effect (activateSpontaneous), which cannot run inside a pure render; see the guarded
  // useEffect next to toggleSpontaneous below, keyed on this same lastSeenNavParams value.
  const [lastSeenNavParams, setLastSeenNavParams] = useState({
    homeFilters, homeCoords, homeChildAges, openFilters, view, nearMe, spontaneous,
  });
  if (paramsChanged(lastSeenNavParams, { homeFilters, homeCoords, homeChildAges, openFilters, view, nearMe, spontaneous })) {
    setLastSeenNavParams({ homeFilters, homeCoords, homeChildAges, openFilters, view, nearMe, spontaneous });
    setFilters(normalizeFilters(parseJson(homeFilters, {})));
    setDeviceCoords(parseJson(homeCoords, null));
    setChildAges(parseJson(homeChildAges, []));
    setSheetOpen(openFilters === 'true');
    setViewMode(view === 'map' ? 'map' : 'list');
    setSortMode(nearMe === 'true' ? 'distance' : 'recommended');
  }
  // The public catalogue comes from the app-wide cache (lib/useActivitiesCatalogue.js) - a repeat
  // visit renders from memory instead of re-downloading ~5,500 rows. It is DATA only: every filter
  // input above/below stays per-screen state, re-seeded from route params exactly as before.
  const catalogue = useActivitiesCatalogue();
  const activities = catalogue.activities;
  // Per-user filtering inputs (hidden ids, excluded categories/areas, benefit clubs, saved default
  // filters) are never cached across screens. Results stay LOADING until they have arrived too, so
  // a cached catalogue never paints an unfiltered list that then jumps (resolveResultsView below).
  const [userStateReady, setUserStateReady] = useState(false);
  const [userLoadError, setUserLoadError] = useState(null);
  const [userLoadAttempt, setUserLoadAttempt] = useState(0);
  const [userId, setUserId] = useState(null);
  const [favoriteIds, setFavoriteIds] = useState(new Set());
  const [visitedIds, setVisitedIds] = useState(new Set());
  const [hiddenIds, setHiddenIds] = useState(new Set());
  const [notes, setNotes] = useState([]); // מ-fetchAllPersonalNotes - לכפתור "📝 הערה" בכרטיס הפעילות
  // *Ref (2026-09-20, "Performance Phase 1" audit סעיף 4C) - עותק תמיד-עדכני של favoriteIds/
  // visitedIds/notes שנקרא רק בתוך handlers (לא בזמן-רינדור) - כדי ש-handleToggleFavorite/
  // handleToggleVisited/openNoteModal למטה יוכלו להישאר useCallback עם תלות יחידה (userId) בלבד,
  // בלי להיות תלויים ב-favoriteIds/visitedIds/notes עצמם. בלי זה, ה-identity של ה-handlers הייתה
  // משתנה בכל toggle (כי הם קוראים favoriteIds.has(id) כדי לחשב את "next") - מה שהיה שובר בשקט
  // את React.memo(ActivityCard): toggle על כרטיס אחד היה מחליף את ה-prop onToggleFavorite/
  // onToggleVisited/onOpenNote אצל *כל* שאר הכרטיסים ברשימה (אותה פונקציה יציבה מוזנת לכולם),
  // וגורם לכולם לרנדר-מחדש - בדיוק העלות שה-audit מדד (118ms stall). הקצאה ישירה בגוף-הרינדור
  // (לא useEffect) בכוונה - useEffect היה מציג "רינדור אחד מפגר" (ה-ref עדיין נושא את הערך
  // הקודם בזמן ה-render של אותו tick), וזה לא נחוץ כאן כי הערך נקרא רק בתוך handler מאוחר יותר.
  const favoriteIdsRef = useRef(favoriteIds);
  favoriteIdsRef.current = favoriteIds;
  const visitedIdsRef = useRef(visitedIds);
  visitedIdsRef.current = visitedIds;
  const notesRef = useRef(notes);
  notesRef.current = notes;
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
  // 🔎 חיפוש חופשי - שדה קבוע-גלוי (Activities Top-Area Simplification, 2026-09-27: הכפתור-
  // הקטן שפתח/סגר אותו הוסר לגמרי, ראו סעיף 6 בבקשה) שמפעיל את אותו Smart Search Engine בדיוק
  // כמו עמוד הבית (lib/smartSearch.js, parseSmartSearchQuery/intentToFilters) - בלי לנווט/לטעון
  // מסך חדש, רק כותב ל-filters הקיים של העמוד הזה (setFilters).
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
    // No location MODE at all (a nationwide Free Search) - the device position, when we have it,
    // is still useful as RANKING context so nearer relevant results come first (Phase A, product
    // decision 1). It cannot narrow anything: matchesLocation returns true for every activity when
    // mode is null, and Smart Radius expansion only ever ADDS records to an under-filled result set.
    if (!mode && deviceCoords) return { lat: deviceCoords.latitude, lng: deviceCoords.longitude };
    return null;
  }, [filters.location?.mode, filters.location?.coords, deviceCoords, settlementCoords]);

  // Per-user state only (the catalogue itself is the shared cache above). Runs once per screen
  // instance, plus again only after an explicit retry of a failed attempt (userLoadAttempt).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (cancelled) return;
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
        if (!cancelled) setUserLoadError(err?.message || 'error');
      } finally {
        if (!cancelled) setUserStateReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [userLoadAttempt]);

  const retryLoad = useCallback(() => {
    if (catalogue.status === 'error') catalogue.retry();
    if (userLoadError) {
      setUserLoadError(null);
      setUserStateReady(false);
      setUserLoadAttempt((n) => n + 1);
    }
  }, [catalogue.status, catalogue.retry, userLoadError]);

  const requireLogin = () => {
    setShowLoginPrompt(true);
    return false;
  };

  const openHideCategoriesModal = () => {
    // ברירת מחדל: איחוד ההסתרה הקבועה (excludedCategories) והזמנית (filters.excludeCategory)
    // שכבר בתוקף - כך שפתיחה חוזרת של הפיקר מציגה תמיד את המצב האמיתי, בלי כפילויות.
    setHideDraft([...new Set([...excludedCategories, ...(filters.excludeCategory || [])])]);
    setSaveAsDefault(false);
    // setSheetOpen(false) (חדש) - באג אמיתי שדווח ואומת: QuickPicker (כאן) ו-FiltersSheet's Modal
    // (sheetOpen) הם שני <Modal> נפרדים, אחים ברמת ה-JSX (לא מקוננים זה-בתוך-זה, בניגוד ל-
    // LocationQuickPicker שכבר בתוך ה-Modal של הסינון) - ב-react-native-web הפורטל של כל Modal
    // נצמד ל-document.body בסדר-ה-mount, שקבוע לפי סדר-ה-JSX (QuickPicker כאן מוצהר *לפני* ה-
    // Modal של הסינון עצמו), לא לפי מי נפתח אחרון. כשה-sheet נשאר פתוח, ה-QuickPicker אמנם נפתח
    // בפועל (state מתעדכן, ה-DOM שלו קיים!) אבל תמיד *מתחת* לפורטל של ה-sheet - בלתי-נראה ובלתי-
    // לחיץ לגמרי (נבדק/אומת ב-devtools: elementFromPoint על השורה מחזיר את ה-sheet, לא את הפיקר).
    // סוגרים את ה-sheet לפני פתיחת הפיקר כדי שרק Modal אחד יהיה גלוי בכל רגע נתון - חוזר לפתוח
    // אותו ב-handleConfirmHide למטה כשהפיקר נסגר, כדי לשמר את זרימת "עדיין בתוך עריכת הפילטרים".
    setSheetOpen(false);
    setHideCategoriesModalOpen(true);
  };

  const handleConfirmHide = async () => {
    setHideCategoriesModalOpen(false);
    setSheetOpen(true);
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
    // setSheetOpen(false) - אותו באג/תיקון בדיוק כמו openHideCategoriesModal למעלה (ראו ההערה
    // המלאה שם): ExcludeAreasPicker הוא גם Modal-אח נפרד ל-sheet, לא מקונן בתוכו.
    setSheetOpen(false);
    setHideLocationsModalOpen(true);
  };

  const handleConfirmHideCities = async () => {
    setHideLocationsModalOpen(false);
    setSheetOpen(true);
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

  // "⚡ עכשיו" עבר להיות טריגר מעמוד הבית בלבד (למשתמשים מחוברים) - לא עוד chip בתוך FiltersSheet.
  // אותו זרימת-הרשאה בדיוק כמו לחיצה ידנית על הכפתור הישן (toggleSpontaneous עצמו, בלי עותק
  // מקביל). לא useEffect(..., []) עוד (2026-09-25, "Search / Location State Consistency Sweep" -
  // ראו ההערה המלאה ליד lastSeenNavParams למעלה): מפתח-תלות ריק היה מריץ את זה פעם אחת בלבד
  // לכל חיי מופע-המסך - לחיצה חוזרת על "⚡ עכשיו" מעמוד הבית על אותו מופע-מסך ממוחזר (BottomNav
  // dismissTo) פשוט לא הייתה עושה כלום, כי spontaneous:'true' הוא אותו מחרוזת בדיוק בשתי
  // הפעמים. תלוי ב-lastSeenNavParams (אותו אובייקט-מעקב שה-render-time block למעלה מעדכן) כדי
  // שדחיפה חדשה תזוהה גם כשהערך הגולמי של spontaneous עצמו לא השתנה. !spontaneousActive - שומר
  // ששחזור על דחיפה שבה הספונטני כבר פעיל מהפעם הקודמת יישאר no-op, לא יכבה אותו בטעות
  // (toggleSpontaneous מהפך את מה שכבר קיים).
  useEffect(() => {
    if (spontaneous === 'true' && !spontaneousActive) toggleSpontaneous();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSeenNavParams]);

  // 🔎 חיפוש חופשי קומפקטי - אותו זרימת-הבהרה בדיוק כמו app/index.js (handleSmartSearch/
  // handleClarifyCity), רק שבמקום לנווט ל-/activities עם homeFilters (אנחנו כבר כאן), כותבים
  // ישירות ל-filters הקיים דרך applyFreeSearchIntent - "מעדכן את עמוד הפעילויות" כמו שהתבקש,
  // לא פותח מסך נפרד.
  // options.explicitLocation - same Phase A rule as app/index.js#goToSmartSearchResults: a new free
  // text search here starts from ITS OWN geographic intent, and does not silently inherit whatever
  // location the results screen happens to be showing. Without this, "לונה פארק" typed on a results
  // page that was already narrowed to a city would stay narrowed to that city forever.
  const applyFreeSearchIntent = (intent, options = {}) => {
    const built = intentToFilters(intent, { explicitLocation: options.explicitLocation?.mode ? options.explicitLocation : null });
    setFilters(normalizeFilters(built));
    if (built.location.mode === 'address' && built.location.coords) {
      setDeviceCoords({ latitude: built.location.coords.lat, longitude: built.location.coords.lng });
    }
    setFreeSearchText('');
    setFreeSearchClarify(null);
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
  //    מקבל explicitLocation=הבחירה בפיקר (Phase A 2026-09-21) - רק בחירה מפורשת עבור החיפוש
  //    הזה, לא מיקום סביבתי של המסך, ובלי להמציא עיר.
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
        applyFreeSearchIntent(data.intent, { explicitLocation: loc });
      } catch {
        setFreeSearchError('activities.freeSearch.errorUnderstand');
        setFreeSearchClarify(null);
      } finally {
        setFreeSearchLoading(false);
      }
      return;
    }
    // Answering Free Search's own location picker IS intent for this search (Phase A note above).
    applyFreeSearchIntent(clarify.pendingIntent, { explicitLocation: loc });
  };

  // מועדפים/"כבר הייתי כאן"/הסתרה - הלוגיקה המשותפת (אופטימי+שחזור-בכשל+הודעה) עברה ל-
  // lib/interactions.js (toggleWithFeedback/hideActivityWithFeedback), כדי שהיא תהיה זהה
  // בדיוק כמו בעמוד הבית (app/index.js) - לא שני מימושים מקבילים.
  // useCallback עם תלות יחידה [userId] בלבד (2026-09-20, "Performance Phase 1" סעיף 4C) - קוראים
  // ל-favoriteIdsRef/visitedIdsRef.current (לא ל-favoriteIds/visitedIds ישירות) בדיוק כדי ש-
  // ה-identity של הפונקציה לא תשתנה בכל toggle - ראו ההערה המלאה ליד הגדרת ה-refs למעלה.
  // אותה סמנטיקה בדיוק כמו קודם (אופטימי+שחזור-בכשל+הודעה), רק שהקריאה ל-favoriteIds.has נעשית
  // דרך ref במקום סגירה-ישירה על ה-state.
  const handleToggleFavorite = useCallback((activityId) => {
    if (!userId) return requireLogin();
    const next = !favoriteIdsRef.current.has(activityId);
    toggleWithFeedback(setFavoriteIds, activityId, next, () => toggleFavorite(userId, activityId, next));
  }, [userId]);

  const handleToggleVisited = useCallback((activityId) => {
    if (!userId) return requireLogin();
    const next = !visitedIdsRef.current.has(activityId);
    toggleWithFeedback(setVisitedIds, activityId, next, () => toggleVisited(userId, activityId, next));
  }, [userId]);

  const handleHide = useCallback((activityId) => {
    if (!userId) return requireLogin();
    hideActivityWithFeedback(setHiddenIds, userId, activityId);
  }, [userId]);

  // 📝 הערה אישית ישירות מכרטיס הפעילות - אותו דפוס בדיוק כמו openNoteModal/saveNoteModal
  // ב-app/my-things.js, רק על notes/notesByActivity המקומיים של העמוד הזה.
  const openNoteModal = useCallback((activityId, activityName) => {
    if (!userId) return requireLogin();
    const existing = notesRef.current.find((n) => n.activity_id === activityId);
    setNoteModalTarget(existing || { activity_id: activityId, activity: { name: activityName } });
    setNoteModalDraft(existing ? existing.note : '');
  }, [userId]);

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

  // enrichedActivities/filteredActivities פוצלו לשתי שכבות (2026-09-20, "Performance Phase 1"
  // audit סעיף 4C, בעקבות המדידה: "one 'visited' toggle -> 118ms main-thread stall"): קודם
  // הכל היה useMemo אחד שתלוי גם ב-favoriteIds/visitedIds - כלומר סימון-מועדף/ביקרתי בודד היה
  // מריץ מחדש haversineKm כפול + buildMatchReasons/formatBenefitCardTag על *כל* הפעילויות
  // המדורגות (עד ~5,585), לא רק על זו שסומנה. עכשיו: enrichedActivities (למטה) מחשב את כל מה
  // שיקר (distance/distanceKm/benefitTag/matchReason) ותלוי רק ב-hiddenIds+קלט-החיפוש עצמו - לא
  // ב-favoriteIds/visitedIds/notesByActivity בכלל. filteredActivities (אחריו) הוא רק "מיפוי-הצמדה"
  // זול (Set.has פעמיים + Map.has פעם) שמריץ מחדש בכל toggle - אבל בלי אף חישוב יקר. שום שינוי-
  // סמנטיקה: אותם activities/distance/matchReason/favorite/visited/hasNote בדיוק כמו קודם, רק
  // מפוצלים לשני useMemo נפרדים במקום אחד.
  const enrichedActivities = useMemo(
    () => rankedResult.activities
      .filter((a) => !hiddenIds.has(a.id))
      // "מה קרוב?" (nearMe==='true') - תיקון-סמנטיקה (2026-09-20, "post-reliability follow-up"):
      // עד עכשיו הייתה כאן חסימה-קשיחה של פעילויות סגורות/לא-נפתחות-בקרוב (בקשת משתמש קודמת,
      // isOpenOrOpeningSoon+NEARME_OPEN_WITHIN_MINUTES) - הוסרה במפורש: ההגדרה הנוכחית והמאושרת
      // של "מה קרוב?" היא "פעילויות זכאיות-גיאוגרפית, ממוינות הכי-קרוב-קודם, עד 50 תוצאות" בלבד -
      // בלי סינון-זמינות סמוי. זמינות עדיין *מוצגת* על הכרטיס ("✓ פתוח עכשיו", getOpenNowInfo
      // דרך lib/matchReasons.js) בדיוק כמו בכל מסך אחר - רק הפכה מ"תנאי-סף מוסתר" ל"עובדה
      // מוצגת", לא נעלמה. שאר כללי-הזכאות (מאושר/לא-מוסתר וכו') לא נגעו.
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
          benefitTag: formatBenefitCardTag(a.benefits, benefitClubs),
          // "✓ למה זה מתאים" - שורה אחת משותפת (לא שתי שורות-הסבר מקבילות על הכרטיס, ראו
          // components/ActivityCard.js): ספונטני פעיל שומר את הניסוח הקיים שלו בדיוק
          // (buildSpontaneousBadge, ללא שינוי), אחרת ההסבר הכללי (גיל+פתוח-עכשיו/ללא-הרשמה).
          matchReason: spontaneousActive ? buildSpontaneousBadge(a) : buildMatchReasons(a, { childAges }),
        };
      }),
    // locale: {...a} מעתיק את ערכי ה-getters (ageRange/price/hours) - חישוב מחדש בהחלפת שפה.
    // בכוונה *בלי* favoriteIds/visitedIds/notesByActivity - ראו ההערה למעלה.
    [rankedResult, hiddenIds, benefitClubs, spontaneousActive, spontaneousCoords, searchOriginCoords, filters.location?.mode, locale, childAges, nearMe]
  );

  const filteredActivities = useMemo(
    () => enrichedActivities.map((a) => ({
      ...a,
      favorite: favoriteIds.has(a.id),
      visited: visitedIds.has(a.id),
      hasNote: notesByActivity.has(a.id),
    })),
    [enrichedActivities, favoriteIds, visitedIds, notesByActivity]
  );

  // LOADING / LOADED_WITH_RESULTS / LOADED_EMPTY / LOAD_FAILED (lib/catalogueCache.js). The count,
  // the empty state and the result divider only ever render in the two LOADED_* states.
  const resultsView = resolveResultsView({
    catalogueStatus: catalogue.status,
    userStateReady,
    loadError: userLoadError,
    resultCount: filteredActivities.length,
  });
  const loading = resultsView === RESULTS_VIEW.LOADING;
  const loadError = resultsView === RESULTS_VIEW.LOAD_FAILED;

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
      // q (2026-09-21): the free-text constraint has the same "explicit relaxation, not silent
      // drop" treatment as every other dimension here - matchesFreeText (lib/filterActivities.js)
      // is the one thing zero-results could be blaming with no widen option at all before this.
      q: (filters.q || '').trim() ? { ...filters, q: '' } : null,
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

  // countAdditionalActiveFilters (not countActiveFilters) - same reasoning as activitiesFilterSummary
  // above: this drives the same button's "active" highlight/accessibility label, so it must agree
  // with the count actually shown in that button's text.
  const activeCount = countAdditionalActiveFilters(filters);
  // כפתור "🎯 סינון" - סיכום קומפקטי (activitiesFilterSummary למעלה), לא עוד badge מספרי +
  // שורת-chips נפרדת מתחת. spontaneousActive לא נכלל כאן בכוונה - הוא כבר לא "פילטר" בכלל
  // (עבר להיות trigger מעמוד הבית, ראו handleSpontaneous/useEffect(spontaneous) - סעיף 6
  // בתוכנית), אז אין לו ייצוג בתקציר-הסינון.
  const filterSummary = useMemo(() => activitiesFilterSummary(filters), [filters, locale]);
  // "מציג כעת..." - תקציר-חיפוש בשפה טבעית, INTERACTIVE (ACTIVITIES SEARCH SUMMARY, 2026-09-27;
  // originally TURU — ACTIVITY RESULTS SEARCH SUMMARY, 2026-09-20). buildResultsSummarySegments
  // (lib/filterSummaries.js) is the one pure function that interprets filters into this sentence -
  // see the full note there. Same canonical filters as activitiesFilterSummary above (no parallel
  // interpretation system) - Free Search/Quick Choice/"מה קרוב?" all already converge to it before
  // this screen even loads, so there is no route-param-specific handling here. [] when there is no
  // meaningful context (a screen with no filter at all) - the JSX below simply renders nothing then.
  const resultsSummarySegments = useMemo(() => buildResultsSummarySegments(filters), [filters, locale]);
  // renderSummarySegments - a RENDERING-ONLY transform of resultsSummarySegments (2026-09-27,
  // "Activities Top-Area Simplification" task, section 10: known web-only orphaned-punctuation issue,
  // see [[project_ui_integration_2026-09-26]]). react-native-web renders a nested <Text
  // accessibilityRole="button"> (every 'category'/'location' segment below) as an inline-block
  // element, so the plain ", " separator segment right before one - an isolated 2-character text
  // node with nothing else inside it - could not break internally and occasionally wrapped to the
  // next line as a whole, leaving a stray comma at the very start of line 2. Folding that separator
  // into the END of the PRECEDING segment's own text (here, at render time only) gives the browser a
  // normal in-word break opportunity instead of an atomic box glued to a block element, so the comma
  // now wraps attached to whatever precedes it, never alone. Deliberately done HERE, not inside
  // buildResultsSummarySegments (lib/filterSummaries.js): that function's contract - each segment is
  // one clean semantic phrase - is exercised directly by tests/resultsSummary.test.js (exact-text
  // lookups like byText('באזור נתניה')), and changing it there would mean teaching that pure,
  // already-tested library function about a react-native-web rendering quirk it has no other reason
  // to know about. No interaction/semantic change: the same segments are still tapped for the same
  // pickers, only which on-screen text node physically carries a trailing ", " changes.
  const renderSummarySegments = useMemo(() => {
    const out = [];
    resultsSummarySegments.forEach((seg, i) => {
      const next = resultsSummarySegments[i + 1];
      // "pure separator" - a plain-text segment sitting right before an interactive one (e.g. the
      // ", " between a WHERE phrase and the trailing travel/distance phrase). A real word-carrying
      // text segment (e.g. "מחר") is never followed directly by an interactive segment without its
      // OWN separator already between them, so this never merges actual sentence content.
      const isPureSeparator = seg.kind === 'text' && next && next.kind !== 'text';
      if (isPureSeparator && out.length > 0) {
        out[out.length - 1] = { ...out[out.length - 1], text: out[out.length - 1].text + seg.text };
        return;
      }
      out.push(seg);
    });
    return out;
  }, [resultsSummarySegments]);
  // tapping the WHAT/category piece of the sentence opens the SAME category picker as the entry
  // gate's "🌟" row (gateCategoryOpen/QuickPicker below) - no second filter or picker state. Tapping
  // WHERE or the trailing travel/distance piece opens the SAME location picker as the entry gate's
  // "🏡" row (gateLocationOpen/LocationQuickPicker below), which is also where travel mode/time
  // itself lives (walking/driving + minutes are controls inside that picker, not a separate one).
  const openResultsSummarySegment = (kind) => {
    if (kind === 'category') setGateCategoryOpen(true);
    else if (kind === 'location') setGateLocationOpen(true);
  };
  // 🔍 Search-intent chip - filters.q is the ONE dimension with no editing surface anywhere else:
  // FILTER_SCHEMA (constants/filterSchema.js) has no 'q' section, so FiltersSheet cannot show or
  // clear it, and resultsWhatPhrase (lib/filterSummaries.js) hides it entirely once a category is
  // also set - "חוות סוסים עם פינת ליטוף" resolves both category:'חווה' and q:'עם פינת ליטוף', and
  // the residual text becomes invisible even though matchesFreeText (lib/filterActivities.js) still
  // silently applies it. Rendered together with activeChips below in one row (Active Search
  // Constraints Chips, 2026-09-21) - see that render block for the rest.
  const searchIntentText = (filters.q || '').trim();
  const clearSearchIntent = () => setField('q', '');
  // tapping the q chip's BODY (not its ×) prefills the always-visible Free Search field (2026-09-27:
  // no longer a collapsible box to reopen, see freeSearchText's declaration above) with the current
  // text, for editing (task req 9) - not a new screen, not a re-run of the parse yet (the user still
  // has to submit again via handleFreeSearch, exactly like typing it fresh).
  const openFreeSearchForEdit = () => {
    setFreeSearchText(searchIntentText);
  };

  // 🔍📍👶 Active Search Constraints Chips (2026-09-21) - every structured filter dimension gets an
  // always-visible, independently-removable chip (buildActiveChips, lib/filterSummaries.js - pure,
  // tested there). Removal is per-dimension (setField(key, DEFAULT_FILTERS[key]) resets ONLY that
  // one field, req 4) except location, which has one extra rule: if the Free Search text (q) is
  // still active once location is cleared, there is no geographic context left for it at all - the
  // existing standard location chooser (gateLocationOpen, same Modal the entry gate already uses)
  // reopens instead of silently leaving the search nationwide-by-omission (req 3). Never falls back
  // to filters.location.mode:'nationwide' - that is a distinct EXPLICIT choice made inside the
  // chooser itself, not something this removal ever sets on its own.
  // .filter(location out) - "Activities Top-Area Simplification" task, section 2 (2026-09-27):
  // location already appears once, live, inside the interactive smart summary above (resultsSummarySegments'
  // 'location' segment) - repeating it as its own "📍 המיקום שלי"-style chip here duplicated the exact
  // same fact on screen twice. buildActiveChips itself is UNCHANGED (still the general-purpose "every
  // active structured dimension" list, pinned as such by tests/filterSummaries.test.js for any future
  // caller) - filtered here, at this screen's own render site, not in the shared lib function.
  // handleRemoveChip's 'location' branch below is intentionally left in place even though a location
  // chip can no longer trigger it from this screen's UI: it is a small, independently-tested
  // (shouldReopenLocationChooser) piece of shared removal logic, not screen-specific dead weight.
  const activeChips = useMemo(() => buildActiveChips(filters).filter((c) => c.key !== 'location'), [filters, locale]);
  const handleRemoveChip = (key) => {
    setField(key, DEFAULT_FILTERS[key]);
    if (key === 'location' && shouldReopenLocationChooser(filters)) setGateLocationOpen(true);
  };
  const hiddenCategoryCount = new Set([...excludedCategories, ...(filters.excludeCategory || [])]).size;
  const hiddenCityCount = new Set([...excludedCities, ...(filters.excludeCity || [])]).size;
  const hiddenRegionCount = new Set([...excludedRegions, ...(filters.excludeRegion || [])]).size;
  const hiddenAreaCount = hiddenCityCount + hiddenRegionCount;

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

  // ↕️ מיון - 'recommended' (2026-09-25, "Result Diversity / Playground Saturation" - עדכון לכלל
  // הישן "חייב להישאר בדיוק כמו היום", ראו lib/resultDiversity.js לנימוק המלא: הכלל ההוא נועד
  // למנוע רה-סידור *בטעות*, לא לאסור רה-סידור מכוון-ומתועד. broad discovery בלבד (isBroadDiscovery -
  // אין קטגוריה נבחרת/חיפוש-חופשי/כוונת-קטגוריה מ-alias, ראו שם) עובר דרך diversifyResults, שמונע
  // רצף ארוך מדי של אותה קטגוריה (בעיקר גני-שעשועים - נמדד: עד 87% מהקטלוג המאושר כולו) בלי לזרוק/
  // לשכפל/לערבב כלום - כל שאר המקרים (כוונה מפורשת) ממשיכים לקבל בדיוק את filteredActivities, אותו
  // reference אפילו, ללא שינוי. 'distance' ממיין *עותק* לפי distanceKm ASC בלבד - לא search חדש,
  // לא נוגע ב-rankedResult/filters/Smart Radius/diversity (בחירת-מיון מפורשת של המשתמש תמיד מנצחת -
  // ראו lib/resultDiversity.js). Array.sort של JS יציב (מובטח מ-ES2019, גם ב-Hermes) - אז תוצאות-
  // בלי-distanceKm (Infinity) נופלות תמיד לסוף בסדר-היציבות המקורי שלהן, ותוצאות עם מרחק-שווה
  // נשארות באותו סדר-מומלץ יחסי ביניהן (secondary sort key) - בדיוק "distance ASC, then
  // existingRank ASC" מהבקשה, בלי צורך בקומפרטור-משני מפורש.
  // NEARME_RESULT_LIMIT = 50 (2026-09-20, "CENTRAL RADAR update" - בקשת המשתמש: "50 is a RESULT
  // LIMIT, not a distance rule... return up to 50 activities ordered by proximity"). חל רק
  // כשהגענו דרך "מה קרוב?" (nearMe==='true', route param קבוע לכל חיי המסך הזה) - לא על מיון-
  // לפי-מרחק הרגיל שזמין תמיד דרך תפריט התצוגה. גם מסנן החוצה תוצאות בלי distanceKm (לא ניתן
  // לדרג גיאוגרפית - בלי lat/lng תקין) לפני החיתוך, כדי לא "לרפד" את ה-50 בתוצאות-מרחק-לא-ידוע
  // רק כדי להגיע למכסה (בקשת המשתמש: "Do not pad the list with irrelevant activities"). שאר
  // כללי-הזכאות (מאושר/לא-מוסתר/וכו') כבר מוחלים למעלה ב-filteredActivities - לא נוגעים בהם כאן.
  // (זמינות/"פתוח עכשיו" הוסרה מכאן כתנאי-סף ב-2026-09-20 "post-reliability follow-up" - ראו
  // ההערה ליד filteredActivities למעלה - לא עוד חלק מ"כללי-הזכאות" של מה קרוב?).
  const NEARME_RESULT_LIMIT = 50;
  const sortedActivities = useMemo(() => {
    const base = sortMode !== 'distance'
      ? (isBroadDiscovery(filters) ? diversifyResults(filteredActivities) : filteredActivities)
      : [...filteredActivities].sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
    if (nearMe !== 'true') return base;
    return base.filter((a) => a.distanceKm != null).slice(0, NEARME_RESULT_LIMIT);
  }, [filteredActivities, sortMode, nearMe, filters]);

  const setField = (key, value) => setFilters((prev) => ({ ...prev, [key]: value }));
  const clearAll = () => setFilters(DEFAULT_FILTERS);

  // רשימת-הכרטיסים בפועל (2026-09-20, "reliability pass" audit סעיף 3: "~5,585 results rendered
  // through .map() inside a ScrollView") - reproduced by reading the code: כל הכרטיסים (יכולים
  // להגיע לאלפים במסך-ללא-סינון, "כל הארץ") נבנו עד עכשיו כולם בבת-אחת בתוך ScrollView יחיד,
  // בלי windowing. showCardsList/listData/renderActivityCard למטה מזינים FlatList *רק* כש-בפועל
  // עומדים להיות כרטיסים לרינדור (לא מפה/loading/שגיאה/מצב-ריק/ספונטני-ריק) - כל שאר המצבים
  // ממשיכים ב-ScrollView הרגיל בדיוק כמו קודם (topContent משותף לשני הענפים - JSX זהה, לא
  // שכפול, ראו למטה). FlatList הוא תמיד ה-scroll-container החיצוני ביותר (לא מקונן בתוך
  // ScrollView קיים) - בדיוק אחד משני הענפים מתרנדר בכל רגע נתון, לעולם לא שניהם יחד. שום שינוי
  // בסמנטיקת-תוצאות (אילו פעילויות/סדר/ספירה/מצבי-ריקה/טעינה/שגיאה) - אותם listData/
  // filteredActivities/sortedActivities/spontaneousVisibleActivities בדיוק, אותם handlers.
  const showCardsList = !loading && !loadError && filteredActivities.length > 0
    && viewMode !== 'map' && !(spontaneousActive && spontaneousOpenCount === 0);
  const listData = spontaneousActive ? spontaneousVisibleActivities : sortedActivities;
  // renderActivityCard (2026-09-20, "Performance Phase 1" audit סעיף 4A/4B) - useCallback + מזין
  // ל-ActivityCard את ה-handlers היציבים (handleToggleFavorite וכו', עצמם useCallback([userId])
  // למעלה) *ישירות*, לא עטופים ב-closure חדש per-item per-render (`() => handleToggleFavorite(a.id)`
  // הישן). ActivityCard עצמו (React.memo, ראו components/ActivityCard.js) קורא ל-onToggleFavorite(id)
  // עם ה-id כפרמטר - כך שאותה פונקציה-יחידה-ויציבה מוזנת לכל הכרטיסים, וה-memo *באמת* יכול לבדוק
  // שוויון-props ולדלג על רינדור-מחדש לכרטיסים לא-קשורים כשמישהו מסמן מועדף/ביקר בכרטיס אחר.
  const renderActivityCard = useCallback(({ item: a }) => (
    <ActivityCard
      {...a}
      onToggleFavorite={handleToggleFavorite}
      onToggleVisited={handleToggleVisited}
      onOpenNote={openNoteModal}
      onHide={handleHide}
    />
  ), [handleToggleFavorite, handleToggleVisited, openNoteModal, handleHide]);

  const topContent = (
    <>
      <Header showBack onMenuPress={() => {}} />

      {/* כותרת = זהות קבועה ("כל הפעילויות") + ספירה קומפקטית צמודה. בכוונה בלי אייקון/אמוג'י
          ליד הכותרת (בקשת המשתמש: "clean/stable/functional/quiet", בניגוד לכותרות-section
          המשחקיות בעמוד הבית) ובלי טקסט-הזמנה חלופי ("פעילויות שכדאי לגלות") - הספירה תמיד
          מספר, גם ב-Discovery Mode; ה"הזמנה לגלות" כבר מגיעה מהכותרת הראשית עצמה + מהתוכן. */}
      <View style={[styles.titleBlock, isDesktop && styles.titleBlockDesktop]}>
        <View style={styles.titleRow}>
          <Text style={styles.pageTitle} numberOfLines={1}>{t('activities.header.title')}</Text>
          {/* Only once the result set is known - while loading this used to read "0". */}
          {!loading && !loadError ? (
            <Text style={styles.titleCount} numberOfLines={1}>
              {t('activities.header.count', { count: filteredActivities.length })}
            </Text>
          ) : null}
        </View>
        {/* תקציר-חיפוש בשפה טבעית ואינטראקטיבי ("מציג כעת...", ראו buildResultsSummarySegments/
            lib/filterSummaries.js) - משני-חזותית ל"כל הפעילויות" (fontSize/color עדינים יותר, ראו
            הסטייל למטה), לא כרטיס/רקע כבד ולא עוד שורת-chips - טקסט זורם, עד 2 שורות, שבתוכו שני
            קטעים (WHAT/קטגוריה, WHERE+DISTANCE/מיקום-וטווח-נסיעה) הם עצמם הכפתור-לפתיחת-הבוררן
            המתאים (accent+underline עדין, לא "שורת צ'יפים" - סעיף 3 בבקשה). מוצג רק כשיש הקשר
            משמעותי לתאר (resultsSummarySegments/renderSummarySegments הם [] יחד במסך-ברירת-מחדל
            בלי שום פילטר - ה"כל הפעילויות" הקבוע כבר אומר את זה, לא צריך עוד "מציג כעת פעילויות"
            ריק). renderSummarySegments (לא resultsSummarySegments הגולמי) הוא מה שמוצג בפועל -
            ראו ההערה המלאה ליד הצהרתו למעלה (תיקון-פיסוק, סעיף 10 בבקשה). */}
        {renderSummarySegments.length ? (
          <Text style={styles.resultsSummaryText} numberOfLines={2}>
            {renderSummarySegments.map((seg, i) => (
              seg.kind === 'text' ? (
                <Text key={i}>{seg.text}</Text>
              ) : (
                <Text
                  key={i}
                  onPress={() => openResultsSummarySegment(seg.kind)}
                  style={styles.resultsSummarySegmentInteractive}
                  accessibilityRole="button"
                  // .replace strips a trailing ", " that renderSummarySegments may have folded onto
                  // THIS segment's own visible text (see its declaration above) - the spoken value
                  // must stay the clean constraint value, not carry punctuation from an unrelated
                  // sentence separator.
                  accessibilityLabel={seg.kind === 'category'
                    ? t('activities.resultsSummary.editCategoryA11y', { value: seg.text.replace(/,\s*$/, '').trim() })
                    : t('activities.resultsSummary.editLocationA11y', { value: seg.text.replace(/,\s*$/, '').trim() })}
                >
                  {seg.text}
                </Text>
              )
            ))}
          </Text>
        ) : null}
      </View>

      {/* Active Search Constraints Chips (2026-09-21) - every active search constraint visible and
          independently removable without leaving this screen: q first (searchIntentChip - distinct
          border/tint so it reads as "search intent" rather than a structured filter, req 8, but same
          chip family/row as everything else, not its own separate row anymore), then one chip per
          active structured dimension (activeChips, buildActiveChips in lib/filterSummaries.js).
          Collapses completely (no row, no gap) when nothing is active, matching every other
          conditional block on this screen - not an empty scroller. Single horizontal, RTL-aware
          (styles use d.row) scrollable row - req 7. */}
      {(searchIntentText || activeChips.length > 0) ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.activeChipsRow}
          contentContainerStyle={styles.activeChipsContent}
        >
          {searchIntentText ? (
            <View style={styles.searchIntentChip}>
              {/* body: opens Free Search prefilled for editing (req 9) - never removes q */}
              <Pressable
                style={styles.searchIntentChipBody}
                onPress={openFreeSearchForEdit}
                accessibilityRole="button"
                accessibilityLabel={t('activities.header.searchIntentChipA11y', { query: searchIntentText })}
              >
                <Text style={styles.searchIntentChipText} numberOfLines={1} ellipsizeMode="tail">
                  {t('activities.header.searchIntentChip', { query: searchIntentText })}
                </Text>
              </Pressable>
              {/* ×: clears filters.q ONLY via setField - location/age/date/opening/category/sort are
                  untouched, exactly like every other setField call on this screen (req 2). */}
              <Pressable
                onPress={clearSearchIntent}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('activities.header.searchIntentChipRemoveA11y', { query: searchIntentText })}
              >
                <Text style={styles.searchIntentChipRemove}>✕</Text>
              </Pressable>
            </View>
          ) : null}
          {activeChips.map((c) => (
            <View key={c.key} style={styles.activeChip}>
              <Text style={styles.activeChipText} numberOfLines={1} ellipsizeMode="tail">{c.icon} {c.text}</Text>
              <Pressable
                onPress={() => handleRemoveChip(c.key)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('activities.header.activeChipRemoveA11y', { label: `${c.icon} ${c.text}` })}
              >
                <Text style={styles.activeChipRemove}>✕</Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}

      {/* 🔎 חיפוש חופשי - שדה אמיתי תמיד-גלוי (Activities Top-Area Simplification, 2026-09-27,
          סעיף 6: "replace the small action/button with a real visible search field") - לא עוד
          כפתור-toggle קטן שפותח/סוגר את זה (freeSearchOpen הוסר לגמרי, ראו ההערה ליד freeSearchText
          למעלה). אותו Smart Search Engine/state בדיוק (handleFreeSearch/applyFreeSearchIntent) -
          אין כאן מנגנון-חיפוש שני, רק שינוי-נראות. ממוקם מעל שורת סינון/רשימה-מפה (לא מתחתיה כמו
          קודם) כך שהיררכיית-הבקרות תואמת את היעד: תקציר → חיפוש → סינון+תצוגה. */}
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

      {/* TOOLBAR - שני controls בלבד: סינון (תקציר-מצב קומפקט, ראו activitiesFilterSummary למעלה)
          ורשימה/מפה (viewToggleGroup, סעיף 5 בבקשה - segmented control תמיד-גלוי, בלי תפריט/Modal).
          חיפוש עבר לשדה הקבוע מעליו (למעלה) ומיון-ידני הוסר לגמרי (סעיף 4: "do NOT expose a sort
          selector" - sortMode ממשיך לפעול פנימית, נשלט רק ע"י route param nearMe, ראו ההערה
          המלאה ליד ה-state שלו למעלה - לא עוד בחירה ידנית/תפריט "מרחק"). Filter מקבל flex:1. */}
      <View style={styles.toolbarRow}>
        <Pressable
          style={[styles.toolbarChip, styles.toolbarChipFlexible, styles.toolbarChipPrimary, activeCount > 0 && styles.toolbarChipPrimaryActive]}
          onPress={() => setSheetOpen((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={activeCount > 0 ? t('activities.header.filterA11yWithCount', { count: activeCount }) : t('activities.header.filterLabel')}
        >
          <Text style={styles.toolbarChipIcon}>🎯</Text>
          <Text style={styles.toolbarChipTextPrimary} numberOfLines={1} ellipsizeMode="tail">
            {filterSummary ? `${filterSummary}` : t('activities.header.filterLabel')}
          </Text>
        </Pressable>

        {/* רשימה/מפה - segmented control עצמאי (סעיף 5 בבקשה): מצב נוכחי מסומן-חזותית תמיד
            (accentTintLight+accent, אותה מוסכמת-"נבחר" כמו בכל מקום אחר במסך), לחיצה אחת מחליפה
            מצב, בלי תפריט/Modal (מחליף לגמרי את displaySheetOpen/ה"תצוגה/מיון" הישן שכלל גם
            בורר-מיון). d.row הופך סדר-קריאה אוטומטית לפי שפה - "רשימה | מפה" ב-RTL. */}
        <View style={styles.viewToggleGroup} accessibilityRole="tablist">
          <Pressable
            style={[styles.viewToggleOption, viewMode === 'list' && styles.viewToggleOptionSelected]}
            onPress={() => setViewMode('list')}
            accessibilityRole="button"
            accessibilityState={{ selected: viewMode === 'list' }}
            accessibilityLabel={t('activities.display.listA11y')}
          >
            <Text style={[styles.viewToggleOptionText, viewMode === 'list' && styles.viewToggleOptionTextSelected]} numberOfLines={1}>
              {t('activities.display.list')}
            </Text>
          </Pressable>
          <View style={styles.viewToggleDivider} />
          <Pressable
            style={[styles.viewToggleOption, viewMode === 'map' && styles.viewToggleOptionSelected]}
            onPress={() => setViewMode('map')}
            accessibilityRole="button"
            accessibilityState={{ selected: viewMode === 'map' }}
            accessibilityLabel={t('activities.display.mapA11y')}
          >
            <Text style={[styles.viewToggleOptionText, viewMode === 'map' && styles.viewToggleOptionTextSelected]} numberOfLines={1}>
              {t('activities.display.map')}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* "⚡ עכשיו" - הטריגר עבר לעמוד הבית (משתמשים מחוברים בלבד, ראו app/index.js), אבל
          כל עוד המצב פעיל (הגיע דרך route param spontaneous=true) חייבת להישאר דרך לכבות
          אותו בלי לחזור לעמוד הבית. spontaneousActive הוא state נפרד מ-filters (לא שדה
          ב-DEFAULT_FILTERS) אז אין לו ייצוג בשורת ה-Active Search Constraints Chips למטה -
          נשאר קישור ייעודי משלו. שקט/מותנה לגמרי (כמו radiusExpandedBanner מתחת) - לא
          תופס מקום כשלא רלוונטי. */}
      {spontaneousActive ? (
        <Pressable onPress={toggleSpontaneous} hitSlop={8} style={styles.spontaneousOffLink}>
          <Text style={styles.spontaneousOffLinkText}>{t('activities.spontaneous.offLink')}</Text>
        </Pressable>
      ) : null}

      {spontaneousError ? <Text style={styles.freeSearchErrorText}>{t(spontaneousError)}</Text> : null}

      {/* A background refresh of a still-valid cached catalogue failed: the results below stay
          exactly as they were (never replaced with 0) - this only says they may be slightly old. */}
      {!loading && !loadError && catalogue.refreshError ? (
        <Pressable onPress={catalogue.retry} hitSlop={6}>
          <Text style={styles.refreshFailedText}>{t('activities.results.refreshFailed')}</Text>
        </Pressable>
      ) : null}

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

      {/* הפרדה עדינה בין הבקרות לתוצאות (בקשת המשתמש: "the controls end here; the results
          begin here" - whitespace + קו דק אחד, לא מיכל/רקע/כותרת חדשה). מוצג רק כשבאמת עומדים
          להיות כרטיסים/מפה מתחתיו - לא מעל spinner, הודעת-שגיאה, מצב-ריק, או מצב "ספונטני
          ושום דבר לא פתוח עכשיו" (גם הוא מוצג כמו מצב-ריק, ראו סעיף 20 בבקשה) - קו מרחף מעל
          הודעת-ריק היה נראה כמו טעות, לא כמו מעבר. */}
      {!loading && !loadError && filteredActivities.length > 0 && !(spontaneousActive && spontaneousOpenCount === 0) ? (
        <View style={styles.resultsDivider} />
      ) : null}
    </>
  );

  const nonListBody = loading ? (
    <View style={styles.emptyState}>
      <ActivityIndicator color={colors.accent} />
    </View>
  ) : loadError ? (
    <View style={styles.emptyState}>
      <Text style={styles.emptyTitle}>{t('activities.results.loadError')}</Text>
      <Pressable style={styles.emptyBtn} onPress={retryLoad}>
        <Text style={styles.emptyBtnText}>{t('activities.results.retry')}</Text>
      </Pressable>
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
        {(filters.q || '').trim() ? (
          <Pressable style={styles.emptyWidenChip} onPress={() => setField('q', '')}>
            <Text style={styles.emptyWidenChipText}>
              {widenPreviewCounts.q != null
                ? t('activities.results.widen.withCount', { label: t('activities.results.widen.searchText'), count: widenPreviewCounts.q })
                : t('activities.results.widen.searchText')}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <Pressable style={styles.emptyBtn} onPress={clearAll}>
        <Text style={styles.emptyBtnText}>{t('activities.results.clearAllFilters')}</Text>
      </Pressable>
    </View>
  ) : viewMode === 'map' ? (
    // רשימה/מפה - הבחירה עצמה עברה לשורת ה-subtitle למעלה (ליד מספר התוצאות), כאן רק
    // המשך-הרינדור לפי viewMode - אותו state/behavior בדיוק.
    <ActivitiesMap activities={sortedActivities} deviceCoords={deviceCoords} />
  ) : (
    // 🪄 ספונטני, אבל שום דבר לא פתוח ברגע זה (סעיף 13 בבקשה) - לא מסך ריק: הודעה
    // ידידותית, ואם יש מידע אמיתי על "נפתח בקרוב" (spontaneousOpensSoon, לא ניחוש) -
    // מציגים אותו; אחרת מציעים להרחיב פילטרים, בלי להמציא פעילויות. (showCardsList===false
    // מבטיח שהענף היחיד שנשאר כאן הוא בדיוק spontaneousActive && spontaneousOpenCount===0).
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
  );

  return (
    <View style={styles.screen}>
      <SkyBackground />
      {showCardsList ? (
        <FlatList
          data={listData}
          keyExtractor={keyExtractor}
          renderItem={renderActivityCard}
          ListHeaderComponent={(
            <>
              {topContent}
              {spontaneousActive && (
                <Text style={styles.spontaneousTopTitle}>{t('activities.spontaneous.topTitle')}</Text>
              )}
            </>
          )}
          ListFooterComponent={
            spontaneousActive && !showAllSpontaneous && filteredActivities.length > SPONTANEOUS_TOP_COUNT ? (
              <Pressable style={styles.showMoreBtn} onPress={() => setShowAllSpontaneous(true)}>
                <Text style={styles.showMoreBtnText}>{t('activities.spontaneous.showMore', { count: filteredActivities.length - SPONTANEOUS_TOP_COUNT })}</Text>
              </Pressable>
            ) : null
          }
          contentContainerStyle={[styles.content, isDesktop && styles.contentDesktop]}
          showsVerticalScrollIndicator={false}
          // כוונון-FlatList (2026-09-20, "Performance Phase 1" audit סעיף 4D) - initialNumToRender
          // מוריד מהערך-הכללי של RN (10) ל-6 כדי לצמצם את עלות-הרינדור הראשוני על מסכים ללא
          // סינון (אלפי תוצאות פוטנציאליות); windowSize/maxToRenderPerBatch/removeClippedSubviews
          // הם רק הידוק-מתון של ברירות-המחדל, לא ערכים אגרסיביים.
          // getItemLayout - בכוונה *לא* נוסף: components/ActivityCard.js מכיל לפחות שלושה
          // מקורות-גובה משתנה שנבדקו בפועל - title בלי numberOfLines (יכול לגלוש לשתי שורות),
          // cityText מותנה (showCityLine), recommendedRow מותנה, matchReasonRow מותנה - גובה-כרטיס
          // הוא *לא* קבוע-אמיתי, אז getItemLayout היה מחשב מיקומי-גלילה שגויים (במיוחד אחרי
          // סינון/מיון-מחדש). נדחה במפורש - לא "נשכח", ראו הדוח.
          initialNumToRender={6}
          maxToRenderPerBatch={8}
          windowSize={7}
          removeClippedSubviews
        />
      ) : (
        <ScrollView contentContainerStyle={[styles.content, isDesktop && styles.contentDesktop]} showsVerticalScrollIndicator={false}>
          {topContent}
          {nonListBody}
        </ScrollView>
      )}
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

      {/* Hiding stays FLAT and CANONICAL on purpose (no browse groups): "hide this activity type"
          is a precise choice, and excludeCategory is matched value-by-value. */}
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
        groups={BROWSE_GROUP_OPTIONS}
        value={filters.category}
        multiple
        showAll
        onChange={(v) => setFilters((prev) => withManualCategorySelection(prev, v))}
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

      {/* "תצוגה/מיון" (הModal הקטן: רשימה/מפה + מומלץ/מרחק) הוסר לגמרי (Activities Top-Area
          Simplification, 2026-09-27, סעיפים 4-5): רשימה/מפה עבר ל-viewToggleGroup תמיד-גלוי
          בתוך ה-toolbar למעלה, ומיון-ידני בין "מומלץ"/"מרחק" (וה-Modal שהציג אותו) הוסר - אין
          יותר בורר-מיון חשוף למשתמש בכלל (sortMode ממשיך לפעול פנימית, נשלט רק ע"י nearMe). */}
    </View>
  );
}

const styles = createStyles((d) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, paddingBottom: 40 },
  // Desktop compaction (2026-09-27, "Activities Top-Area Simplification" section 9, isDesktop
  // computed from useWindowDimensions in the component - see its declaration near the top) - applied
  // ON TOP OF `content` (array style, never replaces it) only at >=800px: constrains the whole column
  // (header+controls+cards all render through this same `content` container, see the JSX) to a
  // readable width instead of stretching full-bleed across a very wide viewport, so it reads as "one
  // coherent page" rather than controls/cards floating as a narrow island inside SkyBackground's much
  // wider blue gradient. SkyBackground itself is untouched (still full-bleed, expected - only the
  // foreground column centers).
  contentDesktop: { maxWidth: 720, width: '100%', alignSelf: 'center' },
  titleBlock: { marginTop: 24, marginBottom: 12 },
  // titleBlockDesktop - the other half of section 9 ("reduce the vertical gap... bring the first
  // activity substantially higher"): only the large mobile marginTop (tuned for a small phone
  // status-bar-safe header) shrinks on desktop; marginBottom/everything else is untouched.
  titleBlockDesktop: { marginTop: 8 },
  pageTitle: { fontFamily: fonts.extraBold, fontSize: 19, color: colors.textPrimary, textAlign: d.textAlign, flexShrink: 0 },
  // כותרת+ספירה בשורה אחת (בקשת המשתמש 2026-09-16 השנייה: "stop using a sentence" עבור מספר
  // התוצאות) - "122" צמוד ל"כל הפעילויות", לא עוד "122 פעילויות נמצאו" בשורה נפרדת. גם
  // isDiscoveryMode (הזמנה-לגלות, לא מספר) יושב באותו slot בדיוק.
  titleRow: { flexDirection: d.row, alignItems: 'baseline', gap: 8 },
  titleCount: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary, flexShrink: 1 },
  // תקציר-חיפוש בשפה טבעית ("מציג כעת...", TURU — ACTIVITY RESULTS SEARCH SUMMARY 2026-09-20) -
  // משני-חזותית ל-pageTitle/titleCount מעליו (fontSize/color עדינים יותר, לא extraBold/textPrimary) -
  // "keep the summary visually secondary... but clearly readable" (סעיף 10 בבקשה). marginTop
  // קטן מפריד אותו משורת-הכותרת בלי ליצור עוד "בלוק" נפרד - עדיין בתוך אותו titleBlock.
  resultsSummaryText: {
    fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, textAlign: d.textAlign,
    lineHeight: 18, marginTop: 4,
  },
  // הקטעים האינטראקטיביים בתוך משפט-התקציר (2026-09-27, "Activities Search Summary") - accent
  // (אותו כחול-אקטיבי כמו activeChipText/spontaneousOffLinkText למעלה) + underline עדין (אותו
  // מוסכמה כמו gateSkipText - "טקסט מודגש-שנלחצים עליו", לא כפתור/רקע) כדי שהמשפט יישאר "משפט
  // עברי טבעי שקורה להיות ניתן-לערוך" (סעיף 3 בבקשה) ולא שורת-צ'יפים.
  resultsSummarySegmentInteractive: {
    fontFamily: fonts.semiBold, color: colors.accent, textDecorationLine: 'underline',
  },

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
  refreshFailedText: { fontFamily: fonts.semiBold, fontSize: 11.5, color: colors.textMuted, textAlign: 'center', marginTop: 8 },

  // TOOLBAR - שני controls בלבד (סינון/רשימה+מפה, 2026-09-27 - חיפוש עבר לשדה קבוע מעל, מיון-ידני
  // הוסר, ראו ה-JSX) - בלי שורת-chips נפרדת מתחת יותר (בקשת המשתמש 2026-09-16 השנייה: "the first
  // real Activity card should appear as early as possible"). Filter מקבל flex:1 (התקציר שלו הכי
  // ארוך, ראו activitiesFilterSummary) - viewToggleGroup בגודל-תוכן בלבד, לא flex:1 שווה.
  toolbarRow: { flexDirection: d.row, gap: 8, marginBottom: 10, zIndex: 15 },
  // קו-הפרדה עדין בין הבקרות לתוצאות: 1px בצבע-הגבול הרגיל של המערכת (colors.border, אותו
  // צבע שכבר משמש למסגרות toolbarChip/gateCard וכו') - בלי מסגרת/רקע/צל/תווית משלו. אין
  // marginHorizontal - מיושר אוטומטית עם ריפוד-התוכן הרגיל (content.padding), לא full-bleed.
  // marginTop/marginBottom אסימטריים בכוונה (בקשת המשתמש 2026-09-19: "מרחק שווה מכל מה שמעליו
  // וכל מה שמתחתיו"): toolbarRow שמעל נושא כבר marginBottom:10 משלו, וה-View/ActivityCard/
  // ActivitiesMap הראשון שמתחת (loading/map/spontaneous/הרשימה הרגילה) לא נושא marginTop
  // משלו בכלל - מרווח סימטרי (spacing.md משני הצדדים) היה יוצא ויזואלית לא-שווה (24 מעל מול
  // 14 מתחת). marginTop כאן משלים את ה-10 של toolbarRow לאותו סה"כ (spacing.md) כמו למטה.
  resultsDivider: { height: 1, backgroundColor: colors.border, marginTop: spacing.xs, marginBottom: spacing.md },
  toolbarChip: {
    flexDirection: d.row, alignItems: 'center', justifyContent: 'center', gap: 5,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card,
    borderRadius: radii.pill, paddingVertical: 9, paddingHorizontal: 12, minHeight: 38,
  },
  toolbarChipFlexible: { flex: 1, minWidth: 0 },
  toolbarChipPrimary: { borderColor: colors.border, backgroundColor: colors.card },
  toolbarChipPrimaryActive: { borderWidth: 1.5, borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  toolbarChipIcon: { fontSize: 13 },
  // רשימה/מפה - segmented control (2026-09-27, סעיף 5): פיל אחד עם קו-מפריד פנימי במקום שני
  // toolbarChip נפרדים, כדי שיקרא ויזואלית כ"שתי מצבים של אותה בקרה" ולא כשני כפתורים עצמאיים -
  // אותה שפה חזותית (border/card/accentTintLight) כמו כל שאר הבקרות במסך הזה.
  viewToggleGroup: {
    flexDirection: d.row, alignItems: 'stretch', borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.card, borderRadius: radii.pill, overflow: 'hidden',
  },
  viewToggleOption: {
    flexDirection: d.row, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 9, paddingHorizontal: 14, minHeight: 38, minWidth: 44,
  },
  viewToggleOptionSelected: { backgroundColor: colors.accentTintLight },
  viewToggleOptionText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary },
  viewToggleOptionTextSelected: { color: colors.accent, fontFamily: fonts.bold },
  viewToggleDivider: { width: 1, backgroundColor: colors.border },
  toolbarChipText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary },
  toolbarChipTextPrimary: { fontFamily: fonts.bold, fontSize: 13, color: colors.accent },

  // 🔍 Search-intent chip - same pill visual language as toolbarChip/emptyWidenChip (border/card/
  // radii.pill), own row so it never competes with the fixed-width toolbar controls above/below it
  // (section 19: no new horizontal overflow, one-row chip, no layout redesign).
  // Active Search Constraints Chips (2026-09-21) - one horizontal row, bleeds to the screen edges
  // (negative marginHorizontal cancels `content`'s own padding, same trick used for every other
  // full-bleed horizontal scroller on this screen) so the row can scroll under the padded content.
  // Collapses to nothing when not rendered at all (see the JSX condition) - no reserved space.
  activeChipsRow: { marginHorizontal: -spacing.xl, marginBottom: 10 },
  activeChipsContent: { flexDirection: d.row, gap: 8, paddingHorizontal: spacing.xl },
  // q's chip: thicker border + accent tint sets it apart as "search intent" rather than a structured
  // filter (req 8), while sharing the same pill shape/size/family as activeChip below. Two nested
  // Pressables (body vs ×, req 9) instead of one - the outer View only carries the shared visual
  // container style, it is not itself pressable.
  searchIntentChip: {
    flexDirection: d.row, alignItems: 'center', gap: 6,
    borderWidth: 1.5, borderColor: colors.accent, backgroundColor: colors.accentTintLight,
    borderRadius: radii.pill, paddingVertical: 7, paddingHorizontal: 12,
  },
  searchIntentChipBody: { flexDirection: d.row, alignItems: 'center', flexShrink: 1 },
  searchIntentChipText: { fontFamily: fonts.bold, fontSize: 13, color: colors.accent, flexShrink: 1, maxWidth: 200 },
  searchIntentChipRemove: { fontFamily: fonts.bold, fontSize: 12, color: colors.accent },
  // every other active dimension (location/age/date/opening/category/...) - same chip family as
  // searchIntentChip (pill shape, accent color) but the plain/neutral member, not the highlighted one.
  activeChip: {
    flexDirection: d.row, alignItems: 'center', gap: 6,
    borderWidth: 1, borderColor: colors.accent, backgroundColor: colors.accentTintLight,
    borderRadius: radii.pill, paddingVertical: 6, paddingHorizontal: 11,
  },
  activeChipText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.accent, maxWidth: 160 },
  activeChipRemove: { fontFamily: fonts.bold, fontSize: 11.5, color: colors.accent },

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
