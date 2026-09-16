import { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, TextInput, ScrollView } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as LocalAuthentication from 'expo-local-authentication';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Header from '../components/Header';
import SkyBackground from '../components/SkyBackground';
import {
  FingerprintIcon, PinIcon, GoogleIcon, AppleIcon, MailIcon,
} from '../components/icons';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { supabase } from '../lib/supabase';
import { enforceNotBanned } from '../lib/checkBanned';
import { signInWithGoogle, signInWithApple } from '../lib/oauth';
import { recordLegalConsentIfNeeded } from '../lib/legal';
import { friendlyAuthError } from '../lib/authErrors';

// כל הטקסטים של מסך ההרשמה/ההתחברות במקום אחד - כדי שיהיה קל להעביר אותם למערכת התרגום
// (עברית/אנגלית) כשתיבנה, בלי לחפש מחרוזות בתוך ה-JSX.
const COPY = {
  // רווח לא-שביר לפני האימוג'י - שלא יישאר לבד בשורה כשהכותרת נשברת במסכים צרים
  registerTitle: 'נרשמים, ותורו מתחילה להכיר אתכם 💛',
  loginTitle: 'התחברות לתורו 👋',
  loginSubtitle: 'בחרו את הדרך שבה נרשמתם',
  benefits: [
    { emoji: '👶', title: 'פעילויות שבאמת מתאימות לילדים שלכם', desc: 'לפי הגילאים וההעדפות שלכם' },
    { emoji: '📍', title: 'זוכרים מה מתאים לכם', desc: 'המיקום וההעדפות נשמרים לפעם הבאה' },
    { emoji: '❤️', title: 'שומרים פעילויות שאהבתם', desc: 'וחוזרים אליהן מתי שרוצים' },
  ],
  tagline: 'ההרשמה חינם ולוקחת רגע',
  google: 'המשך עם Google',
  apple: 'המשך עם Apple',
  or: 'או',
  email: 'המשך עם אימייל',
  emailPlaceholder: 'your@email.com',
  emailSend: 'שליחת קוד',
  emailHint: 'נשלח אליכם קוד בן 6 ספרות - בלי סיסמה',
  phoneRegister: 'הרשמה עם מספר טלפון',
  phoneLogin: 'התחברות עם מספר טלפון',
  nicknamePlaceholder: 'איך נקרא לכם?',
  phoneSubmitRegister: 'יאללה, מצטרפים! 🦘',
  phoneSubmitLogin: 'שליחת קוד בסמס',
  haveAccount: 'כבר יש לכם חשבון?',
  haveAccountAction: 'התחברו',
  noAccount: 'עוד אין לכם חשבון?',
  noAccountAction: 'הרשמה',
  consentRegister: 'בהרשמה לתורו אתם מאשרים את',
  consentLogin: 'בהתחברות לתורו אתם מאשרים את',
  terms: 'תנאי השימוש',
  and: 'ואת',
  privacy: 'מדיניות הפרטיות',
};

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
  // authError - מגיע מ-_layout.js כשחזרה מ-Google/Apple נכשלה בצד השרת
  const { authError } = useLocalSearchParams();
  const [error, setError] = useState(authError ? friendlyAuthError('', 'oauth') : '');
  // 'register' | 'login' - אותן שיטות התחברות בשני המצבים (כולן מטפלות גם במשתמש חדש וגם בקיים);
  // המצב משנה רק נוסח, הסתרת ההסבר "למה להירשם", ושדה הכינוי בזרימת הטלפון.
  const [mode, setMode] = useState('register');
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
      setError(friendlyAuthError(sendError, 'phoneSend'));
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

  const authBusy = googleLoading || appleLoading || sendingEmailCode || submittingPhone;

  const handleGoogleLogin = async () => {
    if (authBusy) return;
    setError('');
    setGoogleLoading(true);
    try {
      const result = await signInWithGoogle();
      if (!result.cancelled) await finishOAuthLogin(result.session?.user?.id);
    } catch (err) {
      setError(friendlyAuthError(err, 'oauth'));
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleAppleLogin = async () => {
    if (authBusy) return;
    setError('');
    setAppleLoading(true);
    try {
      const result = await signInWithApple();
      if (!result.cancelled) await finishOAuthLogin(result.session?.user?.id);
    } catch (err) {
      setError(friendlyAuthError(err, 'oauth'));
    } finally {
      setAppleLoading(false);
    }
  };

  const handleSendEmailCode = async () => {
    if (!isValidEmail(email) || sendingEmailCode) return;
    setError('');
    setSendingEmailCode(true);
    const { error: sendError } = await supabase.auth.signInWithOtp({ email: email.trim() });
    setSendingEmailCode(false);
    if (sendError) {
      setError(friendlyAuthError(sendError, 'emailSend'));
      return;
    }
    router.push({ pathname: '/verify-code', params: { channel: 'email', email: email.trim() } });
  };

  // הרשמה עם טלפון - חולץ מ-app/register.js (שנמחק - אוחד לכאן) בדיוק כמו שהיה: כינוי+טלפון,
  // signInWithOtp({phone}) ואז מסך אימות הקוד. בלי שדה אימייל נוסף כאן - מי שרוצה אימייל כבר
  // יכול להשתמש ב"התחברות עם אימייל" למעלה, לא צריך לבקש פעמיים באותו מסך.
  const handlePhoneSubmit = async () => {
    if (submittingPhone) return;
    const nextErrors = {};
    // כינוי נדרש רק בהרשמה: profiles.nickname הוא NOT NULL, ולמשתמש טלפון אין אימייל שממנו
    // handle_new_user() יכול לגזור כינוי. בהתחברות (משתמש קיים) הטריגר לא רץ בכלל.
    if (mode === 'register' && !regNickname.trim()) nextErrors.nickname = 'נא להזין כינוי';
    if (!regPhone.trim()) nextErrors.phone = 'נא להזין מספר טלפון';
    else if (!isValidIsraeliPhone(regPhone)) nextErrors.phone = 'מספר טלפון לא תקין';
    setRegErrors(nextErrors);
    setError('');
    if (Object.keys(nextErrors).length > 0) return;

    const e164Phone = normalizeIsraeliPhone(regPhone);
    setSubmittingPhone(true);
    const { error: sendError } = await supabase.auth.signInWithOtp(
      mode === 'register'
        ? { phone: e164Phone, options: { data: { nickname: regNickname.trim() } } }
        : { phone: e164Phone }
    );
    setSubmittingPhone(false);

    if (sendError) {
      setError(friendlyAuthError(sendError, mode === 'register' ? 'phoneSend' : 'phoneLogin'));
      return;
    }
    router.push({ pathname: '/verify-code', params: { phone: e164Phone, nickname: regNickname.trim() } });
  };

  if (loading) {
    return (
      <View style={styles.screen}>
        <SkyBackground />
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
    const isRegister = mode === 'register';
    const switchMode = () => {
      setMode(isRegister ? 'login' : 'register');
      setError('');
      setRegErrors({});
    };
    return (
      <View style={styles.screen}>
        <SkyBackground />
        <ScrollView
          contentContainerStyle={styles.registerScrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <Header showBack onMenuPress={() => {}} />
          <View style={styles.registerCenter}>
            <Text style={styles.registerTitle} accessibilityRole="header">
              {isRegister ? COPY.registerTitle : COPY.loginTitle}
            </Text>

            {isRegister ? (
              <View style={styles.benefitsList}>
                {COPY.benefits.map((b) => (
                  <View key={b.title} style={styles.benefitRow}>
                    <Text style={styles.benefitEmoji} importantForAccessibility="no" accessibilityElementsHidden>{b.emoji}</Text>
                    <View style={styles.benefitTextWrap}>
                      <Text style={styles.benefitTitle}>{b.title}</Text>
                      <Text style={styles.benefitDesc}>{b.desc}</Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <Text style={styles.loginSubtitle}>{COPY.loginSubtitle}</Text>
            )}

            {isRegister ? <Text style={styles.registerTagline}>{COPY.tagline}</Text> : null}

            <Pressable
              style={({ pressed }) => [styles.authBtn, pressed && styles.authBtnPressed, authBusy && !googleLoading && styles.authBtnDimmed]}
              onPress={handleGoogleLogin}
              disabled={authBusy}
              accessibilityRole="button"
              accessibilityLabel={COPY.google}
              accessibilityState={{ busy: googleLoading, disabled: authBusy }}
            >
              {googleLoading ? <ActivityIndicator color={colors.textPrimary} /> : (
                <>
                  <GoogleIcon />
                  <Text style={styles.authBtnText}>{COPY.google}</Text>
                </>
              )}
            </Pressable>

            <Pressable
              style={({ pressed }) => [styles.authBtn, pressed && styles.authBtnPressed, authBusy && !appleLoading && styles.authBtnDimmed]}
              onPress={handleAppleLogin}
              disabled={authBusy}
              accessibilityRole="button"
              accessibilityLabel={COPY.apple}
              accessibilityState={{ busy: appleLoading, disabled: authBusy }}
            >
              {appleLoading ? <ActivityIndicator color={colors.textPrimary} /> : (
                <>
                  <AppleIcon color={colors.textPrimary} />
                  <Text style={styles.authBtnText}>{COPY.apple}</Text>
                </>
              )}
            </Pressable>

            <View style={styles.dividerRow} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>{COPY.or}</Text>
              <View style={styles.dividerLine} />
            </View>

            {!showEmailField ? (
              <Pressable
                style={({ pressed }) => [styles.authBtn, pressed && styles.authBtnPressed, authBusy && styles.authBtnDimmed]}
                onPress={() => setShowEmailField(true)}
                disabled={authBusy}
                accessibilityRole="button"
                accessibilityLabel={COPY.email}
              >
                <MailIcon size={18} color={colors.textPrimary} />
                <Text style={styles.authBtnText}>{COPY.email}</Text>
              </Pressable>
            ) : (
              <View style={styles.emailFieldWrap}>
                <TextInput
                  style={styles.emailInput}
                  value={email}
                  onChangeText={setEmail}
                  placeholder={COPY.emailPlaceholder}
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  keyboardType="email-address"
                  textContentType="emailAddress"
                  returnKeyType="send"
                  onSubmitEditing={handleSendEmailCode}
                  accessibilityLabel="אימייל"
                  autoFocus
                />
                <Pressable
                  style={[styles.submitBtn, (!isValidEmail(email) || sendingEmailCode) && styles.submitBtnDisabled]}
                  onPress={handleSendEmailCode}
                  disabled={!isValidEmail(email) || authBusy}
                  accessibilityRole="button"
                  accessibilityLabel={COPY.emailSend}
                  accessibilityState={{ busy: sendingEmailCode, disabled: !isValidEmail(email) || authBusy }}
                >
                  {sendingEmailCode ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitBtnText}>{COPY.emailSend}</Text>}
                </Pressable>
                <Text style={styles.fieldHint}>{COPY.emailHint}</Text>
              </View>
            )}

            {!showPhoneFields ? (
              <Pressable
                onPress={() => setShowPhoneFields(true)}
                disabled={authBusy}
                hitSlop={10}
                style={styles.phoneLink}
                accessibilityRole="button"
              >
                <Text style={styles.secondaryLinkText}>{isRegister ? COPY.phoneRegister : COPY.phoneLogin}</Text>
              </Pressable>
            ) : (
              <View style={styles.phoneFieldsWrap}>
                {isRegister ? (
                  <>
                    <TextInput
                      style={[styles.emailInput, styles.rtlInput, regErrors.nickname && styles.inputError]}
                      value={regNickname}
                      onChangeText={setRegNickname}
                      placeholder={COPY.nicknamePlaceholder}
                      placeholderTextColor={colors.textMuted}
                      accessibilityLabel={COPY.nicknamePlaceholder}
                    />
                    {regErrors.nickname ? <Text style={styles.errorText}>{regErrors.nickname}</Text> : null}
                  </>
                ) : null}
                <TextInput
                  style={[styles.emailInput, regErrors.phone && styles.inputError]}
                  value={regPhone}
                  onChangeText={setRegPhone}
                  placeholder="050-1234567"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="phone-pad"
                  autoComplete="tel"
                  textContentType="telephoneNumber"
                  accessibilityLabel="מספר טלפון"
                />
                {regErrors.phone ? <Text style={styles.errorText}>{regErrors.phone}</Text> : null}
                <Pressable
                  style={[styles.submitBtn, submittingPhone && styles.submitBtnDisabled]}
                  onPress={handlePhoneSubmit}
                  disabled={authBusy}
                  accessibilityRole="button"
                  accessibilityState={{ busy: submittingPhone, disabled: authBusy }}
                >
                  {submittingPhone ? <ActivityIndicator color="#fff" /> : (
                    <Text style={styles.submitBtnText}>{isRegister ? COPY.phoneSubmitRegister : COPY.phoneSubmitLogin}</Text>
                  )}
                </Pressable>
              </View>
            )}

            {error ? <Text style={styles.errorText} accessibilityLiveRegion="polite">{error}</Text> : null}

            <View style={styles.switchModeRow}>
              <Text style={styles.switchModeText}>{isRegister ? COPY.haveAccount : COPY.noAccount}</Text>
              <Pressable onPress={switchMode} hitSlop={10} accessibilityRole="button">
                <Text style={styles.switchModeAction}>{isRegister ? COPY.haveAccountAction : COPY.noAccountAction}</Text>
              </Pressable>
            </View>

            <Text style={styles.consentText}>
              {isRegister ? COPY.consentRegister : COPY.consentLogin}{' '}
              <Text style={styles.consentLink} onPress={() => router.push('/terms')} accessibilityRole="link">{COPY.terms}</Text>
              {' '}{COPY.and}{' '}
              <Text style={styles.consentLink} onPress={() => router.push('/privacy')} accessibilityRole="link">{COPY.privacy}</Text>.
            </Text>
          </View>
        </ScrollView>
      </View>
    );
  }

  const showQuickOptions = pinEnabled || biometricEnabled;

  return (
    <View style={styles.screen}>
      <SkyBackground />
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

  registerTitle: { fontFamily: fonts.extraBold, fontSize: 18, color: colors.textPrimary, textAlign: 'center', marginTop: 4, marginBottom: 14 },
  loginSubtitle: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, textAlign: 'center', marginBottom: 22 },
  benefitsList: { width: '100%', marginBottom: 14, gap: 10 },
  benefitRow: { width: '100%', flexDirection: 'row-reverse', alignItems: 'flex-start', gap: 10 },
  benefitEmoji: { fontSize: 17, lineHeight: 22, width: 22, textAlign: 'center' },
  benefitTextWrap: { flex: 1 },
  benefitTitle: { fontFamily: fonts.bold, fontSize: 14, color: colors.textPrimary, textAlign: 'right', lineHeight: 20 },
  benefitDesc: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: 'right', lineHeight: 17 },
  registerTagline: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginBottom: 14 },

  // כפתורי ההתחברות (Google/Apple/אימייל) - אותה גאומטריה בדיוק לשלושתם, גובה מגע של לפחות 48
  authBtn: {
    width: '100%', minHeight: 48, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.card,
    borderRadius: radii.pill, paddingVertical: 12, marginBottom: 10,
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  authBtnPressed: { opacity: 0.75 },
  authBtnDimmed: { opacity: 0.5 },
  authBtnText: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.textPrimary },
  submitBtn: {
    width: '100%', minHeight: 48, backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 12,
    alignItems: 'center', justifyContent: 'center', marginBottom: 6,
  },
  submitBtnText: { fontFamily: fonts.bold, fontSize: 14.5, color: '#fff' },
  fieldHint: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, textAlign: 'center', marginBottom: 4 },
  rtlInput: { textAlign: 'right', writingDirection: 'rtl' },
  phoneLink: { paddingVertical: 8, marginTop: 4, marginBottom: 6 },
  secondaryLinkText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary, textDecorationLine: 'underline' },
  switchModeRow: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 5, marginTop: 10, marginBottom: 14 },
  switchModeText: { fontFamily: fonts.regular, fontSize: 13.5, color: colors.textSecondary },
  switchModeAction: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.accent, textDecorationLine: 'underline' },

  bioBtn: {
    width: 96, height: 96, borderRadius: 48, backgroundColor: colors.accentTintLight,
    borderWidth: 2, borderColor: colors.accent, alignItems: 'center', justifyContent: 'center',
    marginBottom: 16,
  },
  bioLabel: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.accent, marginBottom: 24 },

  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, width: '100%', marginTop: 4, marginBottom: 14 },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.textMuted },

  pinBtn: {
    width: '100%', borderWidth: 1.5, borderColor: colors.accent, backgroundColor: colors.card,
    borderRadius: radii.pill, paddingVertical: 13, marginBottom: 22,
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  pinBtnText: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.accent },
  submitBtnDisabled: { opacity: 0.5 },

  emailFieldWrap: { width: '100%', marginBottom: 4 },
  emailInput: {
    width: '100%', minHeight: 48, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.card,
    borderRadius: radii.lg, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 10,
    fontFamily: fonts.regular, fontSize: 14.5, color: colors.textPrimary, textAlign: 'left', writingDirection: 'ltr',
  },

  errorText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.danger, textAlign: 'center', marginBottom: 16 },
  consentText: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, textAlign: 'center', marginTop: 4, lineHeight: 17 },
  consentLink: { fontFamily: fonts.semiBold, color: colors.textSecondary, textDecorationLine: 'underline' },

  linkBtn: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.textSecondary, textDecorationLine: 'underline' },
});
