import { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import * as LocalAuthentication from 'expo-local-authentication';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Header from '../components/Header';
import { FingerprintIcon, PinIcon } from '../components/icons';
import { colors, fonts, radii, spacing } from '../constants/theme';

const ASKED_KEY = 'wabbit_asked_quick_login';
const BIOMETRIC_ENABLED_KEY = 'wabbit_biometric_enabled';

export default function BiometricPromptScreen() {
  const router = useRouter();
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
      promptMessage: 'אמתו את הזהות שלכם כדי להפעיל כניסה מהירה',
    });
    setAuthenticating(false);
    if (!result.success) {
      setError('לא הצלחנו לאמת - אפשר לנסות שוב, או לבחור קוד PIN במקום');
      return;
    }
    await AsyncStorage.setItem(BIOMETRIC_ENABLED_KEY, 'true');
    await finishWith('/');
  };

  const handleUsePinInstead = () => finishWith('/create-pin');
  const handleSkip = () => finishWith('/');

  return (
    <View style={styles.screen}>
      <View style={styles.content}>
        <Header onMenuPress={() => {}} />

        <View style={styles.center}>
          <View style={styles.iconWrap}>
            <FingerprintIcon size={46} />
          </View>
          <Text style={styles.headline}>כניסה מהירה בפעם הבאה?</Text>
          <Text style={styles.bodyText}>
            נזהה אתכם עם טביעת אצבע או זיהוי פנים, כדי שלא תצטרכו לחכות לסמס בכל פעם. תמיד אפשר לכבות את זה בהגדרות.
          </Text>

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
                      <Text style={styles.primaryBtnText}>כן, בואו נעשה את זה!</Text>
                      <Text style={styles.primaryBtnEmoji}>🦘</Text>
                    </>
                  )}
                </Pressable>
              )}
              {!biometricAvailable && (
                <Text style={styles.noHardwareText}>המכשיר הזה לא תומך בזיהוי ביומטרי, אבל אפשר להגדיר קוד PIN</Text>
              )}
              <Pressable style={styles.pinBtn} onPress={handleUsePinInstead}>
                <PinIcon size={17} />
                <Text style={styles.pinBtnText}>הגדירו קוד PIN במקום</Text>
              </Pressable>
              <Pressable onPress={handleSkip}>
                <Text style={styles.linkBtn}>אולי בפעם אחרת</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  primaryBtnText: { fontFamily: fonts.bold, fontSize: 16, color: '#fff' },
  primaryBtnEmoji: { fontSize: 16 },

  pinBtn: {
    width: '100%', borderWidth: 1.5, borderColor: colors.accent, backgroundColor: colors.card,
    borderRadius: radii.pill, paddingVertical: 13, marginBottom: 16,
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  pinBtnText: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.accent },

  linkBtn: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.textSecondary },
});
