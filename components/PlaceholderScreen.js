import { View, Text, StyleSheet } from 'react-native';
import Header from './Header';
import SkyBackground from './SkyBackground';
import { colors, fonts, spacing } from '../constants/theme';
import { useI18n } from '../lib/i18n';

export default function PlaceholderScreen({ title }) {
  const { t } = useI18n();
  return (
    <View style={styles.screen}>
      <SkyBackground />
      <View style={styles.content}>
        <Header showBack onMenuPress={() => {}} />
        <View style={styles.center}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.note}>{t('nav.placeholder.comingSoon')}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1, padding: spacing.xl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  title: { fontFamily: fonts.extraBold, fontSize: 19, color: colors.ink },
  note: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary },
});
