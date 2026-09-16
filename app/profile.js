import { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Pressable, TextInput, ActivityIndicator, Modal, Image } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Path, Circle, Line } from 'react-native-svg';
import Header from '../components/Header';
import SkyBackground from '../components/SkyBackground';
import QuickPicker from '../components/QuickPicker';
import ExcludeAreasPicker from '../components/ExcludeAreasPicker';
import LocationQuickPicker, { locationSummary } from '../components/LocationQuickPicker';
import { StarIcon, ChatIcon, CheckIcon, ChevronLeftIcon, ChevronDownIcon, CalendarIcon } from '../components/icons';
import { colors, fonts, radii, spacing } from '../constants/theme';
import {
  CATEGORY_OPTIONS, PRICE_OPTIONS, PLACE_TYPE_OPTIONS, WHEN_OPTIONS, FILTER_SCHEMA, REGION_OPTIONS,
  BOOKING_OPTIONS, DURATION_OPTIONS, AMENITY_COMFORT_OPTIONS, BENEFIT_PROVIDER_OPTIONS,
} from '../constants/filterSchema';
import { categorySummary, listJoin } from '../lib/filterSummaries';
import { supabase } from '../lib/supabase';
import { clearPin } from '../lib/pin';
import { normalizeFilters } from '../lib/filterActivities';
import {
  fetchUserPreferences, saveExcludedCategories, saveExcludedCities, saveExcludedRegions, saveChildren,
  saveVisibleHomeFilters, saveDefaultHomeFilters, saveBenefitClubs,
} from '../lib/preferences';
import { formatChildAge } from '../lib/children';
import { fetchAllPersonalNotes, savePersonalNote, fetchHiddenActivities, toggleHidden } from '../lib/interactions';
import { placeholderImageFor, placeholderBgColorFor } from '../lib/placeholderImages';
import { relativeDate } from '../lib/formatDate';
import { requestAccountDeletion } from '../lib/legal';
import { useI18n, createStyles, t as translate, LOCALES, SUPPORTED_LOCALES } from '../lib/i18n';
import { categoryLabel, regionLabel, placeName } from '../lib/i18n/format';

// אלו הפילטרים שכבר תמיד מופיעים במסך הראשי (קטגוריה/מיקום כפילטרים ראשיים, גיל כקישור
// עדין קבוע) - לא הגיוני לתת עליהם toggle נפרד. שאר הרשימה (מתי/מחיר/סוג מקום/הזמנה/משך/
// נגישות) היא מה שמשתמש יכול לבחור להוסיף כקישורים קטנים נוספים במסך הראשי שלו.
const TOGGLABLE_HOME_FILTERS = FILTER_SCHEMA.filter((f) => !['category', 'location', 'age'].includes(f.key));

// Labels: profile.notifications.items.<key>
const NOTIFICATION_ITEMS = [
  { key: 'new_nearby' },
  { key: 'matches_children' },
  { key: 'weekend_ideas' },
  { key: 'favorite_categories' },
  { key: 'saved_reminders' },
];

// Same options (and locale-aware labels) as the shared WHEN_OPTIONS, limited to today/tomorrow/weekend.
const WHEN_QUICK_OPTIONS = WHEN_OPTIONS.filter((o) => ['today', 'tomorrow', 'weekend'].includes(o.id));

// Canonical benefit-provider value for "other" (data, not copy).
const OTHER_BENEFIT = 'אחר'; // i18n-ignore

// Labels: profile.myActivities.tabs.<key>
const TABS = [
  { key: 'favorites', table: 'favorites' },
  { key: 'planned', table: 'planned_activities' },
  { key: 'visited', table: 'visited_activities' },
];

// ChevronLeftIcon is drawn pointing left = "open/forward" in Hebrew; mirrored for LTR locales.
function ForwardChevron() {
  const { dir } = useI18n();
  return (
    <View style={{ transform: [{ rotate: dir.forwardRotate }] }}>
      <ChevronLeftIcon size={12} color={colors.textMuted} />
    </View>
  );
}

// Language preference row - writes the same global locale as the Home switcher.
function LanguageRow({ last }) {
  const { t, locale, setLocale } = useI18n();
  return (
    <View style={[styles.settingRow, last && styles.settingRowLast]}>
      <Text style={styles.settingLabel}>{t('common.language.label')}</Text>
      <View style={styles.langOptions} accessibilityRole="radiogroup" accessibilityLabel={t('common.language.label')}>
        {SUPPORTED_LOCALES.map((code) => {
          const selected = code === locale;
          return (
            <Pressable
              key={code}
              style={[styles.langOption, selected && styles.langOptionSelected]}
              onPress={() => setLocale(code)}
              hitSlop={6}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              accessibilityLabel={selected
                ? t('common.language.current', { language: LOCALES[code].nativeName })
                : t('common.language.switchTo', { language: LOCALES[code].nativeName })}
            >
              <Text style={[styles.langOptionText, selected && styles.langOptionTextSelected]}>{LOCALES[code].nativeName}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function PlusIcon() {
  return (
    <Svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.6} strokeLinecap="round">
      <Line x1="12" y1="4" x2="12" y2="20" />
      <Line x1="4" y1="12" x2="20" y2="12" />
    </Svg>
  );
}

function EditIcon() {
  return (
    <Svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke={colors.accent} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M3 8h3l2-3h8l2 3h3v11H3z" />
      <Circle cx="12" cy="14" r="3.5" />
    </Svg>
  );
}

function formatPhoneDisplay(e164) {
  if (!e164) return '';
  const digits = e164.startsWith('+972') ? '0' + e164.slice(4) : e164;
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return digits;
}

function summaryForPreference(key, filters) {
  if (key === 'location') return filters.location?.mode ? locationSummary(filters.location) : null;
  if (key === 'category') return filters.category?.length ? categorySummary(filters.category) : null;
  if (key === 'when') return filters.when?.options?.length ? WHEN_QUICK_OPTIONS.find((o) => o.id === filters.when.options[0])?.label : null;
  if (key === 'price') return filters.price?.length ? PRICE_OPTIONS.find((o) => o.id === filters.price[0])?.label : null;
  if (key === 'placeType') return filters.placeType?.length ? PLACE_TYPE_OPTIONS.find((o) => o.id === filters.placeType[0])?.label : null;
  if (key === 'booking') return filters.booking?.length ? BOOKING_OPTIONS.find((o) => o.id === filters.booking[0])?.label : null;
  if (key === 'duration') return filters.duration?.length ? listJoin(filters.duration.map((id) => DURATION_OPTIONS.find((o) => o.id === id)?.label).filter(Boolean)) : null;
  if (key === 'amenities') return filters.amenities?.length ? listJoin(filters.amenities.map((id) => AMENITY_COMFORT_OPTIONS.find((o) => o.id === id)?.label).filter(Boolean)) : null;
  return null;
}

const emptyChildDraft = { id: null, name: '', gender: null, day: '', month: '', year: '' };

export default function ProfileScreen() {
  const router = useRouter();
  const { t, dir } = useI18n();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState(null);
  const [nickname, setNickname] = useState('');
  const [stars, setStars] = useState(0);
  const [email, setEmail] = useState('');
  const [notifyByEmail, setNotifyByEmail] = useState(false);
  const [emailColumnsAvailable, setEmailColumnsAvailable] = useState(false);
  const [quickLoginEnabled, setQuickLoginEnabled] = useState(false);
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState('');
  const [savingNickname, setSavingNickname] = useState(false);
  const [notice, setNotice] = useState('');

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteRequestSubmitting, setDeleteRequestSubmitting] = useState(false);
  const [deleteRequestSent, setDeleteRequestSent] = useState(false);

  const [children, setChildren] = useState([]);
  const [childModalOpen, setChildModalOpen] = useState(false);
  const [childDraft, setChildDraft] = useState(emptyChildDraft);
  const [savingChildren, setSavingChildren] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);

  const [excludedCategories, setExcludedCategories] = useState([]);
  const [excludedDraft, setExcludedDraft] = useState([]);
  const [excludedPickerOpen, setExcludedPickerOpen] = useState(false);
  const [savingExcluded, setSavingExcluded] = useState(false);
  const [excludedCities, setExcludedCities] = useState([]);
  const [excludedRegions, setExcludedRegions] = useState([]);
  // "⛔ לאן לא תרצו להגיע?" - draft דו-ממדי אחד ({regions, cities}), ראו components/ExcludeAreasPicker.js.
  const [excludedAreasDraft, setExcludedAreasDraft] = useState({ regions: [], cities: [] });
  const [excludedCitiesPickerOpen, setExcludedCitiesPickerOpen] = useState(false);
  const [savingExcludedCities, setSavingExcludedCities] = useState(false);
  const [benefitClubs, setBenefitClubs] = useState([]);
  const [benefitClubsOther, setBenefitClubsOther] = useState('');
  const [benefitClubsDraft, setBenefitClubsDraft] = useState([]);
  const [benefitClubsOtherDraft, setBenefitClubsOtherDraft] = useState('');
  const [benefitClubsPickerOpen, setBenefitClubsPickerOpen] = useState(false);
  const [savingBenefitClubs, setSavingBenefitClubs] = useState(false);
  const [hiddenActivities, setHiddenActivities] = useState([]);
  const [hiddenModalOpen, setHiddenModalOpen] = useState(false);
  const [hiddenLoading, setHiddenLoading] = useState(false);
  const [unhidingId, setUnhidingId] = useState(null);
  const [visibleHomeFilters, setVisibleHomeFilters] = useState([]);
  const [savingVisibleFilters, setSavingVisibleFilters] = useState(false);
  // "פילטרים נוספים במסך הראשי" - שורה מתקפלת בתוך "⚙️ הגדרות" (הועברה מ"עוד הגדרות" שהוסר).
  const [visibleFiltersOpen, setVisibleFiltersOpen] = useState(false);

  const [homeDefaultsDraft, setHomeDefaultsDraft] = useState(null);
  const [savingHomeDefaults, setSavingHomeDefaults] = useState(false);
  const [searchPrefsOpen, setSearchPrefsOpen] = useState(false);
  const [prefLocationOpen, setPrefLocationOpen] = useState(false);
  const [prefCategoryOpen, setPrefCategoryOpen] = useState(false);
  const [prefWhenOpen, setPrefWhenOpen] = useState(false);
  const [prefPriceOpen, setPrefPriceOpen] = useState(false);
  const [prefPlaceTypeOpen, setPrefPlaceTypeOpen] = useState(false);
  const [prefBookingOpen, setPrefBookingOpen] = useState(false);
  const [prefDurationOpen, setPrefDurationOpen] = useState(false);
  const [prefAmenitiesOpen, setPrefAmenitiesOpen] = useState(false);

  const [notificationPrefs, setNotificationPrefs] = useState({});

  const [activeTab, setActiveTab] = useState('favorites');
  const [tabItems, setTabItems] = useState([]);
  const [tabLoading, setTabLoading] = useState(false);

  const [notes, setNotes] = useState([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [noteModalOpen, setNoteModalOpen] = useState(false);
  const [noteModalDraft, setNoteModalDraft] = useState('');
  const [noteModalTarget, setNoteModalTarget] = useState(null);
  const [savingNoteModal, setSavingNoteModal] = useState(false);

  const load = useCallback(async () => {
    const { data: { session: currentSession } } = await supabase.auth.getSession();
    setSession(currentSession);

    const [pinFlag, bioFlag] = await Promise.all([
      AsyncStorage.getItem('turu_pin_enabled'),
      AsyncStorage.getItem('turu_biometric_enabled'),
    ]);
    setQuickLoginEnabled(pinFlag === 'true' || bioFlag === 'true');

    if (!currentSession?.user?.id) {
      setLoading(false);
      return;
    }
    const userId = currentSession.user.id;

    const { data: profileWithEmail, error: emailErr } = await supabase
      .from('profiles').select('nickname, email, notify_by_email').eq('id', userId).maybeSingle();
    if (!emailErr && profileWithEmail) {
      setNickname(profileWithEmail.nickname || '');
      setEmail(profileWithEmail.email || '');
      setNotifyByEmail(!!profileWithEmail.notify_by_email);
      setEmailColumnsAvailable(true);
    } else {
      const { data: basicProfile } = await supabase.from('profiles').select('nickname').eq('id', userId).maybeSingle();
      setNickname(basicProfile?.nickname || '');
      setEmailColumnsAvailable(false);
    }
    // stars עוד לא קיים ב-DB (0020_recommendation_stars.sql לא רץ) - שאילתה נפרדת שנכשלת
    // בשקט, כדי לא לשבור את טעינת הכינוי/אימייל למעלה.
    const { data: starsRow, error: starsErr } = await supabase.from('profiles').select('stars').eq('id', userId).maybeSingle();
    setStars(!starsErr ? starsRow?.stars ?? 0 : 0);

    // אם fetchUserPreferences נכשלת (למשל עמודה חסרה זמנית) - לא משאירים את כל העמוד תקוע
    // על ספינר לנצח; ממשיכים עם ברירות מחדל ריקות כדי שהעמוד לפחות יהיה שמיש.
    try {
      const prefs = await fetchUserPreferences(userId);
      setExcludedCategories(prefs.excludedCategories);
      setExcludedCities(prefs.excludedCities);
      setExcludedRegions(prefs.excludedRegions);
      setBenefitClubs(prefs.benefitClubs);
      setBenefitClubsOther(prefs.benefitClubsOther);
      setChildren(prefs.children);
      setVisibleHomeFilters(prefs.visibleHomeFilters);
      setHomeDefaultsDraft(normalizeFilters(prefs.defaultHomeFilters || {}));
      setNotificationPrefs(prefs.notificationPrefs || {});
    } catch (err) {
      setHomeDefaultsDraft(normalizeFilters({}));
      showNotice(translate('profile.errors.prefsLoad'));
    }

    setNotesLoading(true);
    try {
      setNotes(await fetchAllPersonalNotes(userId));
    } catch (err) {
      showNotice(translate('profile.errors.notesLoad'));
    } finally {
      setNotesLoading(false);
    }

    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const loadTab = useCallback(async (tabKey) => {
    if (!session?.user?.id) return;
    const tab = TABS.find((x) => x.key === tabKey);
    setTabLoading(true);
    const { data, error } = await supabase
      .from(tab.table)
      .select('activity_id, created_at, activity:activities(id, name, category, location:locations(name, city))')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: false })
      .limit(20);
    if (!error) setTabItems((data || []).filter((r) => r.activity));
    setTabLoading(false);
  }, [session?.user?.id]);

  useEffect(() => { if (session?.user?.id) loadTab(activeTab); }, [session?.user?.id, activeTab, loadTab]);

  // ---- הערות אישיות ----
  // פתיחת מודל ההערה מתוך "❤️ הפעילויות שלי" (לא רק מתוך "📝 ההערות האישיות שלי") - הפעילות
  // הזו לא בהכרח כבר קיימת ב-notes (ייתכן שאין לה הערה עדיין), אז מחפשים אותה שם ונופלים חזרה
  // לאובייקט-פעילות מינימלי (שם בלבד, מספיק לכותרת המודל) אם היא לא נמצאה.
  const openNoteForActivity = (activityId, activityName) => {
    const existing = notes.find((n) => n.activity_id === activityId);
    setNoteModalTarget(existing || { activity_id: activityId, activity: { name: activityName } });
    setNoteModalDraft(existing ? existing.note : '');
    setNoteModalOpen(true);
  };

  const saveNoteModal = async () => {
    if (!noteModalTarget || !session?.user?.id) return;
    setSavingNoteModal(true);
    try {
      await savePersonalNote(session.user.id, noteModalTarget.activity_id, noteModalDraft);
      const trimmed = noteModalDraft.trim();
      setNotes((prev) => {
        if (!trimmed) return prev.filter((n) => n.activity_id !== noteModalTarget.activity_id);
        const exists = prev.some((n) => n.activity_id === noteModalTarget.activity_id);
        if (exists) {
          return prev.map((n) => (n.activity_id === noteModalTarget.activity_id ? { ...n, note: trimmed, updated_at: new Date().toISOString() } : n));
        }
        // הערה חדשה שנוצרה מ"הפעילויות שלי" (לא הייתה קיימת קודם ב-notes) - מוסיפים שורה
        // מלאה כדי שהיא תופיע מיד גם ב"📝 ההערות האישיות שלי" בלי לטעון מחדש מה-DB.
        const now = new Date().toISOString();
        return [{ activity_id: noteModalTarget.activity_id, note: trimmed, created_at: now, updated_at: now, activity: noteModalTarget.activity }, ...prev];
      });
      setNoteModalOpen(false);
      showNotice(t('profile.notes.saved'));
    } catch (err) {
      showNotice(t('profile.errors.noteSave'));
    } finally {
      setSavingNoteModal(false);
    }
  };

  const showNotice = (text) => {
    setNotice(text);
    setTimeout(() => setNotice(''), 3000);
  };

  const startEditNickname = () => {
    setNicknameDraft(nickname);
    setEditingNickname(true);
  };

  const saveNickname = async () => {
    if (!nicknameDraft.trim() || !session?.user?.id) return;
    setSavingNickname(true);
    const { error } = await supabase.from('profiles').update({ nickname: nicknameDraft.trim() }).eq('id', session.user.id);
    setSavingNickname(false);
    if (!error) {
      setNickname(nicknameDraft.trim());
      setEditingNickname(false);
    } else {
      showNotice(t('profile.errors.nicknameSave'));
    }
  };

  // ---- ילדים ----
  const openAddChild = () => { setChildDraft(emptyChildDraft); setChildModalOpen(true); };

  const openEditChild = (child) => {
    const birth = child.birthdate ? new Date(child.birthdate) : null;
    setChildDraft({
      id: child.id,
      name: child.name || '',
      gender: child.gender || null,
      day: birth ? String(birth.getDate()) : '',
      month: birth ? String(birth.getMonth() + 1) : '',
      year: birth ? String(birth.getFullYear()) : '',
    });
    setChildModalOpen(true);
  };

  const persistChildren = async (next) => {
    setSavingChildren(true);
    try {
      await saveChildren(session.user.id, next);
      setChildren(next);
    } catch (err) {
      showNotice(t('profile.errors.childrenSave'));
    } finally {
      setSavingChildren(false);
    }
  };

  const isChildDraftValid = () => {
    const day = Number(childDraft.day);
    const month = Number(childDraft.month);
    const year = Number(childDraft.year);
    const nowYear = new Date().getFullYear();
    return day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= nowYear - 18 && year <= nowYear;
  };

  const saveChildDraft = () => {
    if (!isChildDraftValid()) return;
    const birthdate = `${childDraft.year}-${String(childDraft.month).padStart(2, '0')}-${String(childDraft.day).padStart(2, '0')}`;
    const entry = { id: childDraft.id || `c${Date.now()}`, name: childDraft.name.trim() || null, gender: childDraft.gender, birthdate };
    const next = childDraft.id
      ? children.map((c) => (c.id === childDraft.id ? entry : c))
      : [...children, entry];
    setChildModalOpen(false);
    persistChildren(next);
  };

  const deleteChild = (id) => {
    persistChildren(children.filter((c) => c.id !== id));
  };

  // ---- העדפות חיפוש (default_home_filters) ----
  const setPref = (key, value) => setHomeDefaultsDraft((prev) => ({ ...prev, [key]: value }));

  const handleSaveHomeDefaults = async () => {
    setSavingHomeDefaults(true);
    try {
      await saveDefaultHomeFilters(session.user.id, homeDefaultsDraft);
      showNotice(t('profile.searchPrefs.saved'));
    } catch (err) {
      showNotice(t('profile.errors.save'));
    } finally {
      setSavingHomeDefaults(false);
    }
  };

  // ---- הגדרות נוספות ----
  const openExcludedPicker = () => {
    setExcludedDraft(excludedCategories);
    setExcludedPickerOpen(true);
  };

  const closeExcludedPicker = async () => {
    setExcludedPickerOpen(false);
    if (JSON.stringify(excludedDraft) === JSON.stringify(excludedCategories)) return;
    setSavingExcluded(true);
    try {
      await saveExcludedCategories(session.user.id, excludedDraft);
      setExcludedCategories(excludedDraft);
    } catch (err) {
      showNotice(t('profile.errors.prefsSave'));
    } finally {
      setSavingExcluded(false);
    }
  };

  // ⛔ "לאן לא תרצו להגיע?" - מקביל מדויק ל-openExcludedPicker/closeExcludedPicker למעלה, על
  // draft דו-ממדי (אזורים+ערים, ראו components/ExcludeAreasPicker.js).
  const openExcludedCitiesPicker = () => {
    setExcludedAreasDraft({ regions: excludedRegions, cities: excludedCities });
    setExcludedCitiesPickerOpen(true);
  };

  const closeExcludedCitiesPicker = async () => {
    setExcludedCitiesPickerOpen(false);
    const unchanged = JSON.stringify(excludedAreasDraft.cities) === JSON.stringify(excludedCities)
      && JSON.stringify(excludedAreasDraft.regions) === JSON.stringify(excludedRegions);
    if (unchanged) return;
    setSavingExcludedCities(true);
    try {
      await Promise.all([
        saveExcludedCities(session.user.id, excludedAreasDraft.cities),
        saveExcludedRegions(session.user.id, excludedAreasDraft.regions),
      ]);
      setExcludedCities(excludedAreasDraft.cities);
      setExcludedRegions(excludedAreasDraft.regions);
    } catch (err) {
      showNotice(t('profile.errors.prefsSave'));
    } finally {
      setSavingExcludedCities(false);
    }
  };

  // "איפוס כל העדפות החיפוש" - מאפס גם קטגוריות וגם ערים יחד (סעיף 15 בבקשה).
  const resetAllSearchPreferences = async () => {
    setSavingExcluded(true);
    setSavingExcludedCities(true);
    try {
      await Promise.all([
        saveExcludedCategories(session.user.id, []),
        saveExcludedCities(session.user.id, []),
        saveExcludedRegions(session.user.id, []),
      ]);
      setExcludedCategories([]);
      setExcludedCities([]);
      setExcludedRegions([]);
    } catch (err) {
      showNotice(t('profile.errors.prefsReset'));
    } finally {
      setSavingExcluded(false);
      setSavingExcludedCities(false);
    }
  };

  // 🎟️ ההטבות שלי - אילו מועדונים/כרטיסים יש למשתמש, אופציונלי לגמרי (ראו lib/benefits.js
  // לאיך זה משפיע על ניסוח התג/סינון/דירוג) - אותו דפוס בדיוק כמו openExcludedPicker למעלה.
  const openBenefitClubsPicker = () => {
    setBenefitClubsDraft(benefitClubs);
    setBenefitClubsOtherDraft(benefitClubsOther);
    setBenefitClubsPickerOpen(true);
  };

  const closeBenefitClubsPicker = async () => {
    setBenefitClubsPickerOpen(false);
    // "אחר" לא נבחר יותר - הטקסט החופשי כבר לא רלוונטי, לא שומרים אותו (גם אם הוקלד קודם).
    const otherToSave = benefitClubsDraft.includes(OTHER_BENEFIT) ? benefitClubsOtherDraft.trim() : '';
    if (
      JSON.stringify(benefitClubsDraft) === JSON.stringify(benefitClubs)
      && otherToSave === (benefitClubsOther || '')
    ) return;
    setSavingBenefitClubs(true);
    try {
      await saveBenefitClubs(session.user.id, benefitClubsDraft, otherToSave);
      setBenefitClubs(benefitClubsDraft);
      setBenefitClubsOther(otherToSave);
    } catch (err) {
      showNotice(t('profile.errors.benefitsSave'));
    } finally {
      setSavingBenefitClubs(false);
    }
  };

  // 🙈 פעילויות חסומות - רשימת הפעילויות שהמשתמש הסתיר מ-app/activity/[id].js (טוגל HideIcon),
  // עם אפשרות "ביטול חסימה" לכל אחת. בניגוד ל-excludedCategories/benefitClubs למעלה, זו לא
  // בחירה-מרובה מרשימה קבועה אלא רשימה דינמית עם activity_id אמיתיים - מודל ייעודי, לא QuickPicker.
  const openHiddenModal = async () => {
    setHiddenModalOpen(true);
    setHiddenLoading(true);
    try {
      setHiddenActivities(await fetchHiddenActivities(session.user.id));
    } catch (err) {
      showNotice(t('profile.errors.hiddenLoad'));
    } finally {
      setHiddenLoading(false);
    }
  };

  const handleUnhide = async (activityId) => {
    setUnhidingId(activityId);
    try {
      await toggleHidden(session.user.id, activityId, false);
      setHiddenActivities((prev) => prev.filter((r) => r.activity_id !== activityId));
    } catch (err) {
      showNotice(t('profile.errors.unhide'));
    } finally {
      setUnhidingId(null);
    }
  };

  const toggleVisibleFilter = async (key) => {
    const next = visibleHomeFilters.includes(key)
      ? visibleHomeFilters.filter((k) => k !== key)
      : [...visibleHomeFilters, key];
    setVisibleHomeFilters(next);
    setSavingVisibleFilters(true);
    try {
      await saveVisibleHomeFilters(session.user.id, next);
    } catch (err) {
      setVisibleHomeFilters(visibleHomeFilters);
      showNotice(t('profile.errors.save'));
    } finally {
      setSavingVisibleFilters(false);
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    await clearPin();
    await AsyncStorage.removeItem('turu_asked_quick_login');
    router.replace('/login');
  };

  // TODO(backend): אין היום מחיקת-חשבון אוטומטית בשרת (ראו lib/legal.js) - זו בקשה אמיתית
  // הנשלחת לצוות לטיפול ידני, לא מחיקה בפועל. אסור להציג למשתמש שהחשבון נמחק בפועל כאן.
  const handleRequestDeletion = async () => {
    setDeleteRequestSubmitting(true);
    try {
      await requestAccountDeletion({
        userId: session.user.id,
        contactEmail: email || undefined,
        nickname,
        phone: session.user.phone,
      });
      setDeleteConfirmOpen(false);
      setDeleteRequestSent(true);
    } catch (err) {
      showNotice(t('profile.errors.deleteRequest'));
    } finally {
      setDeleteRequestSubmitting(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.screen}>
        <SkyBackground />
        <View style={styles.content}>
          <Header onMenuPress={() => {}} />
          <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>
        </View>
      </View>
    );
  }

  if (!session) {
    return (
      <View style={styles.screen}>
        <SkyBackground />
        <View style={styles.content}>
          <Header onMenuPress={() => {}} />
          <View style={styles.center}>
            <Text style={styles.welcome}>{t('profile.loggedOut.title')}</Text>
            <Pressable style={styles.loginBtn} onPress={() => router.push('/login')}>
              <Text style={styles.loginBtnText}>{t('profile.loggedOut.login')}</Text>
            </Pressable>
            <View style={[styles.accountCard, styles.loggedOutLanguageCard]}>
              <LanguageRow last />
            </View>
          </View>
        </View>
      </View>
    );
  }

  const isNewUser = children.length === 0 && !homeDefaultsDraft?.category?.length && !homeDefaultsDraft?.location?.mode;
  const showOnboarding = isNewUser && !onboardingDismissed;

  const summaryBits = [];
  if (children.length > 0) summaryBits.push(t('profile.know.children', { count: children.length }));
  const locSummary = summaryForPreference('location', homeDefaultsDraft || {});
  if (locSummary) summaryBits.push(`📍 ${locSummary}`);
  const catSummary = summaryForPreference('category', homeDefaultsDraft || {});
  if (catSummary) summaryBits.push(`🎯 ${catSummary}`);
  const priceSummary = summaryForPreference('price', homeDefaultsDraft || {});
  if (priceSummary) summaryBits.push(`💰 ${priceSummary}`);
  const whenSummaryBit = summaryForPreference('when', homeDefaultsDraft || {});
  if (whenSummaryBit) summaryBits.push(`📅 ${whenSummaryBit}`);

  return (
    <View style={styles.screen}>
      <SkyBackground />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Header onMenuPress={() => {}} />

        {notice ? <View style={styles.noticeBox}><Text style={styles.noticeText}>{notice}</Text></View> : null}

        <View style={styles.pageTitleBlock}>
          <Text style={styles.pageEmoji}>👨‍👩‍👧</Text>
          <Text style={styles.pageTitle}>{t('profile.page.title')}</Text>
          <Text style={styles.pageSubtitle}>{t('profile.page.subtitle')}</Text>
        </View>

        <View style={styles.profileBlock}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{nickname ? nickname[0] : '?'}</Text>
          </View>
          <View style={styles.profileInfo}>
            {editingNickname ? (
              <View style={styles.nicknameEditRow}>
                <TextInput style={styles.nicknameInput} value={nicknameDraft} onChangeText={setNicknameDraft} autoFocus />
                <Pressable onPress={saveNickname} disabled={savingNickname}>
                  <Text style={styles.nicknameSave}>{savingNickname ? '...' : t('common.actions.save')}</Text>
                </Pressable>
                <Pressable onPress={() => setEditingNickname(false)}>
                  <Text style={styles.nicknameCancel}>{t('common.actions.cancel')}</Text>
                </Pressable>
              </View>
            ) : (
              <>
                <View style={styles.profileNameRow}>
                  <Text style={styles.profileName}>{nickname || t('profile.header.noNickname')}</Text>
                  <Text style={styles.profileStars}>⭐{stars}</Text>
                </View>
                <Pressable onPress={startEditNickname}>
                  <Text style={styles.profileEdit}>{t('profile.header.editNickname')}</Text>
                </Pressable>
              </>
            )}
          </View>
          <Pressable style={styles.addActivityBtn} onPress={() => router.push('/add-activity')}>
            <PlusIcon />
            <Text style={styles.addActivityText}>{t('profile.header.addActivity')}</Text>
          </Pressable>
        </View>

        {/* 👋 בואו נכיר - הכרטיס הראשון בעמוד (לפני "העדפות חיפוש"), לפי בקשת המשתמש. */}
        {showOnboarding && (
          <View style={styles.onboardingCard}>
            <Text style={styles.onboardingTitle}>{t('profile.onboarding.title')}</Text>
            <Text style={styles.onboardingSub}>{t('profile.onboarding.subtitle')}</Text>
            <View style={styles.onboardingSteps}>
              <Text style={styles.onboardingStep}>{t('profile.onboarding.step1')}</Text>
              <Text style={styles.onboardingStep}>{t('profile.onboarding.step2')}</Text>
              <Text style={styles.onboardingStep}>{t('profile.onboarding.step3')}</Text>
            </View>
            <Pressable style={styles.onboardingGoBtn} onPress={openAddChild}>
              <Text style={styles.onboardingGoBtnText}>{t('profile.onboarding.start')}</Text>
            </Pressable>
            <Pressable onPress={() => setOnboardingDismissed(true)}>
              <Text style={styles.onboardingSkip}>{t('profile.onboarding.skip')}</Text>
            </Pressable>
          </View>
        )}

        {/* ⭐ העדפות החיפוש שלי - accordion יחיד: שורה אחת גלויה תמיד ("העדפות חיפוש"), כל
            התוכן מתחתיה מתקפל/נפתח בלחיצה על השורה עצמה בלבד - הועבר גם למיקום גבוה יותר בעמוד
            (מיד אחרי כרטיס הפרופיל, לפני הילדים), לפי בקשת המשתמש. "עוד העדפות" (הזמנה/משך/
            נגישות דרך FiltersSheet) הוסר - שלושתם עכשיו שורות ייעודיות רגילות כמו כל השאר, בלי
            הפרדה. "קטגוריות שלעולם לא יוצגו לי"/"אזורים שלא להציג" עברו לכאן מ"עוד הגדרות" שהוסר. */}
        <View style={styles.shelf}>
          <Pressable style={styles.shelfHeadToggle} onPress={() => setSearchPrefsOpen((v) => !v)}>
            <Text style={styles.shelfTitle}>{t('profile.searchPrefs.title')}</Text>
            <View style={{ transform: [{ rotate: searchPrefsOpen ? '180deg' : '0deg' }] }}>
              <ChevronDownIcon size={14} />
            </View>
          </Pressable>
          {searchPrefsOpen && (
            <>
              <Text style={styles.sectionHint}>{t('profile.searchPrefs.hint')}</Text>

              <View style={styles.accountCard}>
                <Pressable style={styles.settingRow} onPress={() => setPrefLocationOpen(true)}>
                  <Text style={styles.settingLabel}>{t('profile.searchPrefs.location')}</Text>
                  <View style={styles.badgeSetup}>
                    <Text style={styles.badgeSetupText}>{summaryForPreference('location', homeDefaultsDraft) || t('profile.searchPrefs.choose')}</Text>
                    <ForwardChevron />
                  </View>
                </Pressable>
                <Pressable style={styles.settingRow} onPress={() => setPrefCategoryOpen(true)}>
                  <Text style={styles.settingLabel}>{t('profile.searchPrefs.category')}</Text>
                  <View style={styles.badgeSetup}>
                    <Text style={styles.badgeSetupText}>{summaryForPreference('category', homeDefaultsDraft) || t('profile.searchPrefs.choose')}</Text>
                    <ForwardChevron />
                  </View>
                </Pressable>
                <Pressable style={styles.settingRow} onPress={() => setPrefWhenOpen(true)}>
                  <Text style={styles.settingLabel}>{t('profile.searchPrefs.when')}</Text>
                  <View style={styles.badgeSetup}>
                    <Text style={styles.badgeSetupText}>{summaryForPreference('when', homeDefaultsDraft) || t('profile.searchPrefs.anyTime')}</Text>
                    <ForwardChevron />
                  </View>
                </Pressable>
                <Pressable style={styles.settingRow} onPress={() => setPrefPriceOpen(true)}>
                  <Text style={styles.settingLabel}>{t('profile.searchPrefs.price')}</Text>
                  <View style={styles.badgeSetup}>
                    <Text style={styles.badgeSetupText}>{summaryForPreference('price', homeDefaultsDraft) || t('profile.searchPrefs.allPrices')}</Text>
                    <ForwardChevron />
                  </View>
                </Pressable>
                <Pressable style={styles.settingRow} onPress={() => setPrefPlaceTypeOpen(true)}>
                  <Text style={styles.settingLabel}>{t('profile.searchPrefs.placeType')}</Text>
                  <View style={styles.badgeSetup}>
                    <Text style={styles.badgeSetupText}>{summaryForPreference('placeType', homeDefaultsDraft) || t('profile.searchPrefs.noPreference')}</Text>
                    <ForwardChevron />
                  </View>
                </Pressable>
                <Pressable style={styles.settingRow} onPress={() => setPrefBookingOpen(true)}>
                  <Text style={styles.settingLabel}>{t('profile.searchPrefs.booking')}</Text>
                  <View style={styles.badgeSetup}>
                    <Text style={styles.badgeSetupText}>{summaryForPreference('booking', homeDefaultsDraft) || t('profile.searchPrefs.noPreference')}</Text>
                    <ForwardChevron />
                  </View>
                </Pressable>
                <Pressable style={styles.settingRow} onPress={() => setPrefDurationOpen(true)}>
                  <Text style={styles.settingLabel}>{t('profile.searchPrefs.duration')}</Text>
                  <View style={styles.badgeSetup}>
                    <Text style={styles.badgeSetupText} numberOfLines={1}>{summaryForPreference('duration', homeDefaultsDraft) || t('profile.searchPrefs.noPreference')}</Text>
                    <ForwardChevron />
                  </View>
                </Pressable>
                <Pressable style={styles.settingRow} onPress={() => setPrefAmenitiesOpen(true)}>
                  <Text style={styles.settingLabel}>{t('profile.searchPrefs.amenities')}</Text>
                  <View style={styles.badgeSetup}>
                    <Text style={styles.badgeSetupText} numberOfLines={1}>{summaryForPreference('amenities', homeDefaultsDraft) || t('profile.searchPrefs.noPreference')}</Text>
                    <ForwardChevron />
                  </View>
                </Pressable>
                <Pressable style={styles.settingRow} onPress={openExcludedPicker} disabled={savingExcluded}>
                  <Text style={styles.settingLabel}>{t('profile.searchPrefs.excludedCategories')}</Text>
                  <View style={styles.badgeSetup}>
                    <Text style={styles.badgeSetupText} numberOfLines={1}>
                      {savingExcluded ? t('common.actions.saving') : excludedCategories.length > 0 ? excludedCategories.map(categoryLabel).join(' · ') : t('profile.searchPrefs.choose')}
                    </Text>
                    <ForwardChevron />
                  </View>
                </Pressable>
                <Pressable style={[styles.settingRow, styles.settingRowLast]} onPress={openExcludedCitiesPicker} disabled={savingExcludedCities}>
                  <Text style={styles.settingLabel}>{t('profile.searchPrefs.excludedAreas')}</Text>
                  <View style={styles.badgeSetup}>
                    <Text style={styles.badgeSetupText} numberOfLines={1}>
                      {savingExcludedCities ? t('common.actions.saving') : (excludedRegions.length + excludedCities.length) > 0
                        ? [...excludedRegions.map((id) => REGION_OPTIONS.find((r) => r.id === id)?.label || regionLabel(id)), ...excludedCities.map(placeName)].join(' · ')
                        : t('profile.searchPrefs.choose')}
                    </Text>
                    <ForwardChevron />
                  </View>
                </Pressable>
              </View>

              {(excludedCategories.length > 0 || excludedCities.length > 0 || excludedRegions.length > 0) && (
                <Pressable style={styles.resetAllPrefsBtn} onPress={resetAllSearchPreferences}>
                  <Text style={styles.resetAllPrefsBtnText}>{t('profile.searchPrefs.resetAll')}</Text>
                </Pressable>
              )}

              <Pressable style={styles.saveDefaultsBtn} onPress={handleSaveHomeDefaults} disabled={savingHomeDefaults}>
                <Text style={styles.saveDefaultsBtnText}>{savingHomeDefaults ? t('common.actions.saving') : t('profile.searchPrefs.save')}</Text>
              </Pressable>
            </>
          )}
        </View>

        {/* 👶 הילדים שלי */}
        <View style={styles.shelf}>
          <View style={styles.shelfHead}><Text style={styles.shelfTitle}>{t('profile.children.title')}</Text></View>

          {children.length === 0 ? (
            <>
              <View style={styles.emptyShelf}>
                <Text style={styles.emptyShelfText}>{t('profile.children.empty')}</Text>
              </View>
              <View style={styles.benefitsRow}>
                <View style={styles.benefitCard}>
                  <Text style={styles.benefitEmoji}>🎯</Text>
                  <Text style={styles.benefitTitle}>{t('profile.children.benefitMatchTitle')}</Text>
                  <Text style={styles.benefitText}>{t('profile.children.benefitMatchText')}</Text>
                </View>
                <View style={styles.benefitCard}>
                  <Text style={styles.benefitEmoji}>⚡</Text>
                  <Text style={styles.benefitTitle}>{t('profile.children.benefitFasterTitle')}</Text>
                  <Text style={styles.benefitText}>{t('profile.children.benefitFasterText')}</Text>
                </View>
                <View style={styles.benefitCard}>
                  <Text style={styles.benefitEmoji}>❤️</Text>
                  <Text style={styles.benefitTitle}>{t('profile.children.benefitPersonalTitle')}</Text>
                  <Text style={styles.benefitText}>{t('profile.children.benefitPersonalText')}</Text>
                </View>
              </View>
            </>
          ) : (
            <View style={styles.childrenList}>
              {children.map((child) => (
                <View key={child.id} style={styles.childCard}>
                  <Text style={styles.childEmoji}>{child.gender === 'female' ? '👧' : child.gender === 'male' ? '👦' : '🧒'}</Text>
                  <View style={styles.childInfo}>
                    <Text style={styles.childName}>{child.name || t('profile.children.fallbackName')}</Text>
                    <Text style={styles.childAge}>{formatChildAge(child)}</Text>
                  </View>
                  <Pressable style={styles.childActionBtn} onPress={() => openEditChild(child)} hitSlop={6}>
                    <EditIcon />
                  </Pressable>
                  <Pressable style={styles.childActionBtn} onPress={() => deleteChild(child.id)} hitSlop={6}>
                    <Text style={styles.childDeleteText}>✕</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          )}

          <Pressable style={styles.addChildBtn} onPress={openAddChild} disabled={savingChildren}>
            <Text style={styles.addChildBtnText}>{savingChildren ? t('common.actions.saving') : t('profile.children.add')}</Text>
          </Pressable>

          {children.length > 0 && (
            <Text style={styles.childrenFooterHint}>{t('profile.children.footerHint')}</Text>
          )}
        </View>

        {/* מה תורו יודע */}
        {summaryBits.length > 0 && (
          <View style={styles.knowCard}>
            <Text style={styles.knowTitle}>{t('profile.know.title')}</Text>
            {summaryBits.map((bit, i) => (
              <Text key={i} style={styles.knowBit}>{bit}</Text>
            ))}
          </View>
        )}

        {/* ❤️ הפעילויות שלי */}
        <View style={styles.shelf}>
          <View style={styles.shelfHead}><Text style={styles.shelfTitle}>{t('profile.myActivities.title')}</Text></View>
          <View style={styles.tabsRow}>
            {TABS.map((tabDef) => (
              <Pressable
                key={tabDef.key}
                style={[styles.tabBtn, activeTab === tabDef.key && styles.tabBtnActive]}
                onPress={() => setActiveTab(tabDef.key)}
              >
                <Text style={[styles.tabBtnText, activeTab === tabDef.key && styles.tabBtnTextActive]}>{t(`profile.myActivities.tabs.${tabDef.key}`)}</Text>
              </Pressable>
            ))}
          </View>
          {tabLoading ? (
            <ActivityIndicator color={colors.accent} style={{ marginTop: 12 }} />
          ) : tabItems.length === 0 ? (
            <View style={styles.emptyShelf}>
              <Text style={styles.emptyShelfText}>{t('profile.myActivities.empty')}</Text>
            </View>
          ) : (
            tabItems.slice(0, 3).map((item) => {
              const hasNote = notes.some((n) => n.activity_id === item.activity_id);
              return (
                <View key={item.activity_id} style={styles.tabItemRow}>
                  <Pressable style={styles.tabItemMain} onPress={() => router.push(`/activity/${item.activity_id}`)}>
                    <Text style={styles.tabItemTitle} numberOfLines={1}>{item.activity.name}</Text>
                    <Text style={styles.tabItemSub} numberOfLines={1}>
                      {[categoryLabel(item.activity.category), placeName(item.activity.location?.city) || item.activity.location?.name].filter(Boolean).join(' · ')}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={styles.tabItemNoteBtn}
                    onPress={() => openNoteForActivity(item.activity_id, item.activity.name)}
                    hitSlop={6}
                  >
                    <Text style={styles.tabItemNoteBtnText}>{hasNote ? t('profile.myActivities.note') : t('profile.myActivities.addNote')}</Text>
                  </Pressable>
                </View>
              );
            })
          )}
          <Pressable style={styles.allDestinationsBtn} onPress={() => router.push('/my-things')}>
            <Text style={styles.allDestinationsBtnText}>{t('profile.myActivities.allDestinations')}</Text>
          </Pressable>
        </View>

        {/* 📝 ההערות האישיות שלי - Preview קצר בלבד (רק ההערה האחרונה, notes כבר ממוין
            newest-first ע"י fetchAllPersonalNotes) - הרשימה המלאה עם מיון/חיפוש עברה ל-
            /my-things?tab=notes ("📝 הערות שלי", טאב ייעודי בעמוד "❤️ הדברים שלי" המאוחד). */}
        <View style={styles.shelf}>
          <View style={styles.shelfHead}>
            <Text style={styles.shelfTitle}>{t('profile.notes.title')}</Text>
            <Text style={styles.sectionHint}>{t('profile.notes.hint')}</Text>
          </View>

          {notesLoading ? (
            <ActivityIndicator color={colors.accent} style={{ marginTop: 12 }} />
          ) : notes.length === 0 ? (
            <View style={styles.emptyShelf}>
              <Text style={styles.emptyShelfText}>{t('profile.notes.emptyTitle')}</Text>
              <Text style={[styles.emptyShelfText, { marginTop: 4 }]}>{t('profile.notes.emptyText')}</Text>
            </View>
          ) : (() => {
            const note = notes[0];
            const thumb = note.activity.activity_images?.[0]?.url;
            const cityLabel = placeName(note.activity.location?.city) || note.activity.location?.name || '';
            return (
              <View style={styles.noteCard}>
                <View style={styles.noteCardTop}>
                  {thumb ? (
                    <Image source={{ uri: thumb }} style={styles.noteThumb} />
                  ) : placeholderImageFor(note.activity.placeholder_group) ? (
                    <Image
                      source={placeholderImageFor(note.activity.placeholder_group)}
                      resizeMode="contain"
                      style={[styles.noteThumb, { backgroundColor: placeholderBgColorFor(note.activity.placeholder_group) }]}
                    />
                  ) : (
                    <View style={styles.noteThumbPlaceholder}><Text style={styles.noteThumbPlaceholderText}>🖼️</Text></View>
                  )}
                  <View style={styles.noteCardInfo}>
                    <Pressable onPress={() => router.push(`/activity/${note.activity_id}`)}>
                      <Text style={styles.noteActivityName} numberOfLines={1}>{note.activity.name}</Text>
                    </Pressable>
                    {!!cityLabel && <Text style={styles.noteActivityLocation}>📍 {cityLabel}</Text>}
                  </View>
                </View>
                <Text style={styles.noteCardText} numberOfLines={3}>{note.note}</Text>
                <Text style={styles.noteCardMeta}>{t('profile.notes.writtenAt', { date: relativeDate(note.created_at) })}</Text>
              </View>
            );
          })()}

          <Pressable style={styles.allDestinationsBtn} onPress={() => router.push('/my-things?tab=notes')}>
            <Text style={styles.allDestinationsBtnText}>{t('profile.notes.all')}</Text>
          </Pressable>
        </View>

        {/* 🎟️ ההטבות שלי */}
        <View style={styles.shelf}>
          <View style={styles.shelfHead}>
            <Text style={styles.shelfTitle}>{t('profile.benefits.title')}</Text>
            <Text style={styles.sectionHint}>{t('profile.benefits.hint')}</Text>
          </View>
          <Text style={[styles.emptyShelfText, { textAlign: dir.textAlign, marginBottom: 10 }]}>
            {t('profile.benefits.intro')}
          </Text>
          <View style={styles.accountCard}>
            <Pressable style={[styles.settingRow, styles.settingRowLast]} onPress={openBenefitClubsPicker} disabled={savingBenefitClubs}>
              <Text style={styles.settingLabel}>{t('profile.benefits.row')}</Text>
              <View style={styles.badgeSetup}>
                <Text style={styles.badgeSetupText}>
                  {savingBenefitClubs ? t('common.actions.saving') : benefitClubs.length > 0 ? t('profile.benefits.selectedCount', { n: benefitClubs.length }) : t('profile.searchPrefs.choose')}
                </Text>
                <ForwardChevron />
              </View>
            </Pressable>
          </View>
          {benefitClubs.includes(OTHER_BENEFIT) && !!benefitClubsOther && (
            <Text style={[styles.sectionHint, { marginTop: 8 }]}>{t('profile.benefits.other', { text: benefitClubsOther })}</Text>
          )}
          <Text style={[styles.sectionHint, { marginTop: 8 }]}>
            {t('profile.benefits.optional')}
          </Text>
        </View>

        {/* 🎚️ פילטרים נוספים במסך הראשי - שורה מתקפלת (הועברה מ"⚙️ הגדרות", אחרי "🎟️ ההטבות
            שלי"), אותו דפוס accordion בדיוק כמו "⭐ העדפות חיפוש" למעלה - כולל אייקון ליד הכותרת
            כמו כל שאר הסקשנים בעמוד הזה. */}
        <View style={styles.shelf}>
          <Pressable style={styles.shelfHeadToggle} onPress={() => setVisibleFiltersOpen((v) => !v)}>
            <Text style={styles.shelfTitle}>{t('profile.visibleFilters.title')}</Text>
            <View style={{ transform: [{ rotate: visibleFiltersOpen ? '180deg' : '0deg' }] }}>
              <ChevronDownIcon size={14} />
            </View>
          </Pressable>
          {visibleFiltersOpen && (
            <View style={styles.accountCard}>
              {TOGGLABLE_HOME_FILTERS.map((f, i) => {
                const isVisible = visibleHomeFilters.includes(f.key);
                return (
                  <Pressable
                    key={f.key}
                    style={[styles.settingRow, i === TOGGLABLE_HOME_FILTERS.length - 1 && styles.settingRowLast]}
                    onPress={() => toggleVisibleFilter(f.key)}
                    disabled={savingVisibleFilters}
                  >
                    <Text style={styles.settingLabel}>{f.icon} {f.title}</Text>
                    <View style={[styles.toggle, isVisible ? styles.toggleOn : styles.toggleOff]}>
                      <View style={[styles.toggleDot, !isVisible && styles.toggleDotOff]} />
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>

        {/* 🔔 ההתראות שלי - עדיין אין תשתית שליחה בפועל (לא push ולא מייל), אז כל האזור מוצג
            באפור מדוהה ולא לחיץ - נראה, אבל ברור שהוא לא זמין כרגע, כדי לא ליצור רושם שגוי
            שההעדפות האלה כבר פעילות. "עדכונים על מקומות חדשים במייל" (שכן כותב ל-DB בפועל, רק
            שאין job שבאמת שולח מייל על סמך זה) עבר לכאן מ"⚙️ הגדרות" - שייך תמטית לכאן, ולא
            רלוונטי יותר להיות לחיץ לבד באזור נפרד מהתראות אחרות שכולן "בקרוב". */}
        <View style={styles.shelf}>
          <View style={styles.shelfHead}>
            <View style={styles.shelfHeadRow}>
              <Text style={styles.shelfTitle}>{t('profile.notifications.title')}</Text>
              <View style={styles.comingSoonBadge}><Text style={styles.comingSoonText}>{t('profile.notifications.comingSoon')}</Text></View>
            </View>
            <Text style={styles.sectionHint}>{t('profile.notifications.hint')}</Text>
          </View>
          <View style={[styles.accountCard, styles.disabledCard]}>
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>{t('profile.notifications.emailUpdates')}</Text>
              <View style={[styles.toggle, notifyByEmail && emailColumnsAvailable ? styles.toggleOn : styles.toggleOff]}>
                <View style={[styles.toggleDot, !(notifyByEmail && emailColumnsAvailable) && styles.toggleDotOff]} />
              </View>
            </View>
            {NOTIFICATION_ITEMS.map((item, i) => {
              const isOn = !!notificationPrefs[item.key];
              return (
                <View
                  key={item.key}
                  style={[styles.settingRow, i === NOTIFICATION_ITEMS.length - 1 && styles.settingRowLast]}
                >
                  <Text style={styles.settingLabel}>{t(`profile.notifications.items.${item.key}`)}</Text>
                  <View style={[styles.toggle, isOn ? styles.toggleOn : styles.toggleOff]}>
                    <View style={[styles.toggleDot, !isOn && styles.toggleDotOff]} />
                  </View>
                </View>
              );
            })}
          </View>
        </View>

        {/* ⚙️ הגדרות */}
        <View style={styles.shelf}>
          <View style={styles.shelfHead}><Text style={styles.shelfTitle}>{t('profile.settings.title')}</Text></View>
          <View style={styles.accountCard}>
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>{t('profile.settings.nickname')}</Text>
              <Text style={styles.settingValue}>{nickname || '-'}</Text>
            </View>
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>{t('profile.settings.phone')}</Text>
              <Text style={[styles.settingValue, { direction: 'ltr' }]}>{formatPhoneDisplay(session.user.phone)}</Text>
            </View>
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>{t('profile.settings.email')}</Text>
              <Text style={styles.settingValue}>{emailColumnsAvailable ? (email || t('profile.settings.emailNotSet')) : t('profile.settings.emailUnavailable')}</Text>
            </View>
            <LanguageRow />
            <Pressable style={styles.settingRow} onPress={() => !quickLoginEnabled && router.push('/biometric-prompt')}>
              <Text style={styles.settingLabel}>{t('profile.settings.quickLogin')}</Text>
              {quickLoginEnabled ? (
                <View style={styles.badgeOk}>
                  <CheckIcon size={13} color={colors.greenStrong} filled />
                  <Text style={styles.badgeOkText}>{t('profile.settings.quickLoginOn')}</Text>
                </View>
              ) : (
                <View style={styles.badgeSetup}>
                  <Text style={styles.badgeSetupText}>{t('profile.settings.quickLoginEnable')}</Text>
                  <ForwardChevron />
                </View>
              )}
            </Pressable>
            <Pressable style={[styles.settingRow, styles.settingRowLast]} onPress={openHiddenModal}>
              <Text style={styles.settingLabel}>{t('profile.settings.hiddenActivities')}</Text>
              <View style={styles.badgeSetup}>
                <Text style={styles.badgeSetupText}>{t('common.actions.edit')}</Text>
                <ForwardChevron />
              </View>
            </Pressable>
          </View>
        </View>

        {/* ⚖️ משפטי */}
        <View style={styles.shelf}>
          <View style={styles.accountCard}>
            <Pressable style={styles.settingRow} onPress={() => router.push('/terms')}>
              <Text style={styles.settingLabel}>{t('profile.legal.terms')}</Text>
              <ForwardChevron />
            </Pressable>
            <Pressable style={styles.settingRow} onPress={() => router.push('/privacy')}>
              <Text style={styles.settingLabel}>{t('profile.legal.privacy')}</Text>
              <ForwardChevron />
            </Pressable>
            <Pressable
              style={[styles.settingRow, styles.settingRowLast]}
              onPress={() => setDeleteConfirmOpen(true)}
              disabled={deleteRequestSent}
            >
              <Text style={styles.dangerLabel}>{t('profile.legal.deleteAccount')}</Text>
              {deleteRequestSent ? (
                <Text style={styles.badgeSetupText}>{t('profile.legal.deleteRequested')}</Text>
              ) : (
                <ForwardChevron />
              )}
            </Pressable>
          </View>
        </View>

        <Pressable onPress={handleLogout}>
          <Text style={styles.logoutLink}>{t('profile.legal.logout')}</Text>
        </Pressable>
      </ScrollView>

      {/* אישור בקשת מחיקת חשבון - שולחת בקשה אמיתית לצוות (אין מנגנון מחיקה אוטומטי כרגע) */}
      <Modal visible={deleteConfirmOpen} transparent animationType="fade" onRequestClose={() => setDeleteConfirmOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setDeleteConfirmOpen(false)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>{t('profile.deleteModal.title')}</Text>
            <Text style={styles.deleteExplainText}>{t('profile.deleteModal.text')}</Text>
            <View style={styles.modalActionsRow}>
              <Pressable
                style={[styles.modalSaveBtn, styles.modalDangerBtn, deleteRequestSubmitting && styles.modalSaveBtnDisabled]}
                onPress={handleRequestDeletion}
                disabled={deleteRequestSubmitting}
              >
                {deleteRequestSubmitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.modalSaveBtnText}>{t('profile.deleteModal.submit')}</Text>}
              </Pressable>
              <Pressable style={styles.modalCancelBtn} onPress={() => setDeleteConfirmOpen(false)}>
                <Text style={styles.modalCancelBtnText}>{t('common.actions.cancel')}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* מודל הוספת/עריכת ילד */}
      <Modal visible={childModalOpen} transparent animationType="fade" onRequestClose={() => setChildModalOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setChildModalOpen(false)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>{childDraft.id ? t('profile.childForm.editTitle') : t('profile.childForm.addTitle')}</Text>

            <Text style={styles.fieldLabel}>{t('profile.childForm.nameLabel')}</Text>
            <TextInput
              style={styles.textInput}
              value={childDraft.name}
              onChangeText={(v) => setChildDraft((p) => ({ ...p, name: v }))}
              placeholder={t('profile.childForm.namePlaceholder')}
              placeholderTextColor={colors.textMuted}
            />

            <Text style={styles.fieldLabel}>{t('profile.childForm.birthdateLabel')}</Text>
            <View style={styles.dateRow}>
              <TextInput
                style={styles.dateInput}
                value={childDraft.day}
                onChangeText={(v) => setChildDraft((p) => ({ ...p, day: v.replace(/[^0-9]/g, '').slice(0, 2) }))}
                placeholder={t('profile.childForm.day')}
                placeholderTextColor={colors.textMuted}
                keyboardType="number-pad"
                maxLength={2}
              />
              <TextInput
                style={styles.dateInput}
                value={childDraft.month}
                onChangeText={(v) => setChildDraft((p) => ({ ...p, month: v.replace(/[^0-9]/g, '').slice(0, 2) }))}
                placeholder={t('profile.childForm.month')}
                placeholderTextColor={colors.textMuted}
                keyboardType="number-pad"
                maxLength={2}
              />
              <TextInput
                style={[styles.dateInput, styles.dateInputYear]}
                value={childDraft.year}
                onChangeText={(v) => setChildDraft((p) => ({ ...p, year: v.replace(/[^0-9]/g, '').slice(0, 4) }))}
                placeholder={t('profile.childForm.year')}
                placeholderTextColor={colors.textMuted}
                keyboardType="number-pad"
                maxLength={4}
              />
            </View>

            <Text style={styles.fieldLabel}>{t('profile.childForm.genderLabel')}</Text>
            <View style={styles.genderRow}>
              <Pressable
                style={[styles.genderChip, childDraft.gender === 'male' && styles.genderChipSelected]}
                onPress={() => setChildDraft((p) => ({ ...p, gender: p.gender === 'male' ? null : 'male' }))}
              >
                <Text style={[styles.genderChipText, childDraft.gender === 'male' && styles.genderChipTextSelected]}>{t('profile.childForm.male')}</Text>
              </Pressable>
              <Pressable
                style={[styles.genderChip, childDraft.gender === 'female' && styles.genderChipSelected]}
                onPress={() => setChildDraft((p) => ({ ...p, gender: p.gender === 'female' ? null : 'female' }))}
              >
                <Text style={[styles.genderChipText, childDraft.gender === 'female' && styles.genderChipTextSelected]}>{t('profile.childForm.female')}</Text>
              </Pressable>
            </View>

            <Text style={styles.childPrivacyNote}>
              {t('profile.childForm.privacyNote')}{' '}
              <Text style={styles.childPrivacyLink} onPress={() => router.push('/privacy')}>{t('profile.childForm.privacyLink')}</Text>
            </Text>

            <View style={styles.modalActionsRow}>
              <Pressable
                style={[styles.modalSaveBtn, !isChildDraftValid() && styles.modalSaveBtnDisabled]}
                onPress={saveChildDraft}
                disabled={!isChildDraftValid()}
              >
                <Text style={styles.modalSaveBtnText}>{t('common.actions.save')}</Text>
              </Pressable>
              <Pressable style={styles.modalCancelBtn} onPress={() => setChildModalOpen(false)}>
                <Text style={styles.modalCancelBtnText}>{t('common.actions.cancel')}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={noteModalOpen} transparent animationType="fade" onRequestClose={() => setNoteModalOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setNoteModalOpen(false)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>{t('profile.notes.modalTitle')}</Text>
            <Text style={styles.fieldLabel}>{noteModalTarget?.activity?.name}</Text>
            <TextInput
              style={[styles.textInput, styles.noteModalTextarea]}
              value={noteModalDraft}
              onChangeText={setNoteModalDraft}
              multiline
              placeholder={t('profile.notes.placeholder')}
              placeholderTextColor={colors.textMuted}
            />
            <View style={styles.modalActionsRow}>
              <Pressable
                style={[styles.modalSaveBtn, (!noteModalDraft.trim() || savingNoteModal) && styles.modalSaveBtnDisabled]}
                onPress={saveNoteModal}
                disabled={!noteModalDraft.trim() || savingNoteModal}
              >
                <Text style={styles.modalSaveBtnText}>{savingNoteModal ? t('common.actions.saving') : t('profile.notes.save')}</Text>
              </Pressable>
              <Pressable style={styles.modalCancelBtn} onPress={() => setNoteModalOpen(false)}>
                <Text style={styles.modalCancelBtnText}>{t('common.actions.cancel')}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={hiddenModalOpen} transparent animationType="fade" onRequestClose={() => setHiddenModalOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setHiddenModalOpen(false)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>{t('profile.hidden.title')}</Text>
            <Text style={styles.sectionHint}>{t('profile.hidden.hint')}</Text>
            {hiddenLoading ? (
              <ActivityIndicator color={colors.accent} style={{ marginVertical: 16 }} />
            ) : hiddenActivities.length === 0 ? (
              <Text style={[styles.emptyShelfText, { marginTop: 12, textAlign: dir.textAlign }]}>{t('profile.hidden.empty')}</Text>
            ) : (
              <ScrollView style={styles.hiddenListScroll}>
                {hiddenActivities.map((row) => {
                  const cityLabel = placeName(row.activity.location?.city) || row.activity.location?.name || '';
                  return (
                    <View key={row.activity_id} style={styles.hiddenRow}>
                      <View style={styles.hiddenRowInfo}>
                        <Text style={styles.hiddenRowName} numberOfLines={1}>{row.activity.name}</Text>
                        {!!cityLabel && <Text style={styles.hiddenRowCity}>📍 {cityLabel}</Text>}
                      </View>
                      <Pressable onPress={() => handleUnhide(row.activity_id)} disabled={unhidingId === row.activity_id}>
                        <Text style={styles.noteActionText}>{unhidingId === row.activity_id ? '...' : t('profile.hidden.unhide')}</Text>
                      </Pressable>
                    </View>
                  );
                })}
              </ScrollView>
            )}
            <Pressable style={[styles.modalCancelBtn, { marginTop: 14 }]} onPress={() => setHiddenModalOpen(false)}>
              <Text style={styles.modalCancelBtnText}>{t('common.actions.close')}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <QuickPicker
        visible={excludedPickerOpen}
        title={t('profile.pickers.excludedCategoriesTitle')}
        subtitle={t('profile.pickers.excludedCategoriesSubtitle')}
        options={CATEGORY_OPTIONS}
        value={excludedDraft}
        multiple
        onChange={setExcludedDraft}
        onClose={closeExcludedPicker}
        onReset={() => setExcludedDraft([])}
      />

      <ExcludeAreasPicker
        visible={excludedCitiesPickerOpen}
        value={excludedAreasDraft}
        onChange={setExcludedAreasDraft}
        onClose={closeExcludedCitiesPicker}
        onReset={() => setExcludedAreasDraft({ regions: [], cities: [] })}
      />

      <QuickPicker
        visible={benefitClubsPickerOpen}
        title={t('profile.pickers.benefitClubsTitle')}
        subtitle={t('profile.pickers.benefitClubsSubtitle')}
        options={BENEFIT_PROVIDER_OPTIONS}
        value={benefitClubsDraft}
        multiple
        onChange={setBenefitClubsDraft}
        onClose={closeBenefitClubsPicker}
        footer={benefitClubsDraft.includes(OTHER_BENEFIT) && (
          <View style={{ marginTop: 14 }}>
            <Text style={styles.fieldLabel}>{t('profile.pickers.benefitOtherLabel')}</Text>
            <TextInput
              style={styles.textInput}
              value={benefitClubsOtherDraft}
              onChangeText={setBenefitClubsOtherDraft}
              placeholder={t('profile.pickers.benefitOtherPlaceholder')}
              placeholderTextColor={colors.textMuted}
            />
          </View>
        )}
      />

      {homeDefaultsDraft && (
        <>
          <LocationQuickPicker
            visible={prefLocationOpen}
            value={homeDefaultsDraft.location}
            onChange={(v) => setPref('location', v)}
            onCoordsResolved={() => {}}
            onClose={() => setPrefLocationOpen(false)}
          />
          <QuickPicker
            visible={prefCategoryOpen}
            title={t('profile.pickers.categoryTitle')}
            subtitle={t('profile.pickers.categorySubtitle')}
            options={CATEGORY_OPTIONS}
            value={homeDefaultsDraft.category}
            multiple
            showAll
            onChange={(v) => setPref('category', v)}
            onClose={() => setPrefCategoryOpen(false)}
          />
          <QuickPicker
            visible={prefWhenOpen}
            title={t('profile.pickers.whenTitle')}
            options={WHEN_QUICK_OPTIONS}
            value={homeDefaultsDraft.when?.options || []}
            multiple={false}
            showAll
            allLabel={t('profile.searchPrefs.anyTime')}
            onChange={(v) => setPref('when', { options: v, date: null })}
            onClose={() => setPrefWhenOpen(false)}
          />
          <QuickPicker
            visible={prefPriceOpen}
            title={t('profile.pickers.priceTitle')}
            options={PRICE_OPTIONS}
            value={homeDefaultsDraft.price}
            multiple={false}
            showAll
            allLabel={t('profile.searchPrefs.allPrices')}
            onChange={(v) => setPref('price', v)}
            onClose={() => setPrefPriceOpen(false)}
          />
          <QuickPicker
            visible={prefPlaceTypeOpen}
            title={t('profile.pickers.placeTypeTitle')}
            options={PLACE_TYPE_OPTIONS}
            value={homeDefaultsDraft.placeType}
            multiple={false}
            showAll
            allLabel={t('profile.searchPrefs.noPreference')}
            onChange={(v) => setPref('placeType', v)}
            onClose={() => setPrefPlaceTypeOpen(false)}
          />
          <QuickPicker
            visible={prefBookingOpen}
            title={t('profile.pickers.bookingTitle')}
            options={BOOKING_OPTIONS}
            value={homeDefaultsDraft.booking}
            multiple={false}
            showAll
            allLabel={t('profile.searchPrefs.noPreference')}
            onChange={(v) => setPref('booking', v)}
            onClose={() => setPrefBookingOpen(false)}
          />
          <QuickPicker
            visible={prefDurationOpen}
            title={t('profile.pickers.durationTitle')}
            options={DURATION_OPTIONS}
            value={homeDefaultsDraft.duration}
            multiple
            showAll
            allLabel={t('profile.searchPrefs.noPreference')}
            onChange={(v) => setPref('duration', v)}
            onClose={() => setPrefDurationOpen(false)}
          />
          <QuickPicker
            visible={prefAmenitiesOpen}
            title={t('profile.pickers.amenitiesTitle')}
            options={AMENITY_COMFORT_OPTIONS}
            value={homeDefaultsDraft.amenities}
            multiple
            showAll
            allLabel={t('profile.searchPrefs.noPreference')}
            onChange={(v) => setPref('amenities', v)}
            onClose={() => setPrefAmenitiesOpen(false)}
          />
        </>
      )}
    </View>
  );
}

const styles = createStyles((d) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, paddingBottom: 50 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 60 },

  welcome: { fontFamily: fonts.bold, fontSize: 16, color: colors.textSecondary, marginBottom: 16 },
  loginBtn: { backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 12, paddingHorizontal: 24 },
  loginBtnText: { fontFamily: fonts.bold, fontSize: 14, color: '#fff' },

  noticeBox: { backgroundColor: colors.accentTintLight, borderRadius: radii.md, padding: 10, marginTop: 14 },
  noticeText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.accent, textAlign: 'center' },

  pageTitleBlock: { alignItems: 'center', marginTop: 20, marginBottom: 18 },
  pageEmoji: { fontSize: 30, marginBottom: 4 },
  pageTitle: { fontFamily: fonts.extraBold, fontSize: 21, color: colors.textPrimary },
  pageSubtitle: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: 'center', marginTop: 4 },

  profileBlock: { flexDirection: d.row, alignItems: 'center', gap: 14, marginBottom: 24 },
  avatar: { width: 50, height: 50, borderRadius: 25, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: fonts.logo, fontSize: 20, color: '#fff' },
  profileInfo: { flex: 1, minWidth: 0 },
  profileNameRow: { flexDirection: d.row, alignItems: 'center', gap: 8 },
  profileName: { fontFamily: fonts.extraBold, fontSize: 16, color: colors.textPrimary, textAlign: d.textAlign },
  profileStars: { fontFamily: fonts.bold, fontSize: 13, color: colors.yellow },
  profileEdit: { fontFamily: fonts.bold, fontSize: 11.5, color: colors.accent, textDecorationLine: 'underline', textAlign: d.textAlign, marginTop: 2 },
  nicknameEditRow: { flexDirection: d.row, alignItems: 'center', gap: 8 },
  nicknameInput: {
    flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, paddingHorizontal: 10,
    paddingVertical: 6, fontFamily: fonts.bold, fontSize: 15, color: colors.textPrimary, textAlign: d.textAlign, writingDirection: d.writingDirection,
  },
  nicknameSave: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.accent },
  nicknameCancel: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textMuted },
  addActivityBtn: {
    flexDirection: d.row, alignItems: 'center', gap: 6,
    backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 9, paddingHorizontal: 12,
  },
  addActivityText: { fontFamily: fonts.bold, fontSize: 11.5, color: '#fff' },

  onboardingCard: {
    backgroundColor: colors.accentTintLight, borderRadius: radii.xl, padding: spacing.lg, marginBottom: 26,
    borderWidth: 1, borderColor: colors.accentTint,
  },
  onboardingTitle: { fontFamily: fonts.extraBold, fontSize: 17, color: colors.textPrimary, textAlign: 'center', marginBottom: 4 },
  onboardingSub: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: 'center', marginBottom: 14, lineHeight: 18 },
  onboardingSteps: { marginBottom: 16 },
  onboardingStep: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textPrimary, textAlign: d.textAlign, marginBottom: 6 },
  onboardingGoBtn: { backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 13, alignItems: 'center', marginBottom: 10 },
  onboardingGoBtnText: { fontFamily: fonts.bold, fontSize: 14.5, color: '#fff' },
  onboardingSkip: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textMuted, textAlign: 'center' },

  shelf: { marginBottom: 26 },
  shelfHead: { marginBottom: 10 },
  shelfHeadRow: { flexDirection: d.row, alignItems: 'center', gap: 8 },
  // שורת accordion יחידה (למשל "⭐ העדפות חיפוש") - הכותרת+חץ תמיד גלויים, לחיצה מטגלת את שאר
  // התוכן שמתחת (בניגוד ל-shelfHead/shelfHeadRow הרגילים שהם רק כותרת סטטית, לא לחיצות).
  shelfHeadToggle: { flexDirection: d.row, alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4, marginBottom: 10 },
  shelfTitle: { fontFamily: fonts.extraBold, fontSize: 15.5, color: colors.textPrimary, textAlign: d.textAlign },
  sectionHint: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, textAlign: d.textAlign, lineHeight: 17, marginBottom: 12 },
  comingSoonBadge: { backgroundColor: colors.yellowTint, borderRadius: radii.pill, paddingVertical: 2, paddingHorizontal: 8 },
  comingSoonText: { fontFamily: fonts.bold, fontSize: 10, color: colors.yellow },

  emptyShelf: {
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed',
    borderRadius: radii.md, padding: 16, marginBottom: 12,
  },
  emptyShelfText: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textMuted, textAlign: 'center' },

  benefitsRow: { flexDirection: d.row, gap: 8, marginBottom: 14 },
  benefitCard: {
    flex: 1, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
    padding: 10, alignItems: 'center',
  },
  benefitEmoji: { fontSize: 18, marginBottom: 4 },
  benefitTitle: { fontFamily: fonts.bold, fontSize: 11, color: colors.textPrimary, textAlign: 'center', marginBottom: 2 },
  benefitText: { fontFamily: fonts.regular, fontSize: 10, color: colors.textSecondary, textAlign: 'center', lineHeight: 13 },

  childrenList: { gap: 8, marginBottom: 12 },
  childCard: {
    flexDirection: d.row, alignItems: 'center', gap: 10,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12,
  },
  childEmoji: { fontSize: 24 },
  childInfo: { flex: 1, minWidth: 0 },
  childName: { fontFamily: fonts.bold, fontSize: 14, color: colors.textPrimary, textAlign: d.textAlign },
  childAge: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, textAlign: d.textAlign, marginTop: 1 },
  childActionBtn: { padding: 4 },
  childDeleteText: { fontFamily: fonts.bold, fontSize: 14, color: colors.textMuted },
  addChildBtn: {
    borderWidth: 1.5, borderColor: colors.accent, borderStyle: 'dashed', borderRadius: radii.pill,
    paddingVertical: 11, alignItems: 'center',
  },
  addChildBtnText: { fontFamily: fonts.bold, fontSize: 13, color: colors.accent },
  childrenFooterHint: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, textAlign: d.textAlign, marginTop: 10, lineHeight: 16 },

  accountCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, overflow: 'hidden' },
  disabledCard: { opacity: 0.5 },
  settingRow: {
    flexDirection: d.row, alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 13, paddingHorizontal: 15, borderBottomWidth: 1, borderBottomColor: colors.borderLight,
  },
  settingRowLast: { borderBottomWidth: 0 },
  settingLabel: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary, flexShrink: 1 },
  settingValue: { fontFamily: fonts.bold, fontSize: 13, color: colors.textPrimary },
  toggle: { width: 38, height: 22, borderRadius: 11, justifyContent: 'center' },
  toggleOn: { backgroundColor: colors.accent, alignItems: d.alignEnd },
  toggleOff: { backgroundColor: colors.border, alignItems: d.alignStart },
  toggleDot: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#fff', marginHorizontal: 2 },
  toggleDotOff: {},
  badgeOk: { flexDirection: d.row, alignItems: 'center', gap: 4 },
  badgeOkText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.greenStrong },
  badgeSetup: { flexDirection: d.row, alignItems: 'center', gap: 3 },
  badgeSetupText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.accent, maxWidth: 140 },

  moreToggleRow: { flexDirection: d.row, alignItems: 'center', gap: 5, alignSelf: 'center', paddingVertical: 12 },
  moreToggleText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.textSecondary },
  subSectionTitle: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.textSecondary, textAlign: d.textAlign, marginBottom: 8, marginTop: 4 },
  resetAllPrefsBtn: { alignItems: 'center', paddingVertical: 10, marginBottom: 4 },
  resetAllPrefsBtnText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.danger },

  knowCard: {
    backgroundColor: colors.card, borderWidth: 1.5, borderColor: colors.accentTint, borderRadius: radii.xl,
    padding: spacing.lg, marginBottom: 26,
  },
  knowTitle: { fontFamily: fonts.extraBold, fontSize: 14.5, color: colors.textPrimary, textAlign: d.textAlign, marginBottom: 10 },
  knowBit: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary, textAlign: d.textAlign, marginBottom: 4 },

  tabsRow: { flexDirection: d.row, gap: 8, marginBottom: 12 },
  tabBtn: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: radii.pill, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.card },
  tabBtnActive: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  tabBtnText: { fontFamily: fonts.bold, fontSize: 12, color: colors.textSecondary },
  tabBtnTextActive: { color: colors.accent },
  tabItemRow: {
    flexDirection: d.row, alignItems: 'center', gap: 8,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12, marginBottom: 8,
  },
  tabItemMain: { flex: 1, minWidth: 0 },
  tabItemNoteBtn: { borderWidth: 1, borderColor: colors.accent, borderRadius: radii.pill, paddingVertical: 6, paddingHorizontal: 10 },
  tabItemNoteBtnText: { fontFamily: fonts.bold, fontSize: 11, color: colors.accent },
  tabItemTitle: { fontFamily: fonts.bold, fontSize: 13, color: colors.textPrimary, textAlign: d.textAlign },

  noteCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12, marginBottom: 10 },
  noteCardTop: { flexDirection: d.row, alignItems: 'center', gap: 10, marginBottom: 8 },
  noteThumb: { width: 52, height: 52, borderRadius: radii.md, backgroundColor: colors.borderLight },
  noteThumbPlaceholder: { width: 52, height: 52, borderRadius: radii.md, backgroundColor: colors.accentTintLight, alignItems: 'center', justifyContent: 'center' },
  noteThumbPlaceholderText: { fontSize: 20 },
  noteCardInfo: { flex: 1, minWidth: 0 },
  noteActivityName: { fontFamily: fonts.bold, fontSize: 14, color: colors.textPrimary, textAlign: d.textAlign },
  noteActivityLocation: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textSecondary, textAlign: d.textAlign, marginTop: 2 },
  noteCardText: { fontFamily: fonts.regular, fontSize: 13, color: colors.textPrimary, textAlign: d.textAlign, lineHeight: 18, marginBottom: 8 },
  noteCardMeta: { fontFamily: fonts.regular, fontSize: 10.5, color: colors.textMuted },
  noteActionText: { fontFamily: fonts.bold, fontSize: 12, color: colors.accent },
  noteModalTextarea: { minHeight: 90, textAlignVertical: 'top' },
  tabItemSub: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textSecondary, textAlign: d.textAlign, marginTop: 2 },
  allDestinationsBtn: { alignSelf: 'center', paddingVertical: 10 },
  allDestinationsBtnText: { fontFamily: fonts.bold, fontSize: 13, color: colors.accent },

  hiddenListScroll: { maxHeight: 320, marginTop: 12 },
  hiddenRow: {
    flexDirection: d.row, alignItems: 'center', justifyContent: 'space-between', gap: 10,
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.borderLight,
  },
  hiddenRowInfo: { flex: 1 },
  hiddenRowName: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.textPrimary, textAlign: d.textAlign },
  hiddenRowCity: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textSecondary, textAlign: d.textAlign, marginTop: 2 },

  saveDefaultsBtn: { backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 13, alignItems: 'center', marginTop: 10 },
  saveDefaultsBtnText: { fontFamily: fonts.bold, fontSize: 13.5, color: '#fff' },

  logoutLink: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.danger, textAlign: 'center', marginTop: 10 },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(20,30,35,0.4)', justifyContent: 'center', padding: spacing.xl },
  modalCard: { backgroundColor: colors.card, borderRadius: radii.xl, padding: spacing.xl },
  modalTitle: { fontFamily: fonts.extraBold, fontSize: 17, color: colors.textPrimary, textAlign: 'center', marginBottom: 16 },
  fieldLabel: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.textSecondary, textAlign: d.textAlign, marginBottom: 6 },
  textInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12, marginBottom: 14,
    fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, backgroundColor: colors.bg,
    textAlign: d.textAlign, writingDirection: d.writingDirection,
  },
  dateRow: { flexDirection: d.row, gap: 8, marginBottom: 14 },
  dateInput: {
    flex: 1, minWidth: 0, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12,
    fontFamily: fonts.bold, fontSize: 15, color: colors.textPrimary, backgroundColor: colors.bg, textAlign: 'center',
  },
  dateInputYear: { flex: 1.4, minWidth: 0 },
  genderRow: { flexDirection: d.row, gap: 8, marginBottom: 18 },
  genderChip: {
    flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: radii.pill,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg,
  },
  genderChipSelected: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  genderChipText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary },
  genderChipTextSelected: { color: colors.accent, fontFamily: fonts.bold },
  modalActionsRow: { flexDirection: d.row, gap: 10 },
  modalCancelBtn: { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border },
  modalCancelBtnText: { fontFamily: fonts.bold, fontSize: 14, color: colors.textSecondary },
  modalSaveBtn: { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: radii.pill, backgroundColor: colors.accent },
  modalDangerBtn: { backgroundColor: colors.danger },
  dangerLabel: { fontFamily: fonts.semiBold, fontSize: 14, color: colors.danger },
  deleteExplainText: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 20, color: colors.textSecondary, textAlign: d.textAlign, marginBottom: 20 },
  childPrivacyNote: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, textAlign: d.textAlign, lineHeight: 17, marginBottom: 16 },
  childPrivacyLink: { fontFamily: fonts.semiBold, color: colors.textSecondary, textDecorationLine: 'underline' },
  modalSaveBtnDisabled: { opacity: 0.5 },
  modalSaveBtnText: { fontFamily: fonts.bold, fontSize: 14, color: '#fff' },

  loggedOutLanguageCard: { alignSelf: 'stretch', marginTop: 28 },
  langOptions: { flexDirection: d.row, alignItems: 'center', gap: 6 },
  langOption: { paddingVertical: 5, paddingHorizontal: 12, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  langOptionSelected: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  langOptionText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textSecondary },
  langOptionTextSelected: { color: colors.accent, fontFamily: fonts.bold },
}));
