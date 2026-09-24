// TuRu - canonical REGION vocabulary at the location write boundary (2026-09-24).
// locations.region is constrained to the 9 product regions (supabase/0084 locations_region_check; the list is
// constants/categoryValues.json `regions`, byte-identical to the Edge copy). A location write may carry only
// one of those values, or NULL. Anything else - a pre-0084 value such as "השפלה והדרום" still sitting in old
// queue candidates, or free geocoder / admin-area text ("מחוז ירושלים") - becomes NULL: never remapped, because
// the 0084 split is city-dependent and a guess can land in the wrong district. A NULL region on a published
// location is repaired later from evidence by the Cleaner's missing_region route (venue / same-city majority).
const REGIONS = require('../../../constants/categoryValues.json').regions;
const CANONICAL = new Set(REGIONS);

// -> the canonical region, or null (never throws, never maps)
function canonicalRegion(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return CANONICAL.has(v) ? v : null;
}
// -> { region, dropped } - `dropped` carries the rejected raw value for logging / evidence
function regionForWrite(value) {
  const region = canonicalRegion(value);
  return { region, dropped: region == null && typeof value === 'string' && value.trim() ? value.trim() : null };
}

module.exports = { REGIONS, canonicalRegion, regionForWrite };
