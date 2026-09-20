import { Modal, View, Text, Pressable } from 'react-native';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { useI18n, createStyles, SUPPORTED_LOCALES, LOCALES } from '../lib/i18n';

// בורר-שפה - Modal קטן, אותו recipe בדיוק (transparent+slide+backdrop, שורת-פילים לבחירה
// יחידה שסוגרת מייד) כמו "תצוגה/מיון" ב-app/activities.js (displaySheetOption) - לא שפת-עיצוב
// חדשה. בחירה = פעולה שלמה (setLocale כותב למקור-האמת היחיד ב-lib/i18n, ראו setLocale שם
// למנגנון ה-persist/RTL-LTR הקיים) - בלי כפתור "שמירה" נפרד.
export default function LanguageSheet({ visible, onClose }) {
  const { t, locale, setLocale } = useI18n();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.container} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handleRow}>
            <Pressable style={styles.closeBtn} onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.actions.close')}>
              <Text style={styles.closeBtnText}>✕</Text>
            </Pressable>
          </View>
          <Text style={styles.title}>{t('common.language.label')}</Text>
          <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel={t('common.language.label')}>
            {SUPPORTED_LOCALES.map((code) => {
              const selected = code === locale;
              return (
                <Pressable
                  key={code}
                  style={[styles.option, selected && styles.optionSelected]}
                  onPress={() => { setLocale(code); onClose(); }}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  accessibilityLabel={selected
                    ? t('common.language.current', { language: LOCALES[code].nativeName })
                    : t('common.language.switchTo', { language: LOCALES[code].nativeName })}
                >
                  <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{LOCALES[code].nativeName}</Text>
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = createStyles((d) => ({
  backdrop: { flex: 1, backgroundColor: 'rgba(20,30,35,0.5)', justifyContent: 'flex-end' },
  container: {
    backgroundColor: colors.bg, borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    paddingHorizontal: spacing.xl, paddingTop: 10, paddingBottom: 30,
  },
  handleRow: { flexDirection: 'row', justifyContent: d.alignStart, marginBottom: 4 },
  closeBtn: {
    width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
  },
  closeBtnText: { fontFamily: fonts.bold, fontSize: 14, color: colors.textSecondary },
  title: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.textPrimary, textAlign: d.textAlign, marginBottom: 8, marginTop: 12 },
  row: { flexDirection: d.row, gap: 8 },
  option: {
    flex: 1, alignItems: 'center', backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.pill, paddingVertical: 12,
  },
  optionSelected: { backgroundColor: colors.accentTintLight, borderColor: colors.accent },
  optionText: { fontFamily: fonts.semiBold, fontSize: 14, color: colors.textSecondary },
  optionTextSelected: { color: colors.accent, fontFamily: fonts.bold },
}));
