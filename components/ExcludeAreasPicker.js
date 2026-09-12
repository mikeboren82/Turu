import { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, TextInput, ScrollView, Pressable, StyleSheet } from 'react-native';
import { REGION_OPTIONS } from '../constants/filterSchema';
import { ISRAELI_CITIES } from '../constants/israeliCities';
import { colors, fonts, radii, spacing } from '../constants/theme';

const MAX_SUGGESTIONS = 8;

function regionLabel(id) {
  return REGION_OPTIONS.find((r) => r.id === id)?.label || id;
}

// "⛔ לאן לא תרצו להגיע?" - מחליף את ה-QuickPicker הישן (options=CITY_OPTIONS, ענן-צ'יפים של
// כל היישובים) בזרימה דו-שלבית: קודם אזורים רחבים (REGION_OPTIONS, כבר קיים כ-source-of-truth -
// ראו constants/filterSchema.js/supabase/0007_update_regions.sql), ורק מי שרוצה מדויק יותר מחפש
// יישוב ספציפי. value/onChange הם { regions: string[], cities: string[] } - אותו דפוס
// value/onChange כמו QuickPicker, רק דו-ממדי. הסינון בפועל (lib/filterActivities.js) משתמש
// באזורים ישירות מול activity.region - אין כאן שום מיפוי עיר→אזור, ולכן אין גם זיהוי-חפיפה
// מדויק בין עיר לאזור (לדוגמה "רמת גן" מול "תל אביב והמרכז") - אין source-of-truth קיים לכך
// בפרויקט (רק REGION_OPTIONS על הפעילות עצמה, לא על שם-עיר), ובכוונה לא הומצא מיפוי חדש.
// כפילות עיר+אזור נשארת פשוט שני צ'יפים בו-זמנית - לא שוברת שום דבר בסינון (שני תנאי OR).
export default function ExcludeAreasPicker({ visible, value, onChange, onClose, onReset, footer, doneLabel = 'החילו סינון' }) {
  const [search, setSearch] = useState('');
  const [focused, setFocused] = useState(false);
  const searchRef = useRef(null);

  useEffect(() => {
    if (visible) setSearch('');
  }, [visible]);

  const regions = value.regions || [];
  const cities = value.cities || [];

  const toggleRegion = (id) => {
    onChange({
      ...value,
      regions: regions.includes(id) ? regions.filter((r) => r !== id) : [...regions, id],
    });
  };

  const removeRegion = (id) => onChange({ ...value, regions: regions.filter((r) => r !== id) });
  const removeCity = (city) => onChange({ ...value, cities: cities.filter((c) => c !== city) });

  const addCity = (city) => {
    if (!cities.includes(city)) onChange({ ...value, cities: [...cities, city] });
    setSearch('');
    searchRef.current?.focus();
  };

  const query = search.trim();
  const suggestions = query
    ? ISRAELI_CITIES.filter((c) => c.includes(query) && !cities.includes(c)).slice(0, MAX_SUGGESTIONS)
    : [];
  const showDropdown = focused && suggestions.length > 0;

  const totalCount = regions.length + cities.length;
  const hasSelections = totalCount > 0;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>⛔ הסר אזורים מהחיפוש</Text>
          <Text style={styles.subtitle}>בחרו אזורים או מקומות שלא תרצו לראות בתוצאות</Text>

          <ScrollView style={styles.scrollArea} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <Text style={styles.sectionLabel}>אזורים</Text>
            <View style={styles.regionGrid}>
              {REGION_OPTIONS.map((r) => {
                const selected = regions.includes(r.id);
                return (
                  <Pressable
                    key={r.id}
                    onPress={() => toggleRegion(r.id)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    style={[styles.regionChip, selected && styles.chipSelected]}
                  >
                    <Text style={[styles.regionChipText, selected && styles.chipTextSelected]} numberOfLines={1}>
                      {r.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={styles.sectionLabel}>רוצים להיות יותר מדויקים?</Text>
            <View style={styles.searchWrap}>
              <TextInput
                ref={searchRef}
                style={styles.searchInput}
                value={search}
                onChangeText={setSearch}
                onFocus={() => setFocused(true)}
                onBlur={() => setTimeout(() => setFocused(false), 150)}
                placeholder="🔍 חפשו עיר או יישוב להחרגה..."
                placeholderTextColor={colors.textMuted}
              />
              {showDropdown && (
                <View style={styles.dropdown}>
                  {suggestions.map((city) => (
                    <Pressable
                      key={city}
                      style={styles.dropdownItem}
                      accessibilityRole="button"
                      onPress={() => addCity(city)}
                    >
                      <Text style={styles.dropdownItemText}>{city}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>

            {hasSelections && (
              <View style={styles.summarySection}>
                <Text style={styles.sectionLabel}>לא נציג פעילויות ב:</Text>
                <View style={styles.summaryGrid}>
                  {regions.map((id) => (
                    <View key={`r-${id}`} style={styles.summaryChip}>
                      <Text style={styles.summaryChipText} numberOfLines={1}>{regionLabel(id)}</Text>
                      <Pressable
                        onPress={() => removeRegion(id)}
                        accessibilityRole="button"
                        accessibilityLabel={`הסרת החרגה ל${regionLabel(id)}`}
                        hitSlop={8}
                      >
                        <Text style={styles.summaryChipRemove}>×</Text>
                      </Pressable>
                    </View>
                  ))}
                  {cities.map((city) => (
                    <View key={`c-${city}`} style={styles.summaryChip}>
                      <Text style={styles.summaryChipText} numberOfLines={1}>{city}</Text>
                      <Pressable
                        onPress={() => removeCity(city)}
                        accessibilityRole="button"
                        accessibilityLabel={`הסרת החרגה ל${city}`}
                        hitSlop={8}
                      >
                        <Text style={styles.summaryChipRemove}>×</Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {footer}
          </ScrollView>

          <Pressable style={styles.doneBtn} onPress={onClose}>
            <Text style={styles.doneBtnText}>{hasSelections ? `${doneLabel} · ${totalCount} החרגות` : doneLabel}</Text>
          </Pressable>
          {onReset && (
            <Pressable style={styles.resetBtn} onPress={onReset}>
              <Text style={styles.resetBtnText}>איפוס</Text>
            </Pressable>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(20,30,35,0.4)', justifyContent: 'center', padding: spacing.xl },
  card: { backgroundColor: colors.card, borderRadius: radii.xl, padding: spacing.xl, maxHeight: '85%' },
  title: { fontFamily: fonts.extraBold, fontSize: 17, color: colors.textPrimary, textAlign: 'center' },
  subtitle: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: 'center', marginTop: 4, marginBottom: 16 },
  scrollArea: { maxHeight: 420 },
  sectionLabel: { fontFamily: fonts.bold, fontSize: 13, color: colors.textSecondary, textAlign: 'right', marginBottom: 8, marginTop: 4 },
  regionGrid: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 8, marginBottom: 18 },
  regionChip: {
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, borderRadius: radii.pill,
    paddingVertical: 10, paddingHorizontal: 14,
  },
  regionChipText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary },
  chipSelected: { borderColor: colors.danger, backgroundColor: '#fbe4e3' },
  chipTextSelected: { color: colors.danger, fontFamily: fonts.bold },
  searchWrap: { position: 'relative', zIndex: 20, marginBottom: 4 },
  searchInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 10,
    fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, backgroundColor: colors.bg,
    textAlign: 'right', writingDirection: 'rtl',
  },
  dropdown: {
    position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4,
    backgroundColor: colors.card, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    shadowColor: '#000', shadowOpacity: 0.12, shadowOffset: { width: 0, height: 4 }, shadowRadius: 10,
    elevation: 6, overflow: 'hidden', zIndex: 20,
  },
  dropdownItem: { paddingVertical: 10, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
  dropdownItemText: { fontFamily: fonts.regular, fontSize: 13.5, color: colors.textPrimary, textAlign: 'right' },
  summarySection: { marginTop: 16 },
  summaryGrid: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 8 },
  summaryChip: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 6,
    borderWidth: 1, borderColor: colors.danger, backgroundColor: '#fbe4e3', borderRadius: radii.pill,
    paddingVertical: 8, paddingHorizontal: 12,
  },
  summaryChipText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.danger, maxWidth: 140 },
  summaryChipRemove: { fontFamily: fonts.bold, fontSize: 15, color: colors.danger, lineHeight: 16 },
  doneBtn: { marginTop: 18, backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 13, alignItems: 'center' },
  doneBtnText: { fontFamily: fonts.bold, fontSize: 14, color: '#fff' },
  resetBtn: { marginTop: 12, alignItems: 'center' },
  resetBtnText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.danger },
});
