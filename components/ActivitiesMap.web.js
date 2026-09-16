import { View, Text } from 'react-native';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { useI18n, createStyles } from '../lib/i18n';

export default function ActivitiesMap({ activities }) {
  const { t } = useI18n();
  const count = activities.filter((a) => a.lat != null && a.lng != null).length;
  return (
    <View style={styles.wrap}>
      <Text style={styles.emoji}>🗺️</Text>
      <Text style={styles.title}>{t('activities.map.webOnlyTitle')}</Text>
      <Text style={styles.subtitle}>
        {count > 0 ? t('activities.map.webLocatedCount', { count }) : t('activities.map.noKnownLocation')}
      </Text>
    </View>
  );
}

const styles = createStyles(() => ({
  wrap: {
    height: 480, borderRadius: radii.lg, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center', padding: spacing.xl,
  },
  emoji: { fontSize: 40, marginBottom: 10 },
  title: { fontFamily: fonts.extraBold, fontSize: 15, color: colors.textPrimary, textAlign: 'center', marginBottom: 6 },
  subtitle: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: 'center' },
}));
