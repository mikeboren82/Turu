import { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, TextInput, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import * as LocalAuthentication from 'expo-local-authentication';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Header from '../components/Header';
import {
  FingerprintIcon, PinIcon, GoogleIcon, AppleIcon, MailIcon,
} from '../components/icons';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { supabase } from '../lib/supabase';
import { enforceNotBanned } from '../lib/checkBanned';
import { signInWithGoogle, signInWithApple } from '../lib/oauth';
import { recordLegalConsentIfNeeded } from '../lib/legal';

function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

function normalizeIsraeliPhone(raw) {
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.startsWith('972')) return `+${digits}`;
  if (digits.startsWith('0')) return `+972${digits.slice(1)}`;
  if (raw.trim().startsWith('+')) return raw.trim();
  return `+972${digits}`;
}

function isValidIsraeliPhone(raw) {
  const digits = raw.replace(/[^\d]/g, '');
  return /^0\d{8,9}$/.test(digits) || /^972\d{8,9}$/.test(digits);
}

export default function LoginScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState(null);
  const [nickname, setNickname] = useState('');
  const [pinEnabled, setPinEnabled] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [authenticatingBio, setAuthenticatingBio] = useState(false);
  const [error, setError] = useState('');
  const [googleLoading, setGoogleLoading] = useState(false);
  const [appleLoading, setAppleLoading] = useState(false);
  const [showEmailField, setShowEmailField] = useState(false);
  const [email, setEmail] = useState('');
  const [sendingEmailCode, setSendingEmailCode] = useState(false);
  const [showPhoneFields, setShowPhoneFields] = useState(false);
  const [regNickname, setRegNickname] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [regErrors, setRegErrors] = useState({});
  const [submittingPhone, setSubmittingPhone] = useState(false);

  useEffect(() => {
    // תפיסת חזרה מקישור-קסם/OAuth נעשית כעת גלובלית ב-_layout.js (כי אימייל מגיע חזרה
    // ל-Site URL הראשי, לא בהכרח ל-/login) - כאן נשארת רק טעינת ה-session הרגילה.
    let cancelled = false;
    (async () => {
      const [{ data: { session: currentSession } }, pinFlag, bioFlag] = await Promise.all([
        supabase.auth.getSession(),
        AsyncStorage.getItem('turu_pin_enabled'),
        AsyncStorage.getItem('turu_biometric_enabled'),
      ]);
      if (cancelled) return;
      setSession(currentSession);
      setPinEnabled(pinFlag === 'true');
      setBiometricEnabled(bioFlag === 'true');

      if (currentSession?.user?.id) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('nickname')
          .eq('id', currentSession.user.id)
          .maybeSingle();
        if (!cancelled) setNickname(profile?.nickname || '');
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSmsLogin = async () => {
    if (!session?.user?.phone) {
      router.push('/login');
      return;
    }
    setSendingCode(true);
    setError('');
    const { error: sendError } = await supabase.auth.signInWithOtp({ phone: session.user.phone });
    setSendingCode(false);
    if (sendError) {
      setError(
        sendError.message?.includes('provider')
          ? 'שליחת סמס עדיין לא מוגדרת בצד השרת - יש לחבר ספק SMS ב-Supabase'
          : `שגיאה בשליחת קוד: ${sendError.message}`
      );
      return;
    }
    router.push({ pathname: '/verify-code', params: { phone: session.user.phone, nickname } });
  };

  const handleBiometricLogin = async () => {
    setError('');
    setAuthenticatingBio(true);
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'אמתו את הזהות שלכם כדי להתחבר',
    });
    if (!result.success) {
      setAuthenticatingBio(false);
      setError('לא הצלחנו לאמת - אפשר לנסות שוב, או להתחבר בקוד PIN');
      return;
    }
    if (session?.user?.id && await enforceNotBanned(session.user.id)) {
      setAuthenticatingBio(false);
      setError('החשבון הזה חסום ולא ניתן להשתמש בו יותר');
      return;
    }
    setAuthenticatingBio(false);
    router.replace('/');
  };

  // אחרי כניסה מוצלחת (Google/Apple) - אותה זרימת-המשך בדיוק כמו verify-code.js/admin-login.js:
  // בדיקת חסימה, ואז החלטה בין דף הבית לבין הצעת PIN/ביומטריה אם עוד לא הוגדרו במכשיר הזה.
  const finishOAuthLogin = async (userId) => {
    if (userId && await enforceNotBanned(userId)) {
      setError('החשבון הזה חסום ולא ניתן להשתמש בו יותר');
      return;
    }
    await recordLegalConsentIfNeeded(userId);
    const [asked, pin, bio] = await Promise.all([
      AsyncStorage.getItem('turu_asked_quick_login'),
      AsyncStorage.getItem('turu_pin_enabled'),
      AsyncStorage.getItem('turu_biometric_enabled'),
    ]);
    const alreadySetUp = pin === 'true' || bio === 'true';
    router.replace(asked === 'true' || alreadySetUp ? '/' : '/biometric-prompt');
  };

  const handleGoogleLogin = async () => {
    setError('');
    setGoogleLoading(true);
    try {
      const result = await signInWithGoogle();
      if (!result.cancelled) await finishOAuthLogin(result.session?.user?.id);
    } catch (err) {
      setError(`שגיאה בהתחברות עם Google: ${err.message}`);
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleAppleLogin = async () => {
    setError('');
    setAppleLoading(true);
    try {
      const result = await signInWithApple();
      if (!result.cancelled) await finishOAuthLogin(result.session?.user?.id);
    } catch (err) {
      setError(`שגיאה בהתחברות עם Apple: ${err.message}`);
    } finally {
      setAppleLoading(false);
    }
  };

  const handleSendEmailCode = async () => {
    if (!isValidEmail(email)) return;
    setError('');
    setSendingEmailCode(true);
    const { error: sendError } = await supabase.auth.signInWithOtp({ email: email.trim() });
    setSendingEmailCode(false);
    if (sendError) {
      setError(`שגיאה בשליחת קוד: ${sendError.message}`);
      return;
    }
    router.push({ pathname: '/verify-code', params: { channel: 'email', email: email.trim() } });
  };

  // הרשמה עם טלפון - חולץ מ-app/register.js (שנמחק - אוחד לכאן) בדיוק כמו שהיה: כינוי+טלפון,
  // signInWithOtp({phone}) ואז מסך אימות הקוד. בלי שדה אימייל נוסף כאן - מי שרוצה אימייל כבר
  // יכול להשתמש ב"התחברות עם אימייל" למעלה, לא צריך לבקש פעמיים באותו מסך.
  const handlePhoneSubmit = async () => {
    const nextErrors = {};
    if (!regNickname.trim()) nextErrors.nickname = 'נא להזין כינוי';
    if (!regPhone.trim()) nextErrors.phone = 'נא להזין מספר טלפון';
    else if (!isValidIsraeliPhone(regPhone)) nextErrors.phone = 'מספר טלפון לא תקין';
    setRegErrors(nextErrors);
    setError('');
    if (Object.keys(nextErrors).length > 0) return;

    const e164Phone = normalizeIsraeliPhone(regPhone);
    setSubmittingPhone(true);
    const { error: sendError } = await supabase.auth.signInWithOtp({
      phone: e164Phone,
      options: { data: { nickname: regNickname.trim() } },
    });
    setSubmittingPhone(false);

    if (sendError) {
      setError(
        sendError.message?.includes('provider')
          ? 'שליחת סמס עדיין לא מוגדרת בצד השרת - יש לחבר ספק SMS ב-Supabase'
          : `שגיאה בשליחת קוד: ${sendError.message}`
      );
      return;
    }
    router.push({ pathname: '/verify-code', params: { phone: e164Phone, nickname: regNickname.trim() } });
  };

  if (loading) {
    return (
      <View style={styles.screen}>
        <View style={styles.content}>
          <Header showBack onMenuPress={() => {}} />
          <View style={styles.center}>
            <ActivityIndicator color={colors.accent} />
          </View>
        </View>
      </View>
    );
  }

  if (!session) {
    return (
      <View style={styles.screen}>
        <ScrollView contentContainerStyle={styles.registerScrollContent} showsVerticalScrollIndicator={false}>
          <Header showBack onMenuPress={() => {}} />
          <View style={styles.registerCenter}>
            <Text style={[styles.welcome, { marginBottom: 18 }]}>נרשמים, ותורו מתחילה להכיר אתכם 💛</Text>

            <View style={styles.benefitsList}>
              <View style={styles.benefitRow}>
                <Text style={styles.benefitTitle}>👶 פעילויות שמתאימות לילדים שלכם</Text>
                <Text style={styles.benefitDesc}>הוסיפו את הילדים שלכם, ותורו תוכל להתאים לכם פעילויות לפי הגיל ותחומי העניין שלהם.</Text>
              </View>
              <View style={styles.benefitRow}>
                <Text style={styles.benefitTitle}>❤️ שומרים את מה שאהבתם</Text>
                <Text style={styles.benefitDesc}>שמרו פעילויות שאתם רוצים לעשות, כדי שתוכלו לחזור אליהן בקלות מתי שתרצו.</Text>
              </View>
              <View style={styles.benefitRow}>
                <Text style={styles.benefitTitle}>⚡ פחות לחפש, יותר למצוא</Text>
                <Text style={styles.benefitDesc}>ההעדפות שלכם נשמרות, כך שתוכלו למצוא פעילויות שמתאימות לכם מהר יותר.</Text>
              </View>
            </View>

            <Text style={styles.registerTagline}>ההרשמה חינם ולוקחת רגע.</Text>

            <Pressable style={styles.googleBtn} onPress={handleGoogleLogin} disabled={googleLoading}>
              {googleLoading ? <ActivityIndicator color={colors.textPrimary} /> : (
                <>
                  <GoogleIcon />
                  <Text style={styles.googleBtnText}>המשך עם Google</Text>
                </>
              )}
            </Pressable>

            <Pressable style={styles.appleBtn} onPress={handleAppleLogin} disabled={appleLoading}>
              {appleLoading ? <ActivityIndicator color={colors.textPrimary} /> : (
                <>
                  <AppleIcon color={colors.textPrimary} />
                  <Text style={styles.appleBtnText}>המשך עם Apple</Text>
                </>
              )}
            </Pressable>

            {!showEmailField ? (
              <Pressable style={styles.emailToggleBtn} onPress={() => setShowEmailField(true)}>
                <MailIcon />
                <Text style={styles.emailToggleBtnText}>התחברות עם אימייל</Text>
              </Pressable>
            ) : (
              <View style={styles.emailFieldWrap}>
                <TextInput
                  style={styles.emailInput}
                  value={email}
                  onChangeText={setEmail}
                  placeholder="הכתובת שלכם"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  textContentType="emailAddress"
                  autoFocus
                />
                <Pressable
                  style={[styles.pinBtn, !isValidEmail(email) && styles.submitBtnDisabled]}
                  onPress={handleSendEmailCode}
                  disabled={!isValidEmail(email) || sendingEmailCode}
                >
                  {sendingEmailCode ? <ActivityIndicator color={colors.accent} /> : <Text style={styles.pinBtnText}>שליחת קוד</Text>}
                </Pressable>
              </View>
            )}

            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>או</Text>
              <View style={styles.dividerLine} />
            </View>

            {!showPhoneFields ? (
              <Pressable style={styles.pinBtn} onPress={() => setShowPhoneFields(true)}>
                <Text style={styles.pinBtnText}>הרשמה עם מספר טלפון</Text>
              </Pressable>
            ) : (
              <View style={styles.phoneFieldsWrap}>
                <TextInput
                  style={[styles.emailInput, { textAlign: 'right', writingDirection: 'rtl' }, regErrors.nickname && styles.inputError]}
                  value={regNickname}
                  onChangeText={setRegNickname}
                  placeholder="איך נקרא לכם?"
                  placeholderTextColor={colors.textMuted}
                />
                {regErrors.nickname ? <Text style={styles.errorText}>{regErrors.nickname}</Text> : null}
                <TextInput
                  style={[styles.emailInput, { textAlign: 'left', writingDirection: 'ltr' }, regErrors.phone && styles.inputError]}
                  value={regPhone}
                  onChangeText={setRegPhone}
                  placeholder="050-1234567"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="phone-pad"
                />
                {regErrors.phone ? <Text style={styles.errorText}>{regErrors.phone}</Text> : null}
                <Pressable style={styles.pinBtn} onPress={handlePhoneSubmit} disabled={submittingPhone}>
                  {submittingPhone ? <ActivityIndicator color={colors.accent} /> : <Text style={styles.pinBtnText}>יאללה, מצטרפים! 🦘</Text>}
                </Pressable>
              </View>
            )}

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            <Text style={styles.consentText}>
              בהרשמה לתורו אתם מאשרים את{' '}
              <Text style={styles.consentLink} onPress={() => router.push('/terms')}>תנאי השימוש</Text>
              {' '}ואת{' '}
              <Text style={styles.consentLink} onPress={() => router.push('/privacy')}>מדיניות הפרטיות</Text>.
            </Text>

          </View>
        </ScrollView>
      </View>
    );
  }

  const showQuickOptions = pinEnabled || biometricEnabled;

  return (
    <View style={styles.screen}>
      <View style={styles.content}>
        <Header showBack onMenuPress={() => {}} />
        <View style={styles.center}>
          <Text style={styles.welcome}>כיף לראות אתכם שוב! 👋</Text>
          <Text style={styles.welcomeSub}>
            להמשיך בתור <Text style={styles.welcomeName}>{nickname || 'שלכם'}</Text>?
          </Text>

          {biometricEnabled && (
            <>
              <Pressable style={styles.bioBtn} onPress={handleBiometricLogin} disabled={authenticatingBio}>
                {authenticatingBio ? <ActivityIndicator color={colors.accent} /> : <FingerprintIcon />}
              </Pressable>
              <Text style={styles.bioLabel}>התחברות עם טביעת אצבע</Text>
            </>
          )}

          {showQuickOptions && (
            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>או</Text>
              <View style={styles.dividerLine} />
            </View>
          )}

          {pinEnabled && (
            <Pressable style={styles.pinBtn} onPress={() => router.push({ pathname: '/enter-pin', params: { nickname } })}>
              <PinIcon />
              <Text style={styles.pinBtnText}>הזינו קוד PIN</Text>
            </Pressable>
          )}

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <Pressable onPress={handleSmsLogin} disabled={sendingCode}>
            {sendingCode ? (
              <ActivityIndicator color={colors.textSecondary} />
            ) : (
              <Text style={styles.linkBtn}>התחברות עם קוד בסמס</Text>
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1, padding: spacing.xl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  registerScrollContent: { padding: spacing.xl, paddingBottom: 50 },
  registerCenter: { alignItems: 'center', paddingHorizontal: 12 },

  phoneFieldsWrap: { width: '100%', marginBottom: 8 },
  inputError: { borderColor: colors.danger },

  welcome: { fontFamily: fonts.extraBold, fontSize: 22, color: colors.textPrimary, textAlign: 'center', marginBottom: 6 },
  welcomeSub: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, textAlign: 'center', marginBottom: 36 },
  welcomeName: { fontFamily: fonts.bold, color: colors.textPrimary },

  benefitsList: { width: '100%', marginBottom: 18, gap: 14 },
  benefitRow: { width: '100%' },
  benefitTitle: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.textPrimary, textAlign: 'right', marginBottom: 3, lineHeight: 20 },
  benefitDesc: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: 'right', lineHeight: 18 },
  registerTagline: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginBottom: 22 },

  bioBtn: {
    width: 96, height: 96, borderRadius: 48, backgroundColor: colors.accentTintLight,
    borderWidth: 2, borderColor: colors.accent, alignItems: 'center', justifyContent: 'center',
    marginBottom: 16,
  },
  bioLabel: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.accent, marginBottom: 24 },

  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, width: '100%', marginBottom: 18 },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.textMuted },

  pinBtn: {
    width: '100%', borderWidth: 1.5, borderColor: colors.accent, backgroundColor: colors.card,
    borderRadius: radii.pill, paddingVertical: 13, marginBottom: 22,
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  pinBtnText: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.accent },
  submitBtnDisabled: { opacity: 0.5 },

  googleBtn: {
    width: '100%', borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.card,
    borderRadius: radii.pill, paddingVertical: 13, marginBottom: 12,
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  googleBtnText: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.textPrimary },
  appleBtn: {
    width: '100%', borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.card,
    borderRadius: radii.pill, paddingVertical: 13, marginBottom: 12,
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  appleBtnText: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.textPrimary },
  emailToggleBtn: {
    width: '100%', borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.card,
    borderRadius: radii.pill, paddingVertical: 13, marginBottom: 8,
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  emailToggleBtnText: { fontFamily: fonts.bold, fontSize: 14, color: colors.textSecondary },
  emailFieldWrap: { width: '100%', marginBottom: 8 },
  emailInput: {
    width: '100%', borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.card,
    borderRadius: radii.lg, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 10,
    fontFamily: fonts.regular, fontSize: 14.5, color: colors.textPrimary, textAlign: 'left',
  },

  errorText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.danger, textAlign: 'center', marginBottom: 16 },
  consentText: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, textAlign: 'center', marginTop: 4, lineHeight: 17 },
  consentLink: { fontFamily: fonts.semiBold, color: colors.textSecondary, textDecorationLine: 'underline' },

  linkBtn: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.textSecondary, textDecorationLine: 'underline' },
});
