import { useState } from 'react';
import { View, Text, Modal, Pressable, TextInput, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePathname } from 'expo-router';
import { submitFeedback } from '../lib/feedback';
import { supabase } from '../lib/supabase';
import { colors, fonts, radii, spacing } from '../constants/theme';

// יחס הרוחב/גובה של איור הדשא בעמוד הראשי (app/index.js, styles.grassFooter) - כדי שכפתור
// הדיווח יישב מעליו על מסך הבית ולא יתערבב עם הציור, בלי מספר קבוע שלא יתאים לכל רוחב מסך.
const GRASS_ASPECT_RATIO = 939 / 148;

// כפתור גלובלי דיסקרטי - מרונדר פעם אחת ב-app/_layout.js כדי שיופיע בתחתית כל מסך באפליקציה
// בלי לגעת בכל קובץ מסך בנפרד. לא דורש התחברות בשום שלב (ראו lib/feedback.js).
export default function FeedbackButton() {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const { width } = useWindowDimensions();
  const isHome = pathname === '/';
  const grassHeight = isHome ? width / GRASS_ASPECT_RATIO : 0;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const close = () => {
    setOpen(false);
    setTimeout(() => { setMessage(''); setName(''); setError(''); setSent(false); }, 250);
  };

  // בפתיחה - אם המשתמש מחובר, ממלאים את שדה השם מראש עם הכינוי שלו (אבל הוא נשאר חופשי
  // לשנות/למחוק אותו - זה תמיד שדה אופציונלי, גם למשתמש רשום).
  const openModal = async () => {
    setOpen(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user?.id) return;
      const { data } = await supabase.from('profiles').select('nickname').eq('id', session.user.id).maybeSingle();
      if (data?.nickname) setName(data.nickname);
    } catch {
      // אם שליפת הכינוי נכשלת - פשוט משאירים את השדה ריק, לא חוסמים את הדיווח בגלל זה
    }
  };

  const handleSend = async () => {
    if (!message.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      await submitFeedback(message, pathname, name);
      setSent(true);
      setTimeout(close, 1400);
    } catch (err) {
      setError(err.message || 'שגיאה בשליחה - נסו שוב');
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <Pressable
        style={[styles.trigger, { bottom: insets.bottom + 8 + grassHeight }]}
        onPress={openModal}
        hitSlop={8}
      >
        <Text style={styles.triggerText}>משהו לא עובד? דווח לנו</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <KeyboardAvoidingView
          style={styles.backdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={close} />
          <View style={styles.card}>
            {sent ? (
              <View style={styles.sentWrap}>
                <Text style={styles.sentEmoji}>🙏</Text>
                <Text style={styles.sentText}>תודה! קיבלנו את הדיווח</Text>
              </View>
            ) : (
              <>
                <Text style={styles.title}>דיווח על תקלה</Text>
                <Text style={styles.subtitle}>ספרו לנו מה קרה - בלי צורך להתחבר או להשאיר פרטים</Text>
                <Text style={styles.fieldLabel}>שם (לא חובה)</Text>
                <TextInput
                  style={styles.nameInput}
                  value={name}
                  onChangeText={setName}
                  placeholder="איך לקרוא לכם?"
                  placeholderTextColor={colors.textMuted}
                />
                <Text style={styles.fieldLabel}>מה קרה</Text>
                <TextInput
                  style={styles.input}
                  value={message}
                  onChangeText={setMessage}
                  placeholder="לדוגמה: הכפתור 'חיפוש' לא מגיב במסך הראשי..."
                  placeholderTextColor={colors.textMuted}
                  multiline
                  numberOfLines={4}
                  autoFocus
                />
                {error ? <Text style={styles.errorText}>{error}</Text> : null}
                <View style={styles.actionsRow}>
                  <Pressable
                    style={[styles.sendBtn, !message.trim() && styles.sendBtnDisabled]}
                    onPress={handleSend}
                    disabled={!message.trim() || sending}
                  >
                    {sending ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.sendBtnText}>שליחה</Text>}
                  </Pressable>
                  <Pressable style={styles.cancelBtn} onPress={close}>
                    <Text style={styles.cancelBtnText}>ביטול</Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    position: 'absolute', alignSelf: 'center', zIndex: 50,
    backgroundColor: 'rgba(255,255,255,0.88)', borderWidth: 1, borderColor: colors.borderLight,
    borderRadius: radii.pill, paddingVertical: 5, paddingHorizontal: 12,
  },
  triggerText: { fontFamily: fonts.medium, fontSize: 11, color: colors.textMuted },

  backdrop: { flex: 1, backgroundColor: 'rgba(20,30,35,0.4)', justifyContent: 'center', padding: spacing.xl },
  card: { backgroundColor: colors.card, borderRadius: radii.xl, padding: spacing.xl },
  title: { fontFamily: fonts.extraBold, fontSize: 17, color: colors.textPrimary, textAlign: 'center' },
  subtitle: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: 'center', marginTop: 4, marginBottom: 16, lineHeight: 18 },
  fieldLabel: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.textSecondary, textAlign: 'right', marginBottom: 5 },
  nameInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12,
    fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, backgroundColor: colors.bg,
    textAlign: 'right', writingDirection: 'rtl', marginBottom: 14,
  },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 13,
    fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, backgroundColor: colors.bg,
    textAlign: 'right', writingDirection: 'rtl', minHeight: 100, textAlignVertical: 'top',
  },
  errorText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.danger, textAlign: 'center', marginTop: 8 },
  actionsRow: { flexDirection: 'row-reverse', gap: 10, marginTop: 16 },
  cancelBtn: { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border },
  cancelBtnText: { fontFamily: fonts.bold, fontSize: 14, color: colors.textSecondary },
  sendBtn: { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: radii.pill, backgroundColor: colors.accent },
  sendBtnDisabled: { opacity: 0.5 },
  sendBtnText: { fontFamily: fonts.bold, fontSize: 14, color: '#fff' },

  sentWrap: { alignItems: 'center', paddingVertical: 10 },
  sentEmoji: { fontSize: 34, marginBottom: 8 },
  sentText: { fontFamily: fonts.bold, fontSize: 15, color: colors.textPrimary },
});
