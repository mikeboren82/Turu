import { useState, useEffect } from 'react';
import { View, Text, Modal, Pressable, TextInput, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { usePathname } from 'expo-router';
import { submitFeedback } from '../lib/feedback';
import { supabase } from '../lib/supabase';
import { colors, fonts, radii, spacing } from '../constants/theme';

// 2026-09-12 (בקשת המשתמש): הכפתור-המרחף הגלובלי הוסר מכל הדפים - הפיצ'ר עצמו (טופס דיווח-
// תקלה, בלי צורך להתחבר) עבר להיות רכיב-מודל נשלט מבחוץ (visible/onClose), מופעל דרך "משהו
// לא עובד?" בתפריט הנפתח (components/Header.js, מתחת ל"צור קשר") במקום כפתור עצמאי משלו.
// שולף את הכינוי-להצעה-מראש ב-useEffect על visible (במקום בלחיצה על הכפתור, שלא קיים יותר).
export default function FeedbackButton({ visible, onClose }) {
  const pathname = usePathname();
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!visible) return;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.user?.id) return;
        const { data } = await supabase.from('profiles').select('nickname').eq('id', session.user.id).maybeSingle();
        if (data?.nickname) setName(data.nickname);
      } catch {
        // אם שליפת הכינוי נכשלת - פשוט משאירים את השדה ריק, לא חוסמים את הדיווח בגלל זה
      }
    })();
  }, [visible]);

  const close = () => {
    onClose();
    setTimeout(() => { setMessage(''); setName(''); setError(''); setSent(false); }, 250);
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
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
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
  );
}

const styles = StyleSheet.create({
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
