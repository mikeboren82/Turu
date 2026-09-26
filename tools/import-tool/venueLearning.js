// TuRu - shared venue-learning rules for propose-venues.js (published-activity evidence) and the
// Cleaner's cluster step (cleaner/venueClusters.js). One writer for "create a canonical venue from
// evidence": runs venue identity (lib/venueMatch - place id, alias, same spot, same name) immediately
// before insert, so a label variant of an existing venue is reused or held, never a twin; inserts the
// alias with onConflict, and links nothing by itself.
const { normalizeCityName } = require('./cityNaming');
const { normalizeVenueAlias, genericVenueType } = require('./venueNaming');
const { matchExistingVenue } = require('./lib/venueMatch');

const GENERIC_LABELS = new Set(['ספרייה', 'הספרייה', 'ספריה', 'מתנס', 'מתנ"ס', 'המתנס', 'פארק', 'גן', 'גינה', 'הגינה', 'מרכז', 'המרכז', 'אולם', 'היכל', 'בית', 'חוף', 'הפארק', 'קניון', 'הקניון', 'כיכר', 'מגרש', 'אודיטוריום', 'מרכז קהילתי', 'מרכז מסחרי', 'בית ספר', 'גן ילדים', 'מקוון', 'zoom', 'online', 'ספרייה עירונית', 'הספרייה העירונית', 'ספריה עירונית']);
// organizers are not places: "עיריית X" / "מועצה אזורית X" / "החברה להגנת הטבע" label the publisher
const NON_PLACE = /שכונ|ברחבי|רחבי העיר|מקוון|אונליין|zoom|יקבע|יפורסם|לפי בחירה|מספר מוקדים|מוקדים שונים|בכל הסניפים|באתרים שונים|^עיריי?ת?\b|^עירייה|^מועצה|^החברה להגנת הטבע|^קק"?ל|^רשת /;
const TYPE_RULES = [[/קניון|סנטר|מרכז מסחרי|מול\b/, 'mall'], [/ספרי/, 'library'], [/מתנ"?ס|מרכז קהילתי|מרכזים קהילתיים|קהילה/, 'community_center'], [/היכל|תיאטרון|אולם|אודיטוריום|מרכז הבמה/, 'theater'], [/מוזיאון|מוזאון|מדעטק|טכנודע/, 'museum'], [/פארק|גן |גינה|יער|חורש/, 'park'], [/חווה|פינת חי|משק/, 'farm'], [/מרכז תרבות|בית תרבות|תרבות/, 'cultural_center'], [/בריכה|קאנטרי|ספורט|מגרש/, 'sports_center'], [/כיכר|רחבה|טיילת|חוף/, 'public_square'], [/מרכז מבקרים/, 'visitor_center']];
const REGIONS = new Set(['הצפון והגליל', 'עמק יזרעאל והעמקים', 'חיפה והקריות', 'השרון', 'גוש דן והמרכז', 'ירושלים והסביבה', 'השפלה', 'הדרום והנגב', 'יו"ש והבנימין']);

// genericVenueType: every spelling the resolver treats as a generic label (R2/R3) is refused too - a stored
// generic alias is a human ATTESTATION that the label means this venue in its city, so no evidence-driven
// writer may ever create one (GENERIC_LABELS alone missed "ספרייה העירונית" / "הספריה העירונית").
function isLearnableLabel(label) {
  const l = (label || '').trim(); if (!l) return false;
  const norm = normalizeVenueAlias(l);
  return !!norm && norm.length >= 3 && !GENERIC_LABELS.has(norm) && !GENERIC_LABELS.has(l) && !NON_PLACE.test(l) && !genericVenueType(l);
}

// Alias rows written WITHOUT a person explicitly typing that alias for that venue (a venue merge carrying
// the loser's name/aliases, a manifest re-seed) -> { rows, dropped }: generic attestation keys are dropped.
// Explicit admin alias entry (POST /api/venues/:id/alias) does not go through here - attesting stays possible.
function withoutGenericAliases(rows) {
  const keep = [], dropped = [];
  for (const r of rows || []) (genericVenueType(r.alias) || genericVenueType(r.alias_normalized) ? dropped : keep).push(r);
  return { rows: keep, dropped };
}
function inferVenueType(label) { return (TYPE_RULES.find(([re]) => re.test(label || '')) || [null, 'other'])[1]; }

// -> { venue, created, identity } | { error, hold?, identity? }. Conservative: refuses a generic label, a missing city
// or coordinates; then R12 identity (lib/venueMatch) runs BEFORE any insert - a match reuses the existing venue (a
// level-3/4 match also stores this label as its alias, so the next event resolves by alias), an ambiguous or
// other-city identity is HELD (no venue), and only NO_MATCH creates.
async function createVenueWithAlias(client, { label, city, region, type, lat, lng, address, notes, userId }) {
  const cityNorm = normalizeCityName(city || null);
  if (!isLearnableLabel(label)) return { error: 'label not learnable (generic / non-place)' };
  if (!cityNorm) return { error: 'no city' };
  if (lat == null || lng == null) return { error: 'no coordinates' };
  const identity = await matchExistingVenue(client, { label: label.trim(), city: cityNorm, lat, lng });
  if (identity.verdict === 'HOLD') return { error: `identity hold: ${identity.reason}`, hold: true, identity };
  if (identity.verdict === 'MATCH') {
    if (identity.level >= 3) {
      const { error: aErr } = await client.from('venue_aliases').upsert([{ alias: label.trim(), alias_normalized: normalizeVenueAlias(label), venue_id: identity.venue.id }], { onConflict: 'alias_normalized,venue_id' });
      if (aErr) return { venue: identity.venue, created: false, identity, error: 'alias: ' + aErr.message };
    }
    return { venue: identity.venue, created: false, identity };
  }
  const { data: v, error } = await client.from('venues').insert({ name_he: label.trim(), venue_type: type || inferVenueType(label), city: cityNorm, region: REGIONS.has(region) ? region : null, address: address || null, lat, lng, is_active: true, notes: notes || null, created_by: userId || null }).select('id, name_he, city, venue_type, lat, lng, address, is_active').single();
  if (error) return { error: error.message };
  const { error: aErr } = await client.from('venue_aliases').upsert([{ alias: label.trim(), alias_normalized: normalizeVenueAlias(label), venue_id: v.id }], { onConflict: 'alias_normalized,venue_id' });
  if (aErr) return { error: 'alias: ' + aErr.message, venue: v };
  return { venue: v, created: true, identity };
}

module.exports = { GENERIC_LABELS, NON_PLACE, TYPE_RULES, REGIONS, isLearnableLabel, inferVenueType, createVenueWithAlias, withoutGenericAliases };
