import { useState } from 'react';
import { View, Text, StyleSheet, Pressable, Platform, LayoutAnimation, UIManager } from 'react-native';
import * as Location from 'expo-location';
import DateTimePicker from '@react-native-community/datetimepicker';
import {
  FILTER_SCHEMA, REGION_OPTIONS, RADIUS_OPTIONS, WHEN_OPTIONS, HOUR_OPTIONS, DEFAULT_FILTERS,
} from '../constants/filterSchema';
import { countForKey } from '../lib/filterActivities';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { ChevronDownIcon, LocationPinIcon } from './icons';
import CityAutocomplete from './CityAutocomplete';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const animate = () => LayoutAnimation.configureNext(LayoutAnimation.create(220, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));

function Chip({ label, selected, onPress }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, selected && styles.chipSelected]}>
      <Text style={[styles.chipText, selected && styles.chipTextSelected]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

function ChipsGrid({ options, value, multiple, onChange }) {
  const toggle = (id) => {
    animate();
    if (multiple) {
      onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
    } else {
      onChange(value.includes(id) ? [] : [id]);
    }
  };
  return (
    <View style={styles.chipsWrap}>
      {options.map((opt) => (
        <Chip key={opt.id} label={opt.label} selected={value.includes(opt.id)} onPress={() => toggle(opt.id)} />
      ))}
    </View>
  );
}

function LocationSection({ value, onChange, onCoordsResolved }) {
  const [busy, setBusy] = useState(false);

  const useCurrentLocation = async () => {
    setBusy(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        onChange({ ...value, mode: 'current', radiusKm: value.radiusKm || 10 });
        setBusy(false);
        return;
      }
      const pos = await Location.getCurrentPositionAsync({});
      onCoordsResolved({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
      onChange({ ...value, mode: 'current', radiusKm: value.radiusKm || 10 });
    } catch (e) {
      // אין הרשאה/GPS זמין - נשארים במצב "current" בלי קואורדינטות, הסינון לפי מרחק פשוט לא יוחל
      onChange({ ...value, mode: 'current' });
    }
    setBusy(false);
  };

  return (
    <View>
      {/* מצב 'address' (רחוב מגואוקדד, מגיע רק מ"חיפוש חכם" - lib/smartSearch.js) לא היה מיוצג
          כאן בכלל (רק בצ'יפ הנשלף בעמוד התוצאות) - נמצא בבדיקה שהמשתמש לא יכול לראות/לתקן אותו
          דרך "סינון מתקדם" כמו שסעיף 15 בבקשה דורש. בחירת current/city/region למטה כבר מחליפה
          את ה-mode כרגיל - זו דרך התיקון, בלי UI כפול חדש. */}
      {value.mode === 'address' && (
        <View style={styles.addressBanner}>
          <LocationPinIcon size={13} color={colors.accent} />
          <Text style={styles.addressBannerText} numberOfLines={1}>
            {value.addressLabel} (ברדיוס {value.radiusKm} ק"מ)
          </Text>
          <Pressable onPress={() => { animate(); onChange({ ...value, mode: null }); }} hitSlop={8}>
            <Text style={styles.addressBannerClear}>✕</Text>
          </Pressable>
        </View>
      )}
      <View style={styles.modeRow}>
        <Pressable
          style={[styles.modeBtn, value.mode === 'current' && styles.modeBtnActive]}
          onPress={useCurrentLocation}
          disabled={busy}
        >
          <LocationPinIcon size={13} color={value.mode === 'current' ? colors.accent : colors.textSecondary} />
          <Text style={[styles.modeBtnText, value.mode === 'current' && styles.modeBtnTextActive]}>
            {busy ? 'מאתר...' : 'המיקום הנוכחי שלי'}
          </Text>
        </Pressable>
      </View>

      {value.mode === 'current' && (
        <View style={styles.subSection}>
          <Text style={styles.subLabel}>רדיוס מרחק</Text>
          <View style={styles.chipsWrap}>
            {RADIUS_OPTIONS.map((r) => (
              <Chip key={r.id} label={r.label} selected={value.radiusKm === r.km} onPress={() => { animate(); onChange({ ...value, radiusKm: r.km }); }} />
            ))}
          </View>
        </View>
      )}

      <View style={styles.subSection}>
        <Text style={styles.subLabel}>עיר / יישוב</Text>
        <CityAutocomplete
          inputStyle={styles.textInput}
          placeholder="הזינו שם עיר..."
          value={value.mode === 'city' ? value.city : ''}
          onChangeText={(t) => onChange({ ...value, mode: t ? 'city' : null, city: t })}
        />
      </View>

      <View style={styles.subSection}>
        <Text style={styles.subLabel}>אזור בארץ</Text>
        <View style={styles.chipsWrap}>
          {REGION_OPTIONS.map((r) => (
            <Chip
              key={r.id}
              label={r.label}
              selected={value.mode === 'region' && value.region.includes(r.id)}
              onPress={() => {
                animate();
                const current = value.mode === 'region' ? value.region : [];
                const next = current.includes(r.id) ? current.filter((x) => x !== r.id) : [...current, r.id];
                onChange({ ...value, mode: next.length ? 'region' : null, region: next });
              }}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

function toHHMM(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function addHours(hhmm, hours) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (h + hours) * 60 + m;
  const wrapped = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

// "מתי" ו"שעה" מאוחדים לסקשן תצוגה אחד (FILTER_SCHEMA כבר לא מכיל 'hour' בנפרד), אבל ממשיכים
// לכתוב לשני מפתחות state נפרדים (filters.when / filters.hour) - בלי לשנות את מבנה הנתונים.
function WhenSection({ value, hourValue, onChangeWhen, onChangeHour }) {
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const options = value.options || [];
  const isSpecificTime = !!hourValue.custom;

  const toggleDay = (id) => {
    animate();
    const isSpecific = id === 'specific';
    const selected = options.includes(id);
    const nextOptions = selected ? options.filter((o) => o !== id) : [...options, id];
    onChangeWhen({ options: nextOptions, date: isSpecific && selected ? null : value.date });
    if (isSpecific && !selected) setShowDatePicker(true);
  };

  const pickHourOption = (id) => {
    animate();
    onChangeHour({ option: hourValue.option === id ? null : id, custom: null });
  };

  const clearHour = () => {
    animate();
    onChangeHour({ option: null, custom: null });
  };

  return (
    <View>
      <Text style={styles.subLabel}>יום</Text>
      <View style={styles.chipsWrap}>
        {WHEN_OPTIONS.map((opt) => (
          <Chip key={opt.id} label={opt.label} selected={options.includes(opt.id)} onPress={() => toggleDay(opt.id)} />
        ))}
      </View>
      {options.includes('specific') && (
        <View style={styles.subSection}>
          <Pressable style={styles.dateBtn} onPress={() => setShowDatePicker(true)}>
            <Text style={styles.dateBtnText}>
              {value.date ? new Date(value.date).toLocaleDateString('he-IL') : 'בחרו תאריך'}
            </Text>
          </Pressable>
          {showDatePicker && (
            <DateTimePicker
              value={value.date ? new Date(value.date) : new Date()}
              mode="date"
              display={Platform.OS === 'ios' ? 'inline' : 'default'}
              minimumDate={new Date()}
              onChange={(event, selected) => {
                setShowDatePicker(Platform.OS === 'ios');
                if (selected) onChangeWhen({ options: options.includes('specific') ? options : [...options, 'specific'], date: selected.toISOString() });
              }}
            />
          )}
        </View>
      )}

      <View style={styles.subSection}>
        <Text style={styles.subLabel}>שעה</Text>
        <View style={styles.chipsWrap}>
          <Chip label="כל היום" selected={!hourValue.option && !hourValue.custom} onPress={clearHour} />
          {HOUR_OPTIONS.map((opt) => (
            <Chip key={opt.id} label={opt.label} selected={hourValue.option === opt.id} onPress={() => pickHourOption(opt.id)} />
          ))}
          <Chip
            label={isSpecificTime ? `שעה ${hourValue.custom.start}` : 'שעה ספציפית'}
            selected={isSpecificTime}
            onPress={() => setShowTimePicker(true)}
          />
        </View>
        {showTimePicker && (
          <DateTimePicker
            value={new Date()}
            mode="time"
            is24Hour
            display={Platform.OS === 'ios' ? 'inline' : 'default'}
            onChange={(event, selected) => {
              setShowTimePicker(Platform.OS === 'ios');
              if (selected) {
                animate();
                const start = toHHMM(selected);
                onChangeHour({ option: null, custom: { start, end: addHours(start, 2) } });
              }
            }}
          />
        )}
      </View>
    </View>
  );
}

// `only` (אופציונלי) - מגביל אילו סקשנים מתוך FILTER_SCHEMA מוצגים (למשל בעמוד "המשפחה שלי",
// שם category/location/age כבר מקבלים שורות ייעודיות משלהם למעלה - אין טעם לשכפל אותם כאן).
// בלי `only`, מתנהג בדיוק כמו קודם ומציג את כל FILTER_SCHEMA.
export default function FiltersSheet({ filters, onChange, onClearAll, onCoordsResolved, only }) {
  const sections = only ? FILTER_SCHEMA.filter((s) => only.includes(s.key)) : FILTER_SCHEMA;
  // כל הסקשנים תמיד מתחילים סגורים - accordion טהור, כל שורה נפתחת/נסגרת רק בלחיצה עליה
  // עצמה (toggleOpen). בעבר סקשן שנפתח דרך "סינון מתקדם" מעמוד הבית פתח את כולם בבת אחת;
  // המשתמש ביקש במפורש שזה תמיד יהיה סגור כברירת מחדל, גם בכניסה הראשונה.
  const [openKeys, setOpenKeys] = useState(() => new Set());

  const toggleOpen = (key) => {
    animate();
    setOpenKeys((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  // מנקה שדה בודד בלי לפתוח את הסקשן - 'when' הוא היחיד שכותב לשני מפתחות (when+hour, ראו
  // countForKey ב-lib/filterActivities.js שסופר את שניהם יחד), אז צריך לאפס את שניהם יחד.
  const clearSection = (key) => {
    animate();
    if (key === 'when') {
      onChange('when', DEFAULT_FILTERS.when);
      onChange('hour', DEFAULT_FILTERS.hour);
      return;
    }
    onChange(key, DEFAULT_FILTERS[key]);
  };

  return (
    <View style={styles.panel}>
      <View style={styles.panelHeader}>
        <Pressable onPress={onClearAll}><Text style={styles.clearAllText}>נקה הכל</Text></Pressable>
        <Text style={styles.panelTitle}>סינון מתקדם</Text>
      </View>

      {sections.map((section) => {
        const isOpen = openKeys.has(section.key);
        const count = countForKey(filters, section.key);
        return (
          <View key={section.key} style={styles.section}>
            <View style={styles.sectionHeader}>
              <Pressable style={styles.sectionHeaderLeft} onPress={() => toggleOpen(section.key)}>
                <Text style={styles.sectionIcon}>{section.icon}</Text>
                <Text style={styles.sectionTitle}>{section.title}</Text>
                {count > 0 && (
                  <View style={styles.countBadge}><Text style={styles.countBadgeText}>{count}</Text></View>
                )}
              </Pressable>
              <View style={styles.sectionHeaderRight}>
                {count > 0 && (
                  <Pressable onPress={() => clearSection(section.key)} hitSlop={8}>
                    <Text style={styles.sectionClearText}>נקה</Text>
                  </Pressable>
                )}
                <Pressable onPress={() => toggleOpen(section.key)} hitSlop={8}>
                  <View style={{ transform: [{ rotate: isOpen ? '180deg' : '0deg' }] }}>
                    <ChevronDownIcon size={13} />
                  </View>
                </Pressable>
              </View>
            </View>

            {isOpen && (
              <View style={styles.sectionBody}>
                {section.type === 'location' && (
                  <LocationSection
                    value={filters.location}
                    onChange={(v) => onChange('location', v)}
                    onCoordsResolved={onCoordsResolved}
                  />
                )}
                {section.type === 'when' && (
                  <WhenSection
                    value={filters.when}
                    hourValue={filters.hour}
                    onChangeWhen={(v) => onChange('when', v)}
                    onChangeHour={(v) => onChange('hour', v)}
                  />
                )}
                {section.type === 'chips' && (
                  <ChipsGrid
                    options={section.options}
                    value={filters[section.key]}
                    multiple={section.multiple}
                    onChange={(v) => onChange(section.key, v)}
                  />
                )}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.card, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.borderLight,
    padding: spacing.md, marginBottom: 18,
  },
  panelHeader: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 10, paddingHorizontal: 4,
  },
  panelTitle: { fontFamily: fonts.extraBold, fontSize: 15, color: colors.textPrimary },
  clearAllText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.danger },

  section: { backgroundColor: colors.bg, borderRadius: radii.md, borderWidth: 1, borderColor: colors.borderLight, marginBottom: 8, overflow: 'hidden' },
  sectionHeader: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', padding: 13 },
  sectionHeaderLeft: { flex: 1, flexDirection: 'row-reverse', alignItems: 'center', gap: 8 },
  sectionHeaderRight: { flexDirection: 'row-reverse', alignItems: 'center', gap: 14 },
  sectionClearText: { fontFamily: fonts.bold, fontSize: 12, color: colors.danger },
  sectionIcon: { fontSize: 15 },
  sectionTitle: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.textPrimary },
  countBadge: { backgroundColor: colors.accent, borderRadius: 10, minWidth: 20, height: 20, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  countBadgeText: { fontFamily: fonts.bold, fontSize: 11, color: '#fff' },
  sectionBody: { paddingHorizontal: 13, paddingBottom: 13 },

  chipsWrap: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 8 },
  chip: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radii.pill, paddingVertical: 8, paddingHorizontal: 13 },
  chipSelected: { backgroundColor: colors.accentTintLight, borderColor: colors.accent },
  chipText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textSecondary },
  chipTextSelected: { color: colors.accent, fontFamily: fonts.bold },

  addressBanner: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 8,
    backgroundColor: colors.accentTintLight, borderRadius: radii.md, padding: 10, marginBottom: 10,
  },
  addressBannerText: { flex: 1, fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.accent, textAlign: 'right' },
  addressBannerClear: { fontFamily: fonts.bold, fontSize: 13, color: colors.accent },
  subSection: { marginTop: 14 },
  subLabel: { fontFamily: fonts.bold, fontSize: 12, color: colors.textSecondary, marginBottom: 8 },
  modeRow: { marginTop: 4 },
  modeBtn: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 8, alignSelf: 'flex-start',
    borderWidth: 1.5, borderColor: colors.border, borderRadius: radii.pill, paddingVertical: 9, paddingHorizontal: 14,
  },
  modeBtnActive: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  modeBtnText: { fontFamily: fonts.bold, fontSize: 13, color: colors.textSecondary },
  modeBtnTextActive: { color: colors.accent },
  textInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 11,
    fontFamily: fonts.regular, fontSize: 13.5, color: colors.textPrimary,
  },
  dateBtn: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 11, alignItems: 'center' },
  dateBtnText: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.accent },
  hint: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, marginTop: 8 },
});
