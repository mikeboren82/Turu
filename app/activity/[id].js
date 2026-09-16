import { useState, useEffect } from 'react';
import { View, Text, ScrollView, Pressable, TextInput, Linking, ActivityIndicator, ImageBackground, Image, Modal } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import Header from '../../components/Header';
import SkyBackground from '../../components/SkyBackground';
import LoginRequiredModal from '../../components/LoginRequiredModal';
import {
  StarIcon, HideIcon, CheckIcon, CalendarIcon, LocationPinIcon, SlidersIcon, ClockIcon, PriceIcon,
} from '../../components/icons';
import { colors, fonts, radii, spacing } from '../../constants/theme';
import {
  DEFAULT_FILTERS, CATEGORY_OPTIONS, BENEFIT_PROVIDER_EDIT_OPTIONS, BENEFIT_TYPE_EDIT_OPTIONS, REDEMPTION_METHOD_EDIT_OPTIONS,
} from '../../constants/filterSchema';
import { fetchActivityById, updateActivityAsAdmin, deleteActivityAsAdmin } from '../../lib/activities';
import { placeholderImageFor, placeholderBgColorFor } from '../../lib/placeholderImages';
import { supabase } from '../../lib/supabase';
import { uploadActivityPhoto } from '../../lib/photoUpload';
import { relativeDate } from '../../lib/formatDate';
import { useI18n, t as translate, createStyles, DEFAULT_LOCALE } from '../../lib/i18n';
import { categoryLabel, placeName } from '../../lib/i18n/format';
import { openNavigationTo } from '../../lib/openNavigation';
import { formatBenefitDetailLines, addActivityBenefit } from '../../lib/benefits';
import {
  fetchActivityFlags, toggleFavorite, toggleVisited, toggleHidden, togglePlanned,
  fetchPersonalNote, savePersonalNote, fetchCommunityNotes, postCommunityNote,
} from '../../lib/interactions';

const PRICE_ICON_COLOR = colors.green;

// ערכים גולמיים כפי שמאולצים ב-DB (CHECK constraints, ראו supabase/schema.sql) - שונה מ-
// BOOKING_OPTIONS ב-constants/filterSchema.js שם הם מקובצים ל-2 buckets לצורך סינון, לא
// לעריכה ישירה של activities.booking_requirement.
// labelKey נפתר בזמן רינדור (t) - ה-id הוא הערך הקנוני ב-DB.
const ENTITY_TYPE_EDIT_OPTIONS = [
  { id: 'מקום_קבוע', labelKey: 'activity.admin.entityTypes.place' }, // i18n-ignore
  { id: 'פעילות', labelKey: 'activity.admin.entityTypes.activity' }, // i18n-ignore
  { id: 'אירוע_קבוע', labelKey: 'activity.admin.entityTypes.recurringEvent' }, // i18n-ignore
  { id: 'אירוע', labelKey: 'activity.admin.entityTypes.event' }, // i18n-ignore
];
// Raw entity_type value -> badge/description key (Hebrew values mirror the raw DB value exactly).
const ENTITY_TYPE_BADGE_KEYS = {
  'מקום_קבוע': 'activity.detail.entityTypes.place', // i18n-ignore
  'פעילות': 'activity.detail.entityTypes.activity', // i18n-ignore
  'אירוע_קבוע': 'activity.detail.entityTypes.recurringEvent', // i18n-ignore
  'אירוע': 'activity.detail.entityTypes.event', // i18n-ignore
};
const INDOOR_OUTDOOR_EDIT_OPTIONS = [
  { id: 'indoor', labelKey: 'activity.admin.indoorOutdoor.indoor' },
  { id: 'outdoor', labelKey: 'activity.admin.indoorOutdoor.outdoor' },
  { id: 'both', labelKey: 'activity.admin.indoorOutdoor.both' },
];
const BOOKING_EDIT_OPTIONS = [
  { id: 'none', labelKey: 'activity.admin.booking.none' },
  { id: 'walk_in', labelKey: 'activity.admin.booking.walkIn' },
  { id: 'registration_required', labelKey: 'activity.admin.booking.registrationRequired' },
  { id: 'advance_booking', labelKey: 'activity.admin.booking.advanceBooking' },
  { id: 'available_now', labelKey: 'activity.admin.booking.availableNow' },
];

function activityToEditForm(activity) {
  return {
    name: activity.title || '',
    description: activity.description || '',
    category: activity.category || '',
    entity_type: activity.entity_type || 'מקום_קבוע', // i18n-ignore
    min_age: activity.min_age != null ? String(activity.min_age) : '',
    max_age: activity.max_age != null ? String(activity.max_age) : '',
    price_type: activity.price_type || 'free',
    price_amount: activity.price_amount != null ? String(activity.price_amount) : '',
    duration_minutes: activity.duration_minutes != null ? String(activity.duration_minutes) : '',
    indoor_outdoor: activity.indoor_outdoor || '',
    booking_requirement: activity.booking_requirement || '',
    city: activity.city || '',
    location_name: activity.locationName || '',
    location_detail: activity.locationDetail || '',
  };
}

function emptyBenefitForm() {
  return {
    provider: '', benefit_type: '', value: '', special_price: '', valid_until: '',
    redemption_method: '', redemption_url: '', coupon_code: '', terms: '',
  };
}

const FIELD_REPORT_OPTIONS = [
  { key: 'age_range', labelKey: 'activity.report.fields.ageRange' },
  { key: 'price', labelKey: 'activity.report.fields.price' },
  { key: 'hours', labelKey: 'activity.report.fields.hours' },
  { key: 'address', labelKey: 'activity.report.fields.address' },
  { key: 'description', labelKey: 'activity.report.fields.description' },
  { key: 'other', labelKey: 'activity.report.fields.other' },
];

// Badge / fallback-description type: category via categoryLabel, else the entity type.
function activityTypeLabel(activity, t) {
  if (activity.category) return categoryLabel(activity.category);
  const key = ENTITY_TYPE_BADGE_KEYS[activity.entity_type];
  return key ? t(key) : (activity.type || '');
}

function ActionButton({ children, onPress }) {
  return <Pressable style={styles.actionBtn} onPress={onPress} hitSlop={6}>{children}</Pressable>;
}

function InfoCell({ Icon, label, value, tint }) {
  return (
    <View style={styles.infoCell}>
      <View style={[styles.infoIcon, { backgroundColor: tint }]}>
        <Icon size={16} />
      </View>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue} numberOfLines={2}>{value}</Text>
    </View>
  );
}

export default function ActivityScreen() {
  const router = useRouter();
  const { t, dir, formatDate } = useI18n();
  const { id } = useLocalSearchParams();
  const [activity, setActivity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [userId, setUserId] = useState(null);
  const [favorite, setFavorite] = useState(false);
  const [visited, setVisited] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [planned, setPlanned] = useState(false);
  const [personalNote, setPersonalNote] = useState('');
  const [noteStatus, setNoteStatus] = useState('');
  const [editingNote, setEditingNote] = useState(true);
  const [communityNotes, setCommunityNotes] = useState([]);
  const [communityDraft, setCommunityDraft] = useState('');
  const [postingNote, setPostingNote] = useState(false);
  const [notice, setNotice] = useState('');
  const [showPhotoOptions, setShowPhotoOptions] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoStatus, setPhotoStatus] = useState('');
  const [showRegisterPrompt, setShowRegisterPrompt] = useState(false);
  const [showReportChoice, setShowReportChoice] = useState(false);
  const [showReportNoteInput, setShowReportNoteInput] = useState(false);
  const [reportNote, setReportNote] = useState('');
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [reportDone, setReportDone] = useState(false);
  const [showFieldReport, setShowFieldReport] = useState(false);
  const [fieldReportField, setFieldReportField] = useState(null);
  const [fieldReportNote, setFieldReportNote] = useState('');
  const [fieldReportSubmitting, setFieldReportSubmitting] = useState(false);
  const [fieldReportDone, setFieldReportDone] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [benefitClubs, setBenefitClubs] = useState([]);
  const [showAddBenefitModal, setShowAddBenefitModal] = useState(false);
  const [benefitForm, setBenefitForm] = useState(null);
  const [benefitSaving, setBenefitSaving] = useState(false);
  const [benefitError, setBenefitError] = useState('');
  const [showEditModal, setShowEditModal] = useState(false);
  const [editForm, setEditForm] = useState(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteSaving, setDeleteSaving] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [data, { data: { session } }] = await Promise.all([fetchActivityById(String(id)), supabase.auth.getSession()]);
        if (cancelled) return;
        setActivity(data);
        if (session?.user?.id) {
          setUserId(session.user.id);
          const [flags, note, profile] = await Promise.all([
            fetchActivityFlags(session.user.id, String(id)),
            fetchPersonalNote(session.user.id, String(id)),
            supabase.from('profiles').select('role, benefit_clubs').eq('id', session.user.id).maybeSingle(),
          ]);
          if (cancelled) return;
          setFavorite(flags.isFavorite);
          setVisited(flags.isVisited);
          setHidden(flags.isHidden);
          setPlanned(flags.isPlanned);
          setPersonalNote(note);
          setEditingNote(!note);
          setIsAdmin(profile.data?.role === 'admin');
          setBenefitClubs(profile.data?.benefit_clubs || []);
        }
        const notes = await fetchCommunityNotes(String(id));
        if (!cancelled) setCommunityNotes(notes);
      } catch (err) {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  const showNotice = (text) => { setNotice(text); setTimeout(() => setNotice(''), 3000); };

  const requireLogin = () => { setShowRegisterPrompt(true); };

  const handleToggleFavorite = async () => {
    if (!userId) return requireLogin();
    const next = !favorite;
    setFavorite(next);
    try { await toggleFavorite(userId, String(id), next); } catch { setFavorite(!next); }
  };

  const handleToggleVisited = async () => {
    if (!userId) return requireLogin();
    const next = !visited;
    setVisited(next);
    try { await toggleVisited(userId, String(id), next); } catch { setVisited(!next); }
  };

  const handleToggleHidden = async () => {
    if (!userId) return requireLogin();
    const next = !hidden;
    setHidden(next);
    try {
      await toggleHidden(userId, String(id), next);
      showNotice(next ? t('activity.detail.hiddenNotice') : t('activity.detail.unhiddenNotice'));
    } catch {
      setHidden(!next);
    }
  };

  const handleTogglePlanned = async () => {
    if (!userId) return requireLogin();
    const next = !planned;
    setPlanned(next);
    try {
      await togglePlanned(userId, String(id), next);
      showNotice(next ? t('activity.detail.plannedAdded') : t('activity.detail.plannedRemoved'));
    } catch {
      setPlanned(!next);
    }
  };

  const handleSaveNote = async () => {
    if (!userId) return;
    // noteStatus holds a status code ('saving' | 'saved' | 'error'), rendered via t() below.
    setNoteStatus('saving');
    try {
      await savePersonalNote(userId, String(id), personalNote);
      setNoteStatus('saved');
      if (personalNote.trim()) setEditingNote(false);
      setTimeout(() => setNoteStatus(''), 2000);
    } catch {
      setNoteStatus('error');
    }
  };

  const handlePostCommunityNote = async () => {
    if (!userId) return requireLogin();
    if (!communityDraft.trim()) return;
    setPostingNote(true);
    try {
      await postCommunityNote(userId, String(id), communityDraft);
      setCommunityDraft('');
      const notes = await fetchCommunityNotes(String(id));
      setCommunityNotes(notes);
    } catch {
      showNotice(t('activity.notes.postError'));
    } finally {
      setPostingNote(false);
    }
  };

  const handlePickPhoto = async (fromCamera) => {
    setShowPhotoOptions(false);
    if (!userId) return requireLogin();

    const permission = fromCamera
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      showNotice(fromCamera ? t('activity.photos.cameraPermission') : t('activity.photos.libraryPermission'));
      return;
    }

    const result = fromCamera
      ? await ImagePicker.launchCameraAsync({ quality: 0.7 })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.7, mediaTypes: ['images'] });
    if (result.canceled || !result.assets?.[0]) return;

    setUploadingPhoto(true);
    // photoStatus holds a status code ('uploading' | 'sent' | 'error'), rendered via t() below.
    setPhotoStatus('uploading');
    try {
      await uploadActivityPhoto(userId, String(id), result.assets[0].uri);
      setPhotoStatus('sent');
      setTimeout(() => setPhotoStatus(''), 4000);
    } catch {
      setPhotoStatus('error');
    } finally {
      setUploadingPhoto(false);
    }
  };

  const openEditModal = () => {
    setEditForm(activityToEditForm(activity));
    setEditError('');
    setShowEditModal(true);
  };

  const setEditField = (key, value) => setEditForm((prev) => ({ ...prev, [key]: value }));

  const handleSaveEdit = async () => {
    if (!editForm.name.trim()) {
      setEditError(t('activity.admin.nameRequired'));
      return;
    }
    setEditSaving(true);
    setEditError('');
    try {
      const fields = {
        name: editForm.name.trim(),
        description: editForm.description.trim() || null,
        category: editForm.category || null,
        entity_type: editForm.entity_type,
        min_age: editForm.min_age.trim() ? Number(editForm.min_age) : null,
        max_age: editForm.max_age.trim() ? Number(editForm.max_age) : null,
        price_type: editForm.price_type || null,
        price_amount: editForm.price_type === 'fixed' && editForm.price_amount.trim() ? Number(editForm.price_amount) : null,
        duration_minutes: editForm.duration_minutes.trim() ? Number(editForm.duration_minutes) : null,
        indoor_outdoor: editForm.indoor_outdoor || null,
        booking_requirement: editForm.booking_requirement || null,
      };
      const location = {
        name: editForm.location_name.trim() || null,
        city: editForm.city.trim() || null,
      };
      await updateActivityAsAdmin(activity, fields, location);
      const refreshed = await fetchActivityById(String(id));
      setActivity(refreshed);
      setShowEditModal(false);
      showNotice(t('activity.admin.updated'));
    } catch {
      setEditError(t('activity.admin.saveError'));
    } finally {
      setEditSaving(false);
    }
  };

  const handleConfirmDelete = async () => {
    setDeleteSaving(true);
    setDeleteError('');
    try {
      await deleteActivityAsAdmin(String(id));
      router.replace('/activities');
    } catch {
      setDeleteError(t('activity.admin.deleteError'));
      setDeleteSaving(false);
    }
  };

  // הוספת הטבה מהירה מעמוד הפעילות (אדמין בלבד) - מסתמכת על addActivityBenefit (lib/benefits.js,
  // כתיבה ישירה ל-Supabase דרך RLS), בדיוק כמו handleSaveEdit/handleConfirmDelete למעלה. שדות
  // valid_from/status לא נחשפים כאן בכוונה (ברירת מחדל: פעילה, מתחילה מיד) - טופס "הוספה מהירה",
  // כלי הניהול המלא (tools/import-tool) עדיין הכתובת לעריכה/מחיקה/כוונון עדין.
  const openAddBenefitModal = () => {
    setBenefitForm(emptyBenefitForm());
    setBenefitError('');
    setShowAddBenefitModal(true);
  };

  const setBenefitField = (key, value) => setBenefitForm((prev) => ({ ...prev, [key]: value }));

  const handleSaveBenefit = async () => {
    if (!benefitForm.provider || !benefitForm.benefit_type) {
      setBenefitError(t('activity.admin.benefit.required'));
      return;
    }
    setBenefitSaving(true);
    setBenefitError('');
    try {
      await addActivityBenefit(String(id), {
        provider: benefitForm.provider,
        benefit_type: benefitForm.benefit_type,
        value: benefitForm.value.trim() || null,
        special_price: benefitForm.benefit_type === 'special_price' && benefitForm.special_price.trim() ? Number(benefitForm.special_price) : null,
        valid_until: benefitForm.valid_until.trim() || null,
        redemption_method: benefitForm.redemption_method || null,
        redemption_url: benefitForm.redemption_method === 'link' && benefitForm.redemption_url.trim() ? benefitForm.redemption_url.trim() : null,
        coupon_code: benefitForm.redemption_method === 'coupon_code' && benefitForm.coupon_code.trim() ? benefitForm.coupon_code.trim() : null,
        terms: benefitForm.terms.trim() || null,
      });
      const refreshed = await fetchActivityById(String(id));
      setActivity(refreshed);
      setShowAddBenefitModal(false);
      showNotice(t('activity.admin.benefit.added'));
    } catch {
      setBenefitError(t('activity.admin.saveError'));
    } finally {
      setBenefitSaving(false);
    }
  };

  const handleReportPress = () => {
    if (!userId) {
      setShowRegisterPrompt(true);
      return;
    }
    setShowReportChoice((v) => !v);
    setShowReportNoteInput(false);
  };

  const submitReport = async (note) => {
    setReportSubmitting(true);
    try {
      const { error } = await supabase.from('reports').insert({
        reporter_id: userId,
        target_type: 'activity',
        target_id: String(id),
        reason: note || null,
      });
      if (error) throw error;
      setShowReportChoice(false);
      setShowReportNoteInput(false);
      setReportNote('');
      setReportDone(true);
      setTimeout(() => setReportDone(false), 3000);
    } catch {
      showNotice(t('activity.report.sendError'));
    } finally {
      setReportSubmitting(false);
    }
  };

  const handleFieldReportPress = () => {
    if (!userId) {
      setShowRegisterPrompt(true);
      return;
    }
    setShowFieldReport((v) => !v);
    setFieldReportField(null);
    setFieldReportNote('');
  };

  const submitFieldReport = async () => {
    if (!fieldReportField) return;
    setFieldReportSubmitting(true);
    try {
      // reports.reason stays canonical Hebrew (DEFAULT_LOCALE) regardless of UI language - same data as before.
      const fieldKey = FIELD_REPORT_OPTIONS.find((f) => f.key === fieldReportField)?.labelKey;
      const fieldLabel = fieldKey ? translate(fieldKey, null, DEFAULT_LOCALE) : fieldReportField;
      const note = fieldReportNote.trim();
      const { error } = await supabase.from('reports').insert({
        reporter_id: userId,
        target_type: 'activity',
        target_id: String(id),
        reason: note
          ? translate('activity.report.fieldReasonWithNote', { field: fieldLabel, note }, DEFAULT_LOCALE)
          : translate('activity.report.fieldReason', { field: fieldLabel }, DEFAULT_LOCALE),
      });
      if (error) throw error;
      setShowFieldReport(false);
      setFieldReportField(null);
      setFieldReportNote('');
      setFieldReportDone(true);
      setTimeout(() => setFieldReportDone(false), 3000);
    } catch {
      showNotice(t('activity.report.sendError'));
    } finally {
      setFieldReportSubmitting(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.screen}>
        <SkyBackground />
        <View style={styles.content}>
          <Header showBack onMenuPress={() => {}} />
          <View style={styles.notFound}>
            <ActivityIndicator color={colors.accent} />
          </View>
        </View>
      </View>
    );
  }

  if (loadError || !activity) {
    return (
      <View style={styles.screen}>
        <SkyBackground />
        <View style={styles.content}>
          <Header showBack onMenuPress={() => {}} />
          <View style={styles.notFound}>
            <Text style={styles.notFoundText}>{loadError ? t('activity.detail.loadError') : t('activity.detail.notFound')}</Text>
          </View>
        </View>
      </View>
    );
  }

  const placeLabel = [activity.locationName, placeName(activity.city)].filter(Boolean).join(' · ');
  const typeLabel = activityTypeLabel(activity, t);
  // Info tile shows "3-6" for a range (the label above already says "ages"); other shapes use the full ageRange text.
  const ageTileValue = activity.min_age != null && activity.max_age != null && activity.min_age !== activity.max_age
    ? `${activity.min_age}-${activity.max_age}`
    : activity.ageRange;
  // "Recommended by {{name}} ⭐{{stars}}" with the name styled: split the translated sentence around the name.
  const NAME_SLOT = '@@NAME@@';
  const [recommendedBefore, recommendedAfter = ''] = activity.recommendedBy?.nickname
    ? t('activity.detail.recommendedBy', { name: NAME_SLOT, stars: activity.recommendedBy.stars }).split(NAME_SLOT)
    : [''];

  const openNavigation = () => {
    openNavigationTo({ title: activity.title, locationName: activity.locationName, city: activity.city, lat: activity.lat, lng: activity.lng });
  };

  const findSimilarNearby = () => {
    router.push({
      pathname: '/activities',
      params: {
        homeFilters: JSON.stringify({
          ...DEFAULT_FILTERS,
          category: activity.category ? [activity.category] : [],
          location: activity.region
            ? { ...DEFAULT_FILTERS.location, mode: 'region', region: [activity.region] }
            : DEFAULT_FILTERS.location,
        }),
      },
    });
  };

  const descText = activity.description
    || [
      t('activity.detail.fallbackDescription', { title: activity.title, type: typeLabel, age: activity.ageRange }),
      activity.booking_requirement === 'registration_required' ? t('activity.detail.fallbackRegistration') : null,
      activity.indoor_outdoor === 'indoor' ? t('activity.detail.fallbackIndoor') : activity.indoor_outdoor === 'outdoor' ? t('activity.detail.fallbackOutdoor') : null,
    ].filter(Boolean).join(' ');

  const heroActions = (
    <>
      <View style={styles.actionRowRight}>
        <ActionButton onPress={handleToggleFavorite}><StarIcon size={16} filled={favorite} /></ActionButton>
        <ActionButton onPress={handleTogglePlanned}><CalendarIcon size={16} filled={planned} /></ActionButton>
        <ActionButton onPress={handleToggleVisited}><CheckIcon size={16} filled={visited} /></ActionButton>
      </View>
      <View style={styles.actionRowLeft}>
        <ActionButton onPress={handleToggleHidden}><HideIcon size={16} /></ActionButton>
      </View>
    </>
  );

  return (
    <View style={styles.screen}>
      <SkyBackground />
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.headerWrap}>
          <Header showBack onMenuPress={() => {}} />
        </View>

        {activity.imageUrl ? (
          <ImageBackground source={{ uri: activity.imageUrl }} style={styles.hero}>
            {heroActions}
          </ImageBackground>
        ) : placeholderImageFor(activity.placeholderGroup) ? (
          <ImageBackground
            source={placeholderImageFor(activity.placeholderGroup)}
            resizeMode="contain"
            style={[styles.hero, { backgroundColor: placeholderBgColorFor(activity.placeholderGroup) }]}
          >
            {heroActions}
          </ImageBackground>
        ) : (
          <LinearGradient colors={activity.gradient} style={styles.hero}>
            {heroActions}
          </LinearGradient>
        )}

        <View style={styles.content}>
          {notice ? <View style={styles.noticeBox}><Text style={styles.noticeText}>{notice}</Text></View> : null}
          <View style={styles.titleRow}>
            <Text style={styles.title}>{activity.title}</Text>
            <View style={styles.typeBadge}><Text style={styles.typeBadgeText}>{typeLabel}</Text></View>
          </View>
          <View style={styles.locationRow}>
            <LocationPinIcon />
            <Text style={[styles.locationText, { writingDirection: dir.writingDirection }]}>{placeLabel || t('activity.detail.locationNotSpecified')}</Text>
          </View>
          {activity.recommendedBy?.nickname ? (
            <Text style={styles.recommendedText}>
              {recommendedBefore}<Text style={styles.recommendedName}>{activity.recommendedBy.nickname}</Text>{recommendedAfter}
            </Text>
          ) : null}

          {isAdmin ? (
            <View style={styles.adminBar}>
              <Text style={styles.adminBarLabel}>{t('activity.admin.bar')}</Text>
              <View style={styles.adminBarActions}>
                <Pressable style={styles.adminEditBtn} onPress={openEditModal}>
                  <Text style={styles.adminEditBtnText}>{t('activity.admin.edit')}</Text>
                </Pressable>
                <Pressable style={styles.adminEditBtn} onPress={openAddBenefitModal}>
                  <Text style={styles.adminEditBtnText}>{t('activity.admin.addBenefit')}</Text>
                </Pressable>
                <Pressable style={styles.adminDeleteBtn} onPress={() => { setDeleteError(''); setShowDeleteConfirm(true); }}>
                  <Text style={styles.adminDeleteBtnText}>{t('activity.admin.delete')}</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          <View style={styles.infoGrid}>
            <InfoCell Icon={SlidersIcon} label={t('activity.detail.info.ages')} value={ageTileValue} tint={colors.greenTint} />
            <InfoCell Icon={PriceIcon} label={t('activity.detail.info.price')} value={activity.price} tint={colors.greenTint} />
            <InfoCell Icon={ClockIcon} label={t('activity.detail.info.hours')} value={activity.hours} tint={colors.yellowTint} />
          </View>

          {activity.occurrences?.length > 1 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>{t('activity.detail.upcomingDates')}</Text>
              {activity.occurrences.slice(0, 12).map((o) => (
                <View key={`${o.date}-${o.start || ''}`} style={{ flexDirection: dir.row, justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                  <Text style={{ fontFamily: fonts.bold, color: colors.textPrimary }}>{formatDate(o.date, { weekday: 'short', day: 'numeric', month: 'numeric' })}{o.start ? ` · ${o.start}${o.end ? `–${o.end}` : ''}` : ''}</Text>
                  {o.bookingUrl ? (
                    <Pressable onPress={() => Linking.openURL(o.bookingUrl)}><Text style={{ fontFamily: fonts.bold, color: colors.accent }}>{t('activity.detail.occurrenceBuy')}</Text></Pressable>
                  ) : null}
                </View>
              ))}
              {activity.occurrences.length > 12 ? <Text style={{ fontFamily: fonts.regular, color: colors.textSecondary, textAlign: dir.textAlign, marginTop: 6 }}>{t('activity.detail.moreDates', { count: activity.occurrences.length - 12 })}</Text> : null}
            </View>
          ) : null}

          {activity.requiresTicket ? (
            <Pressable onPress={() => Linking.openURL(activity.sourceUrl)} style={styles.ticketBtnWrap}>
              <LinearGradient colors={['#ffbb4d', '#ff8a3d']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.ticketBtn}>
                <Text style={styles.ticketBtnText}>{t('activity.detail.buyTickets')}</Text>
              </LinearGradient>
            </Pressable>
          ) : null}

          {activity.benefits?.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>{t('activity.benefits.sectionTitle')}</Text>
              {activity.benefits.map((benefit) => {
                const b = formatBenefitDetailLines(benefit, benefitClubs);
                return (
                  <View key={benefit.id} style={[styles.benefitCard, b.isPersonalized && styles.benefitCardPersonalized]}>
                    <Text style={styles.benefitProvider}>{b.isPersonalized ? '🟢 ' : ''}{b.provider}</Text>
                    <Text style={styles.benefitHeadline}>{b.headline}</Text>
                    {b.validityText ? <Text style={styles.benefitMeta}>{b.validityText}</Text> : null}
                    {b.redemptionText ? <Text style={styles.benefitMeta}>{t('activity.benefits.howToRedeem', { text: b.redemptionText })}</Text> : null}
                    {b.terms ? <Text style={styles.benefitTerms}>{b.terms}</Text> : null}
                    {b.redemptionUrl ? (
                      <Pressable onPress={() => Linking.openURL(b.redemptionUrl)} hitSlop={6}>
                        <Text style={styles.sourceLink}>{t('activity.benefits.detailsLink')}</Text>
                      </Pressable>
                    ) : null}
                  </View>
                );
              })}
            </View>
          ) : null}

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('activity.detail.about')}</Text>
            {/* Generated fallback text is UI-language prose around a (usually Hebrew) title: pin its direction so
                bidi auto-detection doesn't flip the whole English sentence. Real DB descriptions keep auto. */}
            <Text style={[styles.desc, !activity.description && { writingDirection: dir.writingDirection }]}>{descText}</Text>
            {activity.officialUrl ? (
              <Pressable onPress={() => Linking.openURL(activity.officialUrl)} hitSlop={6}>
                <Text style={styles.sourceLink}>{t('activity.detail.officialSite')}</Text>
              </Pressable>
            ) : activity.sourceUrl && !activity.sourceUrl.includes('openstreetmap.org') ? (
              <Pressable onPress={() => Linking.openURL(activity.sourceUrl)} hitSlop={6}>
                <Text style={styles.sourceLink}>{t('activity.detail.sourceLink')}</Text>
              </Pressable>
            ) : null}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('activity.detail.location')}</Text>
            <View style={styles.mapPlaceholder}>
              <LocationPinIcon size={24} color={colors.accent} />
            </View>
            <View style={styles.addressRow}>
              <Text style={styles.addressText}>
                {placeLabel || t('activity.detail.locationNotSpecified')}{activity.locationDetail ? ` (${activity.locationDetail})` : ''}
              </Text>
              <Pressable style={styles.navBtn} onPress={openNavigation}>
                <Text style={styles.navBtnText}>{t('activity.detail.navigate')}</Text>
              </Pressable>
            </View>
            <Pressable style={styles.similarBtn} onPress={findSimilarNearby}>
              <Text style={styles.similarBtnText}>{t('activity.detail.findSimilar')}</Text>
            </Pressable>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('activity.photos.title')}</Text>
            {activity.imageUrls.length > 0 ? (
              <View style={styles.photoRow}>
                {activity.imageUrls.map((url, i) => (
                  <Image key={i} source={{ uri: url }} style={styles.photoThumb} />
                ))}
              </View>
            ) : (
              <Text style={styles.noNotesText}>{t('activity.photos.empty')}</Text>
            )}
            {showPhotoOptions ? (
              <View style={styles.photoOptionsRow}>
                <Pressable style={styles.photoOptionBtn} onPress={() => handlePickPhoto(false)} disabled={uploadingPhoto}>
                  <Text style={styles.photoOptionBtnText}>{t('activity.photos.fromGallery')}</Text>
                </Pressable>
                <Pressable style={styles.photoOptionBtn} onPress={() => handlePickPhoto(true)} disabled={uploadingPhoto}>
                  <Text style={styles.photoOptionBtnText}>{t('activity.photos.takePhoto')}</Text>
                </Pressable>
                <Pressable style={styles.photoOptionCancel} onPress={() => setShowPhotoOptions(false)}>
                  <Text style={styles.photoOptionCancelText}>{t('common.actions.cancel')}</Text>
                </Pressable>
              </View>
            ) : (
              <Pressable style={styles.addPhotoBtn} onPress={() => setShowPhotoOptions(true)} disabled={uploadingPhoto}>
                <Text style={styles.addPhotoBtnText}>{uploadingPhoto ? t('activity.photos.uploadingShort') : t('activity.photos.add')}</Text>
              </Pressable>
            )}
            {photoStatus ? (
              <Text style={styles.hint}>
                {photoStatus === 'uploading' ? t('activity.photos.uploading') : photoStatus === 'sent' ? t('activity.photos.sent') : t('activity.photos.uploadError')}
              </Text>
            ) : null}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('activity.notes.communityTitle', { n: communityNotes.length })}</Text>
            {communityNotes.length === 0 ? (
              <Text style={styles.noNotesText}>{t('activity.notes.communityEmpty')}</Text>
            ) : (
              communityNotes.map((n) => {
                // nickname is null when the author's public profile isn't available - fallback resolved here, per locale.
                const nickname = n.nickname || t('activity.notes.anonymousAuthor');
                return (
                  <View key={n.id} style={styles.note}>
                    <View style={styles.noteAvatar}><Text style={styles.noteAvatarText}>{nickname[0]}</Text></View>
                    <View style={{ flex: 1 }}>
                      <View style={styles.noteHeadRow}>
                        <Pressable
                          onPress={() => router.push({
                            pathname: '/report',
                            params: { targetType: 'community_note', targetId: n.id, preview: `${nickname}: ${n.note}` },
                          })}
                        >
                          <Text style={styles.reportLink}>{t('activity.notes.report')}</Text>
                        </Pressable>
                        <Text style={styles.noteText}><Text style={styles.noteNick}>{nickname} ⭐{n.stars} </Text>{n.note}</Text>
                      </View>
                      <Text style={styles.noteDate}>{relativeDate(n.created_at)}</Text>
                    </View>
                  </View>
                );
              })
            )}
            <View style={styles.addNoteRow}>
              <TextInput
                style={styles.addNoteInput}
                placeholder={t('activity.notes.communityPlaceholder')}
                placeholderTextColor={colors.textMuted}
                value={communityDraft}
                onChangeText={setCommunityDraft}
              />
              <Pressable style={styles.sendBtn} onPress={handlePostCommunityNote} disabled={postingNote}>
                <Text style={styles.sendBtnText}>{postingNote ? '...' : t('activity.notes.send')}</Text>
              </Pressable>
            </View>
            {!userId && <Text style={styles.hint}>{t('activity.notes.communityLoginRequired')}</Text>}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('activity.notes.personalTitle')}</Text>
            {!editingNote && personalNote ? (
              <View style={styles.notePreviewBox}>
                <Text style={styles.notePreviewHead}>{t('activity.notes.personalHasNote')}</Text>
                <Text style={styles.notePreviewText}>{personalNote}</Text>
                <Pressable style={styles.noteEditBtn} onPress={() => setEditingNote(true)}>
                  <Text style={styles.noteEditBtnText}>{t('activity.notes.edit')}</Text>
                </Pressable>
              </View>
            ) : (
              <>
                <TextInput
                  style={styles.personalNote}
                  placeholder={t('activity.notes.personalPlaceholder')}
                  placeholderTextColor={colors.textMuted}
                  multiline
                  value={personalNote}
                  onChangeText={setPersonalNote}
                  onBlur={handleSaveNote}
                  editable={!!userId}
                  autoFocus={editingNote && !!personalNote}
                />
                {userId ? (
                  noteStatus ? (
                    <Text style={styles.hint}>
                      {noteStatus === 'saving' ? t('common.actions.saving') : noteStatus === 'saved' ? t('activity.notes.saved') : t('activity.notes.saveError')}
                    </Text>
                  ) : (
                    <Text style={styles.hint}>{t('activity.notes.autoSaveHint')}</Text>
                  )
                ) : (
                  <View style={styles.hintRow}>
                    <Text style={styles.hintInline}>{t('activity.notes.personalLoginPrompt')}</Text>
                    <Pressable onPress={() => router.push('/login')}>
                      <Text style={styles.hintLink}>{t('activity.notes.signUp')}</Text>
                    </Pressable>
                  </View>
                )}
              </>
            )}
          </View>

          <View style={styles.reportSection}>
            {reportDone ? (
              <Text style={styles.reportDoneText}>{t('activity.report.sent')}</Text>
            ) : (
              <>
                <Pressable onPress={handleReportPress}>
                  <Text style={styles.reportLink}>{t('activity.report.activityLink')}</Text>
                </Pressable>
                {showReportChoice ? (
                  showReportNoteInput ? (
                    <View style={styles.reportNoteBox}>
                      <TextInput
                        style={styles.reportNoteInput}
                        placeholder={t('activity.report.notePlaceholder')}
                        placeholderTextColor={colors.textMuted}
                        multiline
                        value={reportNote}
                        onChangeText={setReportNote}
                      />
                      <View style={styles.reportNoteActions}>
                        <Pressable
                          style={styles.reportSubmitBtn}
                          onPress={() => submitReport(reportNote.trim())}
                          disabled={reportSubmitting || !reportNote.trim()}
                        >
                          <Text style={styles.reportSubmitBtnText}>{reportSubmitting ? '...' : t('activity.report.submit')}</Text>
                        </Pressable>
                        <Pressable onPress={() => setShowReportChoice(false)}>
                          <Text style={styles.reportCancelText}>{t('common.actions.cancel')}</Text>
                        </Pressable>
                      </View>
                    </View>
                  ) : (
                    <View style={styles.reportChoiceRow}>
                      <Pressable style={styles.reportSubmitBtn} onPress={() => submitReport(null)} disabled={reportSubmitting}>
                        <Text style={styles.reportSubmitBtnText}>{reportSubmitting ? '...' : t('activity.report.quick')}</Text>
                      </Pressable>
                      <Pressable style={styles.reportOptionBtn} onPress={() => setShowReportNoteInput(true)}>
                        <Text style={styles.reportOptionBtnText}>{t('activity.report.addNote')}</Text>
                      </Pressable>
                      <Pressable onPress={() => setShowReportChoice(false)}>
                        <Text style={styles.reportCancelText}>{t('common.actions.cancel')}</Text>
                      </Pressable>
                    </View>
                  )
                ) : null}
              </>
            )}

            {fieldReportDone ? (
              <Text style={[styles.reportDoneText, { marginTop: 10 }]}>{t('activity.report.sent')}</Text>
            ) : (
              <>
                <Pressable onPress={handleFieldReportPress} style={{ marginTop: 10 }}>
                  <Text style={styles.reportLink}>{t('activity.report.fieldLink')}</Text>
                </Pressable>
                {showFieldReport ? (
                  <View style={styles.reportNoteBox}>
                    <Text style={styles.fieldReportPrompt}>{t('activity.report.fieldPrompt')}</Text>
                    <View style={styles.fieldChipsRow}>
                      {FIELD_REPORT_OPTIONS.map((f) => (
                        <Pressable
                          key={f.key}
                          style={[styles.fieldChip, fieldReportField === f.key && styles.fieldChipSelected]}
                          onPress={() => setFieldReportField(f.key)}
                        >
                          <Text style={[styles.fieldChipText, fieldReportField === f.key && styles.fieldChipTextSelected]}>{t(f.labelKey)}</Text>
                        </Pressable>
                      ))}
                    </View>
                    <TextInput
                      style={styles.reportNoteInput}
                      placeholder={t('activity.report.fieldNotePlaceholder')}
                      placeholderTextColor={colors.textMuted}
                      multiline
                      value={fieldReportNote}
                      onChangeText={setFieldReportNote}
                    />
                    <View style={styles.reportNoteActions}>
                      <Pressable
                        style={[styles.reportSubmitBtn, !fieldReportField && styles.primaryBtnDisabled]}
                        onPress={submitFieldReport}
                        disabled={fieldReportSubmitting || !fieldReportField}
                      >
                        <Text style={styles.reportSubmitBtnText}>{fieldReportSubmitting ? '...' : t('activity.report.submit')}</Text>
                      </Pressable>
                      <Pressable onPress={() => setShowFieldReport(false)}>
                        <Text style={styles.reportCancelText}>{t('common.actions.cancel')}</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : null}
              </>
            )}
          </View>
        </View>
      </ScrollView>

      <LoginRequiredModal visible={showRegisterPrompt} onClose={() => setShowRegisterPrompt(false)} />

      <Modal visible={showEditModal} animationType="slide" onRequestClose={() => setShowEditModal(false)} presentationStyle="pageSheet">
        <View style={styles.editSheet}>
          <View style={styles.editHeader}>
            <Text style={styles.editHeaderTitle}>{t('activity.admin.editTitle')}</Text>
            <Pressable onPress={() => setShowEditModal(false)}><Text style={styles.editCloseText}>✕</Text></Pressable>
          </View>
          {editForm && (
            <ScrollView contentContainerStyle={styles.editBody}>
              <Text style={styles.fieldReportPrompt}>{t('activity.admin.nameLabel')}</Text>
              <TextInput style={styles.editInput} value={editForm.name} onChangeText={(v) => setEditField('name', v)} />

              <Text style={styles.fieldReportPrompt}>{t('activity.admin.descriptionLabel')}</Text>
              <TextInput style={[styles.editInput, styles.editTextarea]} value={editForm.description} onChangeText={(v) => setEditField('description', v)} multiline />

              <Text style={styles.fieldReportPrompt}>{t('activity.admin.categoryLabel')}</Text>
              <View style={styles.fieldChipsRow}>
                {CATEGORY_OPTIONS.map((opt) => (
                  <Pressable key={opt.id} style={[styles.fieldChip, editForm.category === opt.id && styles.fieldChipSelected]} onPress={() => setEditField('category', opt.id)}>
                    <Text style={[styles.fieldChipText, editForm.category === opt.id && styles.fieldChipTextSelected]}>{opt.label}</Text>
                  </Pressable>
                ))}
              </View>

              <Text style={styles.fieldReportPrompt}>{t('activity.admin.typeLabel')}</Text>
              <View style={styles.fieldChipsRow}>
                {ENTITY_TYPE_EDIT_OPTIONS.map((opt) => (
                  <Pressable key={opt.id} style={[styles.fieldChip, editForm.entity_type === opt.id && styles.fieldChipSelected]} onPress={() => setEditField('entity_type', opt.id)}>
                    <Text style={[styles.fieldChipText, editForm.entity_type === opt.id && styles.fieldChipTextSelected]}>{t(opt.labelKey)}</Text>
                  </Pressable>
                ))}
              </View>

              <View style={styles.editRow}>
                <View style={styles.editRowItem}>
                  <Text style={styles.fieldReportPrompt}>{t('activity.admin.ageFrom')}</Text>
                  <TextInput style={styles.editInput} value={editForm.min_age} onChangeText={(v) => setEditField('min_age', v.replace(/[^0-9.]/g, ''))} keyboardType="numeric" />
                </View>
                <View style={styles.editRowItem}>
                  <Text style={styles.fieldReportPrompt}>{t('activity.admin.ageTo')}</Text>
                  <TextInput style={styles.editInput} value={editForm.max_age} onChangeText={(v) => setEditField('max_age', v.replace(/[^0-9.]/g, ''))} keyboardType="numeric" />
                </View>
              </View>

              <Text style={styles.fieldReportPrompt}>{t('activity.admin.priceLabel')}</Text>
              <View style={styles.fieldChipsRow}>
                <Pressable style={[styles.fieldChip, editForm.price_type === 'free' && styles.fieldChipSelected]} onPress={() => setEditField('price_type', 'free')}>
                  <Text style={[styles.fieldChipText, editForm.price_type === 'free' && styles.fieldChipTextSelected]}>{t('domain.activityMeta.priceFree')}</Text>
                </Pressable>
                <Pressable style={[styles.fieldChip, editForm.price_type === 'fixed' && styles.fieldChipSelected]} onPress={() => setEditField('price_type', 'fixed')}>
                  <Text style={[styles.fieldChipText, editForm.price_type === 'fixed' && styles.fieldChipTextSelected]}>{t('activity.admin.pricePaid')}</Text>
                </Pressable>
                {editForm.price_type === 'fixed' && (
                  <TextInput
                    style={styles.editPriceInput}
                    value={editForm.price_amount}
                    onChangeText={(v) => setEditField('price_amount', v.replace(/[^0-9.]/g, ''))}
                    keyboardType="numeric"
                    placeholder="₪"
                    placeholderTextColor={colors.textMuted}
                  />
                )}
              </View>

              <Text style={styles.fieldReportPrompt}>{t('activity.admin.durationLabel')}</Text>
              <TextInput style={styles.editInput} value={editForm.duration_minutes} onChangeText={(v) => setEditField('duration_minutes', v.replace(/[^0-9.]/g, ''))} keyboardType="numeric" />

              <Text style={styles.fieldReportPrompt}>{t('activity.admin.placeTypeLabel')}</Text>
              <View style={styles.fieldChipsRow}>
                {INDOOR_OUTDOOR_EDIT_OPTIONS.map((opt) => (
                  <Pressable key={opt.id} style={[styles.fieldChip, editForm.indoor_outdoor === opt.id && styles.fieldChipSelected]} onPress={() => setEditField('indoor_outdoor', opt.id)}>
                    <Text style={[styles.fieldChipText, editForm.indoor_outdoor === opt.id && styles.fieldChipTextSelected]}>{t(opt.labelKey)}</Text>
                  </Pressable>
                ))}
              </View>

              <Text style={styles.fieldReportPrompt}>{t('activity.admin.bookingLabel')}</Text>
              <View style={styles.fieldChipsRow}>
                {BOOKING_EDIT_OPTIONS.map((opt) => (
                  <Pressable key={opt.id} style={[styles.fieldChip, editForm.booking_requirement === opt.id && styles.fieldChipSelected]} onPress={() => setEditField('booking_requirement', opt.id)}>
                    <Text style={[styles.fieldChipText, editForm.booking_requirement === opt.id && styles.fieldChipTextSelected]}>{t(opt.labelKey)}</Text>
                  </Pressable>
                ))}
              </View>

              <Text style={styles.fieldReportPrompt}>{t('activity.admin.cityLabel')}</Text>
              <TextInput style={styles.editInput} value={editForm.city} onChangeText={(v) => setEditField('city', v)} />

              <Text style={styles.fieldReportPrompt}>{t('activity.admin.placeNameLabel')}</Text>
              <TextInput style={styles.editInput} value={editForm.location_name} onChangeText={(v) => setEditField('location_name', v)} />

              {editError ? <Text style={styles.editErrorText}>{editError}</Text> : null}

              <Pressable style={styles.editSaveBtn} onPress={handleSaveEdit} disabled={editSaving}>
                <Text style={styles.editSaveBtnText}>{editSaving ? t('common.actions.saving') : t('activity.admin.saveChanges')}</Text>
              </Pressable>
            </ScrollView>
          )}
        </View>
      </Modal>

      <Modal visible={showAddBenefitModal} animationType="slide" onRequestClose={() => setShowAddBenefitModal(false)} presentationStyle="pageSheet">
        <View style={styles.editSheet}>
          <View style={styles.editHeader}>
            <Text style={styles.editHeaderTitle}>{t('activity.admin.benefit.title')}</Text>
            <Pressable onPress={() => setShowAddBenefitModal(false)}><Text style={styles.editCloseText}>✕</Text></Pressable>
          </View>
          {benefitForm && (
            <ScrollView contentContainerStyle={styles.editBody}>
              <Text style={styles.fieldReportPrompt}>{t('activity.admin.benefit.provider')}</Text>
              <View style={styles.fieldChipsRow}>
                {BENEFIT_PROVIDER_EDIT_OPTIONS.map((opt) => (
                  <Pressable key={opt.id} style={[styles.fieldChip, benefitForm.provider === opt.id && styles.fieldChipSelected]} onPress={() => setBenefitField('provider', opt.id)}>
                    <Text style={[styles.fieldChipText, benefitForm.provider === opt.id && styles.fieldChipTextSelected]}>{opt.label}</Text>
                  </Pressable>
                ))}
              </View>

              <Text style={styles.fieldReportPrompt}>{t('activity.admin.benefit.type')}</Text>
              <View style={styles.fieldChipsRow}>
                {BENEFIT_TYPE_EDIT_OPTIONS.map((opt) => (
                  <Pressable key={opt.id} style={[styles.fieldChip, benefitForm.benefit_type === opt.id && styles.fieldChipSelected]} onPress={() => setBenefitField('benefit_type', opt.id)}>
                    <Text style={[styles.fieldChipText, benefitForm.benefit_type === opt.id && styles.fieldChipTextSelected]}>{opt.label}</Text>
                  </Pressable>
                ))}
              </View>

              <Text style={styles.fieldReportPrompt}>{t('activity.admin.benefit.value')}</Text>
              <TextInput style={styles.editInput} value={benefitForm.value} onChangeText={(v) => setBenefitField('value', v)} placeholder={t('activity.admin.benefit.valuePlaceholder')} placeholderTextColor={colors.textMuted} />

              {benefitForm.benefit_type === 'special_price' && (
                <>
                  <Text style={styles.fieldReportPrompt}>{t('activity.admin.benefit.specialPrice')}</Text>
                  <TextInput style={styles.editInput} value={benefitForm.special_price} onChangeText={(v) => setBenefitField('special_price', v.replace(/[^0-9.]/g, ''))} keyboardType="numeric" />
                </>
              )}

              <Text style={styles.fieldReportPrompt}>{t('activity.admin.benefit.validUntil')}</Text>
              <TextInput style={styles.editInput} value={benefitForm.valid_until} onChangeText={(v) => setBenefitField('valid_until', v)} placeholder="YYYY-MM-DD" placeholderTextColor={colors.textMuted} />

              <Text style={styles.fieldReportPrompt}>{t('activity.admin.benefit.redemption')}</Text>
              <View style={styles.fieldChipsRow}>
                {REDEMPTION_METHOD_EDIT_OPTIONS.map((opt) => (
                  <Pressable key={opt.id} style={[styles.fieldChip, benefitForm.redemption_method === opt.id && styles.fieldChipSelected]} onPress={() => setBenefitField('redemption_method', opt.id)}>
                    <Text style={[styles.fieldChipText, benefitForm.redemption_method === opt.id && styles.fieldChipTextSelected]}>{opt.label}</Text>
                  </Pressable>
                ))}
              </View>

              {benefitForm.redemption_method === 'link' && (
                <>
                  <Text style={styles.fieldReportPrompt}>{t('activity.admin.benefit.redemptionUrl')}</Text>
                  <TextInput style={styles.editInput} value={benefitForm.redemption_url} onChangeText={(v) => setBenefitField('redemption_url', v)} autoCapitalize="none" keyboardType="url" />
                </>
              )}

              {benefitForm.redemption_method === 'coupon_code' && (
                <>
                  <Text style={styles.fieldReportPrompt}>{t('activity.admin.benefit.couponCode')}</Text>
                  <TextInput style={styles.editInput} value={benefitForm.coupon_code} onChangeText={(v) => setBenefitField('coupon_code', v)} autoCapitalize="none" />
                </>
              )}

              <Text style={styles.fieldReportPrompt}>{t('activity.admin.benefit.terms')}</Text>
              <TextInput style={[styles.editInput, styles.editTextarea]} value={benefitForm.terms} onChangeText={(v) => setBenefitField('terms', v)} multiline />

              {benefitError ? <Text style={styles.editErrorText}>{benefitError}</Text> : null}

              <Pressable style={styles.editSaveBtn} onPress={handleSaveBenefit} disabled={benefitSaving}>
                <Text style={styles.editSaveBtnText}>{benefitSaving ? t('common.actions.saving') : t('activity.admin.benefit.submit')}</Text>
              </Pressable>
            </ScrollView>
          )}
        </View>
      </Modal>

      <Modal visible={showDeleteConfirm} transparent animationType="fade" onRequestClose={() => !deleteSaving && setShowDeleteConfirm(false)}>
        <Pressable style={styles.registerBackdrop} onPress={() => !deleteSaving && setShowDeleteConfirm(false)}>
          <Pressable style={styles.deleteConfirmBox} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.deleteConfirmTitle}>{t('activity.admin.deleteTitle', { title: activity.title })}</Text>
            <Text style={styles.deleteConfirmText}>{t('activity.admin.deleteText')}</Text>
            {deleteError ? <Text style={styles.editErrorText}>{deleteError}</Text> : null}
            <View style={styles.deleteConfirmActions}>
              <Pressable style={styles.deleteConfirmBtn} onPress={handleConfirmDelete} disabled={deleteSaving}>
                <Text style={styles.deleteConfirmBtnText}>{deleteSaving ? '...' : t('activity.admin.deleteConfirm')}</Text>
              </Pressable>
              <Pressable style={styles.deleteCancelBtn} onPress={() => setShowDeleteConfirm(false)} disabled={deleteSaving}>
                <Text style={styles.deleteCancelBtnText}>{t('common.actions.cancel')}</Text>
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
  headerWrap: { paddingHorizontal: spacing.xl, paddingTop: spacing.xl },
  hero: { width: '100%', height: 240, marginTop: 12, position: 'relative' },
  actionRowRight: { position: 'absolute', top: 14, [d.start]: 16, flexDirection: d.row, gap: 8 },
  actionRowLeft: { position: 'absolute', top: 14, [d.end]: 16, flexDirection: 'row', gap: 8 },
  actionBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.92)', alignItems: 'center', justifyContent: 'center' },

  content: { padding: spacing.xl },
  titleRow: { marginBottom: 8 },
  title: { fontFamily: fonts.extraBold, fontSize: 21, color: colors.textPrimary, textAlign: d.textAlign },
  typeBadge: { alignSelf: d.alignEnd, marginTop: 6, backgroundColor: colors.accentTintLight, borderRadius: 7, paddingVertical: 4, paddingHorizontal: 10 },
  typeBadgeText: { fontFamily: fonts.bold, fontSize: 12, color: colors.accent },
  locationRow: { flexDirection: d.row, alignItems: 'center', gap: 6, marginBottom: 18 },
  locationText: { fontFamily: fonts.regular, fontSize: 13.5, color: colors.textSecondary },
  recommendedText: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textMuted, textAlign: d.textAlign, marginTop: -12, marginBottom: 18 },
  recommendedName: { fontFamily: fonts.bold, color: colors.accent },

  adminBar: {
    flexDirection: d.row, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
    backgroundColor: '#fff8ec', borderWidth: 1, borderColor: '#f0dcae', borderRadius: radii.lg,
    paddingVertical: 10, paddingHorizontal: 14, marginBottom: 18,
  },
  adminBarLabel: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.warn },
  adminBarActions: { flexDirection: d.row, gap: 8, flexWrap: 'wrap' },
  adminEditBtn: { borderWidth: 1, borderColor: colors.accent, backgroundColor: colors.accentTintLight, borderRadius: radii.pill, paddingVertical: 7, paddingHorizontal: 12 },
  adminEditBtnText: { fontFamily: fonts.bold, fontSize: 12, color: colors.accent },
  adminDeleteBtn: { borderWidth: 1, borderColor: colors.danger, backgroundColor: '#fdeceb', borderRadius: radii.pill, paddingVertical: 7, paddingHorizontal: 12 },
  adminDeleteBtnText: { fontFamily: fonts.bold, fontSize: 12, color: colors.danger },

  infoGrid: { flexDirection: d.rowReverse, gap: 10, marginBottom: 24 },
  ticketBtnWrap: {
    borderRadius: radii.pill, overflow: 'hidden', marginBottom: 24,
    shadowColor: '#ff8a3d', shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 3,
  },
  ticketBtn: { paddingVertical: 14, alignItems: 'center' },
  ticketBtnText: { fontFamily: fonts.bold, fontSize: 14.5, color: '#ffffff' },
  infoCell: { flex: 1, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, padding: 12, alignItems: 'center' },
  infoIcon: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  infoLabel: { fontFamily: fonts.semiBold, fontSize: 11, color: colors.textSecondary, marginBottom: 2 },
  infoValue: { fontFamily: fonts.extraBold, fontSize: 13.5, color: colors.textPrimary, textAlign: 'center' },

  section: { marginBottom: 26 },
  sectionTitle: { fontFamily: fonts.extraBold, fontSize: 15, color: colors.textPrimary, marginBottom: 10, textAlign: d.textAlign },
  desc: { fontFamily: fonts.regular, fontSize: 13.5, lineHeight: 21, color: colors.textSecondary, textAlign: d.textAlign },
  sourceLink: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.accent, textAlign: d.textAlign, marginTop: 10 },

  benefitCard: {
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card,
    borderRadius: radii.lg, padding: 14, marginBottom: 10,
  },
  benefitCardPersonalized: { borderColor: colors.accentTint, backgroundColor: colors.accentTintLight },
  benefitProvider: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.accent, textAlign: d.textAlign, marginBottom: 4 },
  benefitHeadline: { fontFamily: fonts.extraBold, fontSize: 16, color: colors.textPrimary, textAlign: d.textAlign, marginBottom: 6 },
  benefitMeta: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: d.textAlign, marginBottom: 4 },
  benefitTerms: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, textAlign: d.textAlign, marginBottom: 4 },

  mapPlaceholder: {
    height: 140, borderRadius: radii.lg, backgroundColor: colors.accentTintLight,
    alignItems: 'center', justifyContent: 'center', marginBottom: 10,
  },
  addressRow: { flexDirection: d.row, alignItems: 'center', justifyContent: 'space-between' },
  addressText: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary },
  navBtn: { borderWidth: 1.5, borderColor: colors.accent, backgroundColor: colors.accentTintLight, borderRadius: radii.pill, paddingVertical: 8, paddingHorizontal: 14 },
  navBtnText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.accent },
  similarBtn: {
    marginTop: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card,
    borderRadius: radii.pill, paddingVertical: 10, alignItems: 'center',
  },
  similarBtnText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.textPrimary },

  photoRow: { flexDirection: d.row, flexWrap: 'wrap', justifyContent: 'flex-start', gap: 8, marginBottom: 12 },
  photoThumb: { width: 96, height: 96, borderRadius: radii.md, backgroundColor: colors.card },
  addPhotoBtn: {
    alignSelf: d.alignStart, borderWidth: 1.5, borderColor: colors.accent, backgroundColor: colors.accentTintLight,
    borderRadius: radii.pill, paddingVertical: 9, paddingHorizontal: 16,
  },
  addPhotoBtnText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.accent },
  photoOptionsRow: { flexDirection: d.row, gap: 8, flexWrap: 'wrap' },
  photoOptionBtn: {
    borderWidth: 1.5, borderColor: colors.accent, backgroundColor: colors.accentTintLight,
    borderRadius: radii.pill, paddingVertical: 9, paddingHorizontal: 14,
  },
  photoOptionBtnText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.accent },
  photoOptionCancel: { borderRadius: radii.pill, paddingVertical: 9, paddingHorizontal: 14 },
  photoOptionCancelText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textMuted },

  noticeBox: { backgroundColor: colors.accentTintLight, borderRadius: radii.md, padding: 10, marginBottom: 16 },
  noticeText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.accent, textAlign: 'center' },

  noNotesText: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textMuted, textAlign: 'center', marginBottom: 12 },
  note: { flexDirection: d.row, gap: 10, marginBottom: 12 },
  noteAvatar: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' },
  noteAvatarText: { fontFamily: fonts.bold, fontSize: 12, color: colors.accent },
  noteHeadRow: { flexDirection: d.row, justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  reportLink: { fontFamily: fonts.regular, fontSize: 11, color: colors.textMuted, textDecorationLine: 'underline' },
  noteText: { flex: 1, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, textAlign: d.textAlign, lineHeight: 19 },
  noteNick: { fontFamily: fonts.bold, color: colors.textPrimary },
  noteDate: { fontFamily: fonts.regular, fontSize: 10.5, color: colors.textMuted, textAlign: d.textAlign, marginTop: 2 },
  addNoteRow: { flexDirection: d.row, gap: 8, marginTop: 4 },
  addNoteInput: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radii.pill, paddingVertical: 11, paddingHorizontal: 15, fontFamily: fonts.regular, fontSize: 13, color: colors.textPrimary, textAlign: d.textAlign, writingDirection: d.writingDirection },
  sendBtn: { backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 11, paddingHorizontal: 18, justifyContent: 'center' },
  sendBtnText: { fontFamily: fonts.bold, fontSize: 13, color: '#fff' },

  personalNote: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12,
    fontFamily: fonts.regular, fontSize: 13, color: colors.textPrimary, minHeight: 70,
    backgroundColor: '#fdf9ee', textAlignVertical: 'top', textAlign: d.textAlign, writingDirection: d.writingDirection,
  },
  notePreviewBox: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12,
    backgroundColor: '#fdf9ee',
  },
  notePreviewHead: { fontFamily: fonts.bold, fontSize: 12, color: colors.textSecondary, textAlign: d.textAlign },
  notePreviewText: { fontFamily: fonts.regular, fontSize: 13, color: colors.textPrimary, textAlign: d.textAlign, lineHeight: 19, marginTop: 6 },
  noteEditBtn: { alignSelf: d.alignStart, marginTop: 10 },
  noteEditBtnText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.accent },
  hint: { fontFamily: fonts.regular, fontSize: 11, color: colors.textMuted, marginTop: 6, textAlign: d.textAlign },
  hintRow: { flexDirection: d.row, flexWrap: 'wrap', marginTop: 6 },
  hintInline: { fontFamily: fonts.regular, fontSize: 11, color: colors.textMuted, textAlign: d.textAlign },
  hintLink: { fontFamily: fonts.bold, fontSize: 11, color: colors.accent, textDecorationLine: 'underline' },

  reportSection: { marginTop: 6, alignItems: d.alignStart },
  reportLink: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textMuted },
  reportDoneText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.greenStrong },
  reportChoiceRow: { flexDirection: d.row, alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' },
  reportOptionBtn: {
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card,
    borderRadius: radii.pill, paddingVertical: 9, paddingHorizontal: 14,
  },
  reportOptionBtnText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.textSecondary },
  reportSubmitBtn: { backgroundColor: colors.danger, borderRadius: radii.pill, paddingVertical: 9, paddingHorizontal: 16 },
  reportSubmitBtnText: { fontFamily: fonts.bold, fontSize: 12.5, color: '#fff' },
  reportCancelText: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textMuted },
  reportNoteBox: { width: '100%', marginTop: 10 },
  reportNoteInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 10,
    fontFamily: fonts.regular, fontSize: 13, color: colors.textPrimary, minHeight: 60, textAlignVertical: 'top', textAlign: d.textAlign, writingDirection: d.writingDirection,
  },
  reportNoteActions: { flexDirection: d.row, alignItems: 'center', gap: 10, marginTop: 8 },
  primaryBtnDisabled: { opacity: 0.4 },

  fieldReportPrompt: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textPrimary, textAlign: d.textAlign, marginBottom: 8 },
  fieldChipsRow: { flexDirection: d.row, flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  fieldChip: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, borderRadius: radii.pill, paddingVertical: 7, paddingHorizontal: 13 },
  fieldChipSelected: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  fieldChipText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.textSecondary },
  fieldChipTextSelected: { color: colors.accent },

  registerBackdrop: { flex: 1, backgroundColor: 'rgba(20,30,35,0.4)', justifyContent: 'center', padding: spacing.xl },

  notFound: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 60 },
  notFoundText: { fontFamily: fonts.bold, fontSize: 15, color: colors.textSecondary },

  editSheet: { flex: 1, backgroundColor: colors.bg },
  editHeader: {
    flexDirection: d.row, alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.md,
    borderBottomWidth: 1, borderBottomColor: colors.borderLight, backgroundColor: colors.card,
  },
  editHeaderTitle: { fontFamily: fonts.extraBold, fontSize: 16, color: colors.textPrimary },
  editCloseText: { fontSize: 16, color: colors.textSecondary },
  editBody: { padding: spacing.lg, paddingBottom: 60 },
  editInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12,
    fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, backgroundColor: colors.card,
    textAlign: d.textAlign, writingDirection: d.writingDirection, marginBottom: 4,
  },
  editTextarea: { minHeight: 80, textAlignVertical: 'top' },
  editRow: { flexDirection: d.row, gap: 12 },
  editRowItem: { flex: 1 },
  editPriceInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.pill, paddingVertical: 7, paddingHorizontal: 14,
    fontFamily: fonts.regular, fontSize: 13, color: colors.textPrimary, minWidth: 70, textAlign: 'center', backgroundColor: colors.card,
  },
  editErrorText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.danger, textAlign: 'center', marginTop: 10 },
  editSaveBtn: { backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
  editSaveBtnText: { fontFamily: fonts.bold, fontSize: 15, color: '#fff' },

  deleteConfirmBox: { backgroundColor: colors.card, borderRadius: radii.xl, padding: spacing.xl },
  deleteConfirmTitle: { fontFamily: fonts.extraBold, fontSize: 15.5, color: colors.textPrimary, textAlign: 'center', marginBottom: 8 },
  deleteConfirmText: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, textAlign: 'center', lineHeight: 19 },
  deleteConfirmActions: { flexDirection: d.row, gap: 10, marginTop: 20 },
  deleteConfirmBtn: { flex: 1, backgroundColor: colors.danger, borderRadius: radii.pill, paddingVertical: 13, alignItems: 'center' },
  deleteConfirmBtnText: { fontFamily: fonts.bold, fontSize: 14, color: '#fff' },
  deleteCancelBtn: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radii.pill, paddingVertical: 13, alignItems: 'center' },
  deleteCancelBtnText: { fontFamily: fonts.bold, fontSize: 14, color: colors.textSecondary },
}));
