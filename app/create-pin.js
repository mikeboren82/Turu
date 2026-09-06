import { useState, useRef } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import Header from '../components/Header';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { savePin } from '../lib/pin';

function PinRow({ digits, onChangeDigit, onKeyPress, inputsRef, active }) {
  return (
    <View style={styles.codeRow}>
      {digits.map((d, i) => (
        <TextInput
          key={i}
          ref={(el) => { inputsRef.current[i] = el; }}
          style={[styles.codeBox, d && styles.codeBoxFilled, !active && styles.codeBoxDim]}
          value={d}
          onChangeText={(v) => onChangeDigit(i, v)}
          onKeyPress={(e) => onKeyPress(i, e)}
          keyboardType="number-pad"
          maxLength={1}
          textAlign="center"
          secureTextEntry
          editable={active}
        />
      ))}
    </View>
  );
}

export default function CreatePinScreen() {
  const router = useRouter();
  const [chosen, setChosen] = useState(['', '', '', '']);
  const [confirm, setConfirm] = useState(['', '', '', '']);
  const [confirmActive, setConfirmActive] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const chosenInputs = useRef([]);
  const confirmInputs = useRef([]);

  const chosenCode = chosen.join('');
  const confirmCode = confirm.join('');

  const handleChosenChange = (index, value) => {
    const clean = value.replace(/[^0-9]/g, '').slice(-1);
    const next = [...chosen];
    next[index] = clean;
    setChosen(next);
    setError('');
    if (clean && index < 3) chosenInputs.current[index + 1]?.focus();
    if (clean && index === 3) {
      setConfirmActive(true);
      setTimeout(() => confirmInputs.current[0]?.focus(), 50);
    }
  };

  const handleChosenKeyPress = (index, e) => {
    if (e.nativeEvent.key === 'Backspace' && !chosen[index] && index > 0) {
      chosenInputs.current[index - 1]?.focus();
    }
  };

  const handleConfirmChange = (index, value) => {
    const clean = value.replace(/[^0-9]/g, '').slice(-1);
    const next = [...confirm];
    next[index] = clean;
    setConfirm(next);
    setError('');
    if (clean && index < 3) confirmInputs.current[index + 1]?.focus();
  };

  const handleConfirmKeyPress = (index, e) => {
    if (e.nativeEvent.key === 'Backspace' && !confirm[index] && index > 0) {
      confirmInputs.current[index - 1]?.focus();
    }
  };

  const handleSave = async () => {
    if (chosenCode.length !== 4 || confirmCode.length !== 4) return;
    if (chosenCode !== confirmCode) {
      setError('הקודים לא תואמים - נסו שוב');
      setConfirm(['', '', '', '']);
      confirmInputs.current[0]?.focus();
      return;
    }
    setSaving(true);
    await savePin(chosenCode);
    setSaving(false);
    router.replace('/');
  };

  const canSave = chosenCode.length === 4 && confirmCode.length === 4;

  return (
    <View style={styles.screen}>
      <View style={styles.content}>
        <Header showBack onMenuPress={() => {}} />

        <Text style={styles.headline}>בחרו קוד PIN 🔐</Text>
        <Text style={styles.subtext}>4 ספרות שתשתמשו בהן להתחברות מהירה{'\n'}בפעם הבאה, במקום סמס</Text>

        <View style={styles.pinSection}>
          <Text style={styles.pinLabel}>בחרו קוד</Text>
          <PinRow digits={chosen} onChangeDigit={handleChosenChange} onKeyPress={handleChosenKeyPress} inputsRef={chosenInputs} active />
        </View>

        <View style={styles.pinSection}>
          <Text style={styles.pinLabel}>אשרו שוב</Text>
          <PinRow digits={confirm} onChangeDigit={handleConfirmChange} onKeyPress={handleConfirmKeyPress} inputsRef={confirmInputs} active={confirmActive} />
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <Pressable style={[styles.submitBtn, !canSave && styles.submitBtnDisabled]} onPress={handleSave} disabled={!canSave || saving}>
          {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitBtnText}>שמרו את הקוד</Text>}
        </Pressable>

        <Pressable onPress={() => router.back()}>
          <Text style={styles.cancelLink}>ביטול</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1, padding: spacing.xl },

  headline: { fontFamily: fonts.extraBold, fontSize: 21, color: colors.textPrimary, textAlign: 'center', marginTop: 32, marginBottom: 8 },
  subtext: { fontFamily: fonts.regular, fontSize: 13.5, color: colors.textSecondary, textAlign: 'center', marginBottom: 20, lineHeight: 20 },

  pinSection: { marginBottom: 30 },
  pinLabel: { fontFamily: fonts.extraBold, fontSize: 12.5, color: colors.textSecondary, textAlign: 'center', marginBottom: 12 },

  codeRow: { flexDirection: 'row', justifyContent: 'center', gap: 12 },
  codeBox: {
    width: 56, height: 64, borderRadius: radii.lg, borderWidth: 1.5, borderColor: colors.border,
    backgroundColor: colors.card, fontFamily: fonts.extraBold, fontSize: 30, color: colors.textPrimary,
  },
  codeBoxFilled: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  codeBoxDim: { opacity: 0.35 },

  errorText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.danger, textAlign: 'center', marginBottom: 16 },

  submitBtn: {
    backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 15,
    alignItems: 'center', justifyContent: 'center', marginTop: 6,
  },
  submitBtnDisabled: { opacity: 0.4 },
  submitBtnText: { fontFamily: fonts.bold, fontSize: 16, color: '#fff' },

  cancelLink: { fontFamily: fonts.regular, fontSize: 13, color: colors.textMuted, textAlign: 'center', marginTop: 18 },
});
