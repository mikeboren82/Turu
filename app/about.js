import { View, Text, ScrollView, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import Header from '../components/Header';
import SkyBackground from '../components/SkyBackground';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { useI18n, createStyles } from '../lib/i18n';

// הפסקאות נמצאות ב-lib/i18n/locales/<locale>/pages.json (pages.about.paragraphs.*), לפי הסדר הזה.
const PARAGRAPH_KEYS = ['hello', 'origin', 'question', 'born', 'goal', 'journey', 'hope', 'share', 'feedback', 'thanks'];

export default function AboutScreen() {
  const router = useRouter();
  const { t } = useI18n();
  return (
    <View style={styles.screen}>
      <SkyBackground />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Header showBack onMenuPress={() => {}} />

        <Text style={styles.pageTitle}>{t('pages.about.title')}</Text>

        {PARAGRAPH_KEYS.map((key) => (
          <Text key={key} style={styles.paragraph}>{t(`pages.about.paragraphs.${key}`)}</Text>
        ))}

        <View style={styles.verseCard}>
          <Text style={styles.verse}>
            <Text style={styles.verseMark}>{t('pages.about.verseQuoteOpen')}</Text>
            {t('pages.about.verse')}
            <Text style={styles.verseMark}>{t('pages.about.verseQuoteClose')}</Text>
          </Text>
        </View>

        <Pressable style={styles.contactBtn} onPress={() => router.push('/contact')}>
          <Text style={styles.contactBtnText}>{t('pages.about.contact')}</Text>
        </Pressable>

        <View style={styles.legalFooter}>
          <Pressable onPress={() => router.push('/terms')}>
            <Text style={styles.legalFooterLink}>{t('pages.about.terms')}</Text>
          </Pressable>
          <Text style={styles.legalFooterDot}>·</Text>
          <Pressable onPress={() => router.push('/privacy')}>
            <Text style={styles.legalFooterLink}>{t('pages.about.privacy')}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = createStyles((d) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, paddingBottom: 50 },
  pageTitle: { fontFamily: fonts.extraBold, fontSize: 22, color: colors.textPrimary, textAlign: d.textAlign, marginTop: 24, marginBottom: 18 },
  paragraph: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 23, color: colors.textSecondary, textAlign: d.textAlign, marginBottom: 14 },
  verseCard: {
    marginTop: 6, marginBottom: 22, paddingVertical: 12, paddingHorizontal: 18,
    backgroundColor: colors.accentTintLight, borderRadius: radii.lg,
  },
  verse: {
    fontFamily: fonts.verseBold, fontSize: 14, color: colors.ink, textAlign: 'center',
    letterSpacing: 0.2, lineHeight: 21,
  },
  verseMark: { fontFamily: fonts.verseBold, fontSize: 14, color: colors.accent },
  contactBtn: {
    backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 14, alignItems: 'center',
  },
  contactBtnText: { fontFamily: fonts.bold, fontSize: 15, color: '#fff' },
  legalFooter: { flexDirection: d.row, alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 22 },
  legalFooterLink: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, textDecorationLine: 'underline' },
  legalFooterDot: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted },
}));
