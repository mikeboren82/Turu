import { useMemo, useState } from 'react';
import { View, TextInput, ScrollView, Pressable, Text, StyleSheet } from 'react-native';
import { ISRAELI_CITIES } from '../constants/israeliCities';
import { colors, fonts, radii } from '../constants/theme';

export default function CityAutocomplete({ value, onChangeText, placeholder, inputStyle, onSubmitEditing }) {
  const [focused, setFocused] = useState(false);

  const suggestions = useMemo(() => {
    const q = (value || '').trim();
    if (!q) return [];
    return ISRAELI_CITIES.filter((c) => c.includes(q)).slice(0, 8);
  }, [value]);

  const showDropdown = focused && suggestions.length > 0;

  return (
    <View style={styles.wrap}>
      <TextInput
        style={[styles.rightAlign, inputStyle]}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        onSubmitEditing={onSubmitEditing}
      />
      {showDropdown && (
        <View style={styles.dropdown}>
          <ScrollView keyboardShouldPersistTaps="handled" style={styles.dropdownScroll}>
            {suggestions.map((city) => (
              <Pressable
                key={city}
                style={styles.dropdownItem}
                onPress={() => {
                  onChangeText(city);
                  setFocused(false);
                }}
              >
                <Text style={styles.dropdownItemText}>{city}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative', zIndex: 20 },
  rightAlign: { textAlign: 'right', writingDirection: 'rtl' },
  dropdown: {
    position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4,
    backgroundColor: colors.card, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    shadowColor: '#000', shadowOpacity: 0.12, shadowOffset: { width: 0, height: 4 }, shadowRadius: 10,
    elevation: 6, overflow: 'hidden', zIndex: 20,
  },
  dropdownScroll: { maxHeight: 200 },
  dropdownItem: { paddingVertical: 10, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
  dropdownItemText: { fontFamily: fonts.regular, fontSize: 13.5, color: colors.textPrimary, textAlign: 'right' },
});
