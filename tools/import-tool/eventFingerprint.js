// TuRu - Node mirror of supabase/functions/_shared/matching.ts computeEventFingerprint (same
// intentional two-runtime copy as cityNaming/playgroundNaming/venueNaming). Must stay identical.
const { normalizeCityName } = require('./cityNaming');

const HEBREW_DAY_ORDER = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function normalizeForMatch(s) {
  return (s || '').toLowerCase().replace(/[^֐-׿a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function computeEventFingerprint({ name, venueId, city, scheduleType, oneTimeDate, recurringDays, startTime }) {
  const n = normalizeForMatch(name);
  if (!n) return null;
  let when = null;
  if (scheduleType === 'one_time' && oneTimeDate) when = oneTimeDate;
  else if (scheduleType === 'recurring' && Array.isArray(recurringDays) && recurringDays.length) {
    when = [...new Set(recurringDays)].sort((a, b) => HEBREW_DAY_ORDER.indexOf(a) - HEBREW_DAY_ORDER.indexOf(b)).join(',');
  }
  if (!when) return null;
  const where = venueId ? `v:${venueId}` : `c:${normalizeForMatch(normalizeCityName(city || null) || '')}`;
  const time = (startTime || '').slice(0, 5);
  return `${n}|${where}|${when}|${time}`;
}

module.exports = { computeEventFingerprint, normalizeForMatch };
