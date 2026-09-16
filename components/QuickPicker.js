import { useEffect, useState } from 'react';
import { Modal, View, Text, TextInput, ScrollView, Pressable } from 'react-native';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { useI18n, createStyles } from '../lib/i18n';

export default function QuickPicker({
  visible, title, subtitle, options, value, multiple = true, showAll = false, allLabel, onChange, onClose,
  footer = null, doneLabel, onReset, searchable = false,
}) {
  const { t } = useI18n();
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
    ? options.filter((o) => o.label.toLowerCase().includes(search.trim().toLowerCase()))
    : options;

  // כשלאופציות יש emoji (כרגע: CATEGORY_OPTIONS/CATEGORY_FILTER_OPTIONS, constants/filterSchema.js) -
  // רשת דו-טורית מסודרת עם אייקון+טקסט בכל שורה, במקום ה-pills-ברוחב-משתנה שהיו נדחסות אחת
  // ליד השנייה (בקשת המשתמש: "מסודרות עם אייקונים קטנים... בצורה נעימה וברורה לעין"). אופציות
  // בלי emoji (מחיר/עיר/הזמנה/משך וכו') ממשיכות בדיוק כמו קודם - אין שינוי חזותי אצלן.
  const hasIcons = options.some((o) => o.emoji);

  const gridContent = (
    <View>
      {showAll && (
        <Pressable
          onPress={() => onChange([])}
          style={[hasIcons ? styles.allChipWide : styles.allChipCentered, isAllSelected && styles.chipSelected]}
        >
          <Text style={[styles.chipText, isAllSelected && styles.chipTextSelected]}>{allLabel ?? t('common.actions.all')}</Text>
        </Pressable>
      )}
      <View style={hasIcons ? styles.iconGrid : styles.grid}>
        {visibleOptions.map((opt) => {
          const selected = value.includes(opt.id);
          return (
            <Pressable
              key={opt.id}
              onPress={() => toggle(opt.id)}
              style={[hasIcons ? styles.iconRow : styles.chip, selected && styles.chipSelected]}
            >
              {opt.emoji ? <Text style={styles.iconRowEmoji}>{opt.emoji}</Text> : null}
              <Text
                style={[hasIcons ? styles.iconRowText : styles.chipText, selected && styles.chipTextSelected]}
                numberOfLines={2}
              >
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
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
              placeholder={t('filters.quickPicker.searchPlaceholder')}
              placeholderTextColor={colors.textMuted}
            />
          )}
          <ScrollView style={styles.scrollArea} showsVerticalScrollIndicator={false}>
            {gridContent}
            {footer}
          </ScrollView>
          {multiple && (
            <Pressable style={styles.doneBtn} onPress={onClose}>
              <Text style={styles.doneBtnText}>{doneLabel ?? t('common.actions.done')}</Text>
            </Pressable>
          )}
          {onReset && (
            <Pressable style={styles.resetBtn} onPress={onReset}>
              <Text style={styles.resetBtnText}>{t('common.actions.reset')}</Text>
            </Pressable>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = createStyles((d) => ({
  backdrop: { flex: 1, backgroundColor: 'rgba(20,30,35,0.4)', justifyContent: 'center', padding: spacing.xl },
  card: { backgroundColor: colors.card, borderRadius: radii.xl, padding: spacing.xl, maxHeight: '80%' },
  title: { fontFamily: fonts.extraBold, fontSize: 17, color: colors.textPrimary, textAlign: 'center' },
  subtitle: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: 'center', marginTop: 4, marginBottom: 16 },
  searchInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 10, marginBottom: 4,
    fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, backgroundColor: colors.bg,
    textAlign: d.textAlign, writingDirection: d.writingDirection,
  },
  scrollArea: { maxHeight: 360 },
  grid: { flexDirection: d.row, flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginTop: 12 },
  chip: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, borderRadius: radii.pill, paddingVertical: 9, paddingHorizontal: 14 },
  allChipCentered: {
    alignSelf: 'center', marginTop: 12, marginBottom: 4,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, borderRadius: radii.pill,
    paddingVertical: 9, paddingHorizontal: 14,
  },
  // "הכל" ברשת-אייקונים - שורה רחבה ונפרדת מעל הרשת (לא עוד תא ברשת דו-טורית), כדי שתישאר
  // ברורה כפעולת-איפוס נבדלת, לא כקטגוריה נוספת בין השאר.
  allChipWide: {
    alignItems: 'center', marginBottom: 10,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, borderRadius: radii.md,
    paddingVertical: 11,
  },
  chipSelected: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  chipText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary },
  // רשת דו-טורית לאופציות-עם-אייקון (קטגוריות) - שורות קבועות-רוחב (48%) במקום pills
  // ברוחב-משתנה, כדי שהעין תסרוק בקלות עמודה-עמודה במקום צפיפות לא-אחידה.
  iconGrid: { flexDirection: d.row, flexWrap: 'wrap', gap: 10, justifyContent: 'space-between' },
  iconRow: {
    width: '47%', flexDirection: d.row, alignItems: 'center', gap: 8,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, borderRadius: radii.md,
    paddingVertical: 11, paddingHorizontal: 10, marginBottom: 2,
  },
  iconRowEmoji: { fontSize: 18, width: 22, textAlign: 'center' },
  iconRowText: { flex: 1, fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary, textAlign: d.textAlign },
  chipTextSelected: { color: colors.accent, fontFamily: fonts.bold },
  doneBtn: { marginTop: 18, backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 13, alignItems: 'center' },
  doneBtnText: { fontFamily: fonts.bold, fontSize: 14, color: '#fff' },
  resetBtn: { marginTop: 12, alignItems: 'center' },
  resetBtnText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.danger },
}));
