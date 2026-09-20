// Locale-aware display helpers for Turu domain values. Canonical values (Hebrew category/region
// strings, Hebrew city names, filter IDs) are NEVER changed - these only produce display text.
import { t, getLocale, listJoin } from './index';
import placeNamesEn from '../../constants/placeNamesEn.json';
import { LETTER_TO_DAY_NAME } from '../scheduleSummary';

const has = (key) => t(key, null, getLocale()) !== key && t(key) !== '';

// Canonical category value (Hebrew string stored in DB) -> label in the active locale.
export function categoryLabel(value) {
  if (!value) return '';
  const key = `domain.categories.${value}`;
  return has(key) ? t(key) : value;
}

export function regionLabel(value) {
  if (!value) return '';
  const key = `domain.regions.${value}`;
  return has(key) ? t(key) : value;
}

// Must match key() in the placeNamesEn.json build script.
export function normalizePlaceKey(name) {
  return String(name)
    .replace(/[֑-ׇ]/g, '')
    .replace(/\((שבט|יישוב)\)/g, '')
    .replace(/["'`׳״\-–]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Hebrew place name -> display name for the active locale. Unknown names (and names that are
// already Latin) are returned unchanged - never guessed/transliterated per component.
export function placeName(name) {
  if (!name) return '';
  if (getLocale() === 'he') return name;
  if (!/[֐-׿]/.test(name)) return name;
  if (getLocale() === 'en') return placeNamesEn[normalizePlaceKey(name)] || name;
  return name;
}

export function relativeDate(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return t('domain.time.today');
  if (days === 1) return t('domain.time.yesterday');
  if (days < 7) return t('domain.time.daysAgo', { count: days });
  if (days < 30) return t('domain.time.weeksAgo', { count: Math.floor(days / 7) });
  return t('domain.time.monthsAgo', { count: Math.floor(days / 30) });
}

export function formatKm(km) {
  return km < 10 ? km.toFixed(1) : String(Math.round(km));
}

// Schedule "hours" text from summarizeSchedules() structured output, rendered at display time
// (the pure summary in lib/scheduleSummary.js stays locale-free for its Node test).
export function scheduleHoursLabel({ openHours, occurrences, nextDate, recurringDays } = {}) {
  let text = t('domain.schedule.hoursNotSpecified');
  if (openHours) {
    text = `${openHours.start}–${openHours.end}`;
    if (recurringDays && recurringDays.length > 0 && recurringDays.length <= 3) {
      const days = recurringDays.map((d) => t('domain.schedule.dayListItem', { day: t(`domain.schedule.dayShort.${d}`) }));
      text += ` (${days.join(t('common.listSeparator'))})`;
    }
  } else if (nextDate) {
    text = new Date(nextDate).toLocaleDateString(getLocale() === 'he' ? 'he-IL' : 'en-IL');
  }
  if (nextDate && occurrences && occurrences.length > 1) {
    text += ` ${t('domain.schedule.moreDates', { count: occurrences.length - 1 })}`;
  }
  return text;
}

export function dayLetterLabel(letter) {
  return t(`domain.schedule.dayLetter.${letter}`);
}

// Opening Hours Phase 2 (2026-09-20) - locale-aware string builders consuming lib/hoursDisplay.js's
// pure, i18n-free data (buildTodayStatus/buildUpcomingDays). Same layering as scheduleHoursLabel
// above: the data-prep stays locale-free and unit-testable without react-native; only this layer
// touches t(). None of these ever fabricate an hour that isn't in `intervals` - a warning changes
// the WORDING around the hours, never the hours themselves.

function intervalsText(intervals) {
  return (intervals || []).map((iv) => `${iv.start}–${iv.end}`).join(t('common.listSeparator'));
}

// The collapsed status line - "🟢 פתוח עכשיו · עד 18:00" / "סגור עכשיו · נפתח מחר ב-09:00" / etc.
// `status` is lib/hoursDisplay.js#buildTodayStatus's return value.
export function hoursStatusText(status) {
  if (!status) return t('domain.schedule.hoursNotSpecified');
  if (status.state === 'always_open') return t('activity.hours.alwaysOpen');
  if (status.isOpen) return t('activity.hours.openUntil', { time: status.closesAt });
  if (status.opensAt) return t('activity.hours.opensLaterToday', { time: status.opensAt }); // later THE SAME day (e.g. a lunch-break gap)
  if (status.nextOpening) {
    // Checked BEFORE the state:'unknown' fallback below on purpose: today itself can be unknown
    // (no recorded hours for today's specific weekday) while a LATER date within the horizon is
    // still known - e.g. Tuesday has no data but Sunday does. Telling the user "opens Sunday at
    // 09:00" is strictly more useful than a bare "hours not specified" whenever we actually know it.
    if (status.nextOpening.offsetDays === 1) return t('activity.hours.opensTomorrow', { time: status.nextOpening.time });
    const dayName = LETTER_TO_DAY_NAME[status.nextOpening.weekdayLetter];
    return t('activity.hours.opensOnDay', { day: t(`domain.schedule.dayShort.${dayName}`), time: status.nextOpening.time });
  }
  if (status.state === 'unknown') return t('domain.schedule.hoursNotSpecified');
  return t('activity.hours.closedNow'); // nothing known to open within the horizon - never guessed further out
}

// The compact "today is a warning-worthy holiday/eve" line shown alongside the status
// (task section 8) - null when today has no warning, so the caller can omit the line entirely.
export function hoursTodayWarningText(status) {
  if (!status?.todayWarning) return null;
  return t('activity.hours.todayHolidayWarning', { holiday: status.todayWarning.nameHe });
}

// The compact per-day warning line inside the 7-day view (task section 7) - deliberately generic
// (no holiday name repeated here - the day's own label, see hoursDayLabel below, already carries it).
export function hoursDayWarningText() {
  return t('activity.hours.dayWarning');
}

// A 7-day row's day/date identity, split into parts rather than one flat string (2026-09-20,
// Weekly Hours visual polish - task section 5: "holiday information should feel like contextual
// information attached to the date, not part of a giant sentence") - the caller renders `prefix`
// ("היום"/"מחר") and `weekday` together on one line, with the holiday/eve name (see
// hoursDayHolidayName below) as its own secondary line underneath, instead of concatenating
// everything with " · " into a single run of text. `day` is one entry from lib/hoursDisplay.js#
// buildUpcomingDays.
export function hoursDayLabelParts(day) {
  const dayName = LETTER_TO_DAY_NAME[day.weekdayLetter];
  const weekday = t(`domain.schedule.dayShort.${dayName}`);
  const prefix = day.isToday ? t('activity.hours.today') : day.isTomorrow ? t('activity.hours.tomorrow') : null;
  return { prefix, weekday };
}

// The holiday/eve name attached to a date, or null - deliberately separate from the warning
// (task section 5: "holiday name and holiday warning are two different concepts"). A date can
// carry this even when lib/hoursPolicy.js decided it doesn't warrant a warning (e.g. Rosh Chodesh).
export function hoursDayHolidayName(day) {
  return day.warning?.nameHe || day.holidays?.[0]?.nameHe || null;
}

// One shared note for the 7-day list, used instead of repeating the per-day warning line under
// every affected date when several fall within the same visible week (task section 6) - the
// affected rows still carry their own subtle marker (see components/WeeklyHoursSection.js), this
// text only explains what that marker means, generically, without naming every date again.
export function hoursSharedWarningNote() {
  return t('activity.hours.sharedWarningNote');
}

// A 7-day row's right-side value - the resolved hours text, or a state-appropriate label. UNKNOWN
// and CLOSED are kept semantically distinct on purpose (task section 3): an occurrence-kind day
// with no performance is definitively "סגור"; a weekly-kind day with no recorded hours for that
// specific weekday is "שעות לא ידועות" - never presented as if they were the same fact.
export function hoursDayValueText(day) {
  if (day.state === 'always_open') return t('activity.hours.alwaysOpen').replace(/^🟢\s*/, '');
  if (day.intervals?.length) return intervalsText(day.intervals);
  if (day.state === 'closed') return t('activity.hours.closedToday');
  return t('activity.hours.unknownToday');
}

export function categoriesSummary(selectedIds) {
  if (!selectedIds || selectedIds.length === 0) return t('domain.summary.all');
  if (selectedIds.length <= 3) return listJoin(selectedIds.map(categoryLabel));
  return t('domain.summary.categories', { count: selectedIds.length });
}

// Full location summary (Activities, Profile, a11y values).
export function locationSummaryText(location) {
  if (!location) return t('domain.location.nearMe');
  const place = placeName(location.addressLabel || location.city || '');
  if (location.mode === 'nationwide') return t('domain.location.nationwide');
  if (location.travelMode === 'walking') {
    if (location.mode === 'current') return t('domain.location.walkingFromMe');
    if (location.mode === 'address') return t('domain.location.walkingFromPlace', { place });
  }
  if (location.travelMode === 'any') return t('domain.location.anyDistanceArea');
  if (location.travelMode === 'driving' && typeof location.travelMinutes === 'number') {
    const minutes = location.travelMinutes;
    if (location.mode === 'current') return t('domain.location.upToMinutesFromMe', { minutes });
    if (location.mode === 'city' && location.city) return t('domain.location.upToMinutesFromPlace', { minutes, place: placeName(location.city) });
    if (location.mode === 'address') return t('domain.location.upToMinutesFromPlace', { minutes, place });
    if (location.mode === 'region' && location.region?.length) return t('domain.location.upToMinutesFromPlace', { minutes, place: location.region.map(regionLabel).join(', ') });
  }
  if (location.mode === 'current') return t('domain.location.myLocation');
  if (location.mode === 'city' && location.city) return placeName(location.city);
  if (location.mode === 'address') return place || t('domain.location.nearMe');
  if (location.mode === 'region' && location.region?.length) return location.region.map(regionLabel).join(', ');
  return t('domain.location.nearMe');
}

// Compact variant used in Home's guided WHERE row (no "up to", walking without distance).
export function compactLocationText(location) {
  if (!location || !location.mode) return t('domain.location.compact.where');
  if (location.mode === 'nationwide') return t('domain.location.nationwide');
  if (location.travelMode === 'walking') return t('domain.location.compact.walking');
  if (location.travelMode === 'any') return t('domain.location.compact.anyDistance');
  const place = placeName(location.addressLabel || location.city || '');
  if (location.travelMode === 'driving' && typeof location.travelMinutes === 'number') {
    const minutes = location.travelMinutes;
    if (location.mode === 'current') return t('domain.location.compact.minutesFromMe', { minutes });
    if (location.mode === 'city' && location.city) return t('domain.location.compact.minutesFromPlace', { minutes, place: placeName(location.city) });
    if (location.mode === 'address') return t('domain.location.compact.minutesFromPlace', { minutes, place });
    if (location.mode === 'region' && location.region?.length) return t('domain.location.compact.minutesFromPlace', { minutes, place: location.region.map(regionLabel).join(', ') });
  }
  if (location.mode === 'current') return t('domain.location.myLocation');
  if (location.mode === 'city' && location.city) return placeName(location.city);
  if (location.mode === 'address') return place || t('domain.location.myLocation');
  if (location.mode === 'region' && location.region?.length) return location.region.map(regionLabel).join(', ');
  return t('domain.location.compact.where');
}
