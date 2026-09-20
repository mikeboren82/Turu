import { useMemo, useState } from 'react';
import { View, Text, Pressable, Linking } from 'react-native';
import { ClockIcon, ChevronDownIcon } from './icons';
import { colors, fonts, radii } from '../constants/theme';
import { useI18n, createStyles } from '../lib/i18n';
import {
  hoursStatusText, hoursTodayWarningText, hoursDayWarningText, hoursDayLabel, hoursDayValueText,
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
  return (
    <View style={styles.section}>
      <Pressable
        onPress={() => setExpanded((e) => !e)}
        style={({ pressed }) => [styles.headerRow, pressed && styles.headerRowPressed]}
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
          {days.map((day, i) => (
            <View key={day.date}>
              {i > 0 ? <View style={styles.divider} /> : null}
              <View style={styles.dayRow}>
                <Text style={[styles.dayLabel, day.isToday && styles.dayLabelToday]} numberOfLines={1}>
                  {hoursDayLabel(day)}
                </Text>
                <View style={styles.dayValueCol}>
                  <Text style={[styles.dayValue, day.isToday && styles.dayValueToday]} numberOfLines={2}>
                    {hoursDayValueText(day)}
                  </Text>
                  {day.warning ? <Text style={styles.dayWarning} numberOfLines={1}>{hoursDayWarningText()}</Text> : null}
                </View>
              </View>
            </View>
          ))}
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

  headerRow: { flexDirection: d.row, alignItems: 'center', gap: 10, paddingVertical: 4 },
  headerRowPressed: { opacity: 0.7 },
  headerTextWrap: { flex: 1, gap: 2 },
  statusText: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.textPrimary, textAlign: d.textAlign },
  // warn (#b76b1c, amber) - not danger/red: an ordinary-hours-may-vary note is useful context, not
  // an alarm (task section 9: "restrained, not alarming... no red/error styling").
  warningText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.warn, textAlign: d.textAlign },
  chevronWrap: { transform: [{ rotate: '0deg' }], padding: 2 },
  chevronWrapExpanded: { transform: [{ rotate: '180deg' }] },

  daysList: { marginTop: 12, marginHorizontal: -2 },
  dayRow: { flexDirection: d.row, alignItems: 'flex-start', justifyContent: 'space-between', paddingVertical: 9, gap: 10 },
  dayLabel: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary, textAlign: d.textAlign, flexShrink: 1 },
  dayLabelToday: { fontFamily: fonts.bold, color: colors.textPrimary },
  dayValueCol: { alignItems: d.alignEnd, flexShrink: 0, maxWidth: '55%' },
  dayValue: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textSecondary, textAlign: d.textAlignEnd },
  dayValueToday: { fontFamily: fonts.bold, color: colors.textPrimary },
  dayWarning: { fontFamily: fonts.semiBold, fontSize: 11, color: colors.warn, textAlign: d.textAlignEnd, marginTop: 2 },
  // inset, very light divider - whitespace is the primary separator, this is a subtle extra (same
  // principle as the Home Quick Choice redesign: no borders/cards around each row).
  divider: { height: 1, backgroundColor: colors.borderLight, marginHorizontal: 2 },
}));
