import { useState } from 'react';
import { View, Text, ScrollView, Pressable, TextInput, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import Header from '../components/Header';
import SkyBackground from '../components/SkyBackground';
import LoginRequiredModal from '../components/LoginRequiredModal';
import QuickPicker from '../components/QuickPicker';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { CATEGORY_OPTIONS } from '../constants/filterSchema';
import { supabase } from '../lib/supabase';
import { submitUserActivity, extractActivityFromUrl } from '../lib/submitActivity';
import { useI18n, createStyles } from '../lib/i18n';
import { categoryLabel } from '../lib/i18n/format';

// id = canonical entity_type value stored in the DB; labelKey resolved at render time.
const ENTITY_TYPE_OPTIONS = [
  { id: 'מקום_קבוע', labelKey: 'contribute.addActivity.entityTypes.fixedPlace' }, // i18n-ignore
  { id: 'פעילות', labelKey: 'contribute.addActivity.entityTypes.recurringActivity' }, // i18n-ignore
  { id: 'אירוע_קבוע', labelKey: 'contribute.addActivity.entityTypes.recurringEvent' }, // i18n-ignore
  { id: 'אירוע', labelKey: 'contribute.addActivity.entityTypes.oneTimeEvent' }, // i18n-ignore
];

// Error state holds a translation key (rendered with t() so it follows locale switches).
const errorKeyOf = (err, fallbackKey) => err?.i18nKey || fallbackKey;

const EMPTY_FORM = {
  name: '', entity_types: ['מקום_קבוע'], categories: [], city: '', location_name: '', // i18n-ignore
  description: '', min_age: '', max_age: '', price_type: null, price_amount: '',
  start_time: '', end_time: '', image_urls: [],
};

export default function AddActivityScreen() {
  const router = useRouter();
  const { t } = useI18n();
  const [mode, setMode] = useState(null); // null | 'url' | 'manual'
  const [url, setUrl] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState('');
  const [candidates, setCandidates] = useState(null);
  const [sourceUrl, setSourceUrl] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);
  const [showLoginPrompt, setShowLoginPrompt] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitResult, setSubmitResult] = useState(null);
  const [locatingCity, setLocatingCity] = useState(false);
  const [locateCityError, setLocateCityError] = useState('');

  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const toggleEntityType = (id) => {
    setForm((prev) => {
      const has = prev.entity_types.includes(id);
      const next = has ? prev.entity_types.filter((v) => v !== id) : [...prev.entity_types, id];
      return { ...prev, entity_types: next };
    });
  };

  const handleAutoLocateCity = async () => {
    setLocateCityError('');
    setLocatingCity(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setLocateCityError('contribute.addActivity.errors.locationPermission');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({});
      const [place] = await Location.reverseGeocodeAsync({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      });
      const city = place?.city || place?.subregion || place?.region;
      if (!city) {
        setLocateCityError('contribute.addActivity.errors.cityNotDetected');
        return;
      }
      setField('city', city);
    } catch {
      setLocateCityError('contribute.addActivity.errors.locateFailed');
    } finally {
      setLocatingCity(false);
    }
  };

  const startUrlMode = () => { setMode('url'); setExtractError(''); };
  const startManualMode = () => { setForm(EMPTY_FORM); setMode('manual'); };

  const handleExtract = async () => {
    if (!url.trim()) return;
    setExtracting(true);
    setExtractError('');
    setCandidates(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setShowLoginPrompt(true); return; }
      const result = await extractActivityFromUrl(url.trim());
      setSourceUrl(result.sourceUrl);
      if (!result.activities || result.activities.length === 0) {
        setExtractError('contribute.addActivity.errors.noActivityFound');
        return;
      }
      if (result.activities.length === 1) {
        loadIntoForm(result.activities[0]);
      } else {
        setCandidates(result.activities);
      }
    } catch (err) {
      setExtractError(errorKeyOf(err, 'contribute.addActivity.errors.extractFailed'));
    } finally {
      setExtracting(false);
    }
  };

  const loadIntoForm = (activity) => {
    setForm({
      name: activity.name || '',
      entity_types: activity.entity_type ? [activity.entity_type] : ['מקום_קבוע'], // i18n-ignore
      categories: activity.category ? [activity.category] : [],
      city: activity.city || '',
      location_name: activity.location_name || '',
      description: activity.description || '',
      min_age: activity.min_age != null ? String(activity.min_age) : '',
      max_age: activity.max_age != null ? String(activity.max_age) : '',
      price_type: activity.price_type || null,
      price_amount: activity.price_amount != null ? String(activity.price_amount) : '',
      start_time: activity.start_time || '',
      end_time: activity.end_time || '',
      image_urls: Array.isArray(activity.image_urls) ? activity.image_urls : [],
      schedule_type: activity.schedule_type || null,
      recurring_days: activity.recurring_days || null,
      one_time_date: activity.one_time_date || null,
    });
    setCandidates(null);
    setMode('edit');
  };

  const handleSubmit = async () => {
    if (!form.name.trim() || form.categories.length === 0 || form.entity_types.length === 0 || !form.city.trim()) {
      setSubmitError('contribute.addActivity.errors.requiredFields');
      return;
    }
    setSubmitting(true);
    setSubmitError('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setShowLoginPrompt(true); return; }

      // בחירה של כמה קטגוריות/סוגים יוצרת רשומת פעילות נפרדת לכל שילוב (category+entity_type
      // הם עדיין ערך יחיד בכל שורה ב-DB) - כך כל רשומה נשארת רגילה ותואמת לכל שאר האפליקציה
      // (כרטיסיות, סינון, כלי הניהול), רק שהמשתמש קיבל לבחור כמה פעמים "זה מתאים לזה".
      const results = [];
      for (const entity_type of form.entity_types) {
        for (const category of form.categories) {
          const activity = {
            name: form.name.trim(),
            entity_type,
            category,
            city: form.city.trim(),
            location_name: form.location_name.trim() || null,
            description: form.description.trim() || null,
            min_age: form.min_age.trim() ? Number(form.min_age) : null,
            max_age: form.max_age.trim() ? Number(form.max_age) : null,
            price_type: form.price_type,
            price_amount: form.price_amount.trim() ? Number(form.price_amount) : null,
            start_time: form.start_time.trim() || null,
            end_time: form.end_time.trim() || null,
            image_urls: form.image_urls,
            schedule_type: form.schedule_type || (form.start_time || form.end_time ? 'fixed_hours' : null),
            recurring_days: form.recurring_days || null,
            one_time_date: form.one_time_date || null,
          };
          results.push(await submitUserActivity(session.user.id, sourceUrl, activity));
        }
      }
      setSubmitResult({
        count: results.length,
        archivedCount: results.filter((r) => r.archived).length,
      });
    } catch (err) {
      setSubmitError(errorKeyOf(err, 'contribute.addActivity.errors.saveFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  if (submitResult) {
    return (
      <View style={styles.screen}>
        <SkyBackground />
        <View style={styles.content}>
          <Header showBack onMenuPress={() => {}} />
          <View style={styles.doneWrap}>
            <Text style={styles.doneEmoji}>🎉</Text>
            <Text style={styles.doneTitle}>{t('contribute.addActivity.done.title')}</Text>
            <Text style={styles.doneText}>
              {submitResult.count > 1
                ? (submitResult.archivedCount > 0
                    ? t('contribute.addActivity.done.multipleWithArchived', { total: submitResult.count, archived: submitResult.archivedCount })
                    : t('contribute.addActivity.done.multiplePending', { total: submitResult.count }))
                : submitResult.archivedCount > 0
                  ? t('contribute.addActivity.done.singleArchived')
                  : t('contribute.addActivity.done.singlePending')}
            </Text>
            <Pressable style={styles.doneBtn} onPress={() => router.back()}>
              <Text style={styles.doneBtnText}>{t('common.actions.back')}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <SkyBackground />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Header showBack onMenuPress={() => {}} />
        <Text style={styles.pageTitle}>{t('contribute.addActivity.title')}</Text>

        {mode === null && (
          <View style={styles.choiceWrap}>
            <Text style={styles.choiceIntro}>{t('contribute.addActivity.choice.intro')}</Text>
            <Pressable style={styles.choiceCard} onPress={startUrlMode}>
              <Text style={styles.choiceCardTitle}>{t('contribute.addActivity.choice.urlTitle')}</Text>
              <Text style={styles.choiceCardSub}>{t('contribute.addActivity.choice.urlSubtitle')}</Text>
            </Pressable>
            <Pressable style={styles.choiceCard} onPress={startManualMode}>
              <Text style={styles.choiceCardTitle}>{t('contribute.addActivity.choice.manualTitle')}</Text>
              <Text style={styles.choiceCardSub}>{t('contribute.addActivity.choice.manualSubtitle')}</Text>
            </Pressable>
          </View>
        )}

        {mode === 'url' && !candidates && (
          <View style={styles.urlWrap}>
            <TextInput
              style={styles.urlInput}
              placeholder="https://..."
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              value={url}
              onChangeText={setUrl}
            />
            <Pressable style={styles.primaryBtn} onPress={handleExtract} disabled={extracting || !url.trim()}>
              {extracting ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>{t('contribute.addActivity.url.extract')}</Text>}
            </Pressable>
            {extractError ? <Text style={styles.errorText}>{t(extractError)}</Text> : null}
            <Pressable onPress={startManualMode}>
              <Text style={styles.switchModeLink}>{t('contribute.addActivity.url.switchToManual')}</Text>
            </Pressable>
          </View>
        )}

        {mode === 'url' && candidates && (
          <View style={styles.urlWrap}>
            <Text style={styles.choiceIntro}>{t('contribute.addActivity.url.candidatesIntro')}</Text>
            {candidates.map((c, i) => (
              <Pressable key={i} style={styles.candidateCard} onPress={() => loadIntoForm(c)}>
                <Text style={styles.candidateName}>{c.name || t('contribute.addActivity.url.unnamed')}</Text>
                {c.description ? <Text style={styles.candidateDesc} numberOfLines={2}>{c.description}</Text> : null}
              </Pressable>
            ))}
          </View>
        )}

        {(mode === 'manual' || mode === 'edit') && (
          <View style={styles.formWrap}>
            {mode === 'edit' && (
              <Text style={styles.editIntro}>{t('contribute.addActivity.form.editIntro')}</Text>
            )}

            <Text style={styles.fieldLabel}>{t('contribute.addActivity.form.nameLabel')}</Text>
            <TextInput style={styles.input} value={form.name} onChangeText={(v) => setField('name', v)} placeholder={t('contribute.addActivity.form.namePlaceholder')} placeholderTextColor={colors.textMuted} />

            <Text style={styles.fieldLabel}>{t('contribute.addActivity.form.categoryLabel')}</Text>
            <Pressable style={styles.selectBtn} onPress={() => setCategoryPickerOpen(true)}>
              <Text style={styles.selectBtnText}>{form.categories.length ? form.categories.map(categoryLabel).join(', ') : t('contribute.addActivity.form.categoryPlaceholder')}</Text>
            </Pressable>

            <Text style={styles.fieldLabel}>{t('contribute.addActivity.form.entityTypeLabel')}</Text>
            <View style={styles.chipsRow}>
              {ENTITY_TYPE_OPTIONS.map((opt) => (
                <Pressable key={opt.id} style={[styles.chip, form.entity_types.includes(opt.id) && styles.chipSelected]} onPress={() => toggleEntityType(opt.id)}>
                  <Text style={[styles.chipText, form.entity_types.includes(opt.id) && styles.chipTextSelected]}>{t(opt.labelKey)}</Text>
                </Pressable>
              ))}
            </View>

            <View style={styles.fieldLabelRow}>
              <Text style={styles.fieldLabel}>{t('contribute.addActivity.form.cityLabel')}</Text>
              <Pressable style={styles.autoLocateLink} onPress={handleAutoLocateCity} disabled={locatingCity}>
                {locatingCity ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : (
                  <Text style={styles.autoLocateLinkText}>{t('contribute.addActivity.form.autoLocate')}</Text>
                )}
              </Pressable>
            </View>
            <TextInput style={styles.input} value={form.city} onChangeText={(v) => setField('city', v)} placeholder={t('contribute.addActivity.form.cityPlaceholder')} placeholderTextColor={colors.textMuted} />
            {locateCityError ? <Text style={styles.errorText}>{t(locateCityError)}</Text> : null}

            <Text style={styles.fieldLabel}>{t('contribute.addActivity.form.locationNameLabel')}</Text>
            <TextInput style={styles.input} value={form.location_name} onChangeText={(v) => setField('location_name', v)} placeholder={t('contribute.addActivity.form.locationNamePlaceholder')} placeholderTextColor={colors.textMuted} />

            <Text style={styles.fieldLabel}>{t('contribute.addActivity.form.descriptionLabel')}</Text>
            <TextInput style={[styles.input, styles.textarea]} value={form.description} onChangeText={(v) => setField('description', v)} multiline placeholder={t('contribute.addActivity.form.descriptionPlaceholder')} placeholderTextColor={colors.textMuted} />

            <View style={styles.rowFields}>
              <View style={styles.rowField}>
                <Text style={styles.fieldLabel}>{t('contribute.addActivity.form.minAgeLabel')}</Text>
                <TextInput style={styles.input} value={form.min_age} onChangeText={(v) => setField('min_age', v.replace(/[^0-9.]/g, ''))} keyboardType="numeric" placeholder="0" placeholderTextColor={colors.textMuted} />
              </View>
              <View style={styles.rowField}>
                <Text style={styles.fieldLabel}>{t('contribute.addActivity.form.maxAgeLabel')}</Text>
                <TextInput style={styles.input} value={form.max_age} onChangeText={(v) => setField('max_age', v.replace(/[^0-9.]/g, ''))} keyboardType="numeric" placeholder="99" placeholderTextColor={colors.textMuted} />
              </View>
            </View>

            <Text style={styles.fieldLabel}>{t('contribute.addActivity.form.priceLabel')}</Text>
            <View style={styles.chipsRow}>
              <Pressable style={[styles.chip, form.price_type === 'free' && styles.chipSelected]} onPress={() => setField('price_type', form.price_type === 'free' ? null : 'free')}>
                <Text style={[styles.chipText, form.price_type === 'free' && styles.chipTextSelected]}>{t('contribute.addActivity.form.priceFree')}</Text>
              </Pressable>
              <Pressable style={[styles.chip, form.price_type === 'fixed' && styles.chipSelected]} onPress={() => setField('price_type', 'fixed')}>
                <Text style={[styles.chipText, form.price_type === 'fixed' && styles.chipTextSelected]}>{t('contribute.addActivity.form.pricePaid')}</Text>
              </Pressable>
              {form.price_type === 'fixed' && (
                <TextInput style={styles.priceInput} value={form.price_amount} onChangeText={(v) => setField('price_amount', v.replace(/[^0-9.]/g, ''))} keyboardType="numeric" placeholder="₪" placeholderTextColor={colors.textMuted} />
              )}
            </View>

            <View style={styles.rowFields}>
              <View style={styles.rowField}>
                <Text style={styles.fieldLabel}>{t('contribute.addActivity.form.startTimeLabel')}</Text>
                <TextInput style={styles.input} value={form.start_time} onChangeText={(v) => setField('start_time', v)} placeholder="09:00" placeholderTextColor={colors.textMuted} />
              </View>
              <View style={styles.rowField}>
                <Text style={styles.fieldLabel}>{t('contribute.addActivity.form.endTimeLabel')}</Text>
                <TextInput style={styles.input} value={form.end_time} onChangeText={(v) => setField('end_time', v)} placeholder="18:00" placeholderTextColor={colors.textMuted} />
              </View>
            </View>

            {form.image_urls.length > 0 && (
              <Text style={styles.hint}>{t('contribute.addActivity.form.imagesFound', { count: form.image_urls.length })}</Text>
            )}

            {submitError ? <Text style={styles.errorText}>{t(submitError)}</Text> : null}

            <Pressable style={styles.primaryBtn} onPress={handleSubmit} disabled={submitting}>
              {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>{t('contribute.addActivity.form.submit')}</Text>}
            </Pressable>
          </View>
        )}
      </ScrollView>

      <QuickPicker
        visible={categoryPickerOpen}
        title={t('contribute.addActivity.categoryPicker.title')}
        subtitle={t('contribute.addActivity.categoryPicker.subtitle')}
        options={CATEGORY_OPTIONS}
        value={form.categories}
        multiple
        onChange={(ids) => setField('categories', ids)}
        onClose={() => setCategoryPickerOpen(false)}
      />
      <LoginRequiredModal visible={showLoginPrompt} onClose={() => setShowLoginPrompt(false)} target="/login" />
    </View>
  );
}

const styles = createStyles((d) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, paddingBottom: 60 },
  pageTitle: { fontFamily: fonts.extraBold, fontSize: 20, color: colors.textPrimary, textAlign: d.textAlign, marginTop: 20, marginBottom: 18 },

  choiceWrap: { gap: 12 },
  choiceIntro: { fontFamily: fonts.semiBold, fontSize: 14, color: colors.textSecondary, textAlign: d.textAlign, marginBottom: 4 },
  choiceCard: {
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, padding: 16,
  },
  choiceCardTitle: { fontFamily: fonts.extraBold, fontSize: 15.5, color: colors.textPrimary, textAlign: d.textAlign, marginBottom: 4 },
  choiceCardSub: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: d.textAlign, lineHeight: 18 },

  urlWrap: { gap: 12 },
  urlInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 13,
    fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, textAlign: 'left',
  },
  switchModeLink: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.accent, textAlign: 'center', textDecorationLine: 'underline' },
  candidateCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 13 },
  candidateName: { fontFamily: fonts.bold, fontSize: 14, color: colors.textPrimary, textAlign: d.textAlign },
  candidateDesc: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: d.textAlign, marginTop: 4 },

  formWrap: { gap: 4 },
  editIntro: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.accent, textAlign: d.textAlign, marginBottom: 10 },
  fieldLabel: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textSecondary, textAlign: d.textAlign, marginTop: 14, marginBottom: 6 },
  fieldLabelRow: { flexDirection: d.row, alignItems: 'center', justifyContent: 'space-between' },
  autoLocateLink: { marginTop: 14, marginBottom: 6, paddingHorizontal: 4, minWidth: 20, alignItems: d.alignEnd },
  autoLocateLinkText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.accent },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12,
    fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, backgroundColor: colors.card,
    textAlign: d.textAlign, writingDirection: d.writingDirection,
  },
  textarea: { minHeight: 80, textAlignVertical: 'top' },
  selectBtn: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12, backgroundColor: colors.card,
  },
  selectBtnText: { fontFamily: fonts.bold, fontSize: 14, color: colors.textPrimary, textAlign: d.textAlign },
  chipsRow: { flexDirection: d.row, flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, borderRadius: radii.pill, paddingVertical: 9, paddingHorizontal: 14 },
  chipSelected: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  chipText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textSecondary },
  chipTextSelected: { color: colors.accent, fontFamily: fonts.bold },
  priceInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.pill, paddingVertical: 9, paddingHorizontal: 14,
    fontFamily: fonts.regular, fontSize: 13, color: colors.textPrimary, minWidth: 70, textAlign: 'center', backgroundColor: colors.card,
  },
  rowFields: { flexDirection: d.row, gap: 12 },
  rowField: { flex: 1 },
  hint: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, textAlign: d.textAlign, marginTop: 14 },
  errorText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.danger, textAlign: 'center', marginTop: 4 },

  primaryBtn: { backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
  primaryBtnText: { fontFamily: fonts.bold, fontSize: 15, color: '#fff' },

  doneWrap: { alignItems: 'center', paddingTop: 60, gap: 10 },
  doneEmoji: { fontSize: 40 },
  doneTitle: { fontFamily: fonts.extraBold, fontSize: 19, color: colors.textPrimary },
  doneText: { fontFamily: fonts.regular, fontSize: 13.5, color: colors.textSecondary, textAlign: 'center', lineHeight: 20, paddingHorizontal: 10 },
  doneBtn: { backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 12, paddingHorizontal: 30, marginTop: 14 },
  doneBtnText: { fontFamily: fonts.bold, fontSize: 14, color: '#fff' },
}));
