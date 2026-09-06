import { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, TextInput, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import Header from '../components/Header';
import LoginRequiredModal from '../components/LoginRequiredModal';
import QuickPicker from '../components/QuickPicker';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { CATEGORY_OPTIONS } from '../constants/filterSchema';
import { supabase } from '../lib/supabase';
import { submitUserActivity, extractActivityFromUrl } from '../lib/submitActivity';

const ENTITY_TYPE_OPTIONS = [
  { id: 'מקום_קבוע', label: 'מקום קבוע (שעות פתיחה)' },
  { id: 'פעילות', label: 'חוג / פעילות חוזרת' },
  { id: 'אירוע_קבוע', label: 'אירוע חוזר' },
  { id: 'אירוע', label: 'אירוע חד פעמי' },
];

const EMPTY_FORM = {
  name: '', entity_types: ['מקום_קבוע'], categories: [], city: '', location_name: '',
  description: '', min_age: '', max_age: '', price_type: null, price_amount: '',
  start_time: '', end_time: '', image_urls: [],
};

export default function AddActivityScreen() {
  const router = useRouter();
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
        setLocateCityError('צריך לאשר גישה למיקום כדי למלא את העיר אוטומטית');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({});
      const [place] = await Location.reverseGeocodeAsync({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      });
      const city = place?.city || place?.subregion || place?.region;
      if (!city) {
        setLocateCityError('לא הצלחנו לזהות את העיר - אפשר למלא ידנית');
        return;
      }
      setField('city', city);
    } catch {
      setLocateCityError('משהו השתבש באיתור המיקום - אפשר למלא ידנית');
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
        setExtractError('לא הצלחנו לזהות פעילות בעמוד הזה - אפשר לנסות למלא ידנית');
        return;
      }
      if (result.activities.length === 1) {
        loadIntoForm(result.activities[0]);
      } else {
        setCandidates(result.activities);
      }
    } catch (err) {
      setExtractError(err.message || 'שגיאה בשליפת המידע');
    } finally {
      setExtracting(false);
    }
  };

  const loadIntoForm = (activity) => {
    setForm({
      name: activity.name || '',
      entity_types: activity.entity_type ? [activity.entity_type] : ['מקום_קבוע'],
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
      setSubmitError('צריך למלא שם, קטגוריה, סוג ועיר לפחות');
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
      setSubmitError(err.message || 'שגיאה בשמירה');
    } finally {
      setSubmitting(false);
    }
  };

  if (submitResult) {
    return (
      <View style={styles.screen}>
        <View style={styles.content}>
          <Header showBack onMenuPress={() => {}} />
          <View style={styles.doneWrap}>
            <Text style={styles.doneEmoji}>🎉</Text>
            <Text style={styles.doneTitle}>תודה שהוספתם!</Text>
            <Text style={styles.doneText}>
              {submitResult.count > 1
                ? `נוספו ${submitResult.count} רשומות (אחת לכל שילוב של קטגוריה+סוג שבחרתם)` +
                  (submitResult.archivedCount > 0
                    ? `. ${submitResult.archivedCount} מתוכן נשמרו בארכיון - סוג פעילות שהאפליקציה כרגע לא מציגה (חוג/קייטנה שדורש הרשמה קבועה). השאר נשלחו לצוות TuRu לבדיקה, ויופיעו באפליקציה לאחר אישור`
                    : '. כולן נשלחו לצוות TuRu לבדיקה, ותופענה באפליקציה לאחר אישור')
                : submitResult.archivedCount > 0
                  ? 'הפעילות נשמרה - זה סוג פעילות שהאפליקציה כרגע לא מציגה (חוג/קייטנה שדורש הרשמה קבועה)'
                  : 'הפעילות נשלחה לצוות TuRu לבדיקה, ותופיע באפליקציה לאחר אישור'}
            </Text>
            <Pressable style={styles.doneBtn} onPress={() => router.back()}>
              <Text style={styles.doneBtnText}>חזרה</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Header showBack onMenuPress={() => {}} />
        <Text style={styles.pageTitle}>הוספת פעילות</Text>

        {mode === null && (
          <View style={styles.choiceWrap}>
            <Text style={styles.choiceIntro}>איך תרצו להוסיף את הפעילות?</Text>
            <Pressable style={styles.choiceCard} onPress={startUrlMode}>
              <Text style={styles.choiceCardTitle}>🔗 יש לי קישור</Text>
              <Text style={styles.choiceCardSub}>נמלא את הפרטים אוטומטית מתוך העמוד, ותוכלו לערוך לפני שליחה</Text>
            </Pressable>
            <Pressable style={styles.choiceCard} onPress={startManualMode}>
              <Text style={styles.choiceCardTitle}>✍️ אמלא ידנית</Text>
              <Text style={styles.choiceCardSub}>רק כמה שדות חובה, השאר לבחירתכם</Text>
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
              {extracting ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>שליפת מידע</Text>}
            </Pressable>
            {extractError ? <Text style={styles.errorText}>{extractError}</Text> : null}
            <Pressable onPress={startManualMode}>
              <Text style={styles.switchModeLink}>לא הצלחתי - אמלא ידנית</Text>
            </Pressable>
          </View>
        )}

        {mode === 'url' && candidates && (
          <View style={styles.urlWrap}>
            <Text style={styles.choiceIntro}>מצאנו כמה אפשרויות בעמוד הזה - איזו מהן?</Text>
            {candidates.map((c, i) => (
              <Pressable key={i} style={styles.candidateCard} onPress={() => loadIntoForm(c)}>
                <Text style={styles.candidateName}>{c.name || 'ללא שם'}</Text>
                {c.description ? <Text style={styles.candidateDesc} numberOfLines={2}>{c.description}</Text> : null}
              </Pressable>
            ))}
          </View>
        )}

        {(mode === 'manual' || mode === 'edit') && (
          <View style={styles.formWrap}>
            {mode === 'edit' && (
              <Text style={styles.editIntro}>בדקו שהכל נכון ותערכו לפי הצורך לפני השליחה</Text>
            )}

            <Text style={styles.fieldLabel}>שם הפעילות *</Text>
            <TextInput style={styles.input} value={form.name} onChangeText={(v) => setField('name', v)} placeholder="לדוגמה: פארק המשחקים בגני יהושע" placeholderTextColor={colors.textMuted} />

            <Text style={styles.fieldLabel}>קטגוריה * (אפשר לבחור כמה)</Text>
            <Pressable style={styles.selectBtn} onPress={() => setCategoryPickerOpen(true)}>
              <Text style={styles.selectBtnText}>{form.categories.length ? form.categories.join(', ') : 'בחירת קטגוריה'}</Text>
            </Pressable>

            <Text style={styles.fieldLabel}>סוג (אפשר לבחור כמה)</Text>
            <View style={styles.chipsRow}>
              {ENTITY_TYPE_OPTIONS.map((opt) => (
                <Pressable key={opt.id} style={[styles.chip, form.entity_types.includes(opt.id) && styles.chipSelected]} onPress={() => toggleEntityType(opt.id)}>
                  <Text style={[styles.chipText, form.entity_types.includes(opt.id) && styles.chipTextSelected]}>{opt.label}</Text>
                </Pressable>
              ))}
            </View>

            <View style={styles.fieldLabelRow}>
              <Text style={styles.fieldLabel}>עיר/יישוב *</Text>
              <Pressable style={styles.autoLocateLink} onPress={handleAutoLocateCity} disabled={locatingCity}>
                {locatingCity ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : (
                  <Text style={styles.autoLocateLinkText}>📍 מצא אוטומטית</Text>
                )}
              </Pressable>
            </View>
            <TextInput style={styles.input} value={form.city} onChangeText={(v) => setField('city', v)} placeholder="לדוגמה: תל אביב" placeholderTextColor={colors.textMuted} />
            {locateCityError ? <Text style={styles.errorText}>{locateCityError}</Text> : null}

            <Text style={styles.fieldLabel}>שם המקום (אופציונלי)</Text>
            <TextInput style={styles.input} value={form.location_name} onChangeText={(v) => setField('location_name', v)} placeholder="לדוגמה: גני יהושע" placeholderTextColor={colors.textMuted} />

            <Text style={styles.fieldLabel}>תיאור (אופציונלי)</Text>
            <TextInput style={[styles.input, styles.textarea]} value={form.description} onChangeText={(v) => setField('description', v)} multiline placeholder="כמה מילים על הפעילות..." placeholderTextColor={colors.textMuted} />

            <View style={styles.rowFields}>
              <View style={styles.rowField}>
                <Text style={styles.fieldLabel}>גיל מ- (אופציונלי)</Text>
                <TextInput style={styles.input} value={form.min_age} onChangeText={(v) => setField('min_age', v.replace(/[^0-9.]/g, ''))} keyboardType="numeric" placeholder="0" placeholderTextColor={colors.textMuted} />
              </View>
              <View style={styles.rowField}>
                <Text style={styles.fieldLabel}>גיל עד (אופציונלי)</Text>
                <TextInput style={styles.input} value={form.max_age} onChangeText={(v) => setField('max_age', v.replace(/[^0-9.]/g, ''))} keyboardType="numeric" placeholder="99" placeholderTextColor={colors.textMuted} />
              </View>
            </View>

            <Text style={styles.fieldLabel}>מחיר (אופציונלי)</Text>
            <View style={styles.chipsRow}>
              <Pressable style={[styles.chip, form.price_type === 'free' && styles.chipSelected]} onPress={() => setField('price_type', form.price_type === 'free' ? null : 'free')}>
                <Text style={[styles.chipText, form.price_type === 'free' && styles.chipTextSelected]}>חינם</Text>
              </Pressable>
              <Pressable style={[styles.chip, form.price_type === 'fixed' && styles.chipSelected]} onPress={() => setField('price_type', 'fixed')}>
                <Text style={[styles.chipText, form.price_type === 'fixed' && styles.chipTextSelected]}>בתשלום</Text>
              </Pressable>
              {form.price_type === 'fixed' && (
                <TextInput style={styles.priceInput} value={form.price_amount} onChangeText={(v) => setField('price_amount', v.replace(/[^0-9.]/g, ''))} keyboardType="numeric" placeholder="₪" placeholderTextColor={colors.textMuted} />
              )}
            </View>

            <View style={styles.rowFields}>
              <View style={styles.rowField}>
                <Text style={styles.fieldLabel}>משעה (אופציונלי)</Text>
                <TextInput style={styles.input} value={form.start_time} onChangeText={(v) => setField('start_time', v)} placeholder="09:00" placeholderTextColor={colors.textMuted} />
              </View>
              <View style={styles.rowField}>
                <Text style={styles.fieldLabel}>עד שעה (אופציונלי)</Text>
                <TextInput style={styles.input} value={form.end_time} onChangeText={(v) => setField('end_time', v)} placeholder="18:00" placeholderTextColor={colors.textMuted} />
              </View>
            </View>

            {form.image_urls.length > 0 && (
              <Text style={styles.hint}>נמצאו {form.image_urls.length} תמונות בעמוד - יישמרו אוטומטית וימתינו לאישור</Text>
            )}

            {submitError ? <Text style={styles.errorText}>{submitError}</Text> : null}

            <Pressable style={styles.primaryBtn} onPress={handleSubmit} disabled={submitting}>
              {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>אישור ושליחה</Text>}
            </Pressable>
          </View>
        )}
      </ScrollView>

      <QuickPicker
        visible={categoryPickerOpen}
        title="קטגוריה"
        subtitle="אפשר לבחור כמה קטגוריות"
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

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, paddingBottom: 60 },
  pageTitle: { fontFamily: fonts.extraBold, fontSize: 20, color: colors.textPrimary, textAlign: 'right', marginTop: 20, marginBottom: 18 },

  choiceWrap: { gap: 12 },
  choiceIntro: { fontFamily: fonts.semiBold, fontSize: 14, color: colors.textSecondary, textAlign: 'right', marginBottom: 4 },
  choiceCard: {
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, padding: 16,
  },
  choiceCardTitle: { fontFamily: fonts.extraBold, fontSize: 15.5, color: colors.textPrimary, textAlign: 'right', marginBottom: 4 },
  choiceCardSub: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: 'right', lineHeight: 18 },

  urlWrap: { gap: 12 },
  urlInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 13,
    fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, textAlign: 'left',
  },
  switchModeLink: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.accent, textAlign: 'center', textDecorationLine: 'underline' },
  candidateCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 13 },
  candidateName: { fontFamily: fonts.bold, fontSize: 14, color: colors.textPrimary, textAlign: 'right' },
  candidateDesc: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: 'right', marginTop: 4 },

  formWrap: { gap: 4 },
  editIntro: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.accent, textAlign: 'right', marginBottom: 10 },
  fieldLabel: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textSecondary, textAlign: 'right', marginTop: 14, marginBottom: 6 },
  fieldLabelRow: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  autoLocateLink: { marginTop: 14, marginBottom: 6, paddingHorizontal: 4, minWidth: 20, alignItems: 'flex-start' },
  autoLocateLinkText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.accent },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12,
    fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, backgroundColor: colors.card,
    textAlign: 'right', writingDirection: 'rtl',
  },
  textarea: { minHeight: 80, textAlignVertical: 'top' },
  selectBtn: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12, backgroundColor: colors.card,
  },
  selectBtnText: { fontFamily: fonts.bold, fontSize: 14, color: colors.textPrimary, textAlign: 'right' },
  chipsRow: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, borderRadius: radii.pill, paddingVertical: 9, paddingHorizontal: 14 },
  chipSelected: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  chipText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textSecondary },
  chipTextSelected: { color: colors.accent, fontFamily: fonts.bold },
  priceInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.pill, paddingVertical: 9, paddingHorizontal: 14,
    fontFamily: fonts.regular, fontSize: 13, color: colors.textPrimary, minWidth: 70, textAlign: 'center', backgroundColor: colors.card,
  },
  rowFields: { flexDirection: 'row-reverse', gap: 12 },
  rowField: { flex: 1 },
  hint: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, textAlign: 'right', marginTop: 14 },
  errorText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.danger, textAlign: 'center', marginTop: 4 },

  primaryBtn: { backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
  primaryBtnText: { fontFamily: fonts.bold, fontSize: 15, color: '#fff' },

  doneWrap: { alignItems: 'center', paddingTop: 60, gap: 10 },
  doneEmoji: { fontSize: 40 },
  doneTitle: { fontFamily: fonts.extraBold, fontSize: 19, color: colors.textPrimary },
  doneText: { fontFamily: fonts.regular, fontSize: 13.5, color: colors.textSecondary, textAlign: 'center', lineHeight: 20, paddingHorizontal: 10 },
  doneBtn: { backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 12, paddingHorizontal: 30, marginTop: 14 },
  doneBtnText: { fontFamily: fonts.bold, fontSize: 14, color: '#fff' },
});
