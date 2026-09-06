import { View, Text, StyleSheet } from 'react-native';
import Header from './Header';
import { colors, fonts, spacing } from '../constants/theme';

export default function PlaceholderScreen({ title }) {
  return (
    <View style={styles.screen}>
      <View style={styles.content}>
        <Header showBack onMenuPress={() => {}} />
        <View style={styles.center}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.note}>המסך הזה עוד ייבנה 🦘</Text>
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
