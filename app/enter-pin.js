import { useState, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Header from '../components/Header';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { supabase } from '../lib/supabase';
import { verifyPin } from '../lib/pin';
import { enforceNotBanned } from '../lib/checkBanned';

export default function EnterPinScreen() {
  const router = useRouter();
  const { nickname: nicknameParam } = useLocalSearchParams();
  const [nickname, setNickname] = useState(nicknameParam ? String(nicknameParam) : '');
  const [digits, setDigits] = useState(['', '', '', '']);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const inputs = useRef([]);

  useEffect(() => {
    if (nicknameParam) return;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user?.id) return;
      const { data: profile } = await supabase.from('profiles').select('nickname').eq('id', session.user.id).maybeSingle();
      if (profile?.nickname) setNickname(profile.nickname);
    })();
  }, [nicknameParam]);

  const code = digits.join('');

  const handleChange = async (index, value) => {
    const clean = value.replace(/[^0-9]/g, '').slice(-1);
    const next = [...digits];
    next[index] = clean;
    setDigits(next);
    setError('');
    if (clean && index < 3) inputs.current[index + 1]?.focus();

    if (clean && index === 3) {
      const fullCode = next.join('');
      setChecking(true);
      const ok = await verifyPin(fullCode);
      if (ok) {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user?.id && await enforceNotBanned(session.user.id)) {
          setChecking(false);
          setError('החשבון הזה חסום ולא ניתן להשתמש בו יותר');
          setDigits(['', '', '', '']);
          return;
        }
        setChecking(false);
        router.replace('/');
      } else {
        setChecking(false);
        setError('קוד שגוי - נסו שוב');
        setDigits(['', '', '', '']);
        inputs.current[0]?.focus();
      }
    }
  };

  const handleKeyPress = (index, e) => {
    if (e.nativeEvent.key === 'Backspace' && !digits[index] && index > 0) {
      inputs.current[index - 1]?.focus();
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.content}>
        <Header showBack onMenuPress={() => {}} />

        <Text style={styles.headline}>הזינו את קוד ה-PIN שלכם 🔐</Text>
        <Text style={styles.subtext}>שלום שוב{nickname ? ', ' : ''}<Text style={styles.nameText}>{nickname}</Text></Text>

        <View style={styles.codeRow}>
          {digits.map((d, i) => (
            <TextInput
              key={i}
              ref={(el) => { inputs.current[i] = el; }}
              style={[styles.codeBox, d && styles.codeBoxFilled, error && styles.codeBoxError]}
              value={d}
              onChangeText={(v) => handleChange(i, v)}
              onKeyPress={(e) => handleKeyPress(i, e)}
              keyboardType="number-pad"
              maxLength={1}
              textAlign="center"
              secureTextEntry
              editable={!checking}
            />
          ))}
        </View>

        {checking && <ActivityIndicator color={colors.accent} style={{ marginBottom: 16 }} />}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <Pressable onPress={() => router.replace('/login')}>
          <Text style={styles.forgotLink}>שכחתם? התחברות עם קוד בסמס</Text>
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
  nameText: { fontFamily: fonts.bold, color: colors.textPrimary },

  codeRow: { flexDirection: 'row', justifyContent: 'center', gap: 12, marginBottom: 30 },
  codeBox: {
    width: 56, height: 64, borderRadius: radii.lg, borderWidth: 1.5, borderColor: colors.border,
    backgroundColor: colors.card, fontFamily: fonts.extraBold, fontSize: 30, color: colors.textPrimary,
  },
  codeBoxFilled: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  codeBoxError: { borderColor: colors.danger },

  errorText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.danger, textAlign: 'center', marginBottom: 16 },
  forgotLink: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.accent, textAlign: 'center', textDecorationLine: 'underline' },
});
