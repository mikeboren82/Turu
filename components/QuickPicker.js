import { useEffect, useState } from 'react';
import { Modal, View, Text, TextInput, ScrollView, Pressable, StyleSheet } from 'react-native';
import { colors, fonts, radii, spacing } from '../constants/theme';

export default function QuickPicker({
  visible, title, subtitle, options, value, multiple = true, showAll = false, allLabel = 'הכל', onChange, onClose,
  footer = null, doneLabel = 'סיום', onReset, searchable = false,
}) {
  const [search, setSearch] = useState('');

  // מאפס את החיפוש בכל פתיחה מחדש - לא נשאר טקסט-חיפוש ישן מהפעם הקודמת (רלוונטי רק
  // כש-searchable, לרשימות ארוכות כמו ISRAELI_CITIES שאי אפשר להציג את כולן כגריד שטוח).
  useEffect(() => {
    if (visible) setSearch('');
  }, [visible]);

  const toggle = (id) => {
    if (multiple) {
      onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
    } else {
      onChange(value.includes(id) ? [] : [id]);
      if (!value.includes(id)) onClose();
    }
  };

  const isAllSelected = value.length === 0;
  const visibleOptions = searchable && search.trim()
    ? options.filter((o) => o.label.includes(search.trim()))
    : options;

  const gridContent = (
    <View style={styles.grid}>
      {showAll && (
        <Pressable onPress={() => onChange([])} style={[styles.chip, isAllSelected && styles.chipSelected]}>
          <Text style={[styles.chipText, isAllSelected && styles.chipTextSelected]}>{allLabel}</Text>
        </Pressable>
      )}
      {visibleOptions.map((opt) => {
        const selected = value.includes(opt.id);
        return (
          <Pressable key={opt.id} onPress={() => toggle(opt.id)} style={[styles.chip, selected && styles.chipSelected]}>
            <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{opt.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          {searchable && (
            <TextInput
              style={styles.searchInput}
              value={search}
              onChangeText={setSearch}
              placeholder="🔍 חיפוש..."
              placeholderTextColor={colors.textMuted}
            />
          )}
          <ScrollView style={styles.scrollArea} showsVerticalScrollIndicator={false}>
            {gridContent}
            {footer}
          </ScrollView>
          {multiple && (
            <Pressable style={styles.doneBtn} onPress={onClose}>
              <Text style={styles.doneBtnText}>{doneLabel}</Text>
            </Pressable>
          )}
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
  card: { backgroundColor: colors.card, borderRadius: radii.xl, padding: spacing.xl, maxHeight: '80%' },
  title: { fontFamily: fonts.extraBold, fontSize: 17, color: colors.textPrimary, textAlign: 'center' },
  subtitle: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: 'center', marginTop: 4, marginBottom: 16 },
  searchInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 10, marginBottom: 4,
    fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, backgroundColor: colors.bg,
    textAlign: 'right', writingDirection: 'rtl',
  },
  scrollArea: { maxHeight: 320 },
  grid: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginTop: 12 },
  chip: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, borderRadius: radii.pill, paddingVertical: 9, paddingHorizontal: 14 },
  chipSelected: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  chipText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary },
  chipTextSelected: { color: colors.accent, fontFamily: fonts.bold },
  doneBtn: { marginTop: 18, backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 13, alignItems: 'center' },
  doneBtnText: { fontFamily: fonts.bold, fontSize: 14, color: '#fff' },
  resetBtn: { marginTop: 12, alignItems: 'center' },
  resetBtnText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.danger },
});
