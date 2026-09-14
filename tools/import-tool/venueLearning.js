// TuRu - shared venue-learning rules for propose-venues.js (published-activity evidence) and the
// Cleaner's cluster step (cleaner/venueClusters.js). One writer for "create a canonical venue from
// evidence": re-resolves the alias immediately before insert (parallel Cleaner/Monster/admin work
// cannot create twins), inserts the alias with onConflict, and links nothing by itself.
const { normalizeCityName } = require('./cityNaming');
const { resolveVenue, normalizeVenueAlias } = require('./venueNaming');

const GENERIC_LABELS = new Set(['ספרייה', 'הספרייה', 'ספריה', 'מתנס', 'מתנ"ס', 'המתנס', 'פארק', 'גן', 'גינה', 'הגינה', 'מרכז', 'המרכז', 'אולם', 'היכל', 'בית', 'חוף', 'הפארק', 'קניון', 'הקניון', 'כיכר', 'מגרש', 'אודיטוריום', 'מרכז קהילתי', 'מרכז מסחרי', 'בית ספר', 'גן ילדים', 'מקוון', 'zoom', 'online', 'ספרייה עירונית', 'הספרייה העירונית', 'ספריה עירונית']);
// organizers are not places: "עיריית X" / "מועצה אזורית X" / "החברה להגנת הטבע" label the publisher
const NON_PLACE = /שכונ|ברחבי|רחבי העיר|מקוון|אונליין|zoom|יקבע|יפורסם|לפי בחירה|מספר מוקדים|מוקדים שונים|בכל הסניפים|באתרים שונים|^עיריי?ת?\b|^עירייה|^מועצה|^החברה להגנת הטבע|^קק"?ל|^רשת /;
const TYPE_RULES = [[/קניון|סנטר|מרכז מסחרי|מול\b/, 'mall'], [/ספרי/, 'library'], [/מתנ"?ס|מרכז קהילתי|מרכזים קהילתיים|קהילה/, 'community_center'], [/היכל|תיאטרון|אולם|אודיטוריום|מרכז הבמה/, 'theater'], [/מוזיאון|מוזאון|מדעטק|טכנודע/, 'museum'], [/פארק|גן |גינה|יער|חורש/, 'park'], [/חווה|פינת חי|משק/, 'farm'], [/מרכז תרבות|בית תרבות|תרבות/, 'cultural_center'], [/בריכה|קאנטרי|ספורט|מגרש/, 'sports_center'], [/כיכר|רחבה|טיילת|חוף/, 'public_square'], [/מרכז מבקרים/, 'visitor_center']];
const REGIONS = new Set(['הצפון והגליל', 'עמק יזרעאל והעמקים', 'חיפה והקריות', 'השרון', 'גוש דן והמרכז', 'ירושלים והסביבה', 'השפלה', 'הדרום והנגב', 'יו"ש והבנימין']);

function isLearnableLabel(label) {
  const l = (label || '').trim(); if (!l) return false;
  const norm = normalizeVenueAlias(l);
  return !!norm && norm.length >= 3 && !GENERIC_LABELS.has(norm) && !GENERIC_LABELS.has(l) && !NON_PLACE.test(l);
}
function inferVenueType(label) { return (TYPE_RULES.find(([re]) => re.test(label || '')) || [null, 'other'])[1]; }

// -> { venue, created } | { error }. Conservative: refuses when the alias already resolves anywhere
// (same city => reuse; other city => human check), when the city is missing, or when coords are absent.
async function createVenueWithAlias(client, { label, city, region, type, lat, lng, address, notes, userId }) {
  const cityNorm = normalizeCityName(city || null);
  if (!isLearnableLabel(label)) return { error: 'label not learnable (generic / non-place)' };
  if (!cityNorm) return { error: 'no city' };
  if (lat == null || lng == null) return { error: 'no coordinates' };
  const existing = await resolveVenue(client, { locationName: label, city: cityNorm });
  if (existing) return { venue: existing, created: false };
  const anywhere = await resolveVenue(client, { locationName: label, city: null });
  if (anywhere) return { error: `alias exists as ${anywhere.name_he} [${anywhere.city}] - city mismatch, human check` };
  const { data: v, error } = await client.from('venues').insert({ name_he: label.trim(), venue_type: type || inferVenueType(label), city: cityNorm, region: REGIONS.has(region) ? region : null, address: address || null, lat, lng, is_active: true, notes: notes || null, created_by: userId || null }).select('id, name_he, city, venue_type, lat, lng, address, is_active').single();
  if (error) return { error: error.message };
  const { error: aErr } = await client.from('venue_aliases').upsert([{ alias: label.trim(), alias_normalized: normalizeVenueAlias(label), venue_id: v.id }], { onConflict: 'alias_normalized,venue_id' });
  if (aErr) return { error: 'alias: ' + aErr.message, venue: v };
  return { venue: v, created: true };
}

module.exports = { GENERIC_LABELS, NON_PLACE, TYPE_RULES, REGIONS, isLearnableLabel, inferVenueType, createVenueWithAlias };
