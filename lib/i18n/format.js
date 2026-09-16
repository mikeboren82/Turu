// Locale-aware display helpers for Turu domain values. Canonical values (Hebrew category/region
// strings, Hebrew city names, filter IDs) are NEVER changed - these only produce display text.
import { t, getLocale, listJoin } from './index';
import placeNamesEn from '../../constants/placeNamesEn.json';

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
