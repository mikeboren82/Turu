import { useState } from 'react';
import { Modal, View, Text, Pressable } from 'react-native';
import { AGE_OPTIONS } from '../constants/filterSchema';
import { listJoin } from '../lib/filterSummaries';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { t, useI18n, createStyles } from '../lib/i18n';

export function ageSummary(selectedIds) {
  if (!selectedIds || selectedIds.length === 0) return t('common.actions.all');
  const labels = selectedIds.map((id) => AGE_OPTIONS.find((o) => o.id === id)?.label ?? id);
  if (labels.length <= 3) return listJoin(labels);
  return t('filters.age.rangesCount', { count: labels.length });
}

export default function AgeQuickPicker({ visible, value, onChange, onClose }) {
  const { t } = useI18n();
  const toggle = (id) => {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  };

  const isAllSelected = value.length === 0;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>{t('filters.age.title')}</Text>
          <Text style={styles.subtitle}>{t('filters.age.subtitle')}</Text>
          <View style={styles.grid}>
            <Pressable onPress={() => onChange([])} style={[styles.chip, isAllSelected && styles.chipSelected]}>
              <Text style={[styles.chipText, isAllSelected && styles.chipTextSelected]}>{t('common.actions.all')}</Text>
            </Pressable>
            {AGE_OPTIONS.map((opt) => {
              const selected = value.includes(opt.id);
              return (
                <Pressable key={opt.id} onPress={() => toggle(opt.id)} style={[styles.chip, selected && styles.chipSelected]}>
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{opt.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <Pressable style={styles.doneBtn} onPress={onClose}>
            <Text style={styles.doneBtnText}>{t('common.actions.done')}</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = createStyles((d) => ({
  backdrop: { flex: 1, backgroundColor: 'rgba(20,30,35,0.4)', justifyContent: 'center', padding: spacing.xl },
  card: { backgroundColor: colors.card, borderRadius: radii.xl, padding: spacing.xl },
  title: { fontFamily: fonts.extraBold, fontSize: 17, color: colors.textPrimary, textAlign: 'center' },
  subtitle: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: 'center', marginTop: 4, marginBottom: 16 },
  grid: { flexDirection: d.row, flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  chip: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, borderRadius: radii.pill, paddingVertical: 9, paddingHorizontal: 14 },
  chipSelected: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  chipText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary },
  chipTextSelected: { color: colors.accent, fontFamily: fonts.bold },
  doneBtn: { marginTop: 18, backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 13, alignItems: 'center' },
  doneBtnText: { fontFamily: fonts.bold, fontSize: 14, color: '#fff' },
}));
