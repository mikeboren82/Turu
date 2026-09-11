import { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, TextInput, ActivityIndicator, Modal, Image } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Path, Circle, Line } from 'react-native-svg';
import Header from '../components/Header';
import QuickPicker from '../components/QuickPicker';
import LocationQuickPicker, { locationSummary } from '../components/LocationQuickPicker';
import { StarIcon, ChatIcon, CheckIcon, ChevronLeftIcon, ChevronDownIcon, CalendarIcon } from '../components/icons';
import { colors, fonts, radii, spacing } from '../constants/theme';
import {
  CATEGORY_OPTIONS, CITY_OPTIONS, PRICE_OPTIONS, PLACE_TYPE_OPTIONS, WHEN_OPTIONS, FILTER_SCHEMA,
  BOOKING_OPTIONS, DURATION_OPTIONS, AMENITY_COMFORT_OPTIONS, BENEFIT_PROVIDER_OPTIONS,
} from '../constants/filterSchema';
import { categorySummary, hebrewJoin } from '../lib/filterSummaries';
import { supabase } from '../lib/supabase';
import { clearPin } from '../lib/pin';
import { normalizeFilters } from '../lib/filterActivities';
import {
  fetchUserPreferences, saveExcludedCategories, saveExcludedCities, saveChildren,
  saveVisibleHomeFilters, saveDefaultHomeFilters, saveBenefitClubs,
} from '../lib/preferences';
import { formatChildAge } from '../lib/children';
import { fetchAllPersonalNotes, savePersonalNote, fetchHiddenActivities, toggleHidden } from '../lib/interactions';
import { placeholderImageFor, placeholderBgColorFor } from '../lib/placeholderImages';
import { relativeDate } from '../lib/formatDate';
import { requestAccountDeletion } from '../lib/legal';

// אלו הפילטרים שכבר תמיד מופיעים במסך הראשי (קטגוריה/מיקום כפילטרים ראשיים, גיל כקישור
// עדין קבוע) - לא הגיוני לתת עליהם toggle נפרד. שאר הרשימה (מתי/מחיר/סוג מקום/הזמנה/משך/
// נגישות) היא מה שמשתמש יכול לבחור להוסיף כקישורים קטנים נוספים במסך הראשי שלו.
const TOGGLABLE_HOME_FILTERS = FILTER_SCHEMA.filter((f) => !['category', 'location', 'age'].includes(f.key));

const NOTIFICATION_ITEMS = [
  { key: 'new_nearby', label: 'פעילויות חדשות באזור שלי' },
  { key: 'matches_children', label: 'פעילויות שמתאימות לילדים שלי' },
  { key: 'weekend_ideas', label: 'רעיונות לסוף השבוע' },
  { key: 'favorite_categories', label: 'פעילויות חדשות בקטגוריות שאני אוהב/ת' },
  { key: 'saved_reminders', label: 'תזכורות לפעילויות ששמרתי' },
];

const WHEN_QUICK_OPTIONS = [
  { id: 'today', label: 'היום' },
  { id: 'tomorrow', label: 'מחר' },
  { id: 'weekend', label: 'סוף השבוע' },
];

const TABS = [
  { key: 'favorites', label: '❤️ שמורות', table: 'favorites' },
  { key: 'planned', label: '📅 רוצה לעשות', table: 'planned_activities' },
  { key: 'visited', label: '✅ היינו שם', table: 'visited_activities' },
];

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
  if (key === 'duration') return filters.duration?.length ? hebrewJoin(filters.duration.map((id) => DURATION_OPTIONS.find((o) => o.id === id)?.label).filter(Boolean)) : null;
  if (key === 'amenities') return filters.amenities?.length ? hebrewJoin(filters.amenities.map((id) => AMENITY_COMFORT_OPTIONS.find((o) => o.id === id)?.label).filter(Boolean)) : null;
  return null;
}

const emptyChildDraft = { id: null, name: '', gender: null, day: '', month: '', year: '' };

export default function ProfileScreen() {
  const router = useRouter();
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
  const [excludedCitiesDraft, setExcludedCitiesDraft] = useState([]);
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
      setBenefitClubs(prefs.benefitClubs);
      setBenefitClubsOther(prefs.benefitClubsOther);
      setChildren(prefs.children);
      setVisibleHomeFilters(prefs.visibleHomeFilters);
      setHomeDefaultsDraft(normalizeFilters(prefs.defaultHomeFilters || {}));
      setNotificationPrefs(prefs.notificationPrefs || {});
    } catch (err) {
      setHomeDefaultsDraft(normalizeFilters({}));
      showNotice(`חלק מההעדפות לא נטענו: ${err.message}`);
    }

    setNotesLoading(true);
    try {
      setNotes(await fetchAllPersonalNotes(userId));
    } catch (err) {
      showNotice(`ההערות האישיות לא נטענו: ${err.message}`);
    } finally {
      setNotesLoading(false);
    }

    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const loadTab = useCallback(async (tabKey) => {
    if (!session?.user?.id) return;
    const tab = TABS.find((t) => t.key === tabKey);
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
      showNotice('ההערה נשמרה');
    } catch (err) {
      showNotice(`שגיאה בשמירת ההערה: ${err.message}`);
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
      showNotice(`שגיאה בשמירת הכינוי: ${error.message}`);
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
      showNotice(`שגיאה בשמירת פרטי הילדים: ${err.message}`);
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
      showNotice('✓ ההעדפות נשמרו - יופיעו כברירת מחדל במסך הבית');
    } catch (err) {
      showNotice(`שגיאה בשמירה: ${err.message}`);
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
      showNotice(`שגיאה בשמירת ההעדפות: ${err.message}`);
    } finally {
      setSavingExcluded(false);
    }
  };

  // 📍 "אזורים שלא להציג" - מקביל מדויק ל-openExcludedPicker/closeExcludedPicker למעלה.
  const openExcludedCitiesPicker = () => {
    setExcludedCitiesDraft(excludedCities);
    setExcludedCitiesPickerOpen(true);
  };

  const closeExcludedCitiesPicker = async () => {
    setExcludedCitiesPickerOpen(false);
    if (JSON.stringify(excludedCitiesDraft) === JSON.stringify(excludedCities)) return;
    setSavingExcludedCities(true);
    try {
      await saveExcludedCities(session.user.id, excludedCitiesDraft);
      setExcludedCities(excludedCitiesDraft);
    } catch (err) {
      showNotice(`שגיאה בשמירת ההעדפות: ${err.message}`);
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
      ]);
      setExcludedCategories([]);
      setExcludedCities([]);
    } catch (err) {
      showNotice(`שגיאה באיפוס ההעדפות: ${err.message}`);
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
    const otherToSave = benefitClubsDraft.includes('אחר') ? benefitClubsOtherDraft.trim() : '';
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
      showNotice(`שגיאה בשמירת ההטבות: ${err.message}`);
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
      showNotice(`שגיאה בטעינת הפעילויות החסומות: ${err.message}`);
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
      showNotice(`שגיאה בביטול החסימה: ${err.message}`);
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
      showNotice(`שגיאה בשמירה: ${err.message}`);
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
      showNotice(`שגיאה בשליחת הבקשה: ${err.message}`);
    } finally {
      setDeleteRequestSubmitting(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.screen}>
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
        <View style={styles.content}>
          <Header onMenuPress={() => {}} />
          <View style={styles.center}>
            <Text style={styles.welcome}>עדיין לא מחוברים</Text>
            <Pressable style={styles.loginBtn} onPress={() => router.push('/login')}>
              <Text style={styles.loginBtnText}>התחברות</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  const isNewUser = children.length === 0 && !homeDefaultsDraft?.category?.length && !homeDefaultsDraft?.location?.mode;
  const showOnboarding = isNewUser && !onboardingDismissed;

  const summaryBits = [];
  if (children.length > 0) summaryBits.push(`👦 ${children.length} ${children.length === 1 ? 'ילד/ה' : 'ילדים'}`);
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
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Header onMenuPress={() => {}} />

        {notice ? <View style={styles.noticeBox}><Text style={styles.noticeText}>{notice}</Text></View> : null}

        <View style={styles.pageTitleBlock}>
          <Text style={styles.pageEmoji}>👨‍👩‍👧</Text>
          <Text style={styles.pageTitle}>המשפחה שלי</Text>
          <Text style={styles.pageSubtitle}>כמה פרטים עליכם, ותורו יתאים את הפעילויות אליכם</Text>
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
                  <Text style={styles.nicknameSave}>{savingNickname ? '...' : 'שמירה'}</Text>
                </Pressable>
                <Pressable onPress={() => setEditingNickname(false)}>
                  <Text style={styles.nicknameCancel}>ביטול</Text>
                </Pressable>
              </View>
            ) : (
              <>
                <View style={styles.profileNameRow}>
                  <Text style={styles.profileName}>{nickname || 'ללא כינוי'}</Text>
                  <Text style={styles.profileStars}>⭐{stars}</Text>
                </View>
                <Pressable onPress={startEditNickname}>
                  <Text style={styles.profileEdit}>עריכת כינוי</Text>
                </Pressable>
              </>
            )}
          </View>
          <Pressable style={styles.addActivityBtn} onPress={() => router.push('/add-activity')}>
            <PlusIcon />
            <Text style={styles.addActivityText}>הוסף פעילות</Text>
          </Pressable>
        </View>

        {/* 👋 בואו נכיר - הכרטיס הראשון בעמוד (לפני "העדפות חיפוש"), לפי בקשת המשתמש. */}
        {showOnboarding && (
          <View style={styles.onboardingCard}>
            <Text style={styles.onboardingTitle}>👋 בואו נכיר</Text>
            <Text style={styles.onboardingSub}>כמה פרטים קטנים יעזרו לנו למצוא לכם פעילויות הרבה יותר טובות.</Text>
            <View style={styles.onboardingSteps}>
              <Text style={styles.onboardingStep}>1. 👶 בני כמה הילדים?</Text>
              <Text style={styles.onboardingStep}>2. 📍 איפה אתם מחפשים?</Text>
              <Text style={styles.onboardingStep}>3. 🎯 מה אתם אוהבים לעשות?</Text>
            </View>
            <Pressable style={styles.onboardingGoBtn} onPress={openAddChild}>
              <Text style={styles.onboardingGoBtnText}>יאללה, מתחילים 🚀</Text>
            </Pressable>
            <Pressable onPress={() => setOnboardingDismissed(true)}>
              <Text style={styles.onboardingSkip}>לא עכשיו</Text>
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
            <Text style={styles.shelfTitle}>⭐ העדפות חיפוש</Text>
            <View style={{ transform: [{ rotate: searchPrefsOpen ? '180deg' : '0deg' }] }}>
              <ChevronDownIcon size={14} />
            </View>
          </Pressable>
          {searchPrefsOpen && (
            <>
              <Text style={styles.sectionHint}>נשתמש בזה כדי להציג לכם קודם פעילויות שמתאימות בדיוק לכם - עדיין תוכלו לשנות כל פילטר בכל חיפוש.</Text>

              <View style={styles.accountCard}>
                <Pressable style={styles.settingRow} onPress={() => setPrefLocationOpen(true)}>
                  <Text style={styles.settingLabel}>📍 מיקום ברירת מחדל</Text>
                  <View style={styles.badgeSetup}>
                    <Text style={styles.badgeSetupText}>{summaryForPreference('location', homeDefaultsDraft) || 'בחירה'}</Text>
                    <ChevronLeftIcon size={12} />
                  </View>
                </Pressable>
                <Pressable style={styles.settingRow} onPress={() => setPrefCategoryOpen(true)}>
                  <Text style={styles.settingLabel}>🎯 סוגי פעילויות מועדפים</Text>
                  <View style={styles.badgeSetup}>
                    <Text style={styles.badgeSetupText}>{summaryForPreference('category', homeDefaultsDraft) || 'בחירה'}</Text>
                    <ChevronLeftIcon size={12} />
                  </View>
                </Pressable>
                <Pressable style={styles.settingRow} onPress={() => setPrefWhenOpen(true)}>
                  <Text style={styles.settingLabel}>📅 מתי בדרך כלל מחפשים?</Text>
                  <View style={styles.badgeSetup}>
                    <Text style={styles.badgeSetupText}>{summaryForPreference('when', homeDefaultsDraft) || 'כל הזמן'}</Text>
                    <ChevronLeftIcon size={12} />
                  </View>
                </Pressable>
                <Pressable style={styles.settingRow} onPress={() => setPrefPriceOpen(true)}>
                  <Text style={styles.settingLabel}>💰 העדפת מחיר</Text>
                  <View style={styles.badgeSetup}>
                    <Text style={styles.badgeSetupText}>{summaryForPreference('price', homeDefaultsDraft) || 'כל המחירים'}</Text>
                    <ChevronLeftIcon size={12} />
                  </View>
                </Pressable>
                <Pressable style={styles.settingRow} onPress={() => setPrefPlaceTypeOpen(true)}>
                  <Text style={styles.settingLabel}>🏠 סוג מקום מועדף</Text>
                  <View style={styles.badgeSetup}>
                    <Text style={styles.badgeSetupText}>{summaryForPreference('placeType', homeDefaultsDraft) || 'לא משנה'}</Text>
                    <ChevronLeftIcon size={12} />
                  </View>
                </Pressable>
                <Pressable style={styles.settingRow} onPress={() => setPrefBookingOpen(true)}>
                  <Text style={styles.settingLabel}>🎟️ הזמנה</Text>
                  <View style={styles.badgeSetup}>
                    <Text style={styles.badgeSetupText}>{summaryForPreference('booking', homeDefaultsDraft) || 'לא משנה'}</Text>
                    <ChevronLeftIcon size={12} />
                  </View>
                </Pressable>
                <Pressable style={styles.settingRow} onPress={() => setPrefDurationOpen(true)}>
                  <Text style={styles.settingLabel}>⏱️ משך פעילות</Text>
                  <View style={styles.badgeSetup}>
                    <Text style={styles.badgeSetupText} numberOfLines={1}>{summaryForPreference('duration', homeDefaultsDraft) || 'לא משנה'}</Text>
                    <ChevronLeftIcon size={12} />
                  </View>
                </Pressable>
                <Pressable style={styles.settingRow} onPress={() => setPrefAmenitiesOpen(true)}>
                  <Text style={styles.settingLabel}>♿ נגישות ונוחות</Text>
                  <View style={styles.badgeSetup}>
                    <Text style={styles.badgeSetupText} numberOfLines={1}>{summaryForPreference('amenities', homeDefaultsDraft) || 'לא משנה'}</Text>
                    <ChevronLeftIcon size={12} />
                  </View>
                </Pressable>
                <Pressable style={styles.settingRow} onPress={openExcludedPicker} disabled={savingExcluded}>
                  <Text style={styles.settingLabel}>🚫 קטגוריות שלעולם לא יוצגו לי</Text>
                  <View style={styles.badgeSetup}>
                    <Text style={styles.badgeSetupText} numberOfLines={1}>
                      {savingExcluded ? 'שומר...' : excludedCategories.length > 0 ? excludedCategories.join(' · ') : 'בחירה'}
                    </Text>
                    <ChevronLeftIcon size={12} />
                  </View>
                </Pressable>
                <Pressable style={[styles.settingRow, styles.settingRowLast]} onPress={openExcludedCitiesPicker} disabled={savingExcludedCities}>
                  <Text style={styles.settingLabel}>📍 אזורים שלא להציג</Text>
                  <View style={styles.badgeSetup}>
                    <Text style={styles.badgeSetupText} numberOfLines={1}>
                      {savingExcludedCities ? 'שומר...' : excludedCities.length > 0 ? excludedCities.join(' · ') : 'בחירה'}
                    </Text>
                    <ChevronLeftIcon size={12} />
                  </View>
                </Pressable>
              </View>

              {(excludedCategories.length > 0 || excludedCities.length > 0) && (
                <Pressable style={styles.resetAllPrefsBtn} onPress={resetAllSearchPreferences}>
                  <Text style={styles.resetAllPrefsBtnText}>איפוס כל העדפות החיפוש</Text>
                </Pressable>
              )}

              <Pressable style={styles.saveDefaultsBtn} onPress={handleSaveHomeDefaults} disabled={savingHomeDefaults}>
                <Text style={styles.saveDefaultsBtnText}>{savingHomeDefaults ? 'שומר...' : '💾 שמירת ההעדפות'}</Text>
              </Pressable>
            </>
          )}
        </View>

        {/* 👶 הילדים שלי */}
        <View style={styles.shelf}>
          <View style={styles.shelfHead}><Text style={styles.shelfTitle}>👶 הילדים שלי</Text></View>

          {children.length === 0 ? (
            <>
              <View style={styles.emptyShelf}>
                <Text style={styles.emptyShelfText}>עדיין לא הוספתם ילדים</Text>
              </View>
              <View style={styles.benefitsRow}>
                <View style={styles.benefitCard}>
                  <Text style={styles.benefitEmoji}>🎯</Text>
                  <Text style={styles.benefitTitle}>התאמה טובה יותר</Text>
                  <Text style={styles.benefitText}>נציג פעילויות שמתאימות לגיל הילדים.</Text>
                </View>
                <View style={styles.benefitCard}>
                  <Text style={styles.benefitEmoji}>⚡</Text>
                  <Text style={styles.benefitTitle}>פחות חיפושים</Text>
                  <Text style={styles.benefitText}>לא תצטרכו לבחור גילאים מחדש בכל פעם.</Text>
                </View>
                <View style={styles.benefitCard}>
                  <Text style={styles.benefitEmoji}>❤️</Text>
                  <Text style={styles.benefitTitle}>המלצות אישיות</Text>
                  <Text style={styles.benefitText}>נציג לכם פעילויות רלוונטיות למשפחה שלכם.</Text>
                </View>
              </View>
            </>
          ) : (
            <View style={styles.childrenList}>
              {children.map((child) => (
                <View key={child.id} style={styles.childCard}>
                  <Text style={styles.childEmoji}>{child.gender === 'female' ? '👧' : child.gender === 'male' ? '👦' : '🧒'}</Text>
                  <View style={styles.childInfo}>
                    <Text style={styles.childName}>{child.name || 'ילד/ה'}</Text>
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
            <Text style={styles.addChildBtnText}>{savingChildren ? 'שומר...' : '+ הוסף ילד'}</Text>
          </Pressable>

          {children.length > 0 && (
            <Text style={styles.childrenFooterHint}>כשנכיר את גילאי הילדים, נוכל להתאים לכם פעילויות בצורה מדויקת יותר.</Text>
          )}
        </View>

        {/* מה תורו יודע */}
        {summaryBits.length > 0 && (
          <View style={styles.knowCard}>
            <Text style={styles.knowTitle}>מה תורו יודע על המשפחה שלי?</Text>
            {summaryBits.map((bit, i) => (
              <Text key={i} style={styles.knowBit}>{bit}</Text>
            ))}
          </View>
        )}

        {/* ❤️ הפעילויות שלי */}
        <View style={styles.shelf}>
          <View style={styles.shelfHead}><Text style={styles.shelfTitle}>❤️ הפעילויות שלי</Text></View>
          <View style={styles.tabsRow}>
            {TABS.map((t) => (
              <Pressable
                key={t.key}
                style={[styles.tabBtn, activeTab === t.key && styles.tabBtnActive]}
                onPress={() => setActiveTab(t.key)}
              >
                <Text style={[styles.tabBtnText, activeTab === t.key && styles.tabBtnTextActive]}>{t.label}</Text>
              </Pressable>
            ))}
          </View>
          {tabLoading ? (
            <ActivityIndicator color={colors.accent} style={{ marginTop: 12 }} />
          ) : tabItems.length === 0 ? (
            <View style={styles.emptyShelf}>
              <Text style={styles.emptyShelfText}>עדיין אין כלום כאן</Text>
            </View>
          ) : (
            tabItems.slice(0, 3).map((item) => {
              const hasNote = notes.some((n) => n.activity_id === item.activity_id);
              return (
                <View key={item.activity_id} style={styles.tabItemRow}>
                  <Pressable style={styles.tabItemMain} onPress={() => router.push(`/activity/${item.activity_id}`)}>
                    <Text style={styles.tabItemTitle} numberOfLines={1}>{item.activity.name}</Text>
                    <Text style={styles.tabItemSub} numberOfLines={1}>
                      {[item.activity.category, item.activity.location?.city || item.activity.location?.name].filter(Boolean).join(' · ')}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={styles.tabItemNoteBtn}
                    onPress={() => openNoteForActivity(item.activity_id, item.activity.name)}
                    hitSlop={6}
                  >
                    <Text style={styles.tabItemNoteBtnText}>{hasNote ? '📝 הערה' : '📝 הוסף הערה'}</Text>
                  </Pressable>
                </View>
              );
            })
          )}
          <Pressable style={styles.allDestinationsBtn} onPress={() => router.push('/my-things')}>
            <Text style={styles.allDestinationsBtnText}>📍 לכל היעדים שלי ←</Text>
          </Pressable>
        </View>

        {/* 📝 ההערות האישיות שלי - Preview קצר בלבד (רק ההערה האחרונה, notes כבר ממוין
            newest-first ע"י fetchAllPersonalNotes) - הרשימה המלאה עם מיון/חיפוש עברה ל-
            /my-things?tab=notes ("📝 הערות שלי", טאב ייעודי בעמוד "❤️ הדברים שלי" המאוחד). */}
        <View style={styles.shelf}>
          <View style={styles.shelfHead}>
            <Text style={styles.shelfTitle}>📝 ההערות האישיות שלי</Text>
            <Text style={styles.sectionHint}>המקום הפרטי שלכם לזכור דברים חשובים על הפעילויות</Text>
          </View>

          {notesLoading ? (
            <ActivityIndicator color={colors.accent} style={{ marginTop: 12 }} />
          ) : notes.length === 0 ? (
            <View style={styles.emptyShelf}>
              <Text style={styles.emptyShelfText}>עדיין אין לכם הערות אישיות.</Text>
              <Text style={[styles.emptyShelfText, { marginTop: 4 }]}>הוסיפו הערה מתוך עמוד פעילות כדי לזכור דברים חשובים לפעם הבאה.</Text>
            </View>
          ) : (() => {
            const note = notes[0];
            const thumb = note.activity.activity_images?.[0]?.url;
            const cityLabel = note.activity.location?.city || note.activity.location?.name || '';
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
                <Text style={styles.noteCardMeta}>נכתב {relativeDate(note.created_at)}</Text>
              </View>
            );
          })()}

          <Pressable style={styles.allDestinationsBtn} onPress={() => router.push('/my-things?tab=notes')}>
            <Text style={styles.allDestinationsBtnText}>📝 לכל ההערות שלי ←</Text>
          </Pressable>
        </View>

        {/* 🎟️ ההטבות שלי */}
        <View style={styles.shelf}>
          <View style={styles.shelfHead}>
            <Text style={styles.shelfTitle}>🎟️ ההטבות שלי</Text>
            <Text style={styles.sectionHint}>אילו מועדונים וכרטיסים יש לכם?</Text>
          </View>
          <Text style={[styles.emptyShelfText, { textAlign: 'right', marginBottom: 10 }]}>
            בחרו את ההטבות שברשותכם, ותורו תוכל להציג לכם פעילויות שבהן תוכלו לקבל הנחה.
          </Text>
          <View style={styles.accountCard}>
            <Pressable style={[styles.settingRow, styles.settingRowLast]} onPress={openBenefitClubsPicker} disabled={savingBenefitClubs}>
              <Text style={styles.settingLabel}>המועדונים והכרטיסים שלי</Text>
              <View style={styles.badgeSetup}>
                <Text style={styles.badgeSetupText}>
                  {savingBenefitClubs ? 'שומר...' : benefitClubs.length > 0 ? `${benefitClubs.length} נבחרו` : 'בחירה'}
                </Text>
                <ChevronLeftIcon size={12} />
              </View>
            </Pressable>
          </View>
          {benefitClubs.includes('אחר') && !!benefitClubsOther && (
            <Text style={[styles.sectionHint, { marginTop: 8 }]}>אחר: {benefitClubsOther}</Text>
          )}
          <Text style={[styles.sectionHint, { marginTop: 8 }]}>
            לא רוצים להגדיר? אין בעיה. תוכלו לראות את כל הפעילויות כרגיל.
          </Text>
        </View>

        {/* 🎚️ פילטרים נוספים במסך הראשי - שורה מתקפלת (הועברה מ"⚙️ הגדרות", אחרי "🎟️ ההטבות
            שלי"), אותו דפוס accordion בדיוק כמו "⭐ העדפות חיפוש" למעלה - כולל אייקון ליד הכותרת
            כמו כל שאר הסקשנים בעמוד הזה. */}
        <View style={styles.shelf}>
          <Pressable style={styles.shelfHeadToggle} onPress={() => setVisibleFiltersOpen((v) => !v)}>
            <Text style={styles.shelfTitle}>🎚️ פילטרים נוספים במסך הראשי</Text>
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
              <Text style={styles.shelfTitle}>🔔 ההתראות שלי</Text>
              <View style={styles.comingSoonBadge}><Text style={styles.comingSoonText}>בקרוב</Text></View>
            </View>
            <Text style={styles.sectionHint}>ההתראות עוד לא פעילות באפליקציה - נשמח להפעיל אותן בקרוב.</Text>
          </View>
          <View style={[styles.accountCard, styles.disabledCard]}>
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>עדכונים על מקומות חדשים במייל</Text>
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
                  <Text style={styles.settingLabel}>{item.label}</Text>
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
          <View style={styles.shelfHead}><Text style={styles.shelfTitle}>⚙️ הגדרות</Text></View>
          <View style={styles.accountCard}>
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>כינוי</Text>
              <Text style={styles.settingValue}>{nickname || '-'}</Text>
            </View>
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>טלפון</Text>
              <Text style={[styles.settingValue, { direction: 'ltr' }]}>{formatPhoneDisplay(session.user.phone)}</Text>
            </View>
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>אימייל</Text>
              <Text style={styles.settingValue}>{emailColumnsAvailable ? (email || 'לא הוגדר') : 'לא זמין עדיין'}</Text>
            </View>
            <Pressable style={styles.settingRow} onPress={() => !quickLoginEnabled && router.push('/biometric-prompt')}>
              <Text style={styles.settingLabel}>כניסה מהירה</Text>
              {quickLoginEnabled ? (
                <View style={styles.badgeOk}>
                  <CheckIcon size={13} color={colors.greenStrong} filled />
                  <Text style={styles.badgeOkText}>מופעלת</Text>
                </View>
              ) : (
                <View style={styles.badgeSetup}>
                  <Text style={styles.badgeSetupText}>הפעילו</Text>
                  <ChevronLeftIcon size={12} />
                </View>
              )}
            </Pressable>
            <Pressable style={[styles.settingRow, styles.settingRowLast]} onPress={openHiddenModal}>
              <Text style={styles.settingLabel}>🙈 פעילויות חסומות</Text>
              <View style={styles.badgeSetup}>
                <Text style={styles.badgeSetupText}>עריכה</Text>
                <ChevronLeftIcon size={12} />
              </View>
            </Pressable>
          </View>
        </View>

        {/* ⚖️ משפטי */}
        <View style={styles.shelf}>
          <View style={styles.accountCard}>
            <Pressable style={styles.settingRow} onPress={() => router.push('/terms')}>
              <Text style={styles.settingLabel}>⚖️ תנאי שימוש</Text>
              <ChevronLeftIcon size={12} />
            </Pressable>
            <Pressable style={styles.settingRow} onPress={() => router.push('/privacy')}>
              <Text style={styles.settingLabel}>🔒 מדיניות פרטיות</Text>
              <ChevronLeftIcon size={12} />
            </Pressable>
            <Pressable
              style={[styles.settingRow, styles.settingRowLast]}
              onPress={() => setDeleteConfirmOpen(true)}
              disabled={deleteRequestSent}
            >
              <Text style={styles.dangerLabel}>🗑️ מחיקת החשבון</Text>
              {deleteRequestSent ? (
                <Text style={styles.badgeSetupText}>הבקשה נשלחה</Text>
              ) : (
                <ChevronLeftIcon size={12} />
              )}
            </Pressable>
          </View>
        </View>

        <Pressable onPress={handleLogout}>
          <Text style={styles.logoutLink}>התנתקות</Text>
        </Pressable>
      </ScrollView>

      {/* אישור בקשת מחיקת חשבון - שולחת בקשה אמיתית לצוות (אין מנגנון מחיקה אוטומטי כרגע) */}
      <Modal visible={deleteConfirmOpen} transparent animationType="fade" onRequestClose={() => setDeleteConfirmOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setDeleteConfirmOpen(false)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>בקשת מחיקת חשבון</Text>
            <Text style={styles.deleteExplainText}>
              נשלח לצוות בקשה למחיקת החשבון והמידע האישי המשויך אליו. הטיפול בבקשה נעשה ידנית
              ואינו מיידי - נחזור אליכם בהקדם.
            </Text>
            <View style={styles.modalActionsRow}>
              <Pressable
                style={[styles.modalSaveBtn, styles.modalDangerBtn, deleteRequestSubmitting && styles.modalSaveBtnDisabled]}
                onPress={handleRequestDeletion}
                disabled={deleteRequestSubmitting}
              >
                {deleteRequestSubmitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.modalSaveBtnText}>שליחת בקשה</Text>}
              </Pressable>
              <Pressable style={styles.modalCancelBtn} onPress={() => setDeleteConfirmOpen(false)}>
                <Text style={styles.modalCancelBtnText}>ביטול</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* מודל הוספת/עריכת ילד */}
      <Modal visible={childModalOpen} transparent animationType="fade" onRequestClose={() => setChildModalOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setChildModalOpen(false)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>{childDraft.id ? 'עריכת ילד/ה' : 'הוספת ילד/ה'}</Text>

            <Text style={styles.fieldLabel}>שם (לא חובה)</Text>
            <TextInput
              style={styles.textInput}
              value={childDraft.name}
              onChangeText={(v) => setChildDraft((p) => ({ ...p, name: v }))}
              placeholder="איך קוראים לילד/ה?"
              placeholderTextColor={colors.textMuted}
            />

            <Text style={styles.fieldLabel}>תאריך לידה</Text>
            <View style={styles.dateRow}>
              <TextInput
                style={styles.dateInput}
                value={childDraft.day}
                onChangeText={(v) => setChildDraft((p) => ({ ...p, day: v.replace(/[^0-9]/g, '').slice(0, 2) }))}
                placeholder="יום"
                placeholderTextColor={colors.textMuted}
                keyboardType="number-pad"
                maxLength={2}
              />
              <TextInput
                style={styles.dateInput}
                value={childDraft.month}
                onChangeText={(v) => setChildDraft((p) => ({ ...p, month: v.replace(/[^0-9]/g, '').slice(0, 2) }))}
                placeholder="חודש"
                placeholderTextColor={colors.textMuted}
                keyboardType="number-pad"
                maxLength={2}
              />
              <TextInput
                style={[styles.dateInput, styles.dateInputYear]}
                value={childDraft.year}
                onChangeText={(v) => setChildDraft((p) => ({ ...p, year: v.replace(/[^0-9]/g, '').slice(0, 4) }))}
                placeholder="שנה"
                placeholderTextColor={colors.textMuted}
                keyboardType="number-pad"
                maxLength={4}
              />
            </View>

            <Text style={styles.fieldLabel}>מגדר (לא חובה)</Text>
            <View style={styles.genderRow}>
              <Pressable
                style={[styles.genderChip, childDraft.gender === 'male' && styles.genderChipSelected]}
                onPress={() => setChildDraft((p) => ({ ...p, gender: p.gender === 'male' ? null : 'male' }))}
              >
                <Text style={[styles.genderChipText, childDraft.gender === 'male' && styles.genderChipTextSelected]}>👦 בן</Text>
              </Pressable>
              <Pressable
                style={[styles.genderChip, childDraft.gender === 'female' && styles.genderChipSelected]}
                onPress={() => setChildDraft((p) => ({ ...p, gender: p.gender === 'female' ? null : 'female' }))}
              >
                <Text style={[styles.genderChipText, childDraft.gender === 'female' && styles.genderChipTextSelected]}>👧 בת</Text>
              </Pressable>
            </View>

            <Text style={styles.childPrivacyNote}>
              המידע שתוסיפו משמש להתאמת פעילויות לילדים שלכם.{' '}
              <Text style={styles.childPrivacyLink} onPress={() => router.push('/privacy')}>למידע נוסף: מדיניות הפרטיות</Text>
            </Text>

            <View style={styles.modalActionsRow}>
              <Pressable
                style={[styles.modalSaveBtn, !isChildDraftValid() && styles.modalSaveBtnDisabled]}
                onPress={saveChildDraft}
                disabled={!isChildDraftValid()}
              >
                <Text style={styles.modalSaveBtnText}>שמירה</Text>
              </Pressable>
              <Pressable style={styles.modalCancelBtn} onPress={() => setChildModalOpen(false)}>
                <Text style={styles.modalCancelBtnText}>ביטול</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={noteModalOpen} transparent animationType="fade" onRequestClose={() => setNoteModalOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setNoteModalOpen(false)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>עריכת הערה</Text>
            <Text style={styles.fieldLabel}>{noteModalTarget?.activity?.name}</Text>
            <TextInput
              style={[styles.textInput, styles.noteModalTextarea]}
              value={noteModalDraft}
              onChangeText={setNoteModalDraft}
              multiline
              placeholder="כתבו כאן הערה פרטית..."
              placeholderTextColor={colors.textMuted}
            />
            <View style={styles.modalActionsRow}>
              <Pressable
                style={[styles.modalSaveBtn, (!noteModalDraft.trim() || savingNoteModal) && styles.modalSaveBtnDisabled]}
                onPress={saveNoteModal}
                disabled={!noteModalDraft.trim() || savingNoteModal}
              >
                <Text style={styles.modalSaveBtnText}>{savingNoteModal ? 'שומר...' : 'שמירת הערה'}</Text>
              </Pressable>
              <Pressable style={styles.modalCancelBtn} onPress={() => setNoteModalOpen(false)}>
                <Text style={styles.modalCancelBtnText}>ביטול</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={hiddenModalOpen} transparent animationType="fade" onRequestClose={() => setHiddenModalOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setHiddenModalOpen(false)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>פעילויות חסומות</Text>
            <Text style={styles.sectionHint}>פעילויות שהחלטתם להסתיר לא יופיעו לכם בתוצאות החיפוש.</Text>
            {hiddenLoading ? (
              <ActivityIndicator color={colors.accent} style={{ marginVertical: 16 }} />
            ) : hiddenActivities.length === 0 ? (
              <Text style={[styles.emptyShelfText, { marginTop: 12, textAlign: 'right' }]}>אין לכם פעילויות חסומות כרגע.</Text>
            ) : (
              <ScrollView style={styles.hiddenListScroll}>
                {hiddenActivities.map((row) => {
                  const cityLabel = row.activity.location?.city || row.activity.location?.name || '';
                  return (
                    <View key={row.activity_id} style={styles.hiddenRow}>
                      <View style={styles.hiddenRowInfo}>
                        <Text style={styles.hiddenRowName} numberOfLines={1}>{row.activity.name}</Text>
                        {!!cityLabel && <Text style={styles.hiddenRowCity}>📍 {cityLabel}</Text>}
                      </View>
                      <Pressable onPress={() => handleUnhide(row.activity_id)} disabled={unhidingId === row.activity_id}>
                        <Text style={styles.noteActionText}>{unhidingId === row.activity_id ? '...' : '🔓 ביטול חסימה'}</Text>
                      </Pressable>
                    </View>
                  );
                })}
              </ScrollView>
            )}
            <Pressable style={[styles.modalCancelBtn, { marginTop: 14 }]} onPress={() => setHiddenModalOpen(false)}>
              <Text style={styles.modalCancelBtnText}>סגירה</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <QuickPicker
        visible={excludedPickerOpen}
        title="קטגוריות שלעולם לא יוצגו לי"
        subtitle="פעילויות מהקטגוריות שתבחרו לא יופיעו לכם באפליקציה, גם אם הן תואמות לפילטרים אחרים"
        options={CATEGORY_OPTIONS}
        value={excludedDraft}
        multiple
        onChange={setExcludedDraft}
        onClose={closeExcludedPicker}
        onReset={() => setExcludedDraft([])}
      />

      <QuickPicker
        visible={excludedCitiesPickerOpen}
        title="📍 אילו אזורים תרצו להסתיר?"
        subtitle="פעילויות בערים שתבחרו לא יופיעו לכם באפליקציה, גם אם הן תואמות לפילטרים אחרים"
        options={CITY_OPTIONS}
        value={excludedCitiesDraft}
        multiple
        searchable
        onChange={setExcludedCitiesDraft}
        onClose={closeExcludedCitiesPicker}
        onReset={() => setExcludedCitiesDraft([])}
      />

      <QuickPicker
        visible={benefitClubsPickerOpen}
        title="המועדונים והכרטיסים שלי"
        subtitle="אילו מועדונים וכרטיסים יש לכם?"
        options={BENEFIT_PROVIDER_OPTIONS}
        value={benefitClubsDraft}
        multiple
        onChange={setBenefitClubsDraft}
        onClose={closeBenefitClubsPicker}
        footer={benefitClubsDraft.includes('אחר') && (
          <View style={{ marginTop: 14 }}>
            <Text style={styles.fieldLabel}>מה יש לכם?</Text>
            <TextInput
              style={styles.textInput}
              value={benefitClubsOtherDraft}
              onChangeText={setBenefitClubsOtherDraft}
              placeholder="למשל: כרטיס חבר של הפועל תל אביב"
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
            title="מה המשפחה שלכם אוהבת?"
            subtitle="אפשר לבחור כמה קטגוריות - נשתמש בזה כדי להציג לכם רעיונות שמתאימים לכם"
            options={CATEGORY_OPTIONS}
            value={homeDefaultsDraft.category}
            multiple
            showAll
            onChange={(v) => setPref('category', v)}
            onClose={() => setPrefCategoryOpen(false)}
          />
          <QuickPicker
            visible={prefWhenOpen}
            title="מתי בדרך כלל מחפשים?"
            options={WHEN_QUICK_OPTIONS}
            value={homeDefaultsDraft.when?.options || []}
            multiple={false}
            showAll
            allLabel="כל הזמן"
            onChange={(v) => setPref('when', { options: v, date: null })}
            onClose={() => setPrefWhenOpen(false)}
          />
          <QuickPicker
            visible={prefPriceOpen}
            title="העדפת מחיר"
            options={PRICE_OPTIONS}
            value={homeDefaultsDraft.price}
            multiple={false}
            showAll
            allLabel="כל המחירים"
            onChange={(v) => setPref('price', v)}
            onClose={() => setPrefPriceOpen(false)}
          />
          <QuickPicker
            visible={prefPlaceTypeOpen}
            title="סוג מקום מועדף"
            options={PLACE_TYPE_OPTIONS}
            value={homeDefaultsDraft.placeType}
            multiple={false}
            showAll
            allLabel="לא משנה"
            onChange={(v) => setPref('placeType', v)}
            onClose={() => setPrefPlaceTypeOpen(false)}
          />
          <QuickPicker
            visible={prefBookingOpen}
            title="הזמנה"
            options={BOOKING_OPTIONS}
            value={homeDefaultsDraft.booking}
            multiple={false}
            showAll
            allLabel="לא משנה"
            onChange={(v) => setPref('booking', v)}
            onClose={() => setPrefBookingOpen(false)}
          />
          <QuickPicker
            visible={prefDurationOpen}
            title="משך פעילות"
            options={DURATION_OPTIONS}
            value={homeDefaultsDraft.duration}
            multiple
            showAll
            allLabel="לא משנה"
            onChange={(v) => setPref('duration', v)}
            onClose={() => setPrefDurationOpen(false)}
          />
          <QuickPicker
            visible={prefAmenitiesOpen}
            title="נגישות ונוחות"
            options={AMENITY_COMFORT_OPTIONS}
            value={homeDefaultsDraft.amenities}
            multiple
            showAll
            allLabel="לא משנה"
            onChange={(v) => setPref('amenities', v)}
            onClose={() => setPrefAmenitiesOpen(false)}
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
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

  profileBlock: { flexDirection: 'row-reverse', alignItems: 'center', gap: 14, marginBottom: 24 },
  avatar: { width: 50, height: 50, borderRadius: 25, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: fonts.logo, fontSize: 20, color: '#fff' },
  profileInfo: { flex: 1, minWidth: 0 },
  profileNameRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8 },
  profileName: { fontFamily: fonts.extraBold, fontSize: 16, color: colors.textPrimary, textAlign: 'right' },
  profileStars: { fontFamily: fonts.bold, fontSize: 13, color: colors.yellow },
  profileEdit: { fontFamily: fonts.bold, fontSize: 11.5, color: colors.accent, textDecorationLine: 'underline', textAlign: 'right', marginTop: 2 },
  nicknameEditRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8 },
  nicknameInput: {
    flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, paddingHorizontal: 10,
    paddingVertical: 6, fontFamily: fonts.bold, fontSize: 15, color: colors.textPrimary, textAlign: 'right', writingDirection: 'rtl',
  },
  nicknameSave: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.accent },
  nicknameCancel: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textMuted },
  addActivityBtn: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 6,
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
  onboardingStep: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textPrimary, textAlign: 'right', marginBottom: 6 },
  onboardingGoBtn: { backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 13, alignItems: 'center', marginBottom: 10 },
  onboardingGoBtnText: { fontFamily: fonts.bold, fontSize: 14.5, color: '#fff' },
  onboardingSkip: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textMuted, textAlign: 'center' },

  shelf: { marginBottom: 26 },
  shelfHead: { marginBottom: 10 },
  shelfHeadRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8 },
  // שורת accordion יחידה (למשל "⭐ העדפות חיפוש") - הכותרת+חץ תמיד גלויים, לחיצה מטגלת את שאר
  // התוכן שמתחת (בניגוד ל-shelfHead/shelfHeadRow הרגילים שהם רק כותרת סטטית, לא לחיצות).
  shelfHeadToggle: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4, marginBottom: 10 },
  shelfTitle: { fontFamily: fonts.extraBold, fontSize: 15.5, color: colors.textPrimary, textAlign: 'right' },
  sectionHint: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, textAlign: 'right', lineHeight: 17, marginBottom: 12 },
  comingSoonBadge: { backgroundColor: colors.yellowTint, borderRadius: radii.pill, paddingVertical: 2, paddingHorizontal: 8 },
  comingSoonText: { fontFamily: fonts.bold, fontSize: 10, color: colors.yellow },

  emptyShelf: {
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed',
    borderRadius: radii.md, padding: 16, marginBottom: 12,
  },
  emptyShelfText: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textMuted, textAlign: 'center' },

  benefitsRow: { flexDirection: 'row-reverse', gap: 8, marginBottom: 14 },
  benefitCard: {
    flex: 1, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
    padding: 10, alignItems: 'center',
  },
  benefitEmoji: { fontSize: 18, marginBottom: 4 },
  benefitTitle: { fontFamily: fonts.bold, fontSize: 11, color: colors.textPrimary, textAlign: 'center', marginBottom: 2 },
  benefitText: { fontFamily: fonts.regular, fontSize: 10, color: colors.textSecondary, textAlign: 'center', lineHeight: 13 },

  childrenList: { gap: 8, marginBottom: 12 },
  childCard: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 10,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12,
  },
  childEmoji: { fontSize: 24 },
  childInfo: { flex: 1, minWidth: 0 },
  childName: { fontFamily: fonts.bold, fontSize: 14, color: colors.textPrimary, textAlign: 'right' },
  childAge: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, textAlign: 'right', marginTop: 1 },
  childActionBtn: { padding: 4 },
  childDeleteText: { fontFamily: fonts.bold, fontSize: 14, color: colors.textMuted },
  addChildBtn: {
    borderWidth: 1.5, borderColor: colors.accent, borderStyle: 'dashed', borderRadius: radii.pill,
    paddingVertical: 11, alignItems: 'center',
  },
  addChildBtnText: { fontFamily: fonts.bold, fontSize: 13, color: colors.accent },
  childrenFooterHint: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, textAlign: 'right', marginTop: 10, lineHeight: 16 },

  accountCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, overflow: 'hidden' },
  disabledCard: { opacity: 0.5 },
  settingRow: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 13, paddingHorizontal: 15, borderBottomWidth: 1, borderBottomColor: colors.borderLight,
  },
  settingRowLast: { borderBottomWidth: 0 },
  settingLabel: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary, flexShrink: 1 },
  settingValue: { fontFamily: fonts.bold, fontSize: 13, color: colors.textPrimary },
  toggle: { width: 38, height: 22, borderRadius: 11, justifyContent: 'center' },
  toggleOn: { backgroundColor: colors.accent, alignItems: 'flex-start' },
  toggleOff: { backgroundColor: colors.border, alignItems: 'flex-end' },
  toggleDot: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#fff', marginHorizontal: 2 },
  toggleDotOff: {},
  badgeOk: { flexDirection: 'row-reverse', alignItems: 'center', gap: 4 },
  badgeOkText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.greenStrong },
  badgeSetup: { flexDirection: 'row-reverse', alignItems: 'center', gap: 3 },
  badgeSetupText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.accent, maxWidth: 140 },

  moreToggleRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 5, alignSelf: 'center', paddingVertical: 12 },
  moreToggleText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.textSecondary },
  subSectionTitle: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.textSecondary, textAlign: 'right', marginBottom: 8, marginTop: 4 },
  resetAllPrefsBtn: { alignItems: 'center', paddingVertical: 10, marginBottom: 4 },
  resetAllPrefsBtnText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.danger },

  knowCard: {
    backgroundColor: colors.card, borderWidth: 1.5, borderColor: colors.accentTint, borderRadius: radii.xl,
    padding: spacing.lg, marginBottom: 26,
  },
  knowTitle: { fontFamily: fonts.extraBold, fontSize: 14.5, color: colors.textPrimary, textAlign: 'right', marginBottom: 10 },
  knowBit: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary, textAlign: 'right', marginBottom: 4 },

  tabsRow: { flexDirection: 'row-reverse', gap: 8, marginBottom: 12 },
  tabBtn: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: radii.pill, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.card },
  tabBtnActive: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  tabBtnText: { fontFamily: fonts.bold, fontSize: 12, color: colors.textSecondary },
  tabBtnTextActive: { color: colors.accent },
  tabItemRow: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 8,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12, marginBottom: 8,
  },
  tabItemMain: { flex: 1, minWidth: 0 },
  tabItemNoteBtn: { borderWidth: 1, borderColor: colors.accent, borderRadius: radii.pill, paddingVertical: 6, paddingHorizontal: 10 },
  tabItemNoteBtnText: { fontFamily: fonts.bold, fontSize: 11, color: colors.accent },
  tabItemTitle: { fontFamily: fonts.bold, fontSize: 13, color: colors.textPrimary, textAlign: 'right' },

  noteCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12, marginBottom: 10 },
  noteCardTop: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10, marginBottom: 8 },
  noteThumb: { width: 52, height: 52, borderRadius: radii.md, backgroundColor: colors.borderLight },
  noteThumbPlaceholder: { width: 52, height: 52, borderRadius: radii.md, backgroundColor: colors.accentTintLight, alignItems: 'center', justifyContent: 'center' },
  noteThumbPlaceholderText: { fontSize: 20 },
  noteCardInfo: { flex: 1, minWidth: 0 },
  noteActivityName: { fontFamily: fonts.bold, fontSize: 14, color: colors.textPrimary, textAlign: 'right' },
  noteActivityLocation: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textSecondary, textAlign: 'right', marginTop: 2 },
  noteCardText: { fontFamily: fonts.regular, fontSize: 13, color: colors.textPrimary, textAlign: 'right', lineHeight: 18, marginBottom: 8 },
  noteCardMeta: { fontFamily: fonts.regular, fontSize: 10.5, color: colors.textMuted },
  noteActionText: { fontFamily: fonts.bold, fontSize: 12, color: colors.accent },
  noteModalTextarea: { minHeight: 90, textAlignVertical: 'top' },
  tabItemSub: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textSecondary, textAlign: 'right', marginTop: 2 },
  allDestinationsBtn: { alignSelf: 'center', paddingVertical: 10 },
  allDestinationsBtnText: { fontFamily: fonts.bold, fontSize: 13, color: colors.accent },

  hiddenListScroll: { maxHeight: 320, marginTop: 12 },
  hiddenRow: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', gap: 10,
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.borderLight,
  },
  hiddenRowInfo: { flex: 1 },
  hiddenRowName: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.textPrimary, textAlign: 'right' },
  hiddenRowCity: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textSecondary, textAlign: 'right', marginTop: 2 },

  saveDefaultsBtn: { backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 13, alignItems: 'center', marginTop: 10 },
  saveDefaultsBtnText: { fontFamily: fonts.bold, fontSize: 13.5, color: '#fff' },

  logoutLink: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.danger, textAlign: 'center', marginTop: 10 },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(20,30,35,0.4)', justifyContent: 'center', padding: spacing.xl },
  modalCard: { backgroundColor: colors.card, borderRadius: radii.xl, padding: spacing.xl },
  modalTitle: { fontFamily: fonts.extraBold, fontSize: 17, color: colors.textPrimary, textAlign: 'center', marginBottom: 16 },
  fieldLabel: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.textSecondary, textAlign: 'right', marginBottom: 6 },
  textInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12, marginBottom: 14,
    fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, backgroundColor: colors.bg,
    textAlign: 'right', writingDirection: 'rtl',
  },
  dateRow: { flexDirection: 'row-reverse', gap: 8, marginBottom: 14 },
  dateInput: {
    flex: 1, minWidth: 0, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12,
    fontFamily: fonts.bold, fontSize: 15, color: colors.textPrimary, backgroundColor: colors.bg, textAlign: 'center',
  },
  dateInputYear: { flex: 1.4, minWidth: 0 },
  genderRow: { flexDirection: 'row-reverse', gap: 8, marginBottom: 18 },
  genderChip: {
    flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: radii.pill,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg,
  },
  genderChipSelected: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  genderChipText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary },
  genderChipTextSelected: { color: colors.accent, fontFamily: fonts.bold },
  modalActionsRow: { flexDirection: 'row-reverse', gap: 10 },
  modalCancelBtn: { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border },
  modalCancelBtnText: { fontFamily: fonts.bold, fontSize: 14, color: colors.textSecondary },
  modalSaveBtn: { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: radii.pill, backgroundColor: colors.accent },
  modalDangerBtn: { backgroundColor: colors.danger },
  dangerLabel: { fontFamily: fonts.semiBold, fontSize: 14, color: colors.danger },
  deleteExplainText: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 20, color: colors.textSecondary, textAlign: 'right', marginBottom: 20 },
  childPrivacyNote: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, textAlign: 'right', lineHeight: 17, marginBottom: 16 },
  childPrivacyLink: { fontFamily: fonts.semiBold, color: colors.textSecondary, textDecorationLine: 'underline' },
  modalSaveBtnDisabled: { opacity: 0.5 },
  modalSaveBtnText: { fontFamily: fonts.bold, fontSize: 14, color: '#fff' },
});
