import { useState, useMemo, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, Modal } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import Header from '../components/Header';
import LoginRequiredModal from '../components/LoginRequiredModal';
import ActivityCard from '../components/ActivityCard';
import ActivitiesMap from '../components/ActivitiesMap';
import FiltersSheet from '../components/FiltersSheet';
import QuickPicker from '../components/QuickPicker';
import LocationQuickPicker, { locationSummary } from '../components/LocationQuickPicker';
import { ageSummary } from '../components/AgeQuickPicker';
import { ChevronDownIcon } from '../components/icons';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { fetchApprovedActivities, formatDistance } from '../lib/activities';
import { fetchUserActivityFlags, toggleFavorite, toggleVisited, toggleHidden } from '../lib/interactions';
import { fetchUserPreferences, saveExcludedCategories, saveExcludedCities } from '../lib/preferences';
import { supabase } from '../lib/supabase';
import {
  DEFAULT_FILTERS, CATEGORY_OPTIONS, CITY_OPTIONS, PRICE_OPTIONS, PLACE_TYPE_OPTIONS, BOOKING_OPTIONS, DURATION_OPTIONS, AMENITY_COMFORT_OPTIONS, HOUR_OPTIONS, BENEFIT_FILTER_OPTIONS,
} from '../constants/filterSchema';
import { categorySummary, whenSummary, hebrewJoin } from '../lib/filterSummaries';
import { rankActivities, countActiveFilters, normalizeFilters } from '../lib/filterActivities';
import { formatBenefitCardTag } from '../lib/benefits';

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

export default function ActivitiesScreen() {
  const router = useRouter();
  const { homeFilters, homeCoords, openFilters } = useLocalSearchParams();
  const [filters, setFilters] = useState(() => normalizeFilters(parseJson(homeFilters, {})));
  const [deviceCoords, setDeviceCoords] = useState(() => parseJson(homeCoords, null));
  // כשמגיעים דרך "סינון מתקדם" מהעמוד הראשי - פותחים ישר את הפאנל, אבל עדיין מציגים תוצאות
  // (בניגוד למודל הישן, הפאנל עכשיו inline מעל תוצאות חיות, לא חוסם אותן).
  const [sheetOpen, setSheetOpen] = useState(openFilters === 'true');
  const [viewMode, setViewMode] = useState('list');
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [userId, setUserId] = useState(null);
  const [favoriteIds, setFavoriteIds] = useState(new Set());
  const [visitedIds, setVisitedIds] = useState(new Set());
  const [hiddenIds, setHiddenIds] = useState(new Set());
  const [excludedCategories, setExcludedCategories] = useState([]);
  const [excludedCities, setExcludedCities] = useState([]);
  const [benefitClubs, setBenefitClubs] = useState([]);
  const [showLoginPrompt, setShowLoginPrompt] = useState(false);
  // 🚫 "הסר פעילויות" - hideDraft הוא state נפרד מ-filters.excludeCategory בכוונה: הבחירה בפיקר
  // לא משפיעה על התוצאות עד שסוגרים ("החלת הסינון"), אותו דפוס commit-on-close כמו excludedDraft
  // ב-app/profile.js. saveAsDefault נשמר-בזיכרון-בלבד (state מקומי, לא DB) עד ללחיצה על הכפתור.
  const [hideCategoriesModalOpen, setHideCategoriesModalOpen] = useState(false);
  const [hideDraft, setHideDraft] = useState([]);
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [showRegisterPromptForHide, setShowRegisterPromptForHide] = useState(false);
  // 📍 "אזורים שלא להציג" - מקביל מבני מלא ל"הסר פעילויות" למעלה, על ערים במקום קטגוריות.
  const [hideLocationsModalOpen, setHideLocationsModalOpen] = useState(false);
  const [hideCityDraft, setHideCityDraft] = useState([]);
  const [saveCityAsDefault, setSaveCityAsDefault] = useState(false);
  const [showRegisterPromptForHideCities, setShowRegisterPromptForHideCities] = useState(false);
  // "שער" כניסה - כשמגיעים לעמוד בלי קטגוריה/מיקום שנבחרו (למשל ישירות מהתפריט, לא דרך
  // "יאללה יוצאים לדרך" בעמוד הבית) מבקשים למלא את שני הפילטרים הראשיים לפני שממשיכים.
  // מחושב פעם אחת מה-state ההתחלתי - לא חוזר להופיע אחרי שנסגר, גם אם המשתמש מנקה שוב.
  // לא מוצג כשמגיעים דרך "סינון מתקדם" (openFilters=true) - שם הפאנל המלא כבר פתוח ומכסה
  // את אותם שני שדות ועוד; שער נוסף לפניו רק חוסם, לא עוזר.
  const [showGate, setShowGate] = useState(() => (
    openFilters !== 'true' && !filters.category?.length && !filters.location?.mode
  ));
  const [gateCategoryOpen, setGateCategoryOpen] = useState(false);
  const [gateLocationOpen, setGateLocationOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [data, { data: { session } }] = await Promise.all([fetchApprovedActivities(), supabase.auth.getSession()]);
        if (cancelled) return;
        setActivities(data);
        if (session?.user?.id) {
          setUserId(session.user.id);
          const [flags, prefs] = await Promise.all([
            fetchUserActivityFlags(session.user.id),
            fetchUserPreferences(session.user.id),
          ]);
          if (!cancelled) {
            setFavoriteIds(flags.favoriteIds);
            setVisitedIds(flags.visitedIds);
            setHiddenIds(flags.hiddenIds);
            setExcludedCategories(prefs.excludedCategories);
            setExcludedCities(prefs.excludedCities);
            setBenefitClubs(prefs.benefitClubs);
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
    setHideCityDraft([...new Set([...excludedCities, ...(filters.excludeCity || [])])]);
    setSaveCityAsDefault(false);
    setHideLocationsModalOpen(true);
  };

  const handleConfirmHideCities = async () => {
    setHideLocationsModalOpen(false);
    setField('excludeCity', hideCityDraft);
    if (!saveCityAsDefault) return;
    if (!userId) {
      setShowRegisterPromptForHideCities(true);
      return;
    }
    try {
      await saveExcludedCities(userId, hideCityDraft);
      setExcludedCities(hideCityDraft);
      setField('excludeCity', []);
    } catch {
      // ההסתרה הזמנית כבר הוחלה למעלה - כישלון שמירה קבועה לא משאיר את המשתמש בלי שום סינון.
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

  const filteredActivities = useMemo(
    () => rankActivities(activities, filters, deviceCoords, excludedCategories, benefitClubs, excludedCities)
      .filter((a) => !hiddenIds.has(a.id))
      .map((a) => ({
        ...a,
        distance: formatDistance(a, deviceCoords),
        favorite: favoriteIds.has(a.id),
        visited: visitedIds.has(a.id),
        benefitTag: formatBenefitCardTag(a.benefits, benefitClubs),
      })),
    [activities, filters, deviceCoords, hiddenIds, favoriteIds, visitedIds, excludedCategories, benefitClubs, excludedCities]
  );
  const activeCount = countActiveFilters(filters);
  const activeChips = useMemo(() => buildActiveChips(filters), [filters]);
  const hiddenCategoryCount = new Set([...excludedCategories, ...(filters.excludeCategory || [])]).size;
  const hiddenCityCount = new Set([...excludedCities, ...(filters.excludeCity || [])]).size;

  const setField = (key, value) => setFilters((prev) => ({ ...prev, [key]: value }));
  const clearAll = () => setFilters(DEFAULT_FILTERS);

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Header showBack onMenuPress={() => {}} />

        <View style={styles.titleBlock}>
          <Text style={styles.pageTitle}>{buildSearchSentence(filters)}</Text>
          <Text style={styles.pageSubtitle}>{filteredActivities.length} פעילויות נמצאו</Text>
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

        <Pressable style={styles.advToggle} onPress={() => setSheetOpen((v) => !v)}>
          <Text style={styles.advToggleIcon}>🎯</Text>
          <Text style={styles.advToggleText}>סינון מתקדם{activeCount > 0 ? ` · ${activeCount}` : ''}</Text>
          <View style={{ transform: [{ rotate: sheetOpen ? '180deg' : '0deg' }] }}>
            <ChevronDownIcon size={12} />
          </View>
        </Pressable>

        <View style={styles.hideBtnsRow}>
          <Pressable style={styles.hideCategoriesBtn} onPress={openHideCategoriesModal}>
            <Text style={styles.hideCategoriesBtnText}>
              {hiddenCategoryCount > 0 ? `🚫 ${hiddenCategoryCount} קטגוריות מוסתרות` : '🚫 הסר פעילויות'}
            </Text>
          </Pressable>
          <Pressable style={styles.hideCategoriesBtn} onPress={openHideLocationsModal}>
            <Text style={styles.hideCategoriesBtnText}>
              {hiddenCityCount > 0 ? `📍 ${hiddenCityCount} אזורים מוסתרים` : '📍 אזורים שלא להציג'}
            </Text>
          </Pressable>
        </View>

        {sheetOpen && (
          <FiltersSheet
            filters={filters}
            onChange={setField}
            onClearAll={clearAll}
            onCoordsResolved={setDeviceCoords}
            openAllByDefault={openFilters === 'true'}
          />
        )}

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
            <Text style={styles.emptyTitle}>לא מצאנו פעילויות שמתאימות לכל הפילטרים שבחרת.</Text>
            <Pressable style={styles.emptyBtn} onPress={clearAll}>
              <Text style={styles.emptyBtnText}>נקה את כל הפילטרים</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.viewToggleRow}>
              <Pressable
                style={[styles.viewToggleBtn, viewMode === 'list' && styles.viewToggleBtnActive]}
                onPress={() => setViewMode('list')}
              >
                <Text style={[styles.viewToggleText, viewMode === 'list' && styles.viewToggleTextActive]}>📋 רשימה</Text>
              </Pressable>
              <Pressable
                style={[styles.viewToggleBtn, viewMode === 'map' && styles.viewToggleBtnActive]}
                onPress={() => setViewMode('map')}
              >
                <Text style={[styles.viewToggleText, viewMode === 'map' && styles.viewToggleTextActive]}>🗺️ מפה</Text>
              </Pressable>
            </View>

            {viewMode === 'map' ? (
              <ActivitiesMap activities={filteredActivities} deviceCoords={deviceCoords} />
            ) : (
              filteredActivities.map((a) => (
                <ActivityCard
                  key={a.id}
                  {...a}
                  onToggleFavorite={() => handleToggleFavorite(a.id)}
                  onToggleVisited={() => handleToggleVisited(a.id)}
                  onHide={() => handleHide(a.id)}
                />
              ))
            )}
          </>
        )}
      </ScrollView>
      <LoginRequiredModal visible={showLoginPrompt} onClose={() => setShowLoginPrompt(false)} />

      <QuickPicker
        visible={hideCategoriesModalOpen}
        title="🚫 אילו פעילויות לא מעניינות אתכם?"
        subtitle="בחרו דברים שאתם מעדיפים לא לראות בתוצאות."
        options={CATEGORY_OPTIONS}
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

      <QuickPicker
        visible={hideLocationsModalOpen}
        title="📍 אילו אזורים תרצו להסתיר?"
        subtitle="בחרו אזורים שבהם אתם מעדיפים לא לראות פעילויות."
        options={CITY_OPTIONS}
        value={hideCityDraft}
        multiple
        searchable
        onChange={setHideCityDraft}
        onClose={handleConfirmHideCities}
        doneLabel="החלת הסינון"
        onReset={() => setHideCityDraft([])}
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
      <QuickPicker
        visible={gateCategoryOpen}
        title="מה בא לנו?"
        subtitle="אפשר לבחור כמה קטגוריות"
        options={CATEGORY_OPTIONS}
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
      />
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

  advToggle: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1.5, borderColor: colors.accent, backgroundColor: colors.accentTintLight,
    borderRadius: radii.pill, paddingVertical: 11, marginBottom: 14,
  },
  advToggleIcon: { fontSize: 14 },
  advToggleText: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.accent },

  // כפתורי "🚫 הסר פעילויות" / "📍 אזורים שלא להציג" - במכוון שקטים/משניים (טקסט בלבד, בלי
  // מסגרת/רקע), בניגוד ל-advToggle הבולט למעלה - אלה פעולות מתקדמות, לא אמורות להתחרות עם
  // "סינון מתקדם". שני הכפתורים באותה שורה כדי לא לתפוס עוד שורה אנכית מיותרת בעמוד.
  hideBtnsRow: { flexDirection: 'row-reverse', justifyContent: 'center', gap: 18, marginBottom: 14 },
  hideCategoriesBtn: { alignItems: 'center', paddingVertical: 8 },
  hideCategoriesBtnText: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.textSecondary },

  hideFooterRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, marginTop: 16 },
  hideFooterText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textPrimary },
  hideFooterHint: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, textAlign: 'right', marginTop: 4 },
  toggleSmall: { width: 38, height: 22, borderRadius: 11, justifyContent: 'center' },
  toggleOnSmall: { backgroundColor: colors.accent, alignItems: 'flex-start' },
  toggleOffSmall: { backgroundColor: colors.border, alignItems: 'flex-end' },
  toggleDotSmall: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#fff', marginHorizontal: 2 },
  toggleDotOffSmall: {},

  viewToggleRow: { flexDirection: 'row-reverse', gap: 8, marginBottom: 14 },
  viewToggleBtn: {
    flex: 1, alignItems: 'center', paddingVertical: 9,
    borderRadius: radii.pill, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.card,
  },
  viewToggleBtnActive: { borderColor: colors.accent, backgroundColor: colors.accent },
  viewToggleText: { fontFamily: fonts.bold, fontSize: 13, color: colors.textSecondary },
  viewToggleTextActive: { color: '#fff' },

  emptyState: { alignItems: 'center', paddingVertical: 30, paddingHorizontal: 10 },
  emptyTitle: { fontFamily: fonts.semiBold, fontSize: 14, color: colors.textSecondary, textAlign: 'center', marginBottom: 14 },
  emptyBtn: { borderWidth: 1.5, borderColor: colors.accent, borderRadius: radii.pill, paddingVertical: 11, paddingHorizontal: 18 },
  emptyBtnText: { fontFamily: fonts.bold, fontSize: 13, color: colors.accent },

  gateBackdrop: { flex: 1, backgroundColor: 'rgba(20,30,35,0.5)', justifyContent: 'center', padding: spacing.xl },
  gateCard: { backgroundColor: colors.card, borderRadius: radii.xl, padding: spacing.xl },
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
