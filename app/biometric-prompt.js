import { useState, useEffect } from 'react';
import { View, Text, Pressable, ActivityIndicator, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import * as LocalAuthentication from 'expo-local-authentication';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Header from '../components/Header';
import SkyBackground from '../components/SkyBackground';
import { FingerprintIcon, PinIcon } from '../components/icons';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { useI18n, createStyles } from '../lib/i18n';

const ASKED_KEY = 'turu_asked_quick_login';
const BIOMETRIC_ENABLED_KEY = 'turu_biometric_enabled';

export default function BiometricPromptScreen() {
  const router = useRouter();
  const { t } = useI18n();
  const [checkingHardware, setCheckingHardware] = useState(true);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = hasHardware ? await LocalAuthentication.isEnrolledAsync() : false;
      setBiometricAvailable(hasHardware && isEnrolled);
      setCheckingHardware(false);
    })();
  }, []);

  const finishWith = async (next) => {
    await AsyncStorage.setItem(ASKED_KEY, 'true');
    router.replace(next);
  };

  const handleEnableBiometric = async () => {
    setError('');
    setAuthenticating(true);
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: t('auth.biometric.promptMessage'),
    });
    setAuthenticating(false);
    if (!result.success) {
      setError(t('auth.biometric.failed'));
      return;
    }
    await AsyncStorage.setItem(BIOMETRIC_ENABLED_KEY, 'true');
    await finishWith('/');
  };

  const handleUsePinInstead = () => finishWith('/create-pin');
  const handleSkip = () => finishWith('/');

  return (
    <View style={styles.screen}>
      <SkyBackground />
      <View style={styles.content}>
        <Header onMenuPress={() => {}} />

        <View style={styles.center}>
          <View style={styles.iconWrap}>
            <FingerprintIcon size={46} />
          </View>
          <Text style={styles.headline}>{t('auth.biometric.headline')}</Text>
          <Text style={styles.bodyText}>{t('auth.biometric.body')}</Text>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          {checkingHardware ? (
            <ActivityIndicator color={colors.accent} style={{ marginBottom: 16 }} />
          ) : (
            <>
              {biometricAvailable && (
                <Pressable style={styles.primaryBtn} onPress={handleEnableBiometric} disabled={authenticating}>
                  {authenticating ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <>
                      <Text style={styles.primaryBtnText}>{t('auth.biometric.enable')}</Text>
                      <Text style={styles.primaryBtnEmoji}>🦘</Text>
                    </>
                  )}
                </Pressable>
              )}
              {!biometricAvailable && (
                <Text style={styles.noHardwareText}>
                  {/* expo-local-authentication לא נתמך בדפדפן - hasHardwareAsync תמיד false שם, גם בטלפון עם טביעת אצבע */}
                  {Platform.OS === 'web'
                    ? t('auth.biometric.noHardwareWeb')
                    : t('auth.biometric.noHardware')}
                </Text>
              )}
              <Pressable style={styles.pinBtn} onPress={handleUsePinInstead}>
                <PinIcon size={17} />
                <Text style={styles.pinBtnText}>{t('auth.biometric.usePin')}</Text>
              </Pressable>
              <Pressable onPress={handleSkip}>
                <Text style={styles.linkBtn}>{t('auth.biometric.skip')}</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = createStyles((d) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1, padding: spacing.xl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },

  iconWrap: {
    width: 120, height: 120, borderRadius: 60, backgroundColor: colors.accentTintLight,
    alignItems: 'center', justifyContent: 'center', marginBottom: 26,
  },
  headline: { fontFamily: fonts.extraBold, fontSize: 21, color: colors.textPrimary, textAlign: 'center', marginBottom: 12 },
  bodyText: {
    fontFamily: fonts.regular, fontSize: 13.5, lineHeight: 21, color: colors.textSecondary,
    textAlign: 'center', marginBottom: 36, maxWidth: 300,
  },

  errorText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.danger, textAlign: 'center', marginBottom: 16 },
  noHardwareText: { fontFamily: fonts.regular, fontSize: 12, color: colors.textMuted, textAlign: 'center', marginBottom: 16 },

  primaryBtn: {
    width: '100%', backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 15, marginBottom: 14,
    flexDirection: d.row, alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  primaryBtnText: { fontFamily: fonts.bold, fontSize: 16, color: '#fff' },
  primaryBtnEmoji: { fontSize: 16 },

  pinBtn: {
    width: '100%', borderWidth: 1.5, borderColor: colors.accent, backgroundColor: colors.card,
    borderRadius: radii.pill, paddingVertical: 13, marginBottom: 16,
    flexDirection: d.row, alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  pinBtnText: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.accent },

  linkBtn: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.textSecondary },
}));
