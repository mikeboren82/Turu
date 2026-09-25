import { useState } from 'react';
import { View, Text, Pressable, Platform, LayoutAnimation, UIManager } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import {
  FILTER_SCHEMA, WHEN_OPTIONS, HOUR_OPTIONS, DEFAULT_FILTERS,
} from '../constants/filterSchema';
import { countForKey } from '../lib/filterActivities';
import { chipsSelectionLabels, whenSelectionLabels, firstValuePlusN } from '../lib/filterSummaries';
import {
  BROWSE_GROUP_OPTIONS, browseSelectionItems, browseSelectionCount, toggleGroupSelection, toggleCategorySelection,
} from '../lib/browseGroups';
import BrowseGroupGrid from './BrowseGroupGrid';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { ChevronDownIcon, ChevronLeftIcon } from './icons';
import LocationQuickPicker, { locationSummary } from './LocationQuickPicker';
import { useI18n, createStyles } from '../lib/i18n';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const animate = () => LayoutAnimation.configureNext(LayoutAnimation.create(220, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));

function Chip({ label, emoji, selected, onPress }) {
  return (
    <Pressable onPress={onPress} style={[emoji ? styles.iconChip : styles.chip, selected && styles.chipSelected]}>
      {emoji ? <Text style={styles.iconChipEmoji}>{emoji}</Text> : null}
      <Text style={[emoji ? styles.iconChipText : styles.chipText, selected && styles.chipTextSelected]} numberOfLines={emoji ? 2 : 1}>
        {label}
      </Text>
    </Pressable>
  );
}

// אופציות-עם-אייקון (כרגע: קטגוריה/"סוג פעילות", היחידה ב-FILTER_SCHEMA עם emoji לכל אופציה) -
// רשת דו-טורית של מלבנים מסודרים (כמו ה-iconGrid הקיים כבר ב-QuickPicker.js, אותה טכניקה בדיוק:
// width:'47%'+radii.md) במקום ה-pills ברוחב-משתנה שהיו נדחסות אחת ליד השנייה בלי סדר - בקשת
// המשתמש: "אמור להראות את האפשרויות בתוך מלבנים מסודרים כמו שהיה בעבר". אופציות בלי emoji (מחיר/
// גיל/הזמנה/משך וכו') ממשיכות עם ה-pills הרגילות - אין שינוי חזותי אצלן.
function ChipsGrid({ options, value, multiple, onChange }) {
  const hasIcons = options.some((o) => o.emoji);
  const toggle = (id) => {
    animate();
    if (multiple) {
      onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
    } else {
      onChange(value.includes(id) ? [] : [id]);
    }
  };
  return (
    <View style={hasIcons ? styles.iconChipsWrap : styles.chipsWrap}>
      {options.map((opt) => (
        <Chip key={opt.id} label={opt.label} emoji={opt.emoji} selected={value.includes(opt.id)} onPress={() => toggle(opt.id)} />
      ))}
    </View>
  );
}

// תקציר-בחירה מכווץ אחיד לכל שורת-פילטר (2026-09-19, בקשת המשתמש: "Every collapsed filter row
// should immediately show the user's current selection(s)... one consistent summary pattern
// across ALL filter rows") - מנגנון יחיד (לא שבעה מימושים נפרדים), לפי section.type:
//   - 'location': locationSummary הקיימת (components/LocationQuickPicker.js) כבר מחזירה מחרוזת
//     שלמה-אחת (כולל "בכל הארץ"/כמה-אזורים-מחוברים-בפסיק) - נקראת ישירות, לא דרך firstValuePlusN
//     (location הוא תמיד ערך-מחויב-בודד, countForKey מחזיר 0/1 בלבד, לא N בחירות עצמאיות).
//   - 'when': whenSelectionLabels (lib/filterSummaries.js) משלבת day+hour לרשימת-תוויות אחת,
//     תואמת בדיוק את countForKey('when') המשולב.
//   - 'chips': chipsSelectionLabels ממפה את הבחירה (בסדר-הבחירה) ל-labels המפוענחים כבר על
//     section.options עצמו (FILTER_SCHEMA) - אין טבלת-תרגום כפולה.
// שלושתם מסתיימים ב-firstValuePlusN: "VALUE" (1) | "VALUE +N" (2+) | null (0, בלי תקציר-מומצא).
// "סוג פעילות" is browse-group aware (lib/browseGroups.js): a complete group is ONE summary unit and
// ONE badge count ("גני שעשועים ופארקים", not "גן שעשועים +1"); exact picks stay canonical labels;
// internal values are never surfaced. filters.category itself stays a canonical array.
function selectionSummaryFor(section, filters) {
  if (section.key === 'category') return firstValuePlusN(browseSelectionItems(filters.category).items.map((i) => i.label));
  if (section.type === 'location') return filters.location?.mode ? locationSummary(filters.location) : null;
  if (section.type === 'when') return firstValuePlusN(whenSelectionLabels(filters.when, filters.hour));
  if (section.type === 'chips') return firstValuePlusN(chipsSelectionLabels(filters[section.key], section.options));
  return null;
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
    if (key === 'category') onChange('categoryAliasPhrases', []);
  };

  // Manual category change (browse group tile / exact member chip): the canonical array changes and
  // any Smart Search soft-recall alias phrases are dropped, so a browse union never over-recalls.
  const setCategory = (next) => {
    animate();
    onChange('category', next);
    onChange('categoryAliasPhrases', []);
  };

  return (
    <View style={styles.panel}>
      <View style={styles.panelHeader}>
        <Pressable onPress={onClearAll} accessibilityRole="button"><Text style={styles.clearAllText}>{t('common.actions.clearAll')}</Text></Pressable>
        <Text style={styles.panelTitle}>{t('filters.sheet.title')}</Text>
      </View>

      {sections.map((section) => {
        const isOpen = openKeys.has(section.key);
        const count = section.key === 'category' ? browseSelectionCount(filters.category) : countForKey(filters, section.key);
        const summary = selectionSummaryFor(section, filters);
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
                {/* קבוצה מוגנת-רוחב (icon+title+badge, flexShrink:0 מפורש - "Be explicit with
                    layout rather than relying on accidental flex-direction behavior") - לעולם לא
                    נדחסת ע"י תקציר-הבחירה שלצידה. sectionSelectionSummary (למטה) הוא היחיד עם
                    flex:1 בשורה הזו, אז הוא זה שסופג/מקצר את עצמו כשאין מספיק מקום, לא הכותרת. */}
                <View style={styles.sectionHeaderLabel}>
                  <Text style={styles.sectionIcon}>{section.icon}</Text>
                  <Text style={styles.sectionTitle}>{section.title}</Text>
                  {count > 0 && (
                    <View style={styles.countBadge}><Text style={styles.countBadgeText}>{count}</Text></View>
                  )}
                </View>
                {/* תקציר-הבחירה המכווץ (ראו selectionSummaryFor למעלה) - על אותה שורה פיזית
                    בדיוק כמו הכותרת/בד"ד (לא שורה נפרדת מתחת, כמו LocationRowValue הישן שהוסר) -
                    numberOfLines=1 + flex:1/minWidth:0 (על sectionSelectionSummary עצמו) מבטיחים
                    קיצוץ-בשלוש-נקודות במקום גלישה לשורה שנייה/דחיסת שאר השורה. */}
                {summary ? (
                  <Text style={styles.sectionSelectionSummary} numberOfLines={1}>{summary}</Text>
                ) : null}
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
                {section.key === 'category' && (
                  <BrowseGroupGrid
                    groups={BROWSE_GROUP_OPTIONS}
                    options={section.options}
                    value={filters.category}
                    onGroupPress={(id) => setCategory(toggleGroupSelection(id, filters.category))}
                    onMemberPress={(id) => setCategory(toggleCategorySelection(id, filters.category))}
                  />
                )}
                {section.type === 'chips' && section.key !== 'category' && (
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
  // gap:8 (חדש) - כשsectionHeaderLeft (flex:1) מכיל תקציר-בחירה ארוך (sectionSelectionSummary,
  // flex:1 גם הוא) שמתקצר/נחתך, בלי gap כאן הוא היה יכול להתמתח עד ממש הפיקסל הראשון של
  // sectionHeaderRight (נקה/שברון) - "..." של הקיצוץ נדבק ישירות ל"נקה" בלי שום רווח. gap (לא
  // margin) בכוונה - לא-כיווני מטבעו (תמיד "בין" הילדים לאורך הציר הראשי, ללא קשר לכיוון-שורה),
  // עקבי עם gap הקיים כבר על sectionHeaderLeft/sectionHeaderRight עצמם באותה שורה בדיוק, ולא
  // marginStart/End (לא בשימוש בשום מקום אחר בקוד-בסיס הזה - האפליקציה מכבה forceRTL ומטפלת
  // בכיוון ידנית דרך d.row, ראו app/_layout.js). על שורות בלי תקציר (רוב הזמן) אין שינוי-נראה-
  // לעין בכלל - כבר היה שם המון רווח-סרק טבעי בין תוכן-קצר לשברון.
  sectionHeader: { flexDirection: d.row, alignItems: 'center', justifyContent: 'space-between', padding: 13, gap: 8 },
  // minWidth:0 (חדש) - חייב על flex:1 מקונן (Yoga/web ברירת-מחדל: flex-item לא מתכווץ מתחת
  // לרוחב-התוכן-הטבעי שלו בלי זה) כדי ש-sectionHeaderLeft באמת יוכל להצטמצם כש-sectionHeaderRight
  // (הבד"ד/נקה/שברון) תופס את המקום שלו - אחרת תקציר-הבחירה החדש (sectionSelectionSummary,
  // למטה) לא היה מקבל הזדמנות להתכווץ/להיחתך בכלל, גם עם numberOfLines=1 עליו.
  sectionHeaderLeft: { flex: 1, minWidth: 0, flexDirection: d.row, alignItems: 'center', gap: 8 },
  // קבוצה מוגנת (icon+title+badge) - flexShrink:0 מפורש: "Be explicit with layout rather than
  // relying on accidental flex-direction behavior" (בקשת המשתמש). לעולם לא נדחסת/מקוצצת ע"י
  // תקציר-הבחירה שלצידה (sectionSelectionSummary, למטה) - היא היחידה שסופגת מחסור-מקום.
  sectionHeaderLabel: { flexDirection: d.row, alignItems: 'center', gap: 8, flexShrink: 0 },
  sectionHeaderRight: { flexDirection: d.row, alignItems: 'center', gap: 14 },
  sectionClearText: { fontFamily: fonts.bold, fontSize: 12, color: colors.danger },
  sectionIcon: { fontSize: 15 },
  sectionTitle: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.textPrimary },
  countBadge: { backgroundColor: colors.accent, borderRadius: 10, minWidth: 20, height: 20, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  countBadgeText: { fontFamily: fonts.bold, fontSize: 11, color: '#fff' },
  // תקציר-הבחירה המכווץ (2026-09-19, בקשת המשתמש: "Every collapsed filter row should immediately
  // show the user's current selection(s)... on THE SAME ROW... single-line truncation / ellipsis
  // if necessary") - flex:1/minWidth:0 (לא sectionHeaderLabel, ראו שם) הוא היחיד בשורה שסופג
  // מקום-נותר/מתכווץ; numberOfLines=1 על ה-Text עצמו (ה-JSX) עושה את הקיצוץ-בפועל. אותם טוקנים
  // בדיוק שהיו על locationValueText הישן (שהוסר - התקציר היה שורה נפרדת מתחת, עכשיו inline כאן),
  // כדי שהמראה החזותי (צבע/גופן/גודל) יישאר זהה, רק המיקום השתנה מתחת-לשורה לתוך-השורה.
  sectionSelectionSummary: {
    flex: 1, minWidth: 0, fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.accent, textAlign: d.textAlign,
  },
  sectionBody: { paddingHorizontal: 13, paddingBottom: 13 },
  excludeSectionTitleRow: { flexDirection: d.row, alignItems: 'center', gap: 8, padding: 13, paddingBottom: 6 },
  excludeRow: {
    flexDirection: d.row, alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 13, paddingVertical: 11,
  },
  excludeRowText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textPrimary, textAlign: d.textAlign },

  chipsWrap: { flexDirection: d.row, flexWrap: 'wrap', gap: 8 },
  chip: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radii.pill, paddingVertical: 8, paddingHorizontal: 13 },
  chipSelected: { backgroundColor: colors.accentTintLight, borderColor: colors.accent },
  chipText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textSecondary },
  chipTextSelected: { color: colors.accent, fontFamily: fonts.bold },

  // רשת-מלבנים לאופציות-עם-אייקון (ראו ChipsGrid למעלה) - אותם טוקנים בדיוק כמו iconGrid/iconRow
  // ב-QuickPicker.js, כדי ש"סוג פעילות" ייראה עקבי עם שאר מקומות-הבחירה-בקטגוריה באפליקציה.
  iconChipsWrap: { flexDirection: d.row, flexWrap: 'wrap', gap: 10, justifyContent: 'space-between' },
  iconChip: {
    width: '47%', flexDirection: d.row, alignItems: 'center', gap: 8,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
    paddingVertical: 11, paddingHorizontal: 10,
  },
  iconChipEmoji: { fontSize: 18, width: 22, textAlign: 'center' },
  iconChipText: { flex: 1, fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textSecondary, textAlign: d.textAlign },

  subSection: { marginTop: 14 },
  subLabel: { fontFamily: fonts.bold, fontSize: 12, color: colors.textSecondary, marginBottom: 8 },
  dateBtn: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 11, alignItems: 'center' },
  dateBtnText: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.accent },
}));
