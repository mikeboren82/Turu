// TuRu Cleaner - reverse geocode (coordinates -> street/house/city) through the same throttled
// Nominatim access the location resolver uses. Same semantics as enrich-playground-addresses.js:
// an Arabic-script-only road name counts as "no street" (the app is Hebrew-first).
const { nominatim } = require('./nominatimClient');

async function reverseAddress(lat, lng) {
  const r = await nominatim(`/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`);
  const a = r?.address; if (!a) return null;
  const street = a.road || a.pedestrian || a.footway || null;
  if (street && !/[֐-׿a-zA-Z]/.test(street)) return { street: null, houseNumber: null, city: a.city || a.town || a.village || null, raw: r.display_name };
  return { street, houseNumber: a.house_number || null, city: a.city || a.town || a.village || a.municipality || null, suburb: a.suburb || null, raw: r.display_name };
}

module.exports = { reverseAddress };
