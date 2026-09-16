import { useMemo, useState } from 'react';
import { View, TextInput, ScrollView, Pressable, Text } from 'react-native';
import { ISRAELI_CITIES } from '../constants/israeliCities';
import { colors, fonts, radii } from '../constants/theme';
import { useI18n, createStyles } from '../lib/i18n';
import { placeName } from '../lib/i18n/format';

export default function CityAutocomplete({ value, onChangeText, placeholder, inputStyle, onSubmitEditing }) {
  const { locale } = useI18n();
  const [focused, setFocused] = useState(false);

  // הערך (value) נשאר תמיד שם-היישוב הקנוני בעברית; באנגלית אפשר לחפש גם לפי השם המתורגם.
  const suggestions = useMemo(() => {
    const q = (value || '').trim();
    if (!q) return [];
    const lower = q.toLowerCase();
    return ISRAELI_CITIES.filter((c) => c.includes(q) || (locale !== 'he' && placeName(c).toLowerCase().includes(lower))).slice(0, 8);
  }, [value, locale]);

  const showDropdown = focused && suggestions.length > 0;

  // The input shows the display name (English in English UI), while the value handed to the parent
  // stays the canonical Hebrew city: an exact English name typed by hand maps back to it too.
  const handleChangeText = (text) => {
    if (locale !== 'he') {
      const exact = ISRAELI_CITIES.find((c) => placeName(c).toLowerCase() === text.trim().toLowerCase());
      if (exact) return onChangeText(exact);
    }
    return onChangeText(text);
  };

  return (
    <View style={styles.wrap}>
      <TextInput
        style={[styles.rightAlign, inputStyle]}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        value={placeName(value || '')}
        onChangeText={handleChangeText}
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
                <Text style={styles.dropdownItemText}>{placeName(city)}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

const styles = createStyles((d) => ({
  wrap: { position: 'relative', zIndex: 20 },
  rightAlign: { textAlign: d.textAlign, writingDirection: d.writingDirection },
  dropdown: {
    position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4,
    backgroundColor: colors.card, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    shadowColor: '#000', shadowOpacity: 0.12, shadowOffset: { width: 0, height: 4 }, shadowRadius: 10,
    elevation: 6, overflow: 'hidden', zIndex: 20,
  },
  dropdownScroll: { maxHeight: 200 },
  dropdownItem: { paddingVertical: 10, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
  dropdownItemText: { fontFamily: fonts.regular, fontSize: 13.5, color: colors.textPrimary, textAlign: d.textAlign },
}));
