import { useState, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Header from '../components/Header';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { supabase } from '../lib/supabase';
import { enforceNotBanned } from '../lib/checkBanned';
import { recordLegalConsentIfNeeded } from '../lib/legal';

const RESEND_SECONDS = 60;

function formatPhoneDisplay(e164) {
  if (!e164) return '';
  const digits = e164.startsWith('+972') ? '0' + e164.slice(4) : e164;
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return digits;
}

function formatCountdown(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function VerifyCodeScreen() {
  const router = useRouter();
  const { phone, nickname, email, channel } = useLocalSearchParams();
  const isEmailChannel = channel === 'email';
  const digitCount = isEmailChannel ? 6 : 4;
  const [digits, setDigits] = useState(Array(digitCount).fill(''));
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(RESEND_SECONDS);
  const inputs = useRef([]);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [secondsLeft]);

  const code = digits.join('');

  const handleDigitChange = (index, value) => {
    const clean = value.replace(/[^0-9]/g, '').slice(-1);
    const next = [...digits];
    next[index] = clean;
    setDigits(next);
    setError('');
    if (clean && index < digitCount - 1) inputs.current[index + 1]?.focus();
  };

  const handleKeyPress = (index, e) => {
    if (e.nativeEvent.key === 'Backspace' && !digits[index] && index > 0) {
      inputs.current[index - 1]?.focus();
    }
  };

  const handleVerify = async () => {
    if (code.length !== digitCount) return;
    setSubmitting(true);
    setError('');
    const { data, error: verifyError } = await supabase.auth.verifyOtp(
      isEmailChannel
        ? { email: String(email), token: code, type: 'email' }
        : { phone: String(phone), token: code, type: 'sms' }
    );
    setSubmitting(false);

    if (verifyError) {
      setError(
        verifyError.message?.includes('expired') || verifyError.message?.includes('invalid')
          ? 'הקוד שגוי או שפג תוקפו - נסו שוב או שלחו קוד חדש'
          : `שגיאה באימות: ${verifyError.message}`
      );
      setDigits(Array(digitCount).fill(''));
      inputs.current[0]?.focus();
      return;
    }

    if (data?.user?.id && await enforceNotBanned(data.user.id)) {
      setError('החשבון הזה חסום ולא ניתן להשתמש בו יותר');
      setDigits(Array(digitCount).fill(''));
      return;
    }

    await recordLegalConsentIfNeeded(data?.user?.id);

    // עדכון profiles.email רלוונטי רק לזרימת טלפון+אימייל-אופציונלי (register.js) - כשהערוץ
    // הוא כבר אימייל, האימייל הוא הזהות הראשית ו-Supabase כבר שומר אותו על ה-user בעצמו.
    if (!isEmailChannel && email && data?.user?.id) {
      const { error: emailError } = await supabase
        .from('profiles')
        .update({ email: String(email), notify_by_email: true })
        .eq('id', data.user.id);
      if (emailError) {
        console.warn('לא ניתן לשמור את כתובת האימייל (ייתכן שהעמודה עדיין לא נוספה למסד):', emailError.message);
      }
    }

    const [asked, pinEnabled, biometricEnabled] = await Promise.all([
      AsyncStorage.getItem('turu_asked_quick_login'),
      AsyncStorage.getItem('turu_pin_enabled'),
      AsyncStorage.getItem('turu_biometric_enabled'),
    ]);
    const alreadySetUp = pinEnabled === 'true' || biometricEnabled === 'true';
    router.replace(asked === 'true' || alreadySetUp ? '/' : '/biometric-prompt');
  };

  const handleResend = async () => {
    setResending(true);
    setError('');
    const { error: resendError } = await supabase.auth.signInWithOtp(
      isEmailChannel
        ? { email: String(email) }
        : { phone: String(phone), options: { data: { nickname: String(nickname || '') } } }
    );
    setResending(false);
    if (resendError) {
      setError(`שגיאה בשליחת קוד חדש: ${resendError.message}`);
      return;
    }
    setSecondsLeft(RESEND_SECONDS);
    setDigits(Array(digitCount).fill(''));
    inputs.current[0]?.focus();
  };

  return (
    <View style={styles.screen}>
      <View style={styles.content}>
        <Header showBack onMenuPress={() => {}} />

        <Text style={styles.headline}>{isEmailChannel ? 'בדקו את המייל 📧' : 'בדקו את הסמס 📱'}</Text>
        <Text style={styles.subtext}>
          {isEmailChannel
            ? <>שלחנו קוד בן 6 ספרות לכתובת{'\n'}<Text style={styles.phoneText}>{String(email || '')}</Text></>
            : <>שלחנו קוד בן 4 ספרות למספר{'\n'}<Text style={styles.phoneText}>{formatPhoneDisplay(String(phone || ''))}</Text></>}
        </Text>

        <View style={[styles.codeRow, isEmailChannel && styles.codeRowCompact]}>
          {digits.map((d, i) => (
            <TextInput
              key={i}
              ref={(el) => { inputs.current[i] = el; }}
              style={[styles.codeBox, isEmailChannel && styles.codeBoxCompact, d && styles.codeBoxFilled, error && styles.codeBoxError]}
              value={d}
              onChangeText={(v) => handleDigitChange(i, v)}
              onKeyPress={(e) => handleKeyPress(i, e)}
              keyboardType="number-pad"
              maxLength={1}
              textAlign="center"
            />
          ))}
        </View>

        {error ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : (
          <View style={styles.resendRow}>
            {secondsLeft > 0 ? (
              <Text style={styles.resendText}>
                לא קיבלתם? שליחה חוזרת בעוד <Text style={styles.resendTime}>{formatCountdown(secondsLeft)}</Text>
              </Text>
            ) : (
              <Pressable onPress={handleResend} disabled={resending}>
                <Text style={styles.resendLink}>{resending ? 'שולח...' : 'שליחה חוזרת של הקוד'}</Text>
              </Pressable>
            )}
          </View>
        )}

        <Pressable
          style={[styles.submitBtn, code.length !== 4 && styles.submitBtnDisabled]}
          onPress={handleVerify}
          disabled={code.length !== 4 || submitting}
        >
          {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitBtnText}>אישור</Text>}
        </Pressable>

        <Pressable onPress={() => router.back()}>
          <Text style={styles.changeLink}>{isEmailChannel ? 'שינוי כתובת מייל' : 'שינוי מספר טלפון'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1, padding: spacing.xl },

  headline: { fontFamily: fonts.extraBold, fontSize: 21, color: colors.textPrimary, textAlign: 'center', marginTop: 32, marginBottom: 8 },
  subtext: { fontFamily: fonts.regular, fontSize: 13.5, color: colors.textSecondary, textAlign: 'center', marginBottom: 32, lineHeight: 20 },
  phoneText: { fontFamily: fonts.bold, color: colors.textPrimary },

  codeRow: { flexDirection: 'row', justifyContent: 'center', gap: 12, marginBottom: 22 },
  codeRowCompact: { gap: 7 },
  codeBox: {
    width: 56, height: 64, borderRadius: radii.lg, borderWidth: 1.5, borderColor: colors.border,
    backgroundColor: colors.card, fontFamily: fonts.extraBold, fontSize: 26, color: colors.textPrimary,
  },
  codeBoxCompact: { width: 42, height: 54, fontSize: 20 },
  codeBoxFilled: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  codeBoxError: { borderColor: colors.danger },

  resendRow: { alignItems: 'center', marginBottom: 32 },
  resendText: { fontFamily: fonts.regular, fontSize: 13, color: colors.textMuted },
  resendTime: { fontFamily: fonts.bold, color: colors.textSecondary },
  resendLink: { fontFamily: fonts.bold, fontSize: 13, color: colors.accent, textDecorationLine: 'underline' },
  errorText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.danger, textAlign: 'center', marginBottom: 32 },

  submitBtn: {
    backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 15,
    alignItems: 'center', justifyContent: 'center',
  },
  submitBtnDisabled: { opacity: 0.5 },
  submitBtnText: { fontFamily: fonts.bold, fontSize: 16, color: '#fff' },

  changeLink: {
    fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, textAlign: 'center',
    textDecorationLine: 'underline', marginTop: 18,
  },
});
