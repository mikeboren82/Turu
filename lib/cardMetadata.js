// 🎴 Card Metadata Policy (2026-09-25) - product/UI presentation layer only. Decides which of an
// activity's known facts are worth showing in the compact card stats row, and in what priority - see
// the priority matrix in the final report for this task. Never modifies stored activity data, never
// duplicates lib/activities.js's formatters (reuses formatPrice/scheduleHoursLabel), and never
// invents a value: every candidate below returns a fact only when the underlying field is
// EXPLICITLY known, not merely absent - lib/activities.js#formatPrice/scheduleHoursLabel still
// return "not specified" placeholder text for OTHER contexts (the full activity detail page), but
// this module deliberately never surfaces that text on a card, because a placeholder shown as if it
// were a fact makes an otherwise-fine card look broken or misleading (this task's Problem 1).
import { formatPrice } from './activities';
import { scheduleHoursLabel } from './i18n/format';
import { getOpenNowInfo } from './filterActivities';
import { BOOKING_OPTIONS } from '../constants/filterSchema';
import { t } from './i18n';

const NOT_REQUIRED_VALUES = BOOKING_OPTIONS.find((o) => o.id === 'not_required')?.values || [];
const REQUIRED_VALUES = BOOKING_OPTIONS.find((o) => o.id === 'required')?.values || [];

// Exact canonical-category allowlists (constants/categoryValues.json), never a substring/keyword
// match - this task's OTHER bug (see lib/placeholderImages.js) is exactly what a "contains
// שעשועים" match produces: גן שעשועים collapsing into פארק שעשועים. A category not listed in any
// set below (or entity_type not 'אירוע'/'אירוע_קבוע') falls through to 'venue', a safe default that
// keeps the pre-existing price/hours priority - never a wrong specific guess.
const PLAYGROUND_CATEGORIES = new Set(['גן שעשועים', 'פארק']);
const WORKSHOP_CATEGORIES = new Set(['סדנה', 'חוג', 'יצירה', 'מוזיקה', 'ריקוד', 'בישול', 'מדע']);
const PERFORMANCE_CATEGORIES = new Set(['הצגה', 'קולנוע לילדים', 'שעת סיפור']);

// A. public playground/park, C. workshop/class, D. performance/show, E. one-time event,
// F. recurring programme, B. fixed commercial venue (default) - category wins over entity_type
// (e.g. a one-off הצגה is still presented as a performance, not a generic "event").
export function getCardPresentationKind(activity) {
  const category = activity?.category;
  if (PLAYGROUND_CATEGORIES.has(category)) return 'playground';
  if (WORKSHOP_CATEGORIES.has(category)) return 'workshop';
  if (PERFORMANCE_CATEGORIES.has(category)) return 'performance';
  if (activity?.entity_type === 'אירוע') return 'event';
  if (activity?.entity_type === 'אירוע_קבוע') return 'programme';
  return 'venue';
}

// price_type/price_amount: 'free' and a real 'fixed' amount and 'range' are explicit; anything else
// (null/undefined price_type, or 'fixed' with no amount) is UNKNOWN, not "unspecified" - omitted
// rather than shown as lib/activities.js#formatPrice's fallback text.
function priceFact(activity) {
  const { price_type: type, price_amount: amount } = activity || {};
  if (type === 'free' || (type === 'fixed' && amount != null) || type === 'range') {
    return { key: 'price', text: formatPrice(type, amount) };
  }
  return null;
}

// openHours/nextDate present = explicit schedule data; both absent is UNKNOWN (most playgrounds and
// many places genuinely have none), never lib/i18n/format.js#scheduleHoursLabel's "not specified"
// fallback text on a card.
function hoursFact(activity) {
  if (activity?.openHours || activity?.nextDate) return { key: 'hours', text: scheduleHoursLabel(activity) };
  return null;
}

// "פתוח עכשיו" only - never a "closed" fact (section 5: prefer positive facts over filler), and only
// when hasScheduleData is real. Most OSM playgrounds carry no schedule rows at all (see
// isExemptFromScheduleEvidence, lib/filterActivities.js, for the same "no data ≠ closed" principle
// applied to date/time search) - hasScheduleData:false there naturally omits this fact rather than
// inventing an open/closed guess for a place with no recorded hours.
function openNowFact(activity) {
  const info = getOpenNowInfo(activity || {});
  return info.hasScheduleData && info.isOpen ? { key: 'openNow', text: t('activities.card.matchReasons.openNow') } : null;
}

// booking_requirement in the 'required' bucket (constants/filterSchema.js#BOOKING_OPTIONS, the same
// bucket matchesBooking/noRegistrationFact below already use) is explicit; null/undefined or any
// other raw value is UNKNOWN, not "not required" - omitted either way, never guessed.
function registrationRequiredFact(activity) {
  return REQUIRED_VALUES.includes(activity?.booking_requirement)
    ? { key: 'registration', text: t('activities.card.registrationRequired') } : null;
}

// Shared with lib/matchReasons.js's "✓ why this matches" row - one bucket lookup, not two parallel
// copies of which raw values mean "not required". Plain string (not a {key,text} stat) because that
// row is a sentence fragment, not a card stat.
export function noRegistrationFact(activity) {
  return NOT_REQUIRED_VALUES.includes(activity?.booking_requirement) ? t('activities.card.matchReasons.noRegistration') : null;
}

// Priority-ordered candidates per kind - age is deliberately NOT listed here: ActivityCard already
// shows it as its own always-first slot when known (unaffected by this policy, see the "reliability
// pass" comment there), so these lists only cover what shares the remaining 1-2 stat slots.
//   playground: free (if explicit) then a reliable open-now status - never registration (expected/
//     obvious for a public playground, not a useful "why this matches" fact - see noRegistrationFact
//     above, which lib/matchReasons.js gates the same way for this exact kind).
//   workshop: price then explicit registration requirement (a genuinely useful heads-up for a class).
//   performance: time then registration - "tickets" is already its own always-shown badge
//     (requiresTicket, computed in lib/activities.js from real cost + a real purchase link).
//   event: time then price - registration is the weakest signal for a one-off, so it is not in the
//     top 2 here (still available via lib/matchReasons.js's row when genuinely informative).
//   programme/venue: price then hours - the pre-existing default order, now omitting unknowns.
const CANDIDATES_BY_KIND = {
  playground: [priceFact, openNowFact],
  workshop: [priceFact, registrationRequiredFact],
  performance: [hoursFact, registrationRequiredFact],
  event: [hoursFact, priceFact],
  programme: [priceFact, hoursFact],
  venue: [priceFact, hoursFact],
};

// Up to 2 {key, text} facts, each only when explicitly known. The single function
// components/ActivityCard.js calls - it never inspects price_type/booking_requirement/etc itself.
export function buildCardStatFacts(activity) {
  const candidates = CANDIDATES_BY_KIND[getCardPresentationKind(activity)] || CANDIDATES_BY_KIND.venue;
  return candidates.map((fn) => fn(activity)).filter(Boolean).slice(0, 2);
}
