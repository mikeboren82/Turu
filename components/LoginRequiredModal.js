import { View, Text, Modal, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { useI18n } from '../lib/i18n';

// פופאפ קטן שמוצג כשמשתמש לא-מחובר מנסה לבצע פעולה שדורשת חשבון (מועדפים, ביקרתי, המלצה,
// דיווח, תמונה וכו') - במקום להעביר אותו למסך חדש (/login) ולאבד את ההקשר שהיה בו.
// /login עצמו כבר יודע להציג הרשמה או כניסה חוזרת לפי מה שיש במכשיר, אז מספיק כפתור אחד.
export default function LoginRequiredModal({
  visible, onClose, target = '/login', message,
  title, secondaryLabel, onSecondary,
}) {
  const router = useRouter();
  const { t } = useI18n();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.box}>
          {title ? <Text style={styles.title}>{title}</Text> : null}
          <Text style={styles.text}>{message ?? t('common.loginRequired.defaultMessage')}</Text>
          <Pressable style={styles.btn} onPress={() => { onClose(); router.push(target); }}>
            <Text style={styles.btnText}>{t('common.loginRequired.action')}</Text>
          </Pressable>
          {secondaryLabel ? (
            <Pressable style={styles.secondaryBtn} onPress={onSecondary || onClose}>
              <Text style={styles.secondaryBtnText}>{secondaryLabel}</Text>
            </Pressable>
          ) : null}
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(20,30,35,0.4)', justifyContent: 'center', padding: spacing.xl },
  box: { backgroundColor: colors.card, borderRadius: radii.xl, padding: spacing.xl, alignItems: 'center' },
  title: { fontFamily: fonts.extraBold, fontSize: 17, color: colors.textPrimary, textAlign: 'center', marginBottom: 8 },
  text: { fontFamily: fonts.bold, fontSize: 15, color: colors.textPrimary, textAlign: 'center', marginBottom: 16 },
  btn: { backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 12, paddingHorizontal: 28 },
  btnText: { fontFamily: fonts.bold, fontSize: 14, color: '#fff' },
  secondaryBtn: { marginTop: 12 },
  secondaryBtnText: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.textSecondary },
});
