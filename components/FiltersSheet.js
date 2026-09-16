import { useState } from 'react';
import { View, Text, Pressable, Platform, LayoutAnimation, UIManager } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import {
  FILTER_SCHEMA, WHEN_OPTIONS, HOUR_OPTIONS, DEFAULT_FILTERS,
} from '../constants/filterSchema';
import { countForKey } from '../lib/filterActivities';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { ChevronDownIcon, ChevronLeftIcon } from './icons';
import LocationQuickPicker, { locationSummary } from './LocationQuickPicker';
import { useI18n, createStyles } from '../lib/i18n';

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

// סקשן "מיקום" (2026-09-16, בקשת המשתמש): לא עוד UI מקומי משלו (היה כאן LocationSection נפרד עם
// GPS+רדיוס+עיר+צ'יפי-אזור מרובי-בחירה) - לחיצה על השורה פותחת את *אותו* LocationQuickPicker בדיוק
// שעמוד הבית ("איפה נח לכם?") ועמוד הפרופיל משתמשים בו: מקור-אמת אחד לבחירת מיקום/מרחק/"בכל הארץ".
// מודל הנתונים (location.region כמערך) לא השתנה - רק ה-UI אוחד; ראו ההערה ליד selectRegion שם.
function LocationRowValue({ value }) {
  if (!value?.mode) return null;
  return <Text style={styles.locationValueText} numberOfLines={1}>{locationSummary(value)}</Text>;
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
  const { t, formatDate } = useI18n();
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
      <Text style={styles.subLabel}>{t('filters.when.dayLabel')}</Text>
      <View style={styles.chipsWrap}>
        {WHEN_OPTIONS.map((opt) => (
          <Chip key={opt.id} label={opt.label} selected={options.includes(opt.id)} onPress={() => toggleDay(opt.id)} />
        ))}
      </View>
      {options.includes('specific') && (
        <View style={styles.subSection}>
          <Pressable style={styles.dateBtn} onPress={() => setShowDatePicker(true)}>
            <Text style={styles.dateBtnText}>
              {value.date ? formatDate(value.date) : t('filters.when.pickDate')}
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
        <Text style={styles.subLabel}>{t('filters.when.hourLabel')}</Text>
        <View style={styles.chipsWrap}>
          <Chip label={t('filters.when.allDay')} selected={!hourValue.option && !hourValue.custom} onPress={clearHour} />
          {HOUR_OPTIONS.map((opt) => (
            <Chip key={opt.id} label={opt.label} selected={hourValue.option === opt.id} onPress={() => pickHourOption(opt.id)} />
          ))}
          <Chip
            label={isSpecificTime ? t('filters.when.hourAt', { time: hourValue.custom.start }) : t('filters.when.specificHour')}
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
export default function FiltersSheet({
  filters, onChange, onClearAll, onCoordsResolved, deviceCoords = null, only,
  hiddenCategoryCount = 0, hiddenAreaCount = 0, onOpenExcludeCategories, onOpenExcludeAreas,
}) {
  const { t, dir } = useI18n();
  const sections = only ? FILTER_SCHEMA.filter((s) => only.includes(s.key)) : FILTER_SCHEMA;
  // "מיקום" לא נפתח כ-accordion אלא כ-LocationQuickPicker (ראו LocationRowValue למעלה)
  const [locationPickerOpen, setLocationPickerOpen] = useState(false);
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
  const openSection = (key) => (key === 'location' ? setLocationPickerOpen(true) : toggleOpen(key));

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
        <Pressable onPress={onClearAll} accessibilityRole="button"><Text style={styles.clearAllText}>{t('common.actions.clearAll')}</Text></Pressable>
        <Text style={styles.panelTitle}>{t('filters.sheet.title')}</Text>
      </View>

      {sections.map((section) => {
        const isOpen = openKeys.has(section.key);
        const count = countForKey(filters, section.key);
        return (
          <View key={section.key} style={styles.section}>
            <View style={styles.sectionHeader}>
              <Pressable
                style={styles.sectionHeaderLeft}
                onPress={() => openSection(section.key)}
                accessibilityRole="button"
                accessibilityState={section.key === 'location' ? undefined : { expanded: isOpen }}
                accessibilityLabel={count > 0 ? t('filters.sheet.a11y.sectionWithCount', { title: section.title, count }) : section.title}
              >
                <Text style={styles.sectionIcon}>{section.icon}</Text>
                <Text style={styles.sectionTitle}>{section.title}</Text>
                {count > 0 && (
                  <View style={styles.countBadge}><Text style={styles.countBadgeText}>{count}</Text></View>
                )}
              </Pressable>
              <View style={styles.sectionHeaderRight}>
                {count > 0 && (
                  <Pressable onPress={() => clearSection(section.key)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('filters.sheet.a11y.clearSection', { title: section.title })}>
                    <Text style={styles.sectionClearText}>{t('filters.sheet.clearSection')}</Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={() => openSection(section.key)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t(isOpen ? 'filters.sheet.a11y.collapse' : 'filters.sheet.a11y.expand', { title: section.title })}
                >
                  <View style={{ transform: [{ rotate: isOpen ? '180deg' : '0deg' }] }}>
                    <ChevronDownIcon size={13} />
                  </View>
                </Pressable>
              </View>
            </View>

            {section.type === 'location' ? <LocationRowValue value={filters.location} /> : null}
            {isOpen && (
              <View style={styles.sectionBody}>
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

      {/* "החרגות" - "🚫 הסר פעילויות"/"⛔ הסר אזורים" עברו לכאן מהראש של עמוד התוצאות (בקשת
          המשתמש, סעיף 11: "אלה advanced filters, הם לא צריכים להיות visible controls קבועים
          במסך התוצאות"). אותם handlers/modals/state בדיוק (app/activities.js) - השורות כאן רק
          קוראות להם דרך ה-props, בלי לוגיקת-הסתרה חדשה. לא accordion (בניגוד לסקשני FILTER_SCHEMA
          למעלה) - לחיצה פותחת ישירות את אותו QuickPicker/ExcludeAreasPicker שהיה קיים תמיד. */}
      {(onOpenExcludeCategories || onOpenExcludeAreas) && (
        <View style={styles.section}>
          <View style={styles.excludeSectionTitleRow}>
            <Text style={styles.sectionIcon}>🚫</Text>
            <Text style={styles.sectionTitle}>{t('filters.sheet.exclusions.title')}</Text>
          </View>
          {onOpenExcludeCategories && (
            <Pressable style={styles.excludeRow} onPress={onOpenExcludeCategories}>
              <Text style={styles.excludeRowText}>
                {hiddenCategoryCount > 0 ? t('filters.sheet.exclusions.hiddenCategories', { count: hiddenCategoryCount }) : t('filters.sheet.exclusions.categoriesEmpty')}
              </Text>
              <View style={{ transform: [{ rotate: dir.forwardRotate }] }}><ChevronLeftIcon size={13} /></View>
            </Pressable>
          )}
          {onOpenExcludeAreas && (
            <Pressable style={styles.excludeRow} onPress={onOpenExcludeAreas}>
              <Text style={styles.excludeRowText}>
                {hiddenAreaCount > 0 ? t('filters.sheet.exclusions.hiddenAreas', { count: hiddenAreaCount }) : t('filters.sheet.exclusions.areasEmpty')}
              </Text>
              <View style={{ transform: [{ rotate: dir.forwardRotate }] }}><ChevronLeftIcon size={13} /></View>
            </Pressable>
          )}
        </View>
      )}

      {/* אותו רכיב בדיוק כמו "איפה נח לכם?" בעמוד הבית - Modal מעל ה-sheet (RN תומך ב-Modal מקונן). */}
      <LocationQuickPicker
        visible={locationPickerOpen}
        value={filters.location}
        onChange={(v) => onChange('location', v)}
        onCoordsResolved={onCoordsResolved}
        onClose={() => setLocationPickerOpen(false)}
        deviceCoords={deviceCoords}
      />
    </View>
  );
}

const styles = createStyles((d) => ({
  panel: {
    backgroundColor: colors.card, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.borderLight,
    padding: spacing.md, marginBottom: 18,
  },
  // Fixed on purpose: Hebrew keeps its approved order; English gets the conventional title-left / action-right.
  panelHeader: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 10, paddingHorizontal: 4,
  },
  panelTitle: { fontFamily: fonts.extraBold, fontSize: 15, color: colors.textPrimary },
  clearAllText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.danger },

  section: { backgroundColor: colors.bg, borderRadius: radii.md, borderWidth: 1, borderColor: colors.borderLight, marginBottom: 8, overflow: 'hidden' },
  sectionHeader: { flexDirection: d.row, alignItems: 'center', justifyContent: 'space-between', padding: 13 },
  sectionHeaderLeft: { flex: 1, flexDirection: d.row, alignItems: 'center', gap: 8 },
  sectionHeaderRight: { flexDirection: d.row, alignItems: 'center', gap: 14 },
  sectionClearText: { fontFamily: fonts.bold, fontSize: 12, color: colors.danger },
  sectionIcon: { fontSize: 15 },
  sectionTitle: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.textPrimary },
  countBadge: { backgroundColor: colors.accent, borderRadius: 10, minWidth: 20, height: 20, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  countBadgeText: { fontFamily: fonts.bold, fontSize: 11, color: '#fff' },
  sectionBody: { paddingHorizontal: 13, paddingBottom: 13 },
  excludeSectionTitleRow: { flexDirection: d.row, alignItems: 'center', gap: 8, padding: 13, paddingBottom: 6 },
  excludeRow: {
    flexDirection: d.row, alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 13, paddingVertical: 11,
  },
  excludeRowText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textPrimary, textAlign: d.textAlign },
  // הערך הנוכחי של "מיקום" מוצג מתחת לכותרת-השורה (אין לו accordion להיפתח אליו - הלחיצה פותחת
  // את LocationQuickPicker), באותם טוקנים כמו chipText כדי שייקרא כחלק מהשורה ולא כטקסט זר.
  locationValueText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.accent, textAlign: d.textAlign, paddingHorizontal: 13, paddingBottom: 12, marginTop: -6 },

  chipsWrap: { flexDirection: d.row, flexWrap: 'wrap', gap: 8 },
  chip: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radii.pill, paddingVertical: 8, paddingHorizontal: 13 },
  chipSelected: { backgroundColor: colors.accentTintLight, borderColor: colors.accent },
  chipText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textSecondary },
  chipTextSelected: { color: colors.accent, fontFamily: fonts.bold },

  subSection: { marginTop: 14 },
  subLabel: { fontFamily: fonts.bold, fontSize: 12, color: colors.textSecondary, marginBottom: 8 },
  dateBtn: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 11, alignItems: 'center' },
  dateBtnText: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.accent },
}));
