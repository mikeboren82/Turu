import { useMemo, useState } from 'react';
import {
  View, Text, Pressable, Linking, Platform, LayoutAnimation, UIManager,
} from 'react-native';
import { ClockIcon, ChevronDownIcon } from './icons';
import { colors, fonts, radii } from '../constants/theme';
import { useI18n, createStyles } from '../lib/i18n';
import {
  hoursStatusText, hoursTodayWarningText, hoursDayWarningText, hoursDayLabelParts, hoursDayHolidayName,
  hoursSharedWarningNote, hoursDayValueText,
} from '../lib/i18n/format';
import { buildTodayStatus, buildUpcomingDays } from '../lib/hoursDisplay';

// Opening Hours Phase 2 (2026-09-20) - the primary hours/status experience on Activity Detail,
// replacing the old 3rd InfoCell (activity.hours via scheduleHoursLabel, which showed the
// flattened openHours envelope - architecture audit's confirmed display bug) and cleanly
// separating THREE distinct activity shapes (task section 5/12), never rendering one as the other:
//   'weekly'     - a status row + expandable next-7-Israel-calendar-days view (this file's main job)
//   'occurrence' - a status row naming the next real dated performance (its own list of further
//                  dates, if any, is the existing "📅 מועדים קרובים" section elsewhere on this
//                  screen - untouched, still gated on occurrences.length > 1)
//   'unknown'    - a plain "hours not specified" row, not tappable, no chevron
//
// "now" is captured once per mount (not a ticking clock) - the Detail screen is revisited often
// enough (navigation back/forward) that a live-updating timer isn't worth the complexity here.
//
// Visual polish pass (2026-09-20, "Weekly Hours visual polish" - presentation only, no calendar/
// resolver/policy logic touched): same LayoutAnimation pattern components/FiltersSheet.js already
// uses for its own expand/collapse, not a new animation dependency.
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
const animateExpand = () => LayoutAnimation.configureNext(LayoutAnimation.create(220, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));

export default function WeeklyHoursSection({ activity }) {
  const { t, dir } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const now = useMemo(() => new Date(), []);

  const days = useMemo(() => buildUpcomingDays(activity, { now }), [activity, now]);
  const status = useMemo(() => buildTodayStatus(activity, { now, days }), [activity, now, days]);
  const kind = days[0].kind;

  if (kind === 'unknown') {
    return (
      <View style={styles.plainRow}>
        <ClockIcon size={16} color={colors.textSecondary} />
        <Text style={styles.plainRowText}>{t('domain.schedule.hoursNotSpecified')}</Text>
      </View>
    );
  }

  if (kind === 'occurrence') {
    return <OccurrenceStatusRow activity={activity} t={t} dir={dir} />;
  }

  // kind === 'weekly' (recurring/fixed_hours alike, see lib/hoursDisplay.js#displayKind)
  const todayWarningText = hoursTodayWarningText(status);
  // Repetition control (task section 6): a single warning-worthy date still gets its own full
  // sentence on its own row (the "compact warning associated with that row"); once MORE than one
  // date in the currently-expanded week is affected, every affected row keeps only a small marker
  // and one shared note explains what it means, once, below the whole list - never silently
  // dropped, never implied to cover all seven days.
  const warnedCount = days.reduce((n, d) => n + (d.warning ? 1 : 0), 0);
  const useSharedWarning = warnedCount > 1;

  const toggleExpanded = () => {
    animateExpand();
    setExpanded((e) => !e);
  };

  return (
    <View style={styles.section}>
      <Pressable
        onPress={toggleExpanded}
        style={({ pressed }) => [styles.headerRow, pressed && styles.headerRowPressed]}
        hitSlop={4}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={t(expanded ? 'activity.hours.collapseA11y' : 'activity.hours.expandA11y')}
      >
        <ClockIcon size={16} color={colors.textSecondary} />
        <View style={styles.headerTextWrap}>
          <Text style={styles.statusText} numberOfLines={1}>{hoursStatusText(status)}</Text>
          {todayWarningText ? <Text style={styles.warningText} numberOfLines={2}>{todayWarningText}</Text> : null}
        </View>
        <View style={[styles.chevronWrap, expanded && styles.chevronWrapExpanded]}>
          <ChevronDownIcon size={13} color={colors.accent} />
        </View>
      </Pressable>
      {expanded ? (
        <View style={styles.daysList}>
          {days.map((day, i) => {
            const parts = hoursDayLabelParts(day);
            const holidayName = hoursDayHolidayName(day);
            const showFullWarning = day.warning && !useSharedWarning;
            const showWarningMarker = day.warning && useSharedWarning;
            return (
              <View key={day.date}>
                {i > 0 ? <View style={styles.divider} /> : null}
                <View style={styles.dayRow}>
                  <View style={styles.dayIdentityCol}>
                    <View style={styles.dayLabelRow}>
                      {day.isToday ? <View style={styles.todayDot} /> : null}
                      <Text style={[styles.dayLabel, day.isToday && styles.dayLabelToday]} numberOfLines={1}>
                        {day.isToday ? <Text style={styles.dayLabelPrefixToday}>{parts.prefix}</Text> : parts.prefix}
                        {parts.prefix ? `, ${parts.weekday}` : parts.weekday}
                      </Text>
                    </View>
                    {holidayName ? <Text style={styles.holidayName} numberOfLines={1}>{holidayName}</Text> : null}
                  </View>
                  <View style={styles.dayValueCol}>
                    <View style={styles.dayValueRow}>
                      <Text
                        style={[
                          styles.dayValue,
                          // "שעות לא ידועות" must read quieter than a real, known time range, and
                          // must not share "סגור"'s visual weight (task section 9) - state:'unknown'
                          // is the only branch this touches; open/always_open/closed keep the same
                          // solid, legible weight as each other.
                          day.state === 'unknown' && styles.dayValueUnknown,
                          day.isToday && day.state !== 'unknown' && styles.dayValueToday,
                        ]}
                        numberOfLines={2}
                      >
                        {hoursDayValueText(day)}
                      </Text>
                      {showWarningMarker ? (
                        <Text accessibilityLabel={hoursDayWarningText()} style={styles.dayWarningDot}>⚠</Text>
                      ) : null}
                    </View>
                    {showFullWarning ? <Text style={styles.dayWarning} numberOfLines={1}>{hoursDayWarningText()}</Text> : null}
                  </View>
                </View>
              </View>
            );
          })}
          {useSharedWarning ? <Text style={styles.sharedWarningNote}>{hoursSharedWarningNote()}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

// A dated event's status line - the next real performance's own date+time (never the flattened
// openHours envelope, task section 12). No expand affordance: the fuller occurrence list (when
// there is more than one upcoming date) already lives in its own section elsewhere on this screen.
function OccurrenceStatusRow({ activity, t, dir }) {
  const next = activity.occurrences?.[0];
  if (!next) {
    return (
      <View style={styles.plainRow}>
        <ClockIcon size={16} color={colors.textSecondary} />
        <Text style={styles.plainRowText}>{t('domain.schedule.hoursNotSpecified')}</Text>
      </View>
    );
  }
  const dateText = new Date(next.date).toLocaleDateString(dir.isRTL ? 'he-IL' : 'en-IL', { weekday: 'short', day: 'numeric', month: 'numeric' });
  const timeText = next.start ? ` · ${next.start}${next.end ? `–${next.end}` : ''}` : '';
  return (
    <View style={styles.plainRow}>
      <ClockIcon size={16} color={colors.textSecondary} />
      <Text style={styles.plainRowText} numberOfLines={1}>
        {t('activity.hours.nextOccurrenceLabel')}: {dateText}{timeText}
      </Text>
      {next.bookingUrl ? (
        <Pressable onPress={() => Linking.openURL(next.bookingUrl)} hitSlop={8}>
          <Text style={styles.occurrenceBuyLink}>{t('activity.detail.occurrenceBuy')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = createStyles((d) => ({
  section: { marginBottom: 18 },
  plainRow: { flexDirection: d.row, alignItems: 'center', gap: 8, marginBottom: 18 },
  plainRowText: { flex: 1, fontFamily: fonts.semiBold, fontSize: 13.5, color: colors.textSecondary, textAlign: d.textAlign },
  occurrenceBuyLink: { fontFamily: fonts.bold, fontSize: 13, color: colors.accent },

  headerRow: { flexDirection: d.row, alignItems: 'center', gap: 10, paddingVertical: 7 },
  headerRowPressed: { opacity: 0.7 },
  headerTextWrap: { flex: 1, gap: 2 },
  statusText: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.textPrimary, textAlign: d.textAlign, fontVariant: ['tabular-nums'] },
  // warn (#b76b1c, amber) - not danger/red: an ordinary-hours-may-vary note is useful context, not
  // an alarm (task section 9: "restrained, not alarming... no red/error styling"). fonts.medium
  // (not semiBold) + slightly smaller than the pass before this one - softer, less assertive next
  // to the status line it sits under.
  warningText: { fontFamily: fonts.medium, fontSize: 11.5, color: colors.warn, textAlign: d.textAlign },
  chevronWrap: { transform: [{ rotate: '0deg' }], padding: 2 },
  chevronWrapExpanded: { transform: [{ rotate: '180deg' }] },

  daysList: { marginTop: 10, marginHorizontal: -2 },
  dayRow: { flexDirection: d.row, alignItems: 'flex-start', justifyContent: 'space-between', paddingVertical: 10, gap: 10 },
  dayIdentityCol: { flexShrink: 1, gap: 1 },
  dayLabelRow: { flexDirection: d.row, alignItems: 'center', gap: 5 },
  // todayDot - the "tiny blue indicator" direction from the brief, preferred over a background
  // tint or badge: reads clearly at a glance without adding a box around the row.
  todayDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
  // dayLabel ("day/date context" - task section 3's "primary identity" column) - textPrimary, not
  // the muted textSecondary the pre-polish version used: this is the thing being scanned, not a
  // caption. Only weight (not color) changes for today; the accent color is reserved for the
  // "היום"/"מחר" prefix word itself (dayLabelPrefixToday) so it doesn't repeat down every row.
  dayLabel: { fontFamily: fonts.semiBold, fontSize: 13.5, color: colors.textPrimary, textAlign: d.textAlign },
  dayLabelToday: { fontFamily: fonts.bold },
  dayLabelPrefixToday: { color: colors.accent },
  // holidayName - its own secondary line under the day label (task section 5), not appended to it
  // with " · ". Reuses colors.warn (the same warm/amber already used for the hours-may-vary
  // warning elsewhere in this file) - holiday name and warning are two different concepts, kept
  // apart structurally (separate line, no icon here) rather than by inventing a second hue.
  holidayName: { fontFamily: fonts.medium, fontSize: 11.5, color: colors.warn, textAlign: d.textAlign },
  dayValueCol: { alignItems: d.alignEnd, flexShrink: 0, maxWidth: '55%' },
  dayValueRow: { flexDirection: d.row, alignItems: 'center', gap: 4 },
  dayValue: { fontFamily: fonts.semiBold, fontSize: 13.5, color: colors.textPrimary, textAlign: d.textAlignEnd, fontVariant: ['tabular-nums'] },
  dayValueToday: { fontFamily: fonts.bold, color: colors.accent },
  // dayValueUnknown - quieter than a real known time range and NOT the same weight as "סגור"
  // (task section 9): regular weight + the muted secondary tone, vs. dayValue's semiBold/textPrimary
  // for anything actually known (open hours or a definite closed day).
  dayValueUnknown: { fontFamily: fonts.regular, color: colors.textMuted },
  dayWarning: { fontFamily: fonts.medium, fontSize: 11, color: colors.warn, textAlign: d.textAlignEnd, marginTop: 2 },
  // dayWarningDot - the compact per-row marker used once >1 date in the visible week is affected
  // (task section 6), so the specific-row relationship survives even after the full sentence moves
  // to one shared note below the list. accessibilityLabel carries the full sentence regardless of
  // the compact glyph shown sighted users (task section 12: warning meaning must not depend on a
  // glyph/color alone for anyone using a screen reader).
  dayWarningDot: { fontSize: 12, color: colors.warn, lineHeight: 16 },
  // sharedWarningNote - one explanation for the whole list instead of repeating the full sentence
  // under every affected row; still names WHICH kind of dates it refers to ("chagim/erev"), not a
  // blanket "some hours may be wrong" that would blur into the ordinary days above it.
  sharedWarningNote: { fontFamily: fonts.medium, fontSize: 11.5, color: colors.warn, textAlign: d.textAlign, marginTop: 8 },
  // inset, very light divider - whitespace is the primary separator, this is a subtle extra (same
  // principle as the Home Quick Choice redesign: no borders/cards around each row).
  divider: { height: 1, backgroundColor: colors.borderLight, marginHorizontal: 2 },
}));
