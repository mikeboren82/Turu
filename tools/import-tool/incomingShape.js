// TuRu - incoming_activities.extracted_data arrives in two shapes: the page-extraction shape
// (scrapeAndExtract / scan-source: location_name, city, lat, lng, schedule_type…) and the
// Google-Places shape written by scan-settlement-gaps (formatted_address, lat, lon,
// google_place_id, place_kind). saveNewActivity/requireVerifiedLocation only understand the first,
// so "אשר והוסף" on a Places-shaped row used to fail with "לא נמצאה כתובת" (found 2026-09-13 when
// approving 131 such rows). This normalizes either shape into the saveNewActivity contract.

const { normalizeCityName } = require('./cityNaming');

const COUNTRY_TOKENS = new Set(['ישראל', 'israel']);

function splitFormattedAddress(formatted) {
  if (!formatted || typeof formatted !== 'string') return { street: null, city: null };
  const parts = formatted.split(',').map((p) => p.trim()).filter(Boolean)
    .filter((p) => !COUNTRY_TOKENS.has(p.toLowerCase()) && !/^\d{5,7}$/.test(p));
  if (!parts.length) return { street: null, city: null };
  const cityRaw = parts[parts.length - 1].replace(/^\d{5,7}\s+/, '').replace(/\s+\d{5,7}$/, '').trim();
  const city = cityRaw && !/^\d+$/.test(cityRaw) ? normalizeCityName(cityRaw) : null;
  const street = parts.length > 1 ? parts.slice(0, -1).join(', ') : null;
  return { street, city };
}

function isPlacesShape(ed) {
  return !!ed && (ed.formatted_address !== undefined || ed.google_place_id !== undefined || ed.lon !== undefined);
}

function normalizeIncomingCandidate(ed) {
  if (!ed || typeof ed !== 'object') return ed;
  if (!isPlacesShape(ed)) {
    // page-extraction shape: only make sure city is canonical - and that a dated candidate is never
    // defaulted to a never-expiring fixed_hours place
    const schedule_type = ed.schedule_type || (ed.one_time_date || (Array.isArray(ed.occurrences) && ed.occurrences.length) ? 'one_time' : ed.schedule_type);
    return { ...ed, schedule_type, city: ed.city ? normalizeCityName(ed.city) : ed.city };
  }
  const { street, city } = splitFormattedAddress(ed.formatted_address);
  const name = ed.name || null;
  return {
    ...ed,
    name,
    entity_type: ed.entity_type || 'מקום_קבוע',
    category: ed.category || 'גן שעשועים',
    schedule_type: ed.schedule_type || 'fixed_hours',
    // the venue/location label the location row will carry; street-level address when Google gave one
    location_name: ed.location_name || (street ? `${name || 'גן שעשועים'} - ${street}` : name) || null,
    address: street ? [street, city].filter(Boolean).join(', ') : null,
    city: city || (ed.city ? normalizeCityName(ed.city) : null),
    lat: typeof ed.lat === 'number' ? ed.lat : null,
    lng: typeof ed.lng === 'number' ? ed.lng : (typeof ed.lon === 'number' ? ed.lon : null),
    price_type: ed.price_type || 'free',
    price_amount: ed.price_amount ?? 0,
    indoor_outdoor: ed.indoor_outdoor || 'outdoor',
    booking_requirement: ed.booking_requirement || 'none',
    google_place_id: ed.google_place_id || null,
    image_urls: Array.isArray(ed.image_urls) ? ed.image_urls : [],
  };
}

module.exports = { normalizeIncomingCandidate, splitFormattedAddress, isPlacesShape };
