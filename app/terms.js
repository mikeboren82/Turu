import { View, Text, ScrollView } from 'react-native';
import Header from '../components/Header';
import SkyBackground from '../components/SkyBackground';
import { colors, fonts, spacing } from '../constants/theme';
import { LEGAL_LAST_UPDATED, LEGAL_CONTACT_EMAIL, legalEntityName } from '../constants/legal';
import { useI18n, createStyles } from '../lib/i18n';

// Document structure only (language-independent). Text lives in locales/<locale>/legal.json under
// legal.terms.*: intro.p1..pN, s<N>.title + s<N>.p1..pN. Numbers = paragraph count per section.
const INTRO_COUNT = 3;
const SECTION_PARAGRAPHS = [2, 3, 3, 3, 4, 3, 7, 3, 2, 3, 2, 2, 3];
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

export default function TermsScreen() {
  const { t } = useI18n();
  const params = { email: LEGAL_CONTACT_EMAIL, name: legalEntityName(), date: LEGAL_LAST_UPDATED };
  const bindingNotice = t('legal.terms.bindingNotice');

  return (
    <View style={styles.screen}>
      <SkyBackground />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Header showBack onMenuPress={() => {}} />

        <Text style={styles.pageTitle}>{t('legal.terms.title')}</Text>
        <Text style={styles.updated}>{t('legal.terms.updated', params)}</Text>

        {bindingNotice ? <Text style={styles.bindingNotice}>{bindingNotice}</Text> : null}

        {range(INTRO_COUNT).map((i) => (
          <Text key={`intro-${i}`} style={styles.paragraph}>{t(`legal.terms.intro.p${i}`, params)}</Text>
        ))}

        {SECTION_PARAGRAPHS.map((count, s) => (
          <View key={`s${s + 1}`} style={styles.section}>
            <Text style={styles.sectionTitle}>{t(`legal.terms.s${s + 1}.title`)}</Text>
            {range(count).map((i) => (
              <Text key={i} style={styles.paragraph}>{t(`legal.terms.s${s + 1}.p${i}`, params)}</Text>
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = createStyles((d) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, paddingBottom: 50 },
  pageTitle: { fontFamily: fonts.extraBold, fontSize: 22, color: colors.textPrimary, textAlign: d.textAlign, marginTop: 24, marginBottom: 4 },
  updated: { fontFamily: fonts.regular, fontSize: 12, color: colors.textMuted, textAlign: d.textAlign, marginBottom: 22 },
  bindingNotice: { fontFamily: fonts.bold, fontSize: 13, lineHeight: 20, color: colors.textSecondary, textAlign: d.textAlign, marginTop: -10, marginBottom: 18 },
  section: { marginBottom: 20 },
  sectionTitle: { fontFamily: fonts.bold, fontSize: 15.5, color: colors.textPrimary, textAlign: d.textAlign, marginBottom: 8 },
  paragraph: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 22, color: colors.textSecondary, textAlign: d.textAlign, marginBottom: 8 },
}));
