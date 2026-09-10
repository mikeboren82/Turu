import { useState } from 'react';
import { Modal, View, Text, Pressable, StyleSheet } from 'react-native';
import * as Location from 'expo-location';
import { LocationPinIcon } from './icons';
import CityAutocomplete from './CityAutocomplete';
import { colors, fonts, radii, spacing } from '../constants/theme';

export function locationSummary(location) {
  if (!location) return 'באזור שלי';
  if (location.mode === 'current') return 'המיקום שלי';
  if (location.mode === 'city' && location.city) return location.city;
  // 'address' - כתובת מגואוקדדת מ"חיפוש חכם" (lib/smartSearch.js) - addressLabel כבר מוכן
  // לתצוגה ("הרצל, תל אביב"), עדיין נופל בחזרה לעיר/"באזור שלי" אם חסר משהו.
  if (location.mode === 'address') return location.addressLabel || location.city || 'באזור שלי';
  if (location.mode === 'region' && location.region?.length) return location.region.join(', ');
  return 'באזור שלי';
}

export default function LocationQuickPicker({ visible, value, onChange, onCoordsResolved, onClose }) {
  const [busy, setBusy] = useState(false);

  const useCurrentLocation = async () => {
    setBusy(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        const pos = await Location.getCurrentPositionAsync({});
        onCoordsResolved({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
      }
      onChange({ ...value, mode: 'current', radiusKm: value.radiusKm || 10 });
    } catch {
      onChange({ ...value, mode: 'current' });
    }
    setBusy(false);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>איפה?</Text>
          <Text style={styles.subtitle}>איך למצוא פעילויות לידכם</Text>

          <Pressable style={[styles.modeBtn, value.mode === 'current' && styles.modeBtnActive]} onPress={useCurrentLocation} disabled={busy}>
            <LocationPinIcon size={14} color={value.mode === 'current' ? colors.accent : colors.textSecondary} />
            <Text style={[styles.modeBtnText, value.mode === 'current' && styles.modeBtnTextActive]}>
              {busy ? 'מאתר...' : 'המיקום הנוכחי שלי'}
            </Text>
          </Pressable>

          <Text style={styles.orText}>או</Text>

          <CityAutocomplete
            inputStyle={styles.input}
            placeholder="הזינו שם עיר..."
            value={value.mode === 'city' ? value.city : ''}
            onChangeText={(t) => onChange({ ...value, mode: t ? 'city' : null, city: t })}
            onSubmitEditing={onClose}
          />

          <Pressable style={styles.doneBtn} onPress={onClose}>
            <Text style={styles.doneBtnText}>סיום</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(20,30,35,0.4)', justifyContent: 'center', padding: spacing.xl },
  card: { backgroundColor: colors.card, borderRadius: radii.xl, padding: spacing.xl },
  title: { fontFamily: fonts.extraBold, fontSize: 17, color: colors.textPrimary, textAlign: 'center' },
  subtitle: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: 'center', marginTop: 4, marginBottom: 18 },
  modeBtn: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderWidth: 1.5, borderColor: colors.border, borderRadius: radii.pill, paddingVertical: 12,
  },
  modeBtnActive: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  modeBtnText: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.textSecondary },
  modeBtnTextActive: { color: colors.accent },
  orText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.textMuted, textAlign: 'center', marginVertical: 12 },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12,
    fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, backgroundColor: colors.bg,
  },
  doneBtn: { marginTop: 18, backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 13, alignItems: 'center' },
  doneBtnText: { fontFamily: fonts.bold, fontSize: 14, color: '#fff' },
});
