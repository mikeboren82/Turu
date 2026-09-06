import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import Header from '../components/Header';
import { colors, fonts, radii, spacing } from '../constants/theme';

const PARAGRAPHS = [
  'שלום!',
  'אנחנו אבישי ונאיה, שמחים שבחרתם להשתמש באפליקציה שלנו!',
  'את הרעיון לאפליקציה יצרנו מתוך צורך אמיתי שלנו. בכל פעם שרצינו למצוא פעילות, גילינו כמה זה יכול להיות מסורבל — צריך לעבור בין המון אתרים, קבוצות, עמודים וחיפושים שונים, ולא פעם פשוט לוותר כי אין זמן לחפש.',
  'חשבנו לעצמנו: למה שלא יהיה מקום אחד שבו אפשר למצוא את כל הפעילויות לילדים באזור שלנו, במהירות ובקלות?',
  'וכך נולדה האפליקציה שלנו.',
  'המטרה שלנו פשוטה — לחסוך לכם זמן, חיפושים וכאב ראש, ולעזור לכם למצוא בקלות את הפעילות שמתאימה בדיוק לכם ולילדים שלכם.',
  'אנחנו עדיין בתחילת הדרך, וכל הזמן עובדים, משפרים ומוסיפים דברים חדשים כדי להפוך את האפליקציה לטובה, שימושית ונוחה יותר.',
  'מקווים שהצלחנו לעזור לכם למצוא משהו כיפי לעשות! 😊',
  'אם אתם נהנים מהאפליקציה, נשמח מאוד שתשתפו אותה עם חברים, משפחה והורים נוספים.',
  'ואם יש לכם הערה, רעיון, הצעה או אפילו ביקורת — אנחנו תמיד רוצים לשמוע. דווקא המשוב שלכם הוא מה שיעזור לנו להשתפר.',
  'תודה שאתם כאן ❤️',
];

export default function AboutScreen() {
  const router = useRouter();
  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Header showBack onMenuPress={() => {}} />

        <Text style={styles.pageTitle}>עלינו 🦘</Text>

        {PARAGRAPHS.map((p, i) => (
          <Text key={i} style={styles.paragraph}>{p}</Text>
        ))}

        <Text style={styles.signature}>אבישי ונאיה</Text>

        <Pressable style={styles.contactBtn} onPress={() => router.push('/contact')}>
          <Text style={styles.contactBtnText}>צרו קשר</Text>
        </Pressable>

        <View style={styles.legalFooter}>
          <Pressable onPress={() => router.push('/terms')}>
            <Text style={styles.legalFooterLink}>תנאי שימוש</Text>
          </Pressable>
          <Text style={styles.legalFooterDot}>·</Text>
          <Pressable onPress={() => router.push('/privacy')}>
            <Text style={styles.legalFooterLink}>מדיניות פרטיות</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, paddingBottom: 50 },
  pageTitle: { fontFamily: fonts.extraBold, fontSize: 22, color: colors.textPrimary, textAlign: 'right', marginTop: 24, marginBottom: 18 },
  paragraph: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 23, color: colors.textSecondary, textAlign: 'right', marginBottom: 14 },
  signature: { fontFamily: fonts.bold, fontSize: 15, color: colors.textPrimary, textAlign: 'right', marginTop: 6, marginBottom: 22 },
  contactBtn: {
    backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 14, alignItems: 'center',
  },
  contactBtnText: { fontFamily: fonts.bold, fontSize: 15, color: '#fff' },
  legalFooter: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 22 },
  legalFooterLink: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, textDecorationLine: 'underline' },
  legalFooterDot: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted },
});
