import { useState, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, TextInput, ActivityIndicator, Image } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import * as Location from 'expo-location';
import Svg, { Circle, Rect, Polygon, Polyline, Line, Path, G } from 'react-native-svg';
import Header from '../components/Header';
import LoginRequiredModal from '../components/LoginRequiredModal';
import AgeQuickPicker, { ageSummary } from '../components/AgeQuickPicker';
import QuickPicker from '../components/QuickPicker';
import LocationQuickPicker, { locationSummary } from '../components/LocationQuickPicker';
import {
  CATEGORY_OPTIONS, DEFAULT_FILTERS, FILTER_SCHEMA,
  PRICE_OPTIONS, PLACE_TYPE_OPTIONS, BOOKING_OPTIONS, DURATION_OPTIONS, AMENITY_COMFORT_OPTIONS,
} from '../constants/filterSchema';
import { fetchApprovedActivities } from '../lib/activities';
import { haversineKm, normalizeFilters } from '../lib/filterActivities';
import { whenSummary, hebrewJoin, categorySummary } from '../lib/filterSummaries';
import { supabase } from '../lib/supabase';
import { fetchUserPreferences, saveDefaultHomeFilters } from '../lib/preferences';
import { childrenToDefaultAgeFilter, formatChildAge } from '../lib/children';
import { colors, fonts, radii, spacing } from '../constants/theme';

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

const SPONTANEOUS_RADIUS_KM = 4;

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

function SearchIcon() {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={colors.textMuted} strokeWidth={2} strokeLinecap="round">
      <Circle cx="11" cy="11" r="7" />
      <Line x1="21" y1="21" x2="16.2" y2="16.2" />
    </Svg>
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

function SunMascot() {
  return (
    <Svg width={86} height={86} viewBox="0 0 120 120" style={styles.sunMascot} pointerEvents="none">
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

function GrassFooter() {
  return (
    <View style={styles.grassFooter} pointerEvents="none">
      <Image
        source={require('../assets/grass-footer.png')}
        style={styles.grassFooterImage}
        resizeMode="stretch"
      />
      <LinearGradient
        colors={[colors.bg, colors.bg, 'transparent']}
        locations={[0, 0.05, 0.42]}
        style={styles.grassFooterFade}
      />
    </View>
  );
}

export default function HomeScreen() {
  const router = useRouter();
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [deviceCoords, setDeviceCoords] = useState(null);
  const [ageQuickOpen, setAgeQuickOpen] = useState(false);
  const [categoryQuickOpen, setCategoryQuickOpen] = useState(false);
  const [whereQuickOpen, setWhereQuickOpen] = useState(false);
  const [spontaneousLoading, setSpontaneousLoading] = useState(false);
  const [spontaneousError, setSpontaneousError] = useState('');
  const [userId, setUserId] = useState(null);
  const [excludedCategories, setExcludedCategories] = useState([]);
  const [hasSavedDefault, setHasSavedDefault] = useState(false);
  const [showLoginPrompt, setShowLoginPrompt] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);
  const [defaultNotice, setDefaultNotice] = useState('');
  const [freeSearchText, setFreeSearchText] = useState('');
  const [locationNotice, setLocationNotice] = useState('');
  const [locatingForSearch, setLocatingForSearch] = useState(false);
  const [visibleHomeFilters, setVisibleHomeFilters] = useState([]);
  const [children, setChildren] = useState([]);
  const [selectedChildIds, setSelectedChildIds] = useState(new Set());

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
          return;
        }
        setUserId(session.user.id);
        try {
          const prefs = await fetchUserPreferences(session.user.id);
          if (cancelled) return;
          setExcludedCategories(prefs.excludedCategories);
          setVisibleHomeFilters(prefs.visibleHomeFilters);
          if (prefs.defaultHomeFilters) {
            setFilters(normalizeFilters(prefs.defaultHomeFilters));
            setHasSavedDefault(true);
          }
          const kids = prefs.children || [];
          setChildren(kids);
          // ברירת מחדל: כל הילדים "נבחרים" ל"למי מחפשים היום?" - תואם בדיוק את מה שכבר קרה
          // בשקט עד היום (childrenToDefaultAgeFilter על כל הילדים), רק עכשיו זה גם ה-UI.
          setSelectedChildIds(new Set(kids.map((c) => c.id)));
          // גיל ברירת המחדל מגיע מגילאי הילדים (מחושב טרי מתאריך לידה - ראו lib/children.js),
          // לא מ-default_home_filters.age שעלול "לקפוא" בערך ישן - גובר עליו כשיש ילדים.
          // עדיין state מקומי בלבד: שינוי הגיל בחיפוש בודד לא נשמר בחזרה לפרופיל (ראו index.js
          // בכללותו - setField רגיל, לא כותב ל-DB).
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

  const handleSpontaneous = async () => {
    setSpontaneousError('');
    setSpontaneousLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setSpontaneousError('צריך לאשר גישה למיקום כדי להשתמש בכפתור הזה');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({});
      const activities = await fetchApprovedActivities();
      const nearby = activities.filter((a) => (
        !excludedCategories.includes(a.category)
        && a.lat != null && a.lng != null
        && haversineKm(pos.coords.latitude, pos.coords.longitude, a.lat, a.lng) <= SPONTANEOUS_RADIUS_KM
      ));
      if (nearby.length === 0) {
        setSpontaneousError(`לא מצאנו פעילויות במרחק ${SPONTANEOUS_RADIUS_KM} ק"מ מכם הפעם`);
        return;
      }
      const pick = nearby[Math.floor(Math.random() * nearby.length)];
      router.push(`/activity/${pick.id}`);
    } catch {
      setSpontaneousError('משהו השתבש, נסו שוב');
    } finally {
      setSpontaneousLoading(false);
    }
  };

  const PRIMARY_FILTERS = [
    {
      key: 'category', label: 'מה בא לנו?',
      subtitle: filters.category.length > 0 ? categorySummary(filters.category) : 'כל סוגי הפעילויות',
      active: filters.category.length > 0,
      Icon: CategoryIcon, decorEmoji: '🌟', tint: '#fdf3d9', color: '#e8bf36', onPress: () => setCategoryQuickOpen(true),
    },
    {
      key: 'where', label: 'איפה נח לכם?',
      subtitle: filters.location?.mode ? locationSummary(filters.location) : 'באיזור שלי',
      active: !!filters.location?.mode,
      Icon: LocationIcon, decorEmoji: '🏡', tint: '#e2f5e7', color: '#3fb36d', onPress: () => setWhereQuickOpen(true),
    },
  ];

  const handleGo = async () => {
    setLocationNotice('');
    let goFilters = filters;
    let goCoords = deviceCoords;

    if (!filters.location?.mode) {
      setLocatingForSearch(true);
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          setLocationNotice('לא אישרתם גישה למיקום - בחרו איזור באופן ידני ב"באיזור שלי" 📍');
          return;
        }
        const pos = await Location.getCurrentPositionAsync({});
        goCoords = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        goFilters = { ...filters, location: { ...filters.location, mode: 'current', radiusKm: filters.location.radiusKm || 10 } };
        setDeviceCoords(goCoords);
        setFilters(goFilters);
      } catch {
        setLocationNotice('לא הצלחנו לאתר את המיקום - בחרו איזור באופן ידני ב"באיזור שלי" 📍');
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

  const handleFreeSearch = () => {
    if (!freeSearchText.trim()) return;
    router.push({
      pathname: '/activities',
      params: {
        homeFilters: JSON.stringify({ ...filters, q: freeSearchText.trim() }),
        homeCoords: deviceCoords ? JSON.stringify(deviceCoords) : '',
      },
    });
  };

  return (
    <View style={styles.screen}>
      <LinearGradient colors={[colors.accentTint, colors.accentTintLight, colors.bg]} style={styles.topGradient} />
      <SkyClouds />
      <SunMascot />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Header onMenuPress={() => {}} />

        <Text style={styles.headline}>
          כל הפעילויות, לכל הילדים, במקום אחד
        </Text>

        {isPersonalized ? (
          <PersonalPicker kids={children} selectedChildIds={selectedChildIds} onToggleChild={toggleChild} />
        ) : (
          <View style={styles.filtersCard}>
            {PRIMARY_FILTERS.map((f, i) => (
              <FilterRow key={f.key} f={f} isLast={i === PRIMARY_FILTERS.length - 1} onPress={f.onPress} />
            ))}
          </View>
        )}

        <Pressable style={styles.ageAddRow} onPress={() => setAgeQuickOpen(true)} hitSlop={8}>
          <Text style={[styles.ageAddText, filters.age.length > 0 && styles.ageAddTextActive]}>
            {filters.age.length > 0 ? `+ גילאים: ${ageSummary(filters.age)}` : '+ הוספת גילאים'}
          </Text>
        </Pressable>

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

        {userId ? (
          <Pressable style={styles.saveDefaultLink} onPress={handleSaveAsDefault} disabled={savingDefault} hitSlop={8}>
            <Text style={styles.saveDefaultText}>
              {savingDefault ? 'שומר...' : hasSavedDefault ? '⭐ עדכן את ברירת המחדל שלי' : '⭐ שמור את הבחירה כברירת מחדל'}
            </Text>
          </Pressable>
        ) : null}
        {defaultNotice ? <Text style={styles.defaultNoticeText}>{defaultNotice}</Text> : null}

        <Pressable style={styles.searchBtnWrap} onPress={handleGo} disabled={locatingForSearch}>
          <LinearGradient colors={['#1cb0e0', '#00647f']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.searchBtn}>
            {locatingForSearch ? (
              <ActivityIndicator color="#ffffff" size="small" />
            ) : (
              <>
                <Text style={styles.searchBtnText}>יאללה, יוצאים לדרך!</Text>
                <Text style={styles.searchBtnEmoji}>🚀</Text>
              </>
            )}
          </LinearGradient>
        </Pressable>
        {locationNotice ? <Text style={styles.locationNoticeText}>{locationNotice}</Text> : null}

        <View style={styles.smallActionsRow}>
          <Pressable style={styles.smallActionBtn} onPress={handleAdvancedFilters}>
            <Text style={styles.smallActionText}>🎯 סינון מתקדם</Text>
          </Pressable>
          <Pressable style={styles.spontaneousBtnWrap} onPress={handleSpontaneous} disabled={spontaneousLoading}>
            <LinearGradient colors={['#ffbb4d', '#ff8a3d']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.spontaneousBtn}>
              {spontaneousLoading ? <ActivityIndicator color="#ffffff" size="small" /> : <Text style={styles.spontaneousEmoji}>🪄</Text>}
              <Text style={styles.spontaneousBtnText}>ספונטניים</Text>
            </LinearGradient>
          </Pressable>
        </View>
        {spontaneousError ? <Text style={styles.spontaneousErrorText}>{spontaneousError}</Text> : null}

        <View style={styles.freeSearch}>
          <Pressable onPress={handleFreeSearch} hitSlop={8}>
            <SearchIcon />
          </Pressable>
          <TextInput
            style={styles.freeSearchInput}
            placeholder="חפשו פעילות, אירוע או מקום..."
            placeholderTextColor={colors.textMuted}
            value={freeSearchText}
            onChangeText={setFreeSearchText}
            onSubmitEditing={handleFreeSearch}
            returnKeyType="search"
          />
        </View>

        <View style={styles.footerVerseCard}>
          <Text style={styles.footerVerse}>
            <Text style={styles.footerVerseMark}>״</Text>
            {'שְׁלַח־לְךָ֣ יְלָדִים֮ וְיָתֻר֖וּ אֶת־הָאָ֗רֶץ\n(אֹ֥ו לְפָחֹ֖ות אֶת־הַמִּשְׂחֲקִיָּה֮ הַקְּרוֹבָה֒)'}
            <Text style={styles.footerVerseMark}>״</Text>
          </Text>
        </View>

        <GrassFooter />
      </ScrollView>

      <AgeQuickPicker
        visible={ageQuickOpen}
        value={filters.age}
        onChange={(v) => setField('age', v)}
        onClose={() => setAgeQuickOpen(false)}
      />
      <QuickPicker
        visible={categoryQuickOpen}
        title="מה בא לנו?"
        subtitle="אפשר לבחור כמה קטגוריות"
        options={CATEGORY_OPTIONS}
        value={filters.category}
        multiple
        showAll
        onChange={(v) => setField('category', v)}
        onClose={() => setCategoryQuickOpen(false)}
      />
      <LocationQuickPicker
        visible={whereQuickOpen}
        value={filters.location}
        onChange={(v) => setField('location', v)}
        onCoordsResolved={setDeviceCoords}
        onClose={() => setWhereQuickOpen(false)}
      />
      <LoginRequiredModal visible={showLoginPrompt} onClose={() => setShowLoginPrompt(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, paddingBottom: 40 },
  topGradient: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 320,
  },
  skyClouds: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 230,
  },
  sunMascot: {
    position: 'absolute', top: 4, left: 4,
  },
  grassFooter: {
    marginTop: 28, marginHorizontal: -spacing.xl, aspectRatio: 939 / 148,
  },
  grassFooterImage: { width: '100%', height: '100%' },
  grassFooterFade: { position: 'absolute', top: 0, left: 0, right: 0, height: '100%' },
  headline: {
    marginTop: 16, marginBottom: 20, textAlign: 'center', fontSize: 19, fontFamily: fonts.extraBold,
    color: colors.ink, paddingHorizontal: 10, lineHeight: 26,
  },
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
  smallActionsRow: { flexDirection: 'row-reverse', gap: 10, marginTop: 12, marginBottom: 16 },
  smallActionBtn: {
    flex: 1, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card,
    borderRadius: radii.pill, paddingVertical: 10,
  },
  smallActionText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.textSecondary },
  spontaneousBtnWrap: {
    flex: 1, borderRadius: radii.pill, overflow: 'hidden',
    shadowColor: '#ff8a3d', shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 3,
  },
  spontaneousBtn: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10,
  },
  spontaneousEmoji: { fontSize: 15, marginTop: -1 },
  spontaneousBtnText: { fontFamily: fonts.bold, fontSize: 12.5, color: '#ffffff' },
  spontaneousErrorText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.danger, textAlign: 'center', marginTop: -4, marginBottom: 10 },
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
  locationNoticeText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.danger, textAlign: 'center', marginTop: -12, marginBottom: 16 },
  freeSearch: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 10,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.pill, paddingVertical: 12, paddingHorizontal: 16,
  },
  freeSearchInput: { flex: 1, fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, textAlign: 'right', writingDirection: 'rtl' },
  footerVerseCard: {
    marginTop: 22, marginHorizontal: 10, paddingVertical: 12, paddingHorizontal: 18,
    backgroundColor: 'rgba(255,255,255,0.6)', borderRadius: radii.lg,
  },
  footerVerse: {
    fontFamily: fonts.verseBold, fontSize: 14, color: colors.ink, textAlign: 'center',
    letterSpacing: 0.2, lineHeight: 21,
  },
  footerVerseMark: { fontFamily: fonts.verseBold, fontSize: 14, color: colors.accent },
});
