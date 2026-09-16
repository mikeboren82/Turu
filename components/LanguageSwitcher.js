import { View, Text, Pressable } from 'react-native';
import { useI18n, createStyles, SUPPORTED_LOCALES, LOCALES } from '../lib/i18n';
import { colors, fonts, radii } from '../constants/theme';

// Compact language toggle ("עב | EN"). Text labels only - no flags (language is not nationality).
// Writes the single global locale (lib/i18n setLocale), so every screen switches immediately.
export default function LanguageSwitcher({ style }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <View style={[styles.wrap, style]} accessibilityRole="radiogroup" accessibilityLabel={t('common.language.label')}>
      {SUPPORTED_LOCALES.map((code, i) => {
        const selected = code === locale;
        return (
          <View key={code} style={styles.itemRow}>
            {i > 0 ? <Text style={styles.divider} importantForAccessibility="no" accessibilityElementsHidden>|</Text> : null}
            <Pressable
              onPress={() => setLocale(code)}
              hitSlop={{ top: 12, bottom: 12, left: 6, right: 6 }}
              style={styles.item}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              accessibilityLabel={selected
                ? t('common.language.current', { language: LOCALES[code].nativeName })
                : t('common.language.switchTo', { language: LOCALES[code].nativeName })}
            >
              <Text style={[styles.label, selected && styles.labelSelected]}>{LOCALES[code].shortName}</Text>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

const styles = createStyles((d) => ({
  // Order follows reading direction: Hebrew first on the right in RTL, on the left in LTR.
  wrap: {
    flexDirection: d.row, alignItems: 'center', gap: 2,
    backgroundColor: 'rgba(255,255,255,0.85)', borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.pill, paddingHorizontal: 6, height: 30,
  },
  itemRow: { flexDirection: d.row, alignItems: 'center', gap: 2 },
  item: { paddingHorizontal: 6, paddingVertical: 4, minWidth: 26, alignItems: 'center' },
  divider: { fontFamily: fonts.regular, fontSize: 12, color: colors.textMuted },
  label: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textMuted },
  labelSelected: { fontFamily: fonts.bold, color: colors.accent },
}));
