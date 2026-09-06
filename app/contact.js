import { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, Pressable, Linking, ActivityIndicator } from 'react-native';
import Header from '../components/Header';
import { WhatsAppIcon } from '../components/icons';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { sendContactMessage } from '../lib/contact';

const WHATSAPP_PHONE = '972533643918'; // 0533643918 בפורמט בינלאומי בלי ה-0 המוביל

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export default function ContactScreen() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState({});
  const [sending, setSending] = useState(false);
  const [sendStatus, setSendStatus] = useState('');

  const openWhatsApp = () => {
    const text = encodeURIComponent('היי! מגיע/ה מהאפליקציה TuRu 🦘');
    Linking.openURL(`https://wa.me/${WHATSAPP_PHONE}?text=${text}`);
  };

  const handleSend = async () => {
    const nextErrors = {};
    if (!email.trim()) nextErrors.email = 'נא להזין אימייל';
    else if (!isValidEmail(email)) nextErrors.email = 'כתובת אימייל לא תקינה';
    if (!message.trim()) nextErrors.message = 'נא לכתוב הודעה';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSending(true);
    setSendStatus('');
    try {
      await sendContactMessage(email.trim(), message.trim());
      setSendStatus('success');
      setMessage('');
    } catch (err) {
      setSendStatus(`שגיאה בשליחה: ${err.message}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Header showBack onMenuPress={() => {}} />

        <Text style={styles.pageTitle}>צרו קשר 📬</Text>
        <Text style={styles.pageSubtitle}>נשמח לשמוע מכם - יש כמה דרכים להגיע אלינו</Text>

        <Pressable style={styles.whatsappBtn} onPress={openWhatsApp}>
          <WhatsAppIcon size={22} />
          <Text style={styles.whatsappBtnText}>שליחת הודעה בוואטסאפ</Text>
        </Pressable>

        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>או</Text>
          <View style={styles.dividerLine} />
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>האימייל שלכם</Text>
          <TextInput
            style={[styles.input, errors.email && styles.inputError, { textAlign: 'left', writingDirection: 'ltr' }]}
            placeholder="name@example.com"
            placeholderTextColor={colors.textMuted}
            keyboardType="email-address"
            autoCapitalize="none"
            value={email}
            onChangeText={setEmail}
          />
          {errors.email ? <Text style={styles.errorText}>{errors.email}</Text> : null}
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>ההודעה שלכם</Text>
          <TextInput
            style={[styles.input, styles.messageInput, { textAlign: 'right', writingDirection: 'rtl' }, errors.message && styles.inputError]}
            placeholder="ספרו לנו מה על הלב..."
            placeholderTextColor={colors.textMuted}
            multiline
            value={message}
            onChangeText={setMessage}
          />
          {errors.message ? <Text style={styles.errorText}>{errors.message}</Text> : null}
        </View>

        <Pressable style={[styles.sendBtn, sending && styles.sendBtnDisabled]} onPress={handleSend} disabled={sending}>
          {sending ? <ActivityIndicator color="#fff" /> : <Text style={styles.sendBtnText}>שליחה</Text>}
        </Pressable>
        {sendStatus === 'success' ? (
          <Text style={styles.successText}>ההודעה נשלחה ✓ נחזור אליכם בהקדם</Text>
        ) : sendStatus ? (
          <Text style={styles.sendErrorText}>{sendStatus}</Text>
        ) : (
          <Text style={styles.hint}>ההודעה תישלח אלינו ישירות</Text>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, paddingBottom: 50 },
  pageTitle: { fontFamily: fonts.extraBold, fontSize: 22, color: colors.textPrimary, textAlign: 'right', marginTop: 24, marginBottom: 6 },
  pageSubtitle: { fontFamily: fonts.regular, fontSize: 13.5, color: colors.textSecondary, textAlign: 'right', marginBottom: 26 },

  whatsappBtn: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: '#25D366', borderRadius: radii.pill, paddingVertical: 15,
  },
  whatsappBtnText: { fontFamily: fonts.bold, fontSize: 15.5, color: '#fff' },

  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 22 },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.textMuted },

  field: { marginBottom: 16 },
  fieldLabel: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.textSecondary, marginBottom: 6, textAlign: 'right' },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12,
    fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, backgroundColor: colors.card,
  },
  messageInput: { minHeight: 110, textAlignVertical: 'top' },
  inputError: { borderColor: colors.danger },
  errorText: { fontFamily: fonts.semiBold, fontSize: 11.5, color: colors.danger, marginTop: 6, textAlign: 'right' },

  sendBtn: { backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 15, alignItems: 'center', marginTop: 4 },
  sendBtnDisabled: { opacity: 0.6 },
  sendBtnText: { fontFamily: fonts.bold, fontSize: 16, color: '#fff' },
  hint: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, textAlign: 'center', marginTop: 10 },
  successText: { fontFamily: fonts.bold, fontSize: 13, color: colors.greenStrong, textAlign: 'center', marginTop: 10 },
  sendErrorText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.danger, textAlign: 'center', marginTop: 10 },
});
