import { useState } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Header from '../components/Header';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { supabase } from '../lib/supabase';
import { enforceNotBanned } from '../lib/checkBanned';

export default function AdminLoginScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async () => {
    if (!email.trim() || !password) return;
    setSubmitting(true);
    setError('');
    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (signInError) {
      setSubmitting(false);
      setError('שגיאה בהתחברות: ' + signInError.message);
      return;
    }

    if (data?.user?.id && await enforceNotBanned(data.user.id)) {
      setSubmitting(false);
      setError('החשבון הזה חסום ולא ניתן להשתמש בו יותר');
      return;
    }

    const [asked, pinEnabled, biometricEnabled] = await Promise.all([
      AsyncStorage.getItem('turu_asked_quick_login'),
      AsyncStorage.getItem('turu_pin_enabled'),
      AsyncStorage.getItem('turu_biometric_enabled'),
    ]);
    const alreadySetUp = pinEnabled === 'true' || biometricEnabled === 'true';
    setSubmitting(false);
    router.replace(asked === 'true' || alreadySetUp ? '/' : '/biometric-prompt');
  };

  return (
    <View style={styles.screen}>
      <View style={styles.content}>
        <Header showBack onMenuPress={() => {}} />

        <Text style={styles.headline}>כניסת מנהל 🦘</Text>
        <Text style={styles.subtext}>התחברות עם אימייל וסיסמה</Text>

        <View style={styles.field}>
          <Text style={styles.label}>אימייל</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            textContentType="emailAddress"
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>סיסמה</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            textContentType="password"
          />
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <Pressable
          style={[styles.submitBtn, (!email.trim() || !password) && styles.submitBtnDisabled]}
          onPress={handleLogin}
          disabled={!email.trim() || !password || submitting}
        >
          {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitBtnText}>התחברות</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1, padding: spacing.xl },

  headline: { fontFamily: fonts.extraBold, fontSize: 21, color: colors.textPrimary, textAlign: 'center', marginTop: 40, marginBottom: 8 },
  subtext: { fontFamily: fonts.regular, fontSize: 13.5, color: colors.textSecondary, textAlign: 'center', marginBottom: 32 },

  field: { marginBottom: 16 },
  label: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.textSecondary, marginBottom: 6 },
  input: {
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.card, borderRadius: radii.lg,
    paddingHorizontal: 14, paddingVertical: 12, fontFamily: fonts.regular, fontSize: 14.5, color: colors.textPrimary,
    textAlign: 'left',
  },

  errorText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.danger, textAlign: 'center', marginBottom: 16, marginTop: 4 },

  submitBtn: {
    backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 15,
    alignItems: 'center', justifyContent: 'center', marginTop: 8,
  },
  submitBtnDisabled: { opacity: 0.5 },
  submitBtnText: { fontFamily: fonts.bold, fontSize: 16, color: '#fff' },
});
