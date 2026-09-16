import { useState, useRef, useEffect, Fragment } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Header from '../components/Header';
import SkyBackground from '../components/SkyBackground';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { supabase } from '../lib/supabase';
import { enforceNotBanned } from '../lib/checkBanned';
import { recordLegalConsentIfNeeded } from '../lib/legal';
import { friendlyAuthError } from '../lib/authErrors';
import { useI18n } from '../lib/i18n';

const RESEND_SECONDS = 60;

// מפרק תבנית מתורגמת עם {{slot}} לחלקים, כדי לשלב בתוכה רכיב Text מודגש בלי להניח סדר מילים קבוע.
function renderTemplate(template, slots) {
  return template.split(/(\{\{\w+\}\})/).map((part, i) => {
    const m = part.match(/^\{\{(\w+)\}\}$/);
    const content = m && slots[m[1]] !== undefined ? slots[m[1]] : part;
    return content ? <Fragment key={i}>{content}</Fragment> : null;
  });
}

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
  const { t } = useI18n();
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
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  const code = digits.join('');

  const handleDigitChange = (index, value) => {
    const allDigits = value.replace(/[^0-9]/g, '');
    // הדבקה/השלמה-אוטומטית של הקוד המלא לתוך תיבה אחת - מפזרים על כל התיבות
    if (allDigits.length > 1) {
      const next = [...digits];
      allDigits.slice(0, digitCount - index).split('').forEach((ch, k) => { next[index + k] = ch; });
      setDigits(next);
      setError('');
      inputs.current[Math.min(index + allDigits.length, digitCount - 1)]?.focus();
      return;
    }
    const clean = allDigits.slice(-1);
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
      setError(friendlyAuthError(verifyError, 'verify'));
      setDigits(Array(digitCount).fill(''));
      inputs.current[0]?.focus();
      return;
    }

    if (data?.user?.id && await enforceNotBanned(data.user.id)) {
      setError(t('auth.errors.banned'));
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
        console.warn('Could not save profile email (the column may not exist yet):', emailError.message);
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
      setError(friendlyAuthError(resendError, isEmailChannel ? 'emailSend' : 'phoneSend'));
      return;
    }
    setSecondsLeft(RESEND_SECONDS);
    setDigits(Array(digitCount).fill(''));
    inputs.current[0]?.focus();
  };

  return (
    <View style={styles.screen}>
      <SkyBackground />
      <View style={styles.content}>
        <Header showBack onMenuPress={() => {}} />

        <Text style={styles.headline}>{isEmailChannel ? t('auth.verify.emailHeadline') : t('auth.verify.smsHeadline')}</Text>
        <Text style={styles.subtext}>
          {renderTemplate(t(isEmailChannel ? 'auth.verify.sentToEmail' : 'auth.verify.sentToPhone', { digits: digitCount }), {
            value: <Text style={styles.phoneText}>{isEmailChannel ? String(email || '') : formatPhoneDisplay(String(phone || ''))}</Text>,
          })}
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
              maxLength={i === 0 ? digitCount : 1}
              textAlign="center"
              textContentType={i === 0 ? 'oneTimeCode' : 'none'}
              autoComplete={i === 0 ? 'one-time-code' : 'off'}
              accessibilityLabel={t('auth.verify.digitLabel', { n: i + 1, total: digitCount })}
            />
          ))}
        </View>

        {error ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : (
          <View style={styles.resendRow}>
            {secondsLeft > 0 ? (
              <Text style={styles.resendText}>
                {renderTemplate(t('auth.verify.resendIn'), {
                  time: <Text style={styles.resendTime}>{formatCountdown(secondsLeft)}</Text>,
                })}
              </Text>
            ) : (
              <Pressable onPress={handleResend} disabled={resending}>
                <Text style={styles.resendLink}>{resending ? t('common.actions.sending') : t('auth.verify.resend')}</Text>
              </Pressable>
            )}
          </View>
        )}

        <Pressable
          style={[styles.submitBtn, code.length !== digitCount && styles.submitBtnDisabled]}
          onPress={handleVerify}
          disabled={code.length !== digitCount || submitting}
          accessibilityRole="button"
          accessibilityState={{ busy: submitting, disabled: code.length !== digitCount || submitting }}
        >
          {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitBtnText}>{t('common.actions.ok')}</Text>}
        </Pressable>

        <Pressable onPress={() => router.back()}>
          <Text style={styles.changeLink}>{isEmailChannel ? t('auth.verify.changeEmail') : t('auth.verify.changePhone')}</Text>
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
